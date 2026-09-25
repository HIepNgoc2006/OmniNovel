import 'package:flutter/widgets.dart';
import '../../offline/services/offline_content_resolver.dart';
import '../models/reader_models.dart';
import '../repositories/chapter_repository.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_state.dart';
import 'reader_window_policy.dart';

class ReaderSessionController extends ChangeNotifier {
  final ChapterRepository _chapterRepository;
  final ReaderImageCacheCoordinator _imageCacheCoordinator;
  final OfflineContentResolver? _offlineContentResolver;

  ReaderSessionState _state = const ReaderSessionState();
  ReaderSessionState get state => _state;

  ReaderSessionController({
    required ChapterRepository chapterRepository,
    required ReaderImageCacheCoordinator imageCacheCoordinator,
    OfflineContentResolver? offlineContentResolver,
  })  : _chapterRepository = chapterRepository,
        _imageCacheCoordinator = imageCacheCoordinator,
        _offlineContentResolver = offlineContentResolver;

  /// Nạp thông tin chapter và khởi tạo session đọc
  /// (Ưu tiên giải quyết offline payload trước mọi side effect mạng)
  Future<void> loadChapter(
    String chapterId, {
    String? versionId,
    int initialPageIndex = 0,
  }) async {
    _state = _state.copyWith(status: ReaderStatus.loading, errorMessage: null);
    notifyListeners();

    try {
      // 1. P0.2: Giải quyết ngoại tuyến trước mọi network request
      ResolvedOfflineChapter? offlineResult;
      if (_offlineContentResolver != null) {
        try {
          offlineResult = await _offlineContentResolver.resolveChapter(
            chapterId: chapterId,
            preferredVersionId: versionId,
          );
        } catch (_) {
          offlineResult = null;
        }
      }

      final ChapterDetail detail;
      final ReaderTransportMode mode;

      if (offlineResult != null) {
        // Cài đặt chế độ ngoại tuyến: đăng ký local files vào image cache coordinator
        _imageCacheCoordinator.registerLocalAssetFiles(offlineResult.localAssetFiles);
        detail = offlineResult.chapterDetail;
        mode = ReaderTransportMode.offline;
      } else {
        // Fallback sang online path: dọn local files và gọi ChapterRepository qua mạng
        _imageCacheCoordinator.clearLocalAssetFiles();
        detail = await _chapterRepository.getChapterDetail(
          chapterId,
          versionId: versionId,
        );
        mode = ReaderTransportMode.online;
      }

      final totalPages = detail.pages.length;
      final policy = ReaderWindowPolicy(totalPageCount: totalPages);
      final clampedInitial = initialPageIndex.clamp(0, totalPages > 0 ? totalPages - 1 : 0);
      final window = policy.calculateSingleFocus(clampedInitial);

      final initialProgress = totalPages <= 1
          ? 100.0
          : (((clampedInitial + 1) / totalPages) * 100).clamp(0.0, 100.0);

      _state = _state.copyWith(
        status: ReaderStatus.ready,
        transportMode: mode,
        chapterDetail: detail,
        resolvedOfflineChapter: offlineResult,
        focusedPageIndex: clampedInitial,
        visibleStartIndex: clampedInitial,
        visibleEndIndex: clampedInitial,
        progressPercentage: initialProgress,
        windowResult: window,
      );
      notifyListeners();
    } catch (e) {
      _state = _state.copyWith(
        status: ReaderStatus.error,
        errorMessage: e.toString(),
      );
      notifyListeners();
    }
  }

  /// Cập nhật dải trang đang hiển thị trong viewport và kích hoạt chính sách 3 vùng
  void updateVisibleRange({
    required BuildContext context,
    required int startIndex,
    required int endIndex,
    int? focusedIndex,
    required double scrollOffset,
    required double maxScrollOffset,
    int? targetWidth,
  }) {
    if (_state.status != ReaderStatus.ready || _state.totalPages == 0) return;

    final actualFocused = (focusedIndex ?? startIndex).clamp(0, _state.totalPages - 1);
    final policy = ReaderWindowPolicy(totalPageCount: _state.totalPages);
    final window = policy.calculateWindow(
      visibleStartIndex: startIndex,
      visibleEndIndex: endIndex,
    );

    final progress = _state.totalPages <= 1
        ? 100.0
        : (maxScrollOffset > 0
            ? ((scrollOffset / maxScrollOffset) * 100).clamp(0.0, 100.0)
            : (((actualFocused + 1) / _state.totalPages) * 100).clamp(0.0, 100.0));

    // Evict distant bitmaps ngay lập tức khỏi RAM
    _imageCacheCoordinator.evictDistantBitmaps(
      pages: _state.pages,
      distantIndexes: window.distantIndexes,
    );

    // Prefetch adjacent pages trong background có kiểm soát memory budget
    _imageCacheCoordinator.prefetchAdjacentPages(
      context: context,
      pages: _state.pages,
      adjacentIndexes: window.adjacentIndexes,
      targetWidth: targetWidth,
    );

    _state = _state.copyWith(
      visibleStartIndex: startIndex,
      visibleEndIndex: endIndex,
      focusedPageIndex: actualFocused,
      progressPercentage: progress,
      scrollPosition: scrollOffset,
      windowResult: window,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    _imageCacheCoordinator.dispose();
    super.dispose();
  }
}
