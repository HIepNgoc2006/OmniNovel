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
  bool _disposed = false;

  // Active reading tracking & Gamification Daily Cap Invariants
  Stopwatch? _activeReadingStopwatch;
  String? _currentChapterId;
  bool _isChapterReady = false;
  final Set<String> _rewardedChapters = {};
  final Set<String> _rewardingChapters = {};
  String? _dailyReadCapReachedDate;
  String? _currentServerDateVN;

  ReadingProgressCoordinator({
    required ReadingProgressRepository repository,
    GamificationRepository? gamificationRepository,
    this.debounceDuration = const Duration(milliseconds: 1500),
  })  : _repository = repository,
        _gamificationRepository = gamificationRepository;

  /// Đăng ký lắng nghe vòng đời ứng dụng
  void init() {
    WidgetsBinding.instance.addObserver(this);
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
    }
  }

  bool get isServerSyncEnabled => _isServerSyncEnabled;
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

    try {
      await _repository.ensureServerEpoch(storyId);

      if (_disposed ||
          generation != _sessionGeneration ||
          _activeStoryId != storyId) {
        return;
      }

      _isServerSyncEnabled = true;

      // Nếu trong lúc chờ hydrate, user đã scroll tạo pending draft -> schedule sync
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
      ),
    );

    // 2. Thiết lập debounce sync lên server nếu write session đã bật
    if (_isServerSyncEnabled && _activeStoryId == storyId) {
      _scheduleSyncForCurrentGeneration(_sessionGeneration, storyId);
    }

    // 3. Đánh giá điều kiện thưởng EXP đọc chương (Phase 5C.5)
    _evaluateReadingReward(
      chapterId: chapterId,
      progressPercentage: progressPercentage,
    );
  }

  void _evaluateReadingReward({
    required String chapterId,
    required double progressPercentage,
  }) {
    final gamificationRepo = _gamificationRepository;
    if (gamificationRepo == null) return;
    if (!_isChapterReady || _currentChapterId != chapterId) return;

    final durationSeconds = _activeReadingStopwatch?.elapsed.inSeconds ?? 0;
    if (durationSeconds < 45 || progressPercentage < 80.0) return;

    // Daily Cap Suppression: Bỏ qua nếu ngày hôm nay đã chạm trần 100 EXP
    if (_currentServerDateVN != null &&
        _currentServerDateVN == _dailyReadCapReachedDate) {
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
      _currentServerDateVN = res.serverDateVN;

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
    final draft = _pendingDraft;
    if (draft == null || draft.storyId != storyId) return;

    final epoch = _repository.getCachedServerEpoch(storyId);
    if (epoch == null || !_isServerSyncEnabled) return; // Fail closed

    // Materialize draft thành immutable network payload với canonical writeEpoch
    final payload = ReadingProgressPayload.fromDraft(draft, writeEpoch: epoch);

    try {
      await _repository.saveProgress(payload);
      if (_pendingDraft == draft) {
        _pendingDraft = null;
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
    _activeReadingStopwatch?.stop();
  }
}
