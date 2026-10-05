import '../models/library_models.dart';

/// DTO lệnh đột biến Bookmark mang đầy đủ metadata của truyện.
/// Đảm bảo Guest Adapter có đủ thông tin lưu vào SQLite mà không cần fake metadata hay lookup ngược.
class BookmarkMutation {
  final String storyId;
  final bool isBookmarked;
  final String title;
  final String? slug;
  final String? coverUrl;

  const BookmarkMutation({
    required this.storyId,
    required this.isBookmarked,
    required this.title,
    this.slug,
    this.coverUrl,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is BookmarkMutation &&
          runtimeType == other.runtimeType &&
          storyId == other.storyId &&
          isBookmarked == other.isBookmarked &&
          title == other.title &&
          slug == other.slug &&
          coverUrl == other.coverUrl;

  @override
  int get hashCode => Object.hash(storyId, isBookmarked, title, slug, coverUrl);
}

/// Port trừu tượng quản lý Thư viện ở tầng UI.
/// Không kế thừa bất kỳ implementation cụ thể nào của Account hay Guest.
abstract class LibraryAccess {
  /// Lấy trạng thái bookmark của truyện.
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId);

  /// Thêm hoặc gỡ bookmark bằng [BookmarkMutation] mang đầy đủ metadata.
  Future<BookmarkStatusResponse> setBookmark(BookmarkMutation mutation);

  /// Đọc snapshot bookmarks cục bộ theo status (Stale-While-Revalidate).
  List<BookmarkedStoryItem> getCachedBookmarks({String? status});

  /// Fetch danh sách bookmarks phân trang.
  Future<PaginatedBookmarksResponse> fetchBookmarks({
    int page = 1,
    int limit = 20,
    String? status,
  });

  /// Đọc snapshot lịch sử đọc cục bộ (Stale-While-Revalidate).
  List<ReadingHistoryItem> getCachedHistory();

  /// Fetch danh sách lịch sử đọc phân trang.
  Future<PaginatedReadingHistoryResponse> fetchHistory({
    int page = 1,
    int limit = 20,
    bool updateCache = true,
  });

  /// Lấy snapshot Continue Reading đã lưu.
  ReadingHistoryItem? getCachedContinueReading();

  /// Lấy item đọc tiếp gần nhất (Hero Card).
  Future<ReadingHistoryItem?> getContinueReading();

  /// Xóa lịch sử đọc của 1 truyện.
  Future<void> deleteStoryHistory(String storyId);

  /// Xóa toàn bộ lịch sử đọc.
  Future<void> clearAllHistory();
}
