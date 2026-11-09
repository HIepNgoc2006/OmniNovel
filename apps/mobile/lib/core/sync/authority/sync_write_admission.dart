import 'package:flutter/foundation.dart';

import '../../auth/auth_service.dart';
import '../../identity/active_scope_coordinator.dart';
import '../errors/sync_storage_exceptions.dart';
import '../utils/canonical_entity_key.dart';

/// Ảnh chụp trạng thái thẩm quyền hiện tại dùng để kiểm định đồng bộ tại mọi
/// ranh giới giao dịch (`P0-M06`).
@immutable
class SyncAuthoritySnapshot {
  final ActiveScopeState scopeState;
  final String? activeScope;
  final bool canMutateUserState;
  final int transitionGeneration;
  final bool isAuthenticated;
  final String? authenticatedUserId;

  const SyncAuthoritySnapshot({
    required this.scopeState,
    required this.activeScope,
    required this.canMutateUserState,
    required this.transitionGeneration,
    required this.isAuthenticated,
    required this.authenticatedUserId,
  });
}

/// Nguồn đọc trạng thái thẩm quyền live cho lớp admission (`P0-M06`).
abstract interface class SyncAuthoritySource {
  SyncAuthoritySnapshot readSnapshot();
}

/// Nguồn thẩm quyền chuẩn trong runtime Mobile, kết hợp cả [ActiveScopeCoordinator]
/// lẫn [AuthService] để chặn tuyệt đối mọi thao tác ghi khi user logout, đổi tài khoản,
/// chuyển sang `pendingVerification`/`transitioning`, hoặc bị stale `transitionGeneration`.
class LiveSyncAuthoritySource implements SyncAuthoritySource {
  final ActiveScopeCoordinator _coordinator;
  final AuthService _authService;

  const LiveSyncAuthoritySource({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
  })  : _coordinator = coordinator,
        _authService = authService;

  @override
  SyncAuthoritySnapshot readSnapshot() {
    final authState = _authService.state;
    return SyncAuthoritySnapshot(
      scopeState: _coordinator.state,
      activeScope: _coordinator.activeScope,
      canMutateUserState: _coordinator.canMutateUserState,
      transitionGeneration: _coordinator.transitionGeneration,
      isAuthenticated: authState.isAuthenticated,
      authenticatedUserId: authState.user?.id,
    );
  }
}

/// Capability kiểm định thẩm quyền ghi bắt buộc (`P0-M06`).
///
/// Toàn bộ đường ghi của `SyncStorageDal` bắt buộc nhận non-null implementation
/// phù hợp ([AccountWriteAdmission] cho Account Sync, [GuestLocalWriteAdmission]
/// cho Guest-local). Không có tham số nullable để bỏ qua kiểm định trong production.
abstract interface class SyncWriteAdmission {
  String get authorizedScope;

  void assertAdmitted(String targetScope);
}

/// Capability ghi bắt buộc dành riêng cho **Account Sync Storage** (`account:<userId>`).
///
/// Ràng buộc bất biến với `(expectedUserId, expectedGeneration)` và kiểm chứng 6 điều kiện:
/// 1. `targetScope` hợp lệ và đúng bằng `'account:$expectedUserId'` (chặn `guest:*`).
/// 2. `AuthService.state.isAuthenticated == true` (chặn unauthenticated / pendingVerification).
/// 3. `AuthService.state.user?.id == expectedUserId` (chặn đổi tài khoản chéo).
/// 4. `ActiveScopeCoordinator.state == ActiveScopeState.account && canMutateUserState`.
/// 5. `ActiveScopeCoordinator.activeScope == 'account:$expectedUserId'`.
/// 6. `ActiveScopeCoordinator.transitionGeneration == expectedGeneration`.
class AccountWriteAdmission implements SyncWriteAdmission {
  final SyncAuthoritySource _authoritySource;
  final String expectedUserId;
  final int expectedGeneration;

  @override
  final String authorizedScope;

  AccountWriteAdmission._({
    required SyncAuthoritySource authoritySource,
    required this.expectedUserId,
    required this.expectedGeneration,
  })  : _authoritySource = authoritySource,
        authorizedScope = 'account:$expectedUserId';

  /// Khởi tạo admission ràng buộc vào [authoritySource], [expectedUserId] và [expectedGeneration].
  factory AccountWriteAdmission({
    required SyncAuthoritySource authoritySource,
    required String expectedUserId,
    required int expectedGeneration,
  }) {
    final trimmed = expectedUserId.trim();
    if (trimmed.isEmpty ||
        expectedUserId != trimmed ||
        trimmed.contains(':')) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid expectedUserId "$expectedUserId" for AccountWriteAdmission.',
      );
    }
    if (expectedGeneration < 0) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid negative transitionGeneration $expectedGeneration.',
      );
    }
    return AccountWriteAdmission._(
      authoritySource: authoritySource,
      expectedUserId: trimmed,
      expectedGeneration: expectedGeneration,
    );
  }

  /// Tiện ích production gắn trực tiếp vào [ActiveScopeCoordinator] + [AuthService]
  /// cho phiên tài khoản `(expectedUserId, expectedGeneration)`.
  factory AccountWriteAdmission.forLiveSession({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
    required String expectedUserId,
    required int expectedGeneration,
  }) {
    return AccountWriteAdmission(
      authoritySource: LiveSyncAuthoritySource(
        coordinator: coordinator,
        authService: authService,
      ),
      expectedUserId: expectedUserId,
      expectedGeneration: expectedGeneration,
    );
  }

  /// Chụp capability từ phiên tài khoản đang active. Fail-closed ngay lập tức nếu
  /// chưa xác thực hoặc scope hiện hành không phải `ActiveScopeState.account`.
  factory AccountWriteAdmission.captureFromLive({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
  }) {
    final source = LiveSyncAuthoritySource(
      coordinator: coordinator,
      authService: authService,
    );
    final snap = source.readSnapshot();
    final userId = snap.authenticatedUserId?.trim();
    if (!snap.isAuthenticated ||
        userId == null ||
        userId.isEmpty ||
        snap.scopeState != ActiveScopeState.account ||
        !snap.canMutateUserState) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Cannot capture AccountWriteAdmission outside an authenticated active account session (scopeState=${snap.scopeState}, isAuthenticated=${snap.isAuthenticated}).',
      );
    }
    final admission = AccountWriteAdmission._(
      authoritySource: source,
      expectedUserId: userId,
      expectedGeneration: snap.transitionGeneration,
    );
    admission.assertAdmitted('account:$userId');
    return admission;
  }

  @override
  void assertAdmitted(String targetScope) {
    assertAccountScope(targetScope);
    if (targetScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Account admission scope mismatch (expected "$authorizedScope", got "$targetScope").',
      );
    }

    final snapshot = _authoritySource.readSnapshot();
    if (!snapshot.isAuthenticated) {
      throw const SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Account session is not authenticated.',
      );
    }
    if (snapshot.authenticatedUserId?.trim() != expectedUserId) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Authenticated user changed (expected "$expectedUserId", got "${snapshot.authenticatedUserId}").',
      );
    }
    if (snapshot.scopeState != ActiveScopeState.account ||
        !snapshot.canMutateUserState) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: ActiveScopeCoordinator is not in active account state (state=${snapshot.scopeState}).',
      );
    }
    if (snapshot.activeScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Active scope mismatch (expected "$authorizedScope", got "${snapshot.activeScope}").',
      );
    }
    if (snapshot.transitionGeneration != expectedGeneration) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Stale transitionGeneration (expected $expectedGeneration, current ${snapshot.transitionGeneration}).',
      );
    }
  }
}

/// Capability ghi dành riêng cho **Guest-Local Storage** (`local_preferences` / Guest lifecycle).
/// Không thể truyền vào các hàm Account Sync do khác kiểu tường minh với [AccountWriteAdmission].
class GuestLocalWriteAdmission implements SyncWriteAdmission {
  final SyncAuthoritySource _authoritySource;
  final String expectedGuestProfileId;
  final int expectedGeneration;

  @override
  final String authorizedScope;

  GuestLocalWriteAdmission._({
    required SyncAuthoritySource authoritySource,
    required this.expectedGuestProfileId,
    required this.expectedGeneration,
  })  : _authoritySource = authoritySource,
        authorizedScope = 'guest:$expectedGuestProfileId';

  factory GuestLocalWriteAdmission({
    required SyncAuthoritySource authoritySource,
    required String expectedGuestProfileId,
    required int expectedGeneration,
  }) {
    final trimmed = expectedGuestProfileId.trim();
    if (trimmed.isEmpty ||
        expectedGuestProfileId != trimmed ||
        trimmed.contains(':')) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid expectedGuestProfileId "$expectedGuestProfileId" for GuestLocalWriteAdmission.',
      );
    }
    if (expectedGeneration < 0) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid negative transitionGeneration $expectedGeneration.',
      );
    }
    return GuestLocalWriteAdmission._(
      authoritySource: authoritySource,
      expectedGuestProfileId: trimmed,
      expectedGeneration: expectedGeneration,
    );
  }

  factory GuestLocalWriteAdmission.forLiveSession({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
    required String expectedGuestProfileId,
    required int expectedGeneration,
  }) {
    return GuestLocalWriteAdmission(
      authoritySource: LiveSyncAuthoritySource(
        coordinator: coordinator,
        authService: authService,
      ),
      expectedGuestProfileId: expectedGuestProfileId,
      expectedGeneration: expectedGeneration,
    );
  }

  factory GuestLocalWriteAdmission.captureFromLive({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
  }) {
    final source = LiveSyncAuthoritySource(
      coordinator: coordinator,
      authService: authService,
    );
    final snap = source.readSnapshot();
    final scope = snap.activeScope;
    if (snap.isAuthenticated ||
        snap.scopeState != ActiveScopeState.guest ||
        !snap.canMutateUserState ||
        scope == null ||
        !scope.startsWith('guest:')) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Cannot capture GuestLocalWriteAdmission outside an active guest session (scopeState=${snap.scopeState}, scope=$scope).',
      );
    }
    final profileId = scope.substring('guest:'.length);
    final admission = GuestLocalWriteAdmission._(
      authoritySource: source,
      expectedGuestProfileId: profileId,
      expectedGeneration: snap.transitionGeneration,
    );
    admission.assertAdmitted(scope);
    return admission;
  }

  @override
  void assertAdmitted(String targetScope) {
    assertGuestScope(targetScope);
    if (targetScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Guest admission scope mismatch (expected "$authorizedScope", got "$targetScope").',
      );
    }

    final snapshot = _authoritySource.readSnapshot();
    if (snapshot.isAuthenticated) {
      throw const SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Guest-local write rejected while authenticated session is active.',
      );
    }
    if (snapshot.scopeState != ActiveScopeState.guest ||
        !snapshot.canMutateUserState) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: ActiveScopeCoordinator is not in active guest state (state=${snapshot.scopeState}).',
      );
    }
    if (snapshot.activeScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Active guest scope mismatch (expected "$authorizedScope", got "${snapshot.activeScope}").',
      );
    }
    if (snapshot.transitionGeneration != expectedGeneration) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Stale guest transitionGeneration (expected $expectedGeneration, current ${snapshot.transitionGeneration}).',
      );
    }
  }
}
