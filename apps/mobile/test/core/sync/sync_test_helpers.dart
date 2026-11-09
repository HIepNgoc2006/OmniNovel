import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_write_admission.dart';

/// Canonical RFC4122 UUIDv4 fixtures dùng cho các test Mobile Sync (`P1-M08`).
const String kTestClientId = '11111111-1111-4111-8111-111111111111';
const String kTestClientIdAlt = '22222222-2222-4222-9222-222222222222';

/// Nguồn thẩm quyền có thể điều khiển trạng thái trực tiếp trong unit test (`P0-M06`).
class MutableSyncAuthoritySource implements SyncAuthoritySource {
  ActiveScopeState scopeState;
  String? activeScope;
  bool canMutateUserState;
  int transitionGeneration;
  bool isAuthenticated;
  String? authenticatedUserId;

  MutableSyncAuthoritySource({
    required this.scopeState,
    required this.activeScope,
    required this.canMutateUserState,
    required this.transitionGeneration,
    required this.isAuthenticated,
    required this.authenticatedUserId,
  });

  factory MutableSyncAuthoritySource.activeAccount(
    String userId, {
    int generation = 1,
  }) {
    return MutableSyncAuthoritySource(
      scopeState: ActiveScopeState.account,
      activeScope: 'account:$userId',
      canMutateUserState: true,
      transitionGeneration: generation,
      isAuthenticated: true,
      authenticatedUserId: userId,
    );
  }

  factory MutableSyncAuthoritySource.activeGuest(
    String guestProfileId, {
    int generation = 1,
  }) {
    return MutableSyncAuthoritySource(
      scopeState: ActiveScopeState.guest,
      activeScope: 'guest:$guestProfileId',
      canMutateUserState: true,
      transitionGeneration: generation,
      isAuthenticated: false,
      authenticatedUserId: null,
    );
  }

  @override
  SyncAuthoritySnapshot readSnapshot() {
    return SyncAuthoritySnapshot(
      scopeState: scopeState,
      activeScope: activeScope,
      canMutateUserState: canMutateUserState,
      transitionGeneration: transitionGeneration,
      isAuthenticated: isAuthenticated,
      authenticatedUserId: authenticatedUserId,
    );
  }
}

/// Tạo [AccountWriteAdmission] hợp lệ cho phiên Account test xác định (không phải bypass).
AccountWriteAdmission testAccountAdmission(
  String ownerScope, {
  int generation = 1,
}) {
  final userId = ownerScope.startsWith('account:')
      ? ownerScope.substring('account:'.length)
      : ownerScope;
  return AccountWriteAdmission(
    authoritySource: MutableSyncAuthoritySource.activeAccount(
      userId,
      generation: generation,
    ),
    expectedUserId: userId,
    expectedGeneration: generation,
  );
}

/// Tạo [GuestLocalWriteAdmission] hợp lệ cho phiên Guest-local test xác định.
GuestLocalWriteAdmission testGuestAdmission(
  String guestScope, {
  int generation = 1,
}) {
  final profileId = guestScope.startsWith('guest:')
      ? guestScope.substring('guest:'.length)
      : guestScope;
  return GuestLocalWriteAdmission(
    authoritySource: MutableSyncAuthoritySource.activeGuest(
      profileId,
      generation: generation,
    ),
    expectedGuestProfileId: profileId,
    expectedGeneration: generation,
  );
}

/// Tạo [UnusedGuestEvictionAdmission] hợp lệ cho Guest cũ đã tách khỏi active scope.
UnusedGuestEvictionAdmission testUnusedGuestAdmission(
  String guestScope, {
  String activeAccountUserId = 'other-account',
  int generation = 1,
}) {
  final profileId = guestScope.startsWith('guest:')
      ? guestScope.substring('guest:'.length)
      : guestScope;
  return UnusedGuestEvictionAdmission(
    authoritySource: MutableSyncAuthoritySource.activeAccount(
      activeAccountUserId,
      generation: generation,
    ),
    targetGuestProfileId: profileId,
    expectedGeneration: generation,
  );
}
