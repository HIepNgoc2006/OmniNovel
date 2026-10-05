import '../../../core/identity/active_scope_coordinator.dart';
import '../../../core/storage/local_library_dao.dart';
import '../../../core/storage/local_library_models.dart';

/// Repository quản lý Tiến độ đọc & Phiên đọc cục bộ cho Khách (Guest) trên Mobile.
///
/// Invariant 1: Tự động inject `ownerScope` từ `ActiveScopeCoordinator`.
/// Invariant 2: Chỉ chấp nhận `guest:*`. Scope `account:*`, `device:*`, rỗng đều ném [InvalidGuestScopeException].
/// Invariant 3: Không network (không gọi ApiClient), không epoch server, không gamification.
/// Invariant 4: Atomic Reading Session (progress + history cùng commit hoặc rollback).
/// Invariant 5: Monotonic MAX history.
/// Invariant 6: Paged mode giữ nguyên canonical `pageIndex >= 1`, không mã hóa vào scrollPosition.
class GuestReadingProgressRepository {
  final ActiveScopeCoordinator _coordinator;
  final LocalLibraryDao _dao;

  GuestReadingProgressRepository({
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
        'Không thể thực hiện tác vụ Guest Reading Progress với scope không phải guest ("$scope").',
      );
    }
    return scope;
  }

  /// Lấy vị trí đọc canonical hiện tại của Guest cho một truyện.
  Future<LocalReadingProgress?> getProgress(String storyId) async {
    final scope = await _getGuestScope();
    return _dao.getProgress(ownerScope: scope, storyId: storyId);
  }

  /// Lưu tiến độ đọc tức thì (ghi đè checkpoint hiện tại).
  /// Tự động gán `ownerScope` từ guest coordinator hiện tại.
  Future<void> saveProgress(LocalReadingProgress progress) async {
    final scope = await _getGuestScope();
    final scopedProgress = progress.copyWith(ownerScope: scope);
    await _dao.saveProgress(scopedProgress);
  }

  /// Invariant 4 & 5: Ghi nhận phiên đọc hoàn chỉnh nguyên tử (Atomic Session).
  /// Đồng thời lưu `local_reading_progress` (vị trí hiện tại) và `local_reading_history` (snapshot chương).
  /// Lịch sử tự động duy trì tiến độ cao nhất đạt được (Monotonic MAX).
  Future<void> recordReadingSession({
    required LocalReadingProgress progress,
    required LocalReadingHistory history,
    Future<void> Function()? onBeforeCommitHook,
  }) async {
    final scope = await _getGuestScope();
    final scopedProgress = progress.copyWith(ownerScope: scope);
    final scopedHistory = history.copyWith(ownerScope: scope);

    await _dao.recordReadingSession(
      progress: scopedProgress,
      history: scopedHistory,
      onBeforeCommitHook: onBeforeCommitHook,
    );
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
