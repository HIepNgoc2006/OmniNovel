import 'dart:async';
import 'package:flutter/foundation.dart';
import '../auth/auth_state.dart';
import '../claim/scope_coordinator_claim_bridge.dart';
import 'guest_profile_identity_provider.dart';
import 'installation_identity_provider.dart';

enum ActiveScopeState {
  bootstrapping,
  guest,
  account,
  transitioning,
}

/// Điều phối Scope người dùng hiện tại (Guest vs Account vs Transitioning).
///
/// Tuân thủ nguyên tắc Zero-Bypass Single Authority:
/// - onAuthStatusChanged(authenticated) CHỈ chuyển trạng thái sang transitioning, TUYỆT ĐỐI không mở account.
/// - GuestClaimCoordinator là THẨM QUYỀN DUY NHẤT được phép gọi resolveToAccount(userId, expectedGeneration).
/// - Triple-check concurrency guard kết hợp generation counter đơn điệu bảo vệ tuyệt đối trước stale callbacks.
class ActiveScopeCoordinator extends ChangeNotifier implements ScopeCoordinatorClaimBridge {
  final InstallationIdentityProvider _installProvider;
  final GuestProfileIdentityProvider _guestProfileProvider;

  ActiveScopeState _state = ActiveScopeState.bootstrapping;
  String? _activeScope;
  int _transitionGeneration = 0;
  String? _pendingUserId;
  String? _lastUnavailableMessage;
  final List<Completer<String>> _waiters = [];

  ActiveScopeCoordinator({
    required InstallationIdentityProvider installProvider,
    required GuestProfileIdentityProvider guestProfileProvider,
  })  : _installProvider = installProvider,
        _guestProfileProvider = guestProfileProvider;

  ActiveScopeState get state => _state;
  String? get activeScope => _activeScope;

  @override
  int get transitionGeneration => _transitionGeneration;

  String? get pendingUserId => _pendingUserId;
  String? get lastUnavailableMessage => _lastUnavailableMessage;

  /// P0 Invariant: Cấm persistent user-state write trong bootstrapping và transitioning.
  /// Chỉ cho phép khi scope đã giải quyết dứt khoát thành guest hoặc account.
  bool get canMutateUserState =>
      (_state == ActiveScopeState.guest || _state == ActiveScopeState.account) &&
      _activeScope != null;

  /// Đợi active scope giải quyết xong (chống race condition khi app vừa khởi động).
  Future<String> waitForResolvedScope() {
    if (canMutateUserState && _activeScope != null) {
      return Future.value(_activeScope!);
    }
    final completer = Completer<String>();
    _waiters.add(completer);
    return completer.future;
  }

  /// Đưa coordinator vào trạng thái transitioning với generation counter tăng đơn điệu.
  /// Tránh tăng lặp lại nếu đã ở transitioning cho cùng một phiên/user.
  void setTransitioning({String? forUserId}) {
    final trimmed = forUserId?.trim();
    if (_state == ActiveScopeState.transitioning && _pendingUserId == trimmed) {
      return;
    }

    _transitionGeneration++;
    _pendingUserId = trimmed;
    _state = ActiveScopeState.transitioning;
    _activeScope = null;
    notifyListeners();
  }

  /// Thẩm quyền duy nhất mở scope ACCOUNT sau khi quy trình claim đã hoàn tất.
  /// Kiểm tra chặt chẽ:
  /// 1. State phải là transitioning.
  /// 2. expectedGeneration phải khớp transitionGeneration hiện tại (chống stale callbacks).
  /// 3. userId không rỗng.
  @override
  Future<void> resolveToAccount(String userId, {required int expectedGeneration}) async {
    if (_state != ActiveScopeState.transitioning) {
      throw StateError('Cannot resolveToAccount when state is $_state');
    }

    // P0 Invariant: Stale generation guard -> drop silently fail-closed
    if (expectedGeneration != _transitionGeneration) {
      return;
    }

    final trimmed = userId.trim();
    if (trimmed.isEmpty) {
      // Fail-closed: Auth báo authenticated nhưng userId rỗng -> rơi về bootstrapping
      _state = ActiveScopeState.bootstrapping;
      _activeScope = null;
      _pendingUserId = null;
      notifyListeners();
      return;
    }

    if (_pendingUserId != null && _pendingUserId != trimmed) {
      // User mismatch guard
      return;
    }

    _activeScope = 'account:$trimmed';
    _state = ActiveScopeState.account;
    _pendingUserId = null;
    _flushWaiters(_activeScope!);
    notifyListeners();
  }

  /// Ghi nhận lỗi chuyển giao hoặc tạm ngừng hoạt động (fail-closed).
  @override
  void markPendingUnavailable(String message) {
    _lastUnavailableMessage = message;
    notifyListeners();
  }

  /// Tiêu thụ trạng thái xác thực từ AuthService/AuthState.
  ///
  /// P0 Invariant: Fail closed nếu authenticated nhưng thiếu userId hợp lệ.
  /// Nhánh authenticated LUÔN chuyển sang transitioning, KHÔNG BAO GIỜ tự mở account.
  Future<void> onAuthStatusChanged(AuthStatus status, {String? userId}) async {
    switch (status) {
      case AuthStatus.initial:
        _state = ActiveScopeState.bootstrapping;
        _activeScope = null;
        _pendingUserId = null;
        notifyListeners();
        break;

      case AuthStatus.authenticating:
        setTransitioning(forUserId: userId);
        break;

      case AuthStatus.unauthenticated:
        final profileId = await _guestProfileProvider.getOrCreateGuestProfileId();
        final guestScope = 'guest:$profileId';
        if (_state == ActiveScopeState.guest && _activeScope == guestScope) {
          return;
        }
        _transitionGeneration++;
        _activeScope = guestScope;
        _state = ActiveScopeState.guest;
        _pendingUserId = null;
        _flushWaiters(_activeScope!);
        notifyListeners();
        break;

      case AuthStatus.authenticated:
        final trimmed = userId?.trim();
        if (trimmed == null || trimmed.isEmpty) {
          // Fail-closed: Auth báo authenticated nhưng userId rỗng -> ở lại bootstrapping, cấm ghi!
          _state = ActiveScopeState.bootstrapping;
          _activeScope = null;
          _pendingUserId = null;
          notifyListeners();
          break;
        }

        // P0-1 Zero-Bypass Invariant:
        // Luôn chuyển sang transitioning, không bao giờ tự mở account.
        // Chỉ GuestClaimCoordinator mới được resolveToAccount().
        setTransitioning(forUserId: trimmed);
        break;
    }
  }

  /// Xử lý đăng xuất:
  /// 1. Detach account scope cũ, tăng generation
  /// 2. Giữ nguyên installationId ổn định
  /// 3. Xoay sang fresh guestProfileId
  /// 4. Kích hoạt fresh guest scope với thư viện rỗng sạch sẽ
  Future<void> onLogout() async {
    _transitionGeneration++;
    _state = ActiveScopeState.transitioning;
    _activeScope = null;
    _pendingUserId = null;
    notifyListeners();

    final freshProfileId = await _guestProfileProvider.rotateGuestProfileId();
    _activeScope = 'guest:$freshProfileId';
    _state = ActiveScopeState.guest;

    _flushWaiters(_activeScope!);
    notifyListeners();
  }

  /// Trả về scope thiết bị ổn định (device:<installationId>).
  Future<String> getDeviceScope() async {
    final installId = await _installProvider.getOrCreateInstallationId();
    return 'device:$installId';
  }

  void _flushWaiters(String resolvedScope) {
    final waiters = List<Completer<String>>.from(_waiters);
    _waiters.clear();
    for (final completer in waiters) {
      if (!completer.isCompleted) {
        completer.complete(resolvedScope);
      }
    }
  }
}
