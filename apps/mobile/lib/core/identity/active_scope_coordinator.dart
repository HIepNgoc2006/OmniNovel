import 'dart:async';
import 'package:flutter/foundation.dart';
import '../auth/auth_state.dart';
import 'guest_profile_identity_provider.dart';
import 'installation_identity_provider.dart';

enum ActiveScopeState {
  bootstrapping,
  guest,
  account,
  transitioning,
}

class ActiveScopeCoordinator extends ChangeNotifier {
  final InstallationIdentityProvider _installProvider;
  final GuestProfileIdentityProvider _guestProfileProvider;

  ActiveScopeState _state = ActiveScopeState.bootstrapping;
  String? _activeScope;
  final List<Completer<String>> _waiters = [];

  ActiveScopeCoordinator({
    required InstallationIdentityProvider installProvider,
    required GuestProfileIdentityProvider guestProfileProvider,
  })  : _installProvider = installProvider,
        _guestProfileProvider = guestProfileProvider;

  ActiveScopeState get state => _state;
  String? get activeScope => _activeScope;

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

  /// Tiêu thụ trạng thái xác thực từ AuthService/AuthState.
  Future<void> onAuthStatusChanged(AuthStatus status, {String? userId}) async {
    switch (status) {
      case AuthStatus.initial:
        _state = ActiveScopeState.bootstrapping;
        _activeScope = null;
        notifyListeners();
        break;

      case AuthStatus.authenticating:
        _state = ActiveScopeState.transitioning;
        _activeScope = null;
        notifyListeners();
        break;

      case AuthStatus.unauthenticated:
        final profileId = await _guestProfileProvider.getOrCreateGuestProfileId();
        _activeScope = 'guest:$profileId';
        _state = ActiveScopeState.guest;
        _flushWaiters(_activeScope!);
        notifyListeners();
        break;

      case AuthStatus.authenticated:
        final uid = userId ?? 'unknown';
        _activeScope = 'account:$uid';
        _state = ActiveScopeState.account;
        _flushWaiters(_activeScope!);
        notifyListeners();
        break;
    }
  }

  /// Xử lý đăng xuất:
  /// 1. Detach account scope cũ
  /// 2. Giữ nguyên installationId ổn định
  /// 3. Xoay sang fresh guestProfileId
  /// 4. Kích hoạt fresh guest scope với thư viện rỗng sạch sẽ
  Future<void> onLogout() async {
    _state = ActiveScopeState.transitioning;
    _activeScope = null;
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
