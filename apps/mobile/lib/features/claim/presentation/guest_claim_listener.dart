import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../../core/auth/auth_service.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/claim/guest_claim_coordinator.dart';
import '../../../app/router/app_router.dart';
import 'guest_claim_bottom_sheet.dart';

/// Root Shell Orchestration Widget (Task 5)
///
/// Lắng nghe trạng thái xác thực từ AuthService và trạng thái phiên claim từ GuestClaimCoordinator.
/// Đảm bảo:
/// 1. Tự động kích hoạt checkCrashRecovery() và checkAndPrepareClaim() khi auth chuyển sang authenticated (Verified Auth).
/// 2. Bỏ qua và không kích hoạt claim khi ở trạng thái pendingVerification (Offline Auth).
/// 3. Hiển thị GuestClaimBottomSheet khi coordinator.isOpen == true độc lập với route hiện tại.
/// 4. Đóng modal và reset claim session khi người dùng đăng xuất.
/// 5. Chống duplicate modal khi widget root rebuild nhiều lần.
class GuestClaimListener extends StatefulWidget {
  final Widget child;

  const GuestClaimListener({
    super.key,
    required this.child,
  });

  @override
  State<GuestClaimListener> createState() => _GuestClaimListenerState();
}

class _GuestClaimListenerState extends State<GuestClaimListener> {
  AuthStatus _lastAuthStatus = AuthStatus.initial;
  String? _lastUserId;
  bool _isModalShowing = false;
  BuildContext? _modalContext;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _handleOrchestration();
  }

  void _handleOrchestration() {
    final authService = context.watch<AuthService>();
    final coordinator = context.watch<GuestClaimCoordinator>();
    final authState = authService.state;

    final currentStatus = authState.status;
    final currentUserId = authState.user?.id;

    // 1. Khi Auth đăng xuất (authenticated -> unauthenticated) trong lúc modal đang hiển thị: Đóng modal và reset
    if (_lastAuthStatus == AuthStatus.authenticated && currentStatus == AuthStatus.unauthenticated) {
      if (_isModalShowing) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          _dismissModal();
          coordinator.resetSession();
        });
      }
    }

    // 2. Lifecycle Orchestration: Chỉ kích hoạt khi chuyển sang Verified Auth (authenticated)
    if (currentStatus == AuthStatus.authenticated &&
        (_lastAuthStatus != AuthStatus.authenticated || _lastUserId != currentUserId)) {
      _lastAuthStatus = currentStatus;
      _lastUserId = currentUserId;

      if (currentUserId != null && currentUserId.isNotEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          if (!mounted) return;
          // Bước 1: Ưu tiên phục hồi crash recovery journal nếu có
          await coordinator.checkCrashRecovery(currentUserId);
          // Bước 2: Nếu chưa mở modal phục hồi và phiên vẫn hợp lệ, chuẩn bị claim mới
          if (!coordinator.isOpen) {
            await coordinator.checkAndPrepareClaim(currentUserId);
          }
        });
      }
    } else {
      _lastAuthStatus = currentStatus;
      _lastUserId = currentUserId;
    }

    // 3. Quản lý hiển thị Bottom Sheet khi coordinator.isOpen == true
    if (coordinator.isOpen && !_isModalShowing) {
      _isModalShowing = true;
      final targetUserId = coordinator.currentUserId ?? currentUserId ?? '';
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_isModalShowing) return;
        _showBottomSheet(coordinator, targetUserId);
      });
    } else if (!coordinator.isOpen && _isModalShowing) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _dismissModal();
      });
    }

  }

  void _showBottomSheet(GuestClaimCoordinator coordinator, String userId) {
    final navContext = AppRouter.rootNavigatorKey.currentContext ?? context;
    showModalBottomSheet(
      context: navContext,
      isDismissible: false,
      enableDrag: false,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) {
        return GuestClaimBottomSheet(
          coordinator: coordinator,
          userId: userId,
        );
      },
    ).then((_) {
      _isModalShowing = false;
    });
  }

  void _dismissModal() {
    if (_isModalShowing) {
      _isModalShowing = false;
      final rootNavState = AppRouter.rootNavigatorKey.currentState;
      if (rootNavState != null && rootNavState.canPop()) {
        rootNavState.pop();
      } else if (Navigator.of(context).canPop()) {
        Navigator.of(context).pop();
      }
    }
  }


  @override
  Widget build(BuildContext context) {
    _handleOrchestration();
    return widget.child;
  }
}

