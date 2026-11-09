import 'package:flutter/foundation.dart';

import '../../auth/auth_service.dart';
import '../../identity/active_scope_coordinator.dart';
import '../errors/sync_storage_exceptions.dart';
import '../utils/canonical_entity_key.dart';
import 'sync_client_identity_provider.dart';

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
  final String? jwtSessionId;
  final String? currentGuestProfileId;

  const SyncAuthoritySnapshot({
    required this.scopeState,
    required this.activeScope,
    required this.canMutateUserState,
    required this.transitionGeneration,
    required this.isAuthenticated,
    required this.authenticatedUserId,
    this.jwtSessionId,
    this.currentGuestProfileId,
  });
}

/// Nguồn đọc trạng thái thẩm quyền live cho lớp admission (`P0-M06`).
abstract interface class SyncAuthoritySource {
  SyncAuthoritySnapshot readSnapshot();
}

/// Giao diện nội bộ cho phép `SyncStorageDal` đọc lại [SyncAuthoritySnapshot]
/// từ capability hiện hành (dùng để trích JWT `sid`/guest identity phòng chống va chạm `clientId`).
abstract interface class SyncAuthorityContextProvider {
  SyncAuthoritySnapshot readAuthoritySnapshot();
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
    final activeScope = _coordinator.activeScope;
    final currentGuestId =
        activeScope != null && activeScope.startsWith('guest:')
            ? activeScope.substring('guest:'.length)
            : null;
    return SyncAuthoritySnapshot(
      scopeState: _coordinator.state,
      activeScope: activeScope,
      canMutateUserState: _coordinator.canMutateUserState,
      transitionGeneration: _coordinator.transitionGeneration,
      isAuthenticated: authState.isAuthenticated,
      authenticatedUserId: authState.user?.id,
      jwtSessionId: extractJwtSessionId(authState.accessToken),
      currentGuestProfileId: currentGuestId,
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

/// Capability dành riêng cho dọn dẹp Guest local (`purgeGuestLocalScope`),
/// gồm [GuestLocalWriteAdmission] (active guest clear) và [UnusedGuestEvictionAdmission]
/// (thu hồi Guest cũ đã tách khỏi active scope).
abstract interface class GuestPurgeAdmission implements SyncWriteAdmission {}

/// Capability ghi bắt buộc dành riêng cho **Account Sync Storage** (`account:<userId>`).
///
/// Ràng buộc bất biến với `(expectedUserId, expectedGeneration)` và kiểm chứng 6 điều kiện:
/// 1. `targetScope` hợp lệ và đúng bằng `'account:$expectedUserId'` (chặn `guest:*`).
/// 2. `AuthService.state.isAuthenticated == true` (chặn unauthenticated / pendingVerification).
/// 3. `AuthService.state.user?.id == expectedUserId` (chặn đổi tài khoản chéo).
/// 4. `ActiveScopeCoordinator.state == ActiveScopeState.account && canMutateUserState`.
/// 5. `ActiveScopeCoordinator.activeScope == 'account:$expectedUserId'`.
/// 6. `ActiveScopeCoordinator.transitionGeneration == expectedGeneration`.
class AccountWriteAdmission
    implements SyncWriteAdmission, SyncAuthorityContextProvider {
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
  SyncAuthoritySnapshot readAuthoritySnapshot() => _authoritySource.readSnapshot();

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
class GuestLocalWriteAdmission
    implements SyncWriteAdmission, GuestPurgeAdmission, SyncAuthorityContextProvider {
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
  SyncAuthoritySnapshot readAuthoritySnapshot() => _authoritySource.readSnapshot();

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

/// Capability chuyên biệt cho `GuestLifecyclePurgeReason.verifiedUnusedGuestEviction`:
/// cho phép thu hồi một Guest scope **cũ / không còn active** (`targetScope != activeScope`)
/// mà không tạo deadlock sau `onLogout()` (xoay sang fresh guest) hoặc sau khi đã đăng nhập Account.
///
/// Chặn tuyệt đối khi:
/// - Coordinator đang ở `bootstrapping` hoặc `transitioning` (đang login / logout / `GuestClaim`).
/// - `targetScope` trùng với `activeScope` hiện tại (active guest clear phải dùng [GuestLocalWriteAdmission]).
/// - `transitionGeneration` đã thay đổi so với lúc cấp capability.
class UnusedGuestEvictionAdmission
    implements SyncWriteAdmission, GuestPurgeAdmission, SyncAuthorityContextProvider {
  final SyncAuthoritySource _authoritySource;
  final String targetGuestProfileId;
  final int expectedGeneration;

  @override
  final String authorizedScope;

  UnusedGuestEvictionAdmission._({
    required SyncAuthoritySource authoritySource,
    required this.targetGuestProfileId,
    required this.expectedGeneration,
  })  : _authoritySource = authoritySource,
        authorizedScope = 'guest:$targetGuestProfileId';

  factory UnusedGuestEvictionAdmission({
    required SyncAuthoritySource authoritySource,
    required String targetGuestProfileId,
    required int expectedGeneration,
  }) {
    final trimmed = targetGuestProfileId.trim();
    if (trimmed.isEmpty ||
        targetGuestProfileId != trimmed ||
        trimmed.contains(':')) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid targetGuestProfileId "$targetGuestProfileId" for UnusedGuestEvictionAdmission.',
      );
    }
    if (expectedGeneration < 0) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid negative transitionGeneration $expectedGeneration.',
      );
    }
    return UnusedGuestEvictionAdmission._(
      authoritySource: authoritySource,
      targetGuestProfileId: trimmed,
      expectedGeneration: expectedGeneration,
    );
  }

  factory UnusedGuestEvictionAdmission.captureFromLive({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
    required String targetGuestProfileId,
  }) {
    final source = LiveSyncAuthoritySource(
      coordinator: coordinator,
      authService: authService,
    );
    final snap = source.readSnapshot();
    final admission = UnusedGuestEvictionAdmission(
      authoritySource: source,
      targetGuestProfileId: targetGuestProfileId,
      expectedGeneration: snap.transitionGeneration,
    );
    admission.assertAdmitted('guest:${admission.targetGuestProfileId}');
    return admission;
  }

  @override
  SyncAuthoritySnapshot readAuthoritySnapshot() => _authoritySource.readSnapshot();

  @override
  void assertAdmitted(String targetScope) {
    assertGuestScope(targetScope);
    if (targetScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Unused guest eviction scope mismatch (expected "$authorizedScope", got "$targetScope").',
      );
    }

    final snapshot = _authoritySource.readSnapshot();
    if ((snapshot.scopeState != ActiveScopeState.guest &&
            snapshot.scopeState != ActiveScopeState.account) ||
        !snapshot.canMutateUserState) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Cannot evict unused guest scope while coordinator is ${snapshot.scopeState}.',
      );
    }
    if (snapshot.activeScope == authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Cannot use UnusedGuestEvictionAdmission on currently active scope "$authorizedScope".',
      );
    }
    if (snapshot.transitionGeneration != expectedGeneration) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Stale eviction transitionGeneration (expected $expectedGeneration, current ${snapshot.transitionGeneration}).',
      );
    }
  }
}

/// Capability thu hồi bộ đệm của **một Account đã tách (detached/inactive)** (`evictDetachedAccountScope`)
/// để tránh deadlock dọn rác khi session hết hạn (`handleSessionExpired()`), logout bị ngắt quãng,
/// hoặc đổi sang tài khoản khác (`user-A -> user-B`).
///
/// Tách kiểu hoàn toàn khỏi [AccountWriteAdmission]:
/// - KHÔNG THỂ dùng cho bất kỳ thao tác đọc/ghi đồng bộ, pending mutation, hay `purgeAccountScope` active.
/// - CHỈ cho phép khi `targetUserId` KHÔNG phải user đang active hoặc authenticated hiện tại,
///   và coordinator KHÔNG ở `bootstrapping` / `transitioning` (`GuestClaim`).
class DetachedAccountEvictionAdmission
    implements SyncWriteAdmission, SyncAuthorityContextProvider {
  final SyncAuthoritySource _authoritySource;
  final String targetUserId;
  final int expectedGeneration;

  @override
  final String authorizedScope;

  DetachedAccountEvictionAdmission._({
    required SyncAuthoritySource authoritySource,
    required this.targetUserId,
    required this.expectedGeneration,
  })  : _authoritySource = authoritySource,
        authorizedScope = 'account:$targetUserId';

  factory DetachedAccountEvictionAdmission({
    required SyncAuthoritySource authoritySource,
    required String targetUserId,
    required int expectedGeneration,
  }) {
    final trimmed = targetUserId.trim();
    if (trimmed.isEmpty ||
        targetUserId != trimmed ||
        trimmed.contains(':')) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid targetUserId "$targetUserId" for DetachedAccountEvictionAdmission.',
      );
    }
    if (expectedGeneration < 0) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Invalid negative transitionGeneration $expectedGeneration.',
      );
    }
    return DetachedAccountEvictionAdmission._(
      authoritySource: authoritySource,
      targetUserId: trimmed,
      expectedGeneration: expectedGeneration,
    );
  }

  factory DetachedAccountEvictionAdmission.captureFromLive({
    required ActiveScopeCoordinator coordinator,
    required AuthService authService,
    required String targetUserId,
  }) {
    final source = LiveSyncAuthoritySource(
      coordinator: coordinator,
      authService: authService,
    );
    final snap = source.readSnapshot();
    final admission = DetachedAccountEvictionAdmission(
      authoritySource: source,
      targetUserId: targetUserId,
      expectedGeneration: snap.transitionGeneration,
    );
    admission.assertAdmitted('account:${admission.targetUserId}');
    return admission;
  }

  @override
  SyncAuthoritySnapshot readAuthoritySnapshot() => _authoritySource.readSnapshot();

  @override
  void assertAdmitted(String targetScope) {
    assertAccountScope(targetScope);
    if (targetScope != authorizedScope) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Detached account eviction scope mismatch (expected "$authorizedScope", got "$targetScope").',
      );
    }

    final snapshot = _authoritySource.readSnapshot();
    if ((snapshot.scopeState != ActiveScopeState.guest &&
            snapshot.scopeState != ActiveScopeState.account) ||
        !snapshot.canMutateUserState) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Cannot evict detached account while coordinator is ${snapshot.scopeState}.',
      );
    }
    if (snapshot.activeScope == authorizedScope ||
        snapshot.authenticatedUserId?.trim() == targetUserId) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Target account "$authorizedScope" is currently active/authenticated; use purgeAccountScope with AccountWriteAdmission instead.',
      );
    }
    if (snapshot.transitionGeneration != expectedGeneration) {
      throw SyncAdmissionRejectedError(
        'SYNC_ADMISSION_REJECTED: Stale detached eviction transitionGeneration (expected $expectedGeneration, current ${snapshot.transitionGeneration}).',
      );
    }
  }
}
