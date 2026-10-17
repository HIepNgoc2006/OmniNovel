import 'dart:async';
import 'package:flutter/foundation.dart';
import '../auth/auth_service.dart';
import '../auth/auth_state.dart';
import '../logging/app_logger.dart';
import 'active_scope_coordinator.dart';

/// Cầu nối đồng bộ giữa AuthService (ChangeNotifier) và ActiveScopeCoordinator (State Machine).
///
/// Phân biệt 3 ngữ nghĩa cốt lõi của [AuthStatus.unauthenticated]:
/// 1. Cold start không có token (initial -> unauthenticated):
///    => Giữ nguyên / khởi tạo guestProfileId hiện hành, KHÔNG rotate.
/// 2. Đăng nhập thất bại (authenticating -> unauthenticated):
///    => Quay lại đúng guestProfileId trước khi thử login, KHÔNG rotate.
/// 3. Đăng xuất hoặc session expired từ Account (authenticated -> unauthenticated):
///    => BẮT BUỘC gọi onLogout() để rotate sang fresh guestProfileId mới tinh.
///
/// Synchronization Gate:
/// Listener của ChangeNotifier là synchronous nhưng coordinator có async I/O
/// (SharedPreferences, UUID rotate). AuthScopeBridge tuần tự hóa các transitions
/// qua một chuỗi Future và cung cấp [settle()] để đảm bảo coordinator đã hoàn tất
/// giải quyết scope trước khi Router hoặc UI bắt đầu render / truy vấn dữ liệu.
class AuthScopeBridge {
  final AuthService _authService;
  final ActiveScopeCoordinator _coordinator;
  final AppLogger _logger;

  AuthStatus _previousStatus = AuthStatus.initial;
  String? _previousUserId;
  VoidCallback? _authListener;

  Object? _lastTransitionError;
  StackTrace? _lastTransitionStackTrace;

  // Chuỗi Future tuần tự hóa (serialized execution queue)
  Future<void> _currentTransition = Future.value();

  AuthScopeBridge({
    required AuthService authService,
    required ActiveScopeCoordinator coordinator,
    AppLogger logger = const AppLogger('AuthScopeBridge'),
  })  : _authService = authService,
        _coordinator = coordinator,
        _logger = logger;

  AuthStatus get previousStatus => _previousStatus;
  String? get previousUserId => _previousUserId;
  Object? get lastError => _lastTransitionError;
  StackTrace? get lastStackTrace => _lastTransitionStackTrace;

  /// Gắn listener vào AuthService để tự động đồng bộ khi AuthState thay đổi.
  void attach() {
    if (_authListener != null) return;
    _authListener = () {
      _enqueueTransition(_authService.state);
    };
    _authService.addListener(_authListener!);
  }

  /// Hủy gắn listener khỏi AuthService.
  void dispose() {
    if (_authListener != null) {
      _authService.removeListener(_authListener!);
      _authListener = null;
    }
  }

  /// Đưa transition của state vào hàng đợi tuần tự hóa để bảo đảm không bị race.
  Future<void> _enqueueTransition(AuthState state) {
    _currentTransition = _currentTransition.then((_) => _applyTransition(state)).catchError((Object e, StackTrace s) {
      _lastTransitionError = e;
      _lastTransitionStackTrace = s;
      _logger.e('Lỗi chuyển đổi trạng thái AuthScopeBridge: $e', e, s);
      // Giữ coordinator ở trạng thái an toàn fail-closed (canMutateUserState = false)
    });
    return _currentTransition;
  }

  /// Đồng bộ trạng thái hiện tại thủ công (dùng trong bootstrap hoặc test).
  Future<void> reconcileCurrentState() {
    return _enqueueTransition(_authService.state);
  }

  /// Chờ tất cả các transition đang pending giải quyết xong (Synchronization Gate).
  Future<void> settle() async {
    await _currentTransition;
  }

  /// Thực thi logic chuyển đổi trạng thái với các Invariant đã khóa
  Future<void> _applyTransition(AuthState state) async {
    final nextStatus = state.status;
    final nextUserId = state.user?.id;

    // Tránh transition dư thừa nếu status và userId không đổi (bảo vệ generation counter không bị bump giả lập)
    if (_previousStatus == nextStatus && _previousUserId == nextUserId) {
      return;
    }

    final prev = _previousStatus;
    _previousStatus = nextStatus;
    _previousUserId = nextUserId;

    switch (nextStatus) {
      case AuthStatus.initial:
        await _coordinator.onAuthStatusChanged(AuthStatus.initial);
        break;

      case AuthStatus.authenticating:
        // Bắt đầu quá trình đăng nhập (unauthenticated -> authenticating)
        await _coordinator.onAuthStatusChanged(AuthStatus.authenticating, userId: nextUserId);
        break;

      case AuthStatus.authenticated:
        // Xác thực thành công (authenticating -> authenticated hoặc cold-boot initial -> authenticated)
        // P0 Invariant: Nhánh này chuyển sang transitioning, không bao giờ tự mở account
        await _coordinator.onAuthStatusChanged(
          AuthStatus.authenticated,
          userId: nextUserId,
        );
        break;

      case AuthStatus.pendingVerification:
        // P0-1 Amendment: Giữ nguyên guest identity, không tự ý commit claim hay mở account
        await _coordinator.onAuthStatusChanged(
          AuthStatus.pendingVerification,
          userId: nextUserId,
        );
        break;

      case AuthStatus.unauthenticated:
        if (prev == AuthStatus.authenticated) {
          // Ngữ nghĩa 3: Đăng xuất hoặc session expired từ Account
          // BẮT BUỘC gọi onLogout() để rotate sang fresh guestProfileId
          await _coordinator.onLogout();
        } else {
          // Ngữ nghĩa 1 & 2:
          // - Cold-start không có token (prev == initial)
          // - Login thất bại (prev == authenticating)
          // Giữ nguyên guestProfileId hiện tại, KHÔNG rotate!
          await _coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
        }
        break;

    }
  }
}
