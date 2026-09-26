import 'dart:async';
import 'package:flutter/widgets.dart';
import '../../gamification/repositories/gamification_repository.dart';
import '../models/reading_progress_models.dart';
import '../repositories/reading_progress_repository.dart';

class ResumePointer {
  final String chapterId;
  final String? chapterVersionId;
  final int flutterPageIndex; // 0-based
  final int serverPageIndex; // 1-based
  final double progressPercentage;
  final double scrollPosition;
  final String? anchorBlockId;
  final int? textOffset;
  final bool isFromLocal;

  const ResumePointer({
    required this.chapterId,
    this.chapterVersionId,
    required this.flutterPageIndex,
    required this.serverPageIndex,
    required this.progressPercentage,
    required this.scrollPosition,
    this.anchorBlockId,
    this.textOffset,
    required this.isFromLocal,
  });
}

/// Bộ điều phối tiến độ đọc truyện (ReadingProgressCoordinator):
/// 1. Ghi Local Checkpoint tức thì (SharedPreferences) để bảo vệ dữ liệu khi kill app.
/// 2. Hydration canonical server epoch trước khi enable server write session (Zero-fallback).
/// 3. Debounce đồng bộ lên server (1.5s) khi người đọc đang cuộn liên tục.
/// 4. Session generation guard chống stale hydration race.
/// 5. Phân giải ResumePointer bằng hàm thuần túy resolveResumePointerFrom.
/// 6. Active reading timer (Stopwatch), per-chapter reward in-flight guard và canonical serverDateVN daily cap suppression.
class ReadingProgressCoordinator with WidgetsBindingObserver {
  final ReadingProgressRepository _repository;
  final GamificationRepository? _gamificationRepository;
  final Duration debounceDuration;

  Timer? _debounceTimer;
  PendingReadingProgress? _pendingDraft;

  int _sessionGeneration = 0;
  String? _activeStoryId;
  bool _isServerSyncEnabled = false;
  bool _networkSideEffectsEnabled = true;
  bool _disposed = false;

  // Active reading tracking & Gamification Daily Cap Invariants
  Stopwatch? _activeReadingStopwatch;
  String? _currentChapterId;
  bool _isChapterReady = false;
  final Set<String> _rewardedChapters = {};
  final Set<String> _rewardingChapters = {};
  String? _dailyReadCapReachedDate;
  String? _currentServerDateVN;
  Timer? _midnightTimer;

  ReadingProgressCoordinator({
    required ReadingProgressRepository repository,
    GamificationRepository? gamificationRepository,
    this.debounceDuration = const Duration(milliseconds: 1500),
    bool networkSideEffectsEnabled = true,
  })  : _repository = repository,
        _gamificationRepository = gamificationRepository,
        _networkSideEffectsEnabled = networkSideEffectsEnabled;

  /// Đăng ký lắng nghe vòng đời ứng dụng và hẹn giờ qua nửa đêm VN
  void init() {
    WidgetsBinding.instance.addObserver(this);
    _scheduleMidnightCheck();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      flush();
      _activeReadingStopwatch?.stop();
    } else if (state == AppLifecycleState.resumed) {
      if (_isChapterReady) {
        _activeReadingStopwatch?.start();
      }
      _checkAndHandleDateRollover();
    }
  }

  void _scheduleMidnightCheck([int? delaySeconds]) {
    _midnightTimer?.cancel();
    if (_disposed) return;

    Duration delay;
    if (delaySeconds != null && delaySeconds > 0) {
      delay = Duration(seconds: delaySeconds + 1);
    } else {
      // Local clock được dùng CHỈ NHƯ WAKE-UP HINT để đánh thức timer,
      // tuyệt đối không được promote thành canonical server date.
      final nowUtc = DateTime.now().toUtc();
      final nowVn = nowUtc.add(const Duration(hours: 7));
      final tomorrowVn = DateTime.utc(nowVn.year, nowVn.month, nowVn.day + 1);
      final durationUntilMidnight = tomorrowVn.difference(
        DateTime.utc(nowVn.year, nowVn.month, nowVn.day, nowVn.hour, nowVn.minute, nowVn.second),
      );
      delay = durationUntilMidnight + const Duration(seconds: 1);
    }

    _midnightTimer = Timer(delay, () {
      if (!_disposed) {
        _checkAndHandleDateRollover();
        _scheduleMidnightCheck();
      }
    });
  }

  /// Fail-closed date rollover: chỉ cập nhật serverDateVN khi server trả về thành công.
  /// Tuyệt đối KHÔNG fallback về local clock DateTime.now() khi offline hoặc gặp lỗi!
  Future<void> _checkAndHandleDateRollover() async {
    if (!_networkSideEffectsEnabled) return;
    final gamificationRepo = _gamificationRepository;
    if (gamificationRepo == null) return;

    try {
      final prog = await gamificationRepo.getProgression(forceRefresh: true);
      updateServerDateVN(prog.serverDateVN);
      if (prog.secondsUntilNextCheckin > 0) {
        _scheduleMidnightCheck(prog.secondsUntilNextCheckin);
      }
    } catch (_) {
      // Fail-closed: Giữ nguyên canonical state hiện tại.
      // KHÔNG update từ DateTime.now().
    }
  }

  @visibleForTesting
  Future<void> checkAndHandleDateRolloverForTesting() =>
      _checkAndHandleDateRollover();

  bool get isServerSyncEnabled => _isServerSyncEnabled;
  bool get networkSideEffectsEnabled => _networkSideEffectsEnabled;

  void setNetworkSideEffectsEnabled(bool enabled) {
    _networkSideEffectsEnabled = enabled;
  }

  PendingReadingProgress? get pendingDraft => _pendingDraft;
  Set<String> get rewardedChapters => Set.unmodifiable(_rewardedChapters);
  Set<String> get rewardingChapters => Set.unmodifiable(_rewardingChapters);
  String? get dailyReadCapReachedDate => _dailyReadCapReachedDate;
  String? get currentServerDateVN => _currentServerDateVN;
  int get currentActiveReadingDurationSeconds =>
      _activeReadingStopwatch?.elapsed.inSeconds ?? 0;
  bool get isChapterReady => _isChapterReady;

  void setActiveReadingStopwatchForTesting(Stopwatch stopwatch) {
    _activeReadingStopwatch = stopwatch;
  }

  void setRewardedChaptersForTesting(Iterable<String> chapters) {
    _rewardedChapters.addAll(chapters);
  }

  void setDailyReadCapReachedDateForTesting(String? date) {
    _dailyReadCapReachedDate = date;
  }

  void setCurrentServerDateVNForTesting(String? date) {
    _currentServerDateVN = date;
  }

  /// Hook khi Chapter đã nạp xong và ReaderSessionController ở trạng thái ready
  void onChapterReady(String chapterId) {
    if (_currentChapterId != chapterId) {
      _currentChapterId = chapterId;
      _activeReadingStopwatch?.reset();
      _activeReadingStopwatch?.stop();
      _activeReadingStopwatch = Stopwatch()..start();
    } else {
      _activeReadingStopwatch?.start();
    }
    _isChapterReady = true;
  }

  /// Cập nhật serverDateVN khi hydrate hoặc khi sang ngày mới
  void updateServerDateVN(String serverDateVN) {
    if (_currentServerDateVN != serverDateVN) {
      _currentServerDateVN = serverDateVN;
      // Sang ngày mới -> reset suppression
      if (_dailyReadCapReachedDate != null && _dailyReadCapReachedDate != serverDateVN) {
        _dailyReadCapReachedDate = null;
      }
    }
  }

  void resetDailyCapSuppression() {
    _dailyReadCapReachedDate = null;
  }

  /// Khởi tạo phiên đọc cho một bộ truyện:
  /// Hydrate canonical server epoch. Chỉ khi thành công mới bật server sync.
  Future<void> startSession(String storyId) async {
    final generation = ++_sessionGeneration;
    _activeStoryId = storyId;
    _isServerSyncEnabled = false;

    // P0.1 Global Zero-Network: Không hydrate epoch hay kích hoạt network khi side effects bị tắt
    if (!_networkSideEffectsEnabled) {
      return;
    }

    try {
      await _repository.ensureServerEpoch(storyId);

      if (_disposed ||
          generation != _sessionGeneration ||
          _activeStoryId != storyId) {
        return;
      }

      _isServerSyncEnabled = true;

      // P0.2 & P0.3 Durable Replay Protocol (Phase 5D.5):
      // Nếu RAM chưa có _pendingDraft (ví dụ khi app bị kill đột ngột sau khi đọc offline),
      // đọc checkpoint cục bộ trên đĩa để replay với canonical epoch vừa hydrate.
      if (_pendingDraft == null) {
        try {
          final localCheckpoint = await _repository.getLocalCheckpoint(storyId);
          // Gate 12: Chỉ replay khi checkpoint là dirty (chưa từng sync hoặc có thay đổi mới)
          if (localCheckpoint != null && localCheckpoint.isDirty) {
            ReadingProgressResponse? serverProgress;
            try {
              serverProgress = _repository.getCachedServerProgress(storyId);
            } catch (_) {}
            final serverEpoch = _repository.getCachedServerEpoch(storyId);
            final serverTime = serverProgress?.updatedAt ?? DateTime.fromMillisecondsSinceEpoch(0);

            // Gate 10: Newer Server Progress Wins.
            // Local checkpoint CHỈ được replay nếu strictly newer hơn server.
            // Nếu server đã có tiến độ mới hơn (hoặc bằng), server wins, không ghi đè dù chapter/page khác!
            final isLocalStrictlyNewer = localCheckpoint.updatedAt.isAfter(serverTime);

            // Gate 11: Tombstone Epoch Anti-Resurrection Guard.
            // Nếu checkpoint được tạo dưới epoch N (baseWriteEpoch == N) nhưng server hiện tại đã là M != N
            // (ví dụ: lịch sử đã bị xóa trên server hoặc tăng epoch):
            // TUYỆT ĐỐI KHÔNG auto-promote hay rebind checkpoint cũ sang epoch mới!
            final isEpochSafe = localCheckpoint.baseWriteEpoch == null ||
                localCheckpoint.baseWriteEpoch == serverEpoch;

            if (isLocalStrictlyNewer && isEpochSafe) {
              _pendingDraft = PendingReadingProgress(
                storyId: localCheckpoint.storyId,
                chapterId: localCheckpoint.chapterId,
                chapterVersionId: localCheckpoint.chapterVersionId,
                readingMode: serverProgress?.readingMode ?? 'WEBTOON',
                pageIndex: localCheckpoint.pageIndex,
                progressPercentage: localCheckpoint.progressPercentage,
                scrollPosition: localCheckpoint.scrollPosition,
                anchorBlockId: localCheckpoint.anchorBlockId,
                textOffset: localCheckpoint.textOffset,
                baseWriteEpoch: localCheckpoint.baseWriteEpoch ?? serverEpoch,
              );
            }
          }
        } catch (_) {
          // Bỏ qua lỗi đọc checkpoint cục bộ để bảo vệ session đã hydrate epoch thành công
        }
      }

      // Nếu có pending draft -> schedule sync
      final draft = _pendingDraft;
      if (draft != null && draft.storyId == storyId) {
        _scheduleSyncForCurrentGeneration(generation, storyId);
      }
    } catch (_) {
      if (generation == _sessionGeneration) {
        _isServerSyncEnabled = false;
      }
    }
  }

  /// Gọi khi người dùng cuộn đến vị trí mới
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode = 'WEBTOON',
    required int flutterPageIndex,
    required double progressPercentage,
    required double scrollPosition,
    String? anchorBlockId,
    int? textOffset,
  }) {
    final currentEpoch =
        _isServerSyncEnabled ? _repository.getCachedServerEpoch(storyId) : null;

    final draft = PendingReadingProgress.fromFlutterIndex(
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      readingMode: readingMode,
      flutterPageIndex: flutterPageIndex,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
      anchorBlockId: anchorBlockId,
      textOffset: textOffset,
      baseWriteEpoch: currentEpoch,
    );

    _pendingDraft = draft;

    // 1. Ghi tức thì vào Local Checkpoint (User-scoped, không phụ thuộc mạng)
    _repository.saveLocalCheckpoint(
      LocalReadingCheckpoint(
        storyId: storyId,
        chapterId: chapterId,
        chapterVersionId: chapterVersionId,
        pageIndex: draft.pageIndex, // 1-based
        progressPercentage: progressPercentage,
        scrollPosition: scrollPosition,
        anchorBlockId: anchorBlockId,
        textOffset: textOffset,
        updatedAt: DateTime.now(),
        isDirty: true,
        baseWriteEpoch: currentEpoch,
      ),
    );

    // 2. Thiết lập debounce sync lên server nếu write session đã bật và network side effects enabled
    if (_networkSideEffectsEnabled && _isServerSyncEnabled && _activeStoryId == storyId) {
      _scheduleSyncForCurrentGeneration(_sessionGeneration, storyId);
    }

    // 3. Đánh giá điều kiện thưởng EXP đọc chương (Phase 5C.5) - Chặn 100% khi offline (P0.1)
    if (_networkSideEffectsEnabled) {
      _evaluateReadingReward(
        chapterId: chapterId,
        progressPercentage: progressPercentage,
      );
    }
  }

  void _evaluateReadingReward({
    required String chapterId,
    required double progressPercentage,
  }) {
    if (!_networkSideEffectsEnabled) return; // P0.1 Global Zero-Network Guard
    final gamificationRepo = _gamificationRepository;
    if (gamificationRepo == null) return;
    if (!_isChapterReady || _currentChapterId != chapterId) return;

    final durationSeconds = _activeReadingStopwatch?.elapsed.inSeconds ?? 0;
    if (durationSeconds < 45 || progressPercentage < 80.0) return;

    // Daily Cap Suppression: Fail-closed theo canonical server date SSoT
    // Tuyệt đối không fallback về local clock; suppression chỉ được clear khi server xác nhận ngày mới
    if (_dailyReadCapReachedDate != null &&
        _dailyReadCapReachedDate == _currentServerDateVN) {
      return;
    }

    if (_rewardedChapters.contains(chapterId) ||
        _rewardingChapters.contains(chapterId)) {
      return;
    }

    _triggerReward(
      chapterId: chapterId,
      durationSeconds: durationSeconds,
      progressPercentage: progressPercentage,
    );
  }

  Future<void> _triggerReward({
    required String chapterId,
    required int durationSeconds,
    required double progressPercentage,
  }) async {
    final gamificationRepo = _gamificationRepository;
    if (gamificationRepo == null) return;
    if (_rewardingChapters.contains(chapterId)) return;

    _rewardingChapters.add(chapterId);

    try {
      final res = await gamificationRepo.rewardReadChapter(
        chapterId: chapterId,
        readingDurationSeconds: durationSeconds,
        progressPercentage: progressPercentage,
      );

      // Cập nhật SSoT serverDateVN trực tiếp từ API response
      updateServerDateVN(res.serverDateVN);

      if (res.earnedExp > 0 || res.reason == 'ALREADY_REWARDED') {
        _rewardedChapters.add(chapterId);
      } else if (res.reason == 'DAILY_CAP_REACHED') {
        // TUYỆT ĐỐI KHÔNG thêm chapterId vào _rewardedChapters!
        // Lưu suppression bind chính xác vào serverDateVN từ API response
        _dailyReadCapReachedDate = res.serverDateVN;
      }
    } catch (_) {
      // Best-effort network failure
    } finally {
      _rewardingChapters.remove(chapterId);
    }
  }

  void _scheduleSyncForCurrentGeneration(int generation, String storyId) {
    _debounceTimer?.cancel();
    final localGen = _repository.getLocalGeneration(storyId);

    _debounceTimer = Timer(debounceDuration, () {
      if (_disposed ||
          generation != _sessionGeneration ||
          _activeStoryId != storyId) {
        return;
      }
      if (localGen != _repository.getLocalGeneration(storyId)) {
        return; // Đã bị invalidate
      }
      _syncToServer(storyId);
    });
  }

  Future<void> _syncToServer(String storyId) async {
    if (!_networkSideEffectsEnabled) return;
    final draft = _pendingDraft;
    if (draft == null || draft.storyId != storyId) return;

    final epoch = _repository.getCachedServerEpoch(storyId);
    if (epoch == null || !_isServerSyncEnabled) return; // Fail closed

    // P0.2 Gate 11 Anti-Resurrection Guard:
    // Nếu draft có baseWriteEpoch và baseWriteEpoch != epoch hiện tại:
    // Drop draft để ngăn chặn zombie resurrection!
    if (draft.baseWriteEpoch != null && draft.baseWriteEpoch != epoch) {
      _pendingDraft = null;
      return;
    }

    // Materialize draft thành immutable network payload với canonical writeEpoch
    final payload = ReadingProgressPayload.fromDraft(draft, writeEpoch: epoch);

    try {
      await _repository.saveProgress(payload);
      if (_pendingDraft == draft) {
        _pendingDraft = null;
      }
      // Gate 12: Đánh dấu checkpoint cục bộ đã sync (isDirty = false)
      // Để khi restart app hoặc mở lại không bị duplicate replay
      final currentLocal = await _repository.getLocalCheckpoint(storyId);
      if (currentLocal != null &&
          currentLocal.chapterId == payload.chapterId &&
          currentLocal.pageIndex == payload.pageIndex) {
        await _repository.saveLocalCheckpoint(
          currentLocal.copyWith(isDirty: false, baseWriteEpoch: epoch),
        );
      }
    } on StaleWriteEpochException {
      // P0.4: Drop stale payload, tắt server sync, không bao giờ promote retry!
      if (_pendingDraft == draft) {
        _pendingDraft = null;
      }
      _isServerSyncEnabled = false;
    } catch (_) {
      // Giữ _pendingDraft để lần flush/retry kế tiếp
    }
  }

  /// Đồng bộ khẩn cấp lên server (khi pause/inactive/thoát reader)
  Future<void> flush() async {
    _debounceTimer?.cancel();
    _debounceTimer = null;
    if (!_networkSideEffectsEnabled) return;
    final storyId = _activeStoryId;
    if (storyId != null) {
      await _syncToServer(storyId);
    }
  }

  /// Hàm thuần túy đối chiếu Local Checkpoint vs Server Progress (Khử duplicate GET)
  ResumePointer? resolveResumePointerFrom({
    required LocalReadingCheckpoint? local,
    required ReadingProgressResponse? server,
  }) {
    final hasLocal = local != null && local.chapterId.isNotEmpty;
    final hasServer = server != null && server.hasProgress && server.chapterId != null;

    if (!hasLocal && !hasServer) {
      return null;
    }

    if (hasLocal && !hasServer) {
      return ResumePointer(
        chapterId: local.chapterId,
        chapterVersionId: local.chapterVersionId,
        flutterPageIndex: local.flutterPageIndex,
        serverPageIndex: local.pageIndex,
        progressPercentage: local.progressPercentage,
        scrollPosition: local.scrollPosition,
        anchorBlockId: local.anchorBlockId,
        textOffset: local.textOffset,
        isFromLocal: true,
      );
    }

    if (!hasLocal && hasServer) {
      return ResumePointer(
        chapterId: server.chapterId!,
        chapterVersionId: server.chapterVersionId,
        flutterPageIndex: server.flutterPageIndex,
        serverPageIndex: server.pageIndex,
        progressPercentage: server.progressPercentage,
        scrollPosition: server.scrollPosition,
        anchorBlockId: server.anchorBlockId,
        textOffset: server.textOffset,
        isFromLocal: false,
      );
    }

    // Có cả 2: So sánh updatedAt
    final localTime = local!.updatedAt;
    final serverTime =
        server!.updatedAt ?? DateTime.fromMillisecondsSinceEpoch(0);

    if (localTime.isAfter(serverTime)) {
      return ResumePointer(
        chapterId: local.chapterId,
        chapterVersionId: local.chapterVersionId,
        flutterPageIndex: local.flutterPageIndex,
        serverPageIndex: local.pageIndex,
        progressPercentage: local.progressPercentage,
        scrollPosition: local.scrollPosition,
        anchorBlockId: local.anchorBlockId,
        textOffset: local.textOffset,
        isFromLocal: true,
      );
    } else {
      return ResumePointer(
        chapterId: server.chapterId!,
        chapterVersionId: server.chapterVersionId,
        flutterPageIndex: server.flutterPageIndex,
        serverPageIndex: server.pageIndex,
        progressPercentage: server.progressPercentage,
        scrollPosition: server.scrollPosition,
        anchorBlockId: server.anchorBlockId,
        textOffset: server.textOffset,
        isFromLocal: false,
      );
    }
  }

  /// Tiện ích lấy ResumePointer khi gọi độc lập
  Future<ResumePointer?> resolveResumePointer(String storyId) async {
    final localFuture = _repository.getLocalCheckpoint(storyId);
    final serverFuture = () async {
      try {
        return await _repository.getProgress(storyId);
      } catch (_) {
        return null;
      }
    }();

    final results = await Future.wait([localFuture, serverFuture]);
    final local = results[0] as LocalReadingCheckpoint?;
    final server = results[1] as ReadingProgressResponse?;

    return resolveResumePointerFrom(local: local, server: server);
  }

  /// Dọn dẹp listener và huỷ timer
  void dispose() {
    _disposed = true;
    flush();
    WidgetsBinding.instance.removeObserver(this);
    _debounceTimer?.cancel();
    _midnightTimer?.cancel();
    _activeReadingStopwatch?.stop();
  }
}
