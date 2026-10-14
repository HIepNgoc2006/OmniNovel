/// Bridge interface tách rời GuestClaimCoordinator khỏi ActiveScopeCoordinator (Task 4)
/// phục vụ Dependency Injection và kiểm thử độc lập.
abstract class ScopeCoordinatorClaimBridge {
  /// Counter thế hệ chuyển dịch scope, tăng đơn điệu mỗi khi có transition mới (đăng nhập / đăng xuất)
  int get transitionGeneration;

  /// Chuyển đổi trạng thái scope sang account:<userId> với kiểm tra generation (Fail-closed nếu stale)
  Future<void> resolveToAccount(String userId, {required int expectedGeneration});

  /// Đánh dấu trạng thái chuyển dịch tạm thời không khả dụng hoặc chờ thử lại (fail-closed)
  void markPendingUnavailable(String message);
}
