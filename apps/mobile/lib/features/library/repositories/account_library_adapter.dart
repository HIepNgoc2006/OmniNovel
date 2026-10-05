import '../models/library_models.dart';
import 'library_access.dart';
import 'library_repository.dart';

/// Adapter kết nối [LibraryAccess] với [LibraryRepository] dành cho tài khoản đã xác thực (Account).
class AccountLibraryAdapter implements LibraryAccess {
  final LibraryRepository _repository;

  AccountLibraryAdapter({required LibraryRepository repository})
      : _repository = repository;

  @override
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId) {
    return _repository.getBookmarkStatus(storyId);
  }

  @override
  Future<BookmarkStatusResponse> setBookmark(BookmarkMutation mutation) {
    return _repository.setBookmark(mutation.storyId, mutation.isBookmarked);
  }

  @override
  List<BookmarkedStoryItem> getCachedBookmarks({String? status}) {
    return _repository.getCachedBookmarks(status: status);
  }

  @override
  Future<PaginatedBookmarksResponse> fetchBookmarks({
    int page = 1,
    int limit = 20,
    String? status,
  }) {
    return _repository.fetchBookmarks(
      page: page,
      limit: limit,
      status: status,
    );
  }

  @override
  List<ReadingHistoryItem> getCachedHistory() {
    return _repository.getCachedHistory();
  }

  @override
  Future<PaginatedReadingHistoryResponse> fetchHistory({
    int page = 1,
    int limit = 20,
    bool updateCache = true,
  }) {
    return _repository.fetchHistory(
      page: page,
      limit: limit,
      updateCache: updateCache,
    );
  }

  @override
  ReadingHistoryItem? getCachedContinueReading() {
    return _repository.getCachedContinueReading();
  }

  @override
  Future<ReadingHistoryItem?> getContinueReading() {
    return _repository.getContinueReading();
  }

  @override
  Future<void> deleteStoryHistory(String storyId) {
    return _repository.deleteStoryHistory(storyId);
  }

  @override
  Future<void> clearAllHistory() {
    return _repository.clearAllHistory();
  }
}
