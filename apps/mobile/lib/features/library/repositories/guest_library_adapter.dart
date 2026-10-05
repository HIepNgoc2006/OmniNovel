import '../../../core/storage/local_library_models.dart';
import '../models/library_models.dart';
import 'guest_library_repository.dart';
import 'library_access.dart';

/// Adapter kết nối [LibraryAccess] với [GuestLibraryRepository] dành cho Khách (Guest).
///
/// Invariants:
/// 1. Zero Network: Không gọi bất kỳ API hay network client nào.
/// 2. Metadata Preservation: Dùng đầy đủ title/slug/coverUrl từ [BookmarkMutation] để lưu [LocalBookmark].
/// 3. In-memory Snapshot: Giữ snapshot từ lần đọc SQLite gần nhất để phục vụ Stale-While-Revalidate.
class GuestLibraryAdapter implements LibraryAccess {
  final GuestLibraryRepository _guestRepository;
  List<BookmarkedStoryItem> _cachedBookmarks = [];
  List<ReadingHistoryItem> _cachedHistory = [];

  GuestLibraryAdapter({required GuestLibraryRepository guestRepository})
      : _guestRepository = guestRepository;

  @override
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId) async {
    final isBookmarked = await _guestRepository.isBookmarked(storyId);
    return BookmarkStatusResponse(isBookmarked: isBookmarked);
  }

  @override
  Future<BookmarkStatusResponse> setBookmark(BookmarkMutation mutation) async {
    if (mutation.isBookmarked) {
      await _guestRepository.saveBookmark(
        storyId: mutation.storyId,
        title: mutation.title,
        slug: mutation.slug,
        coverUrl: mutation.coverUrl,
      );
    } else {
      await _guestRepository.deleteBookmark(mutation.storyId);
    }
    return BookmarkStatusResponse(isBookmarked: mutation.isBookmarked);
  }

  @override
  List<BookmarkedStoryItem> getCachedBookmarks({String? status}) {
    return List.unmodifiable(_cachedBookmarks);
  }

  @override
  Future<PaginatedBookmarksResponse> fetchBookmarks({
    int page = 1,
    int limit = 20,
    String? status,
  }) async {
    final localBookmarks = await _guestRepository.getBookmarks();
    final allItems = localBookmarks.map((b) => _toBookmarkedStoryItem(b)).toList();

    final totalItems = allItems.length;
    final totalPages = totalItems == 0 ? 1 : (totalItems / limit).ceil();
    final startIndex = (page - 1) * limit;
    final pagedData = startIndex >= totalItems
        ? <BookmarkedStoryItem>[]
        : allItems.skip(startIndex).take(limit).toList();

    if (page == 1) {
      _cachedBookmarks = allItems;
    }

    return PaginatedBookmarksResponse(
      data: pagedData,
      pagination: PaginationMeta(
        page: page,
        limit: limit,
        totalItems: totalItems,
        totalPages: totalPages,
      ),
    );
  }

  @override
  List<ReadingHistoryItem> getCachedHistory() {
    return List.unmodifiable(_cachedHistory);
  }

  @override
  Future<PaginatedReadingHistoryResponse> fetchHistory({
    int page = 1,
    int limit = 20,
    bool updateCache = true,
  }) async {
    final localHistory = await _guestRepository.getHistory();
    final allItems = localHistory.map((h) => _toReadingHistoryItem(h)).toList();

    final totalItems = allItems.length;
    final totalPages = totalItems == 0 ? 1 : (totalItems / limit).ceil();
    final startIndex = (page - 1) * limit;
    final pagedData = startIndex >= totalItems
        ? <ReadingHistoryItem>[]
        : allItems.skip(startIndex).take(limit).toList();

    if (page == 1 && updateCache) {
      _cachedHistory = allItems;
    }

    return PaginatedReadingHistoryResponse(
      data: pagedData,
      pagination: PaginationMeta(
        page: page,
        limit: limit,
        totalItems: totalItems,
        totalPages: totalPages,
      ),
    );
  }

  @override
  ReadingHistoryItem? getCachedContinueReading() {
    if (_cachedHistory.isNotEmpty) return _cachedHistory.first;
    return null;
  }

  @override
  Future<ReadingHistoryItem?> getContinueReading() async {
    final history = await _guestRepository.getHistory();
    if (history.isEmpty) return null;
    return _toReadingHistoryItem(history.first);
  }

  @override
  Future<void> deleteStoryHistory(String storyId) async {
    await _guestRepository.deleteStoryHistory(storyId);
    _cachedHistory.removeWhere((item) => item.story.id == storyId);
  }

  @override
  Future<void> clearAllHistory() async {
    await _guestRepository.clearAllHistory();
    _cachedHistory.clear();
  }

  // ==================== MAPPERS ====================

  BookmarkedStoryItem _toBookmarkedStoryItem(LocalBookmark b) {
    return BookmarkedStoryItem(
      story: LibraryStorySummary(
        id: b.storyId,
        title: b.title,
        slug: b.slug ?? '',
        coverUrl: b.coverUrl,
        mediaFormat: 'COMIC',
        status: 'ONGOING',
        totalChapters: 0,
      ),
      bookmarkedAt: b.createdAt,
      unreadChapterCount: 0,
    );
  }

  ReadingHistoryItem _toReadingHistoryItem(LocalReadingHistory h) {
    return ReadingHistoryItem(
      story: LibraryStorySummary(
        id: h.storyId,
        title: h.storyTitle,
        slug: h.storySlug ?? '',
        coverUrl: h.storyCoverUrl,
        mediaFormat: 'COMIC',
        status: 'ONGOING',
        totalChapters: 0,
      ),
      chapter: LibraryChapterSummary(
        id: h.chapterId,
        title: h.chapterTitle ?? '',
        chapterNumber: int.tryParse(h.chapterNumber) ?? 1,
      ),
      resume: ResumeSnapshot(
        chapterVersionId: h.chapterVersionId,
        readingMode: 'WEBTOON',
        progressPercentage: h.progressPercentage,
        scrollPosition: 0.0,
        pageIndex: 1,
        textOffset: 0,
      ),
      updatedAt: h.lastReadAt,
    );
  }
}
