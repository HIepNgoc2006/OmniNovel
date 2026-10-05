import '../../../core/identity/active_scope_coordinator.dart';
import '../../../core/storage/local_library_dao.dart';
import '../../../core/storage/local_library_models.dart';

/// Repository quản lý Thư viện cho Khách (Guest) trên Mobile.
///
/// Invariant 1: Tự động inject `ownerScope` từ `ActiveScopeCoordinator`.
/// Invariant 2: Chỉ chấp nhận `guest:*`. Mọi scope `account:*`, `device:*`, rỗng đều ném [InvalidGuestScopeException].
/// Invariant 3: Zero network (không gọi ApiClient), Zero SharedPreferences.
class GuestLibraryRepository {
  final ActiveScopeCoordinator _coordinator;
  final LocalLibraryDao _dao;

  GuestLibraryRepository({
    required ActiveScopeCoordinator coordinator,
    required LocalLibraryDao dao,
  })  : _coordinator = coordinator,
        _dao = dao;

  /// Đợi active scope resolve (chống race condition khi khởi động app);
  /// sau đó ném [InvalidGuestScopeException] nếu scope không phải Guest (`guest:*`).
  Future<String> _getGuestScope() async {
    final scope = await _coordinator.waitForResolvedScope();
    if (!scope.startsWith('guest:') || scope.length <= 6) {
      throw InvalidGuestScopeException(
        'Không thể thực hiện tác vụ Guest Library với scope không phải guest ("$scope").',
      );
    }
    return scope;
  }

  // ==================== BOOKMARKS ====================

  /// Kiểm tra xem truyện đã được lưu vào thư viện Guest chưa.
  Future<bool> isBookmarked(String storyId) async {
    final scope = await _getGuestScope();
    return _dao.isBookmarked(ownerScope: scope, storyId: storyId);
  }

  /// Lấy chi tiết một dấu trang của Guest.
  Future<LocalBookmark?> getBookmark(String storyId) async {
    final scope = await _getGuestScope();
    return _dao.getBookmark(ownerScope: scope, storyId: storyId);
  }

  /// Thêm hoặc cập nhật dấu trang trong thư viện Guest.
  /// Repository tự động gán `ownerScope` từ coordinator hiện tại.
  Future<void> saveBookmark({
    required String storyId,
    required String title,
    String? slug,
    String? coverUrl,
    DateTime? createdAt,
  }) async {
    final scope = await _getGuestScope();
    final bookmark = LocalBookmark(
      ownerScope: scope,
      storyId: storyId,
      title: title,
      slug: slug,
      coverUrl: coverUrl,
      createdAt: createdAt ?? DateTime.now().toUtc(),
    );
    await _dao.saveBookmark(bookmark);
  }

  /// Xóa dấu trang khỏi thư viện Guest.
  Future<void> deleteBookmark(String storyId) async {
    final scope = await _getGuestScope();
    await _dao.deleteBookmark(ownerScope: scope, storyId: storyId);
  }

  /// Lấy toàn bộ danh sách dấu trang của Guest hiện tại.
  Future<List<LocalBookmark>> getBookmarks() async {
    final scope = await _getGuestScope();
    return _dao.getBookmarks(ownerScope: scope);
  }

  // ==================== READING HISTORY ====================

  /// Lấy toàn bộ lịch sử đọc của Guest hiện tại.
  Future<List<LocalReadingHistory>> getHistory() async {
    final scope = await _getGuestScope();
    return _dao.getHistory(ownerScope: scope);
  }

  /// Xóa toàn bộ lịch sử đọc và tiến độ đọc của một truyện trong phạm vi Guest hiện tại.
  /// Invariant: Bookmark hoàn toàn không bị ảnh hưởng.
  Future<void> deleteStoryHistory(String storyId) async {
    final scope = await _getGuestScope();
    await _dao.deleteStoryReadingState(ownerScope: scope, storyId: storyId);
  }

  /// Xóa sạch toàn bộ lịch sử đọc và tiến độ đọc của Guest hiện tại.
  /// Invariant: Bookmark hoàn toàn không bị ảnh hưởng.
  Future<void> clearAllHistory() async {
    final scope = await _getGuestScope();
    await _dao.clearAllReadingState(ownerScope: scope);
  }

  /// Lấy danh sách ID các chương mà Guest đã đọc đạt ngưỡng threshold (mặc định 80%).
  Future<List<String>> getReadChapterIds(
    String storyId, {
    double threshold = 80.0,
  }) async {
    final scope = await _getGuestScope();
    return _dao.getReadChapterIds(
      ownerScope: scope,
      storyId: storyId,
      threshold: threshold,
    );
  }
}
