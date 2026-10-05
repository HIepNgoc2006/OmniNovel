import 'dart:async';
import '../../../core/storage/local_library_models.dart';
import 'guest_reading_progress_repository.dart';
import 'reading_session_access.dart';

/// Adapter kết nối [ReadingSessionAccess] với [GuestReadingProgressRepository] dành cho Khách (Guest).
///
/// Invariants:
/// 1. Zero Network: Không HTTP sync, không server epoch, không gamification API.
/// 2. Atomic Reading Session: Lưu đồng thời `LocalReadingProgress` và `LocalReadingHistory` vào SQLite v3.
/// 3. Debounce 1500ms: Tương đương coordinator của account để tránh I/O bão hòa khi cuộn nhanh.
class GuestReadingSessionAdapter implements ReadingSessionAccess {
  final GuestReadingProgressRepository _guestRepository;
  final Duration debounceDuration;

  Timer? _debounceTimer;
  LocalReadingProgress? _pendingProgress;
  LocalReadingHistory? _pendingHistory;
  bool _disposed = false;

  GuestReadingSessionAdapter({
    required GuestReadingProgressRepository guestRepository,
    this.debounceDuration = const Duration(milliseconds: 1500),
  }) : _guestRepository = guestRepository;

  @override
  Future<void> initSession({required String storyId}) async {
    // Không cần nạp server epoch hay hydrate network
  }

  @override
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
    String? storyTitle,
    String? storySlug,
    String? storyCoverUrl,
    String? chapterNumber,
    String? chapterTitle,
  }) {
    if (_disposed) return;

    final now = DateTime.now().toUtc();
    final canonicalPageIndex = flutterPageIndex >= 0 ? flutterPageIndex + 1 : 1;

    _pendingProgress = LocalReadingProgress(
      ownerScope: '', // Tự động gán bởi GuestReadingProgressRepository
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      readingMode: readingMode,
      progressPercentage: progressPercentage,
      scrollPosition: scrollPosition,
      pageIndex: canonicalPageIndex,
      anchorBlockId: anchorBlockId,
      textOffset: textOffset,
      updatedAt: now,
      deviceTimestamp: now,
    );

    _pendingHistory = LocalReadingHistory(
      ownerScope: '', // Tự động gán bởi GuestReadingProgressRepository
      storyId: storyId,
      chapterId: chapterId,
      chapterVersionId: chapterVersionId,
      storyTitle: storyTitle ?? 'Truyện',
      storySlug: storySlug,
      storyCoverUrl: storyCoverUrl,
      chapterNumber: chapterNumber ?? '1',
      chapterTitle: chapterTitle,
      progressPercentage: progressPercentage,
      lastReadAt: now,
    );

    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounceDuration, () {
      unawaited(flush());
    });
  }

  @override
  Future<void> flush() async {
    _debounceTimer?.cancel();
    final progress = _pendingProgress;
    final history = _pendingHistory;

    if (progress != null && history != null) {
      _pendingProgress = null;
      _pendingHistory = null;
      try {
        await _guestRepository.recordReadingSession(
          progress: progress,
          history: history,
        );
      } catch (_) {
        // Fail-safe ghi nhận lỗi cục bộ nếu cần
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _debounceTimer?.cancel();
    unawaited(flush());
  }
}
