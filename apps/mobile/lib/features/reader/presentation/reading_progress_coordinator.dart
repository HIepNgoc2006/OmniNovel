import 'dart:async';
import 'package:flutter/widgets.dart';
import '../models/reading_progress_models.dart';
import '../repositories/reading_progress_repository.dart';

class ResumePointer {
  final String chapterId;
  final String? chapterVersionId;
  final int flutterPageIndex; // 0-based
  final int serverPageIndex;  // 1-based
  final double progressPercentage;
  final double scrollPosition;
  final bool isFromLocal;

  const ResumePointer({
    required this.chapterId,
    this.chapterVersionId,
    required this.flutterPageIndex,
    required this.serverPageIndex,
    required this.progressPercentage,
    required this.scrollPosition,
    required this.isFromLocal,
  });
}

/// Bộ điều phối tiến độ đọc truyện (ReadingProgressCoordinator):
/// 1. Ghi Local Checkpoint tức thì (SharedPreferences) để chống mất dữ liệu khi kill app.
/// 2. Debounce đồng bộ lên server (1.5s) khi người đọc đang cuộn liên tục.
/// 3. Khẩn cấp flush lên server khi app vào trạng thái paused / inactive hoặc khi thoát màn hình.
/// 4. Đối chiếu (Reconciliation) giữa Local Checkpoint và Server Progress để khôi phục chính xác nhất.
class ReadingProgressCoordinator with WidgetsBindingObserver {
  final ReadingProgressRepository _repository;
  final Duration debounceDuration;

  Timer? _debounceTimer;
  ReadingProgressPayload? _pendingPayload;

  ReadingProgressCoordinator({
    required ReadingProgressRepository repository,
    this.debounceDuration = const Duration(milliseconds: 1500),
  }) : _repository = repository;

  /// Đăng ký lắng nghe vòng đời ứng dụng
  void init() {
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.inactive) {
      flush();
    }
  }

  /// Gọi khi người dùng cuộn đến vị trí mới
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    required int flutterPageIndex,
    required double progressPercentage,
    required double scrollPosition,
  }) {

    final payload = ReadingProgressPayload.fromFlutterIndex(
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      flutterPageIndex: flutterPageIndex,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
    );

    _pendingPayload = payload;

    // 1. Ghi tức thì vào Local Checkpoint (không phụ thuộc mạng, an toàn tuyệt đối nếu kill app)
    _repository.saveLocalCheckpoint(
      LocalReadingCheckpoint(
        storyId: storyId,
        chapterId: chapterId,
        chapterVersionId: chapterVersionId,
        pageIndex: payload.pageIndex, // 1-based
        progressPercentage: progressPercentage,
        scrollPosition: scrollPosition,
        updatedAt: DateTime.now(),
      ),
    );

    // 2. Thiết lập debounce sync lên server
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounceDuration, () {
      _syncToServer();
    });
  }

  Future<void> _syncToServer() async {
    final payload = _pendingPayload;
    if (payload == null) return;

    try {
      await _repository.saveProgress(payload);
      if (_pendingPayload == payload) {
        _pendingPayload = null;
      }
    } catch (_) {
      // Giữ _pendingPayload để lần flush kế tiếp retry
    }
  }

  /// Đồng bộ khẩn cấp lên server (khi pause/inactive/thoát reader)
  Future<void> flush() async {
    _debounceTimer?.cancel();
    _debounceTimer = null;
    await _syncToServer();
  }

  /// Xác định điểm resume tối ưu bằng cách đối chiếu Local Checkpoint vs Server Progress
  Future<ResumePointer?> resolveResumePointer(String storyId) async {
    final localFuture = _repository.getLocalCheckpoint(storyId);
    final serverFuture = _repository.getProgress(storyId).catchError((_) {
      return const ReadingProgressResponse(storyId: '');
    });

    final results = await Future.wait([localFuture, serverFuture]);
    final local = results[0] as LocalReadingCheckpoint?;
    final server = results[1] as ReadingProgressResponse;

    final hasLocal = local != null && local.chapterId.isNotEmpty;
    final hasServer = server.hasProgress && server.chapterId != null;

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
        isFromLocal: false,
      );
    }

    // Có cả 2: So sánh updatedAt
    final localTime = local!.updatedAt;
    final serverTime = server.updatedAt ?? DateTime.fromMillisecondsSinceEpoch(0);

    if (localTime.isAfter(serverTime)) {
      // Local mới hơn (ví dụ vừa đọc xong thì kill app, request chưa kịp lên server)
      return ResumePointer(
        chapterId: local.chapterId,
        chapterVersionId: local.chapterVersionId,
        flutterPageIndex: local.flutterPageIndex,
        serverPageIndex: local.pageIndex,
        progressPercentage: local.progressPercentage,
        scrollPosition: local.scrollPosition,
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
        isFromLocal: false,
      );
    }
  }

  /// Dọn dẹp listener và huỷ timer
  void dispose() {
    flush();
    WidgetsBinding.instance.removeObserver(this);
    _debounceTimer?.cancel();
  }
}
