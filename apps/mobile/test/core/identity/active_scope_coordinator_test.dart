import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockSecureStorage mockSecureStorage;
  late Map<String, String> secureStorageData;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    mockSecureStorage = MockSecureStorage();
    secureStorageData = {};

    when(() => mockSecureStorage.read(key: any(named: 'key')))
        .thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      return secureStorageData[key];
    });

    when(() => mockSecureStorage.write(
          key: any(named: 'key'),
          value: any(named: 'value'),
        )).thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      final value = invocation.namedArguments[#value] as String;
      secureStorageData[key] = value;
    });

    when(() => mockSecureStorage.delete(key: any(named: 'key')))
        .thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      secureStorageData.remove(key);
    });
  });

  group('Task 7A.1: Mobile InstallationIdentityProvider', () {
    test('creates and persists stable installationId across both SecureStorage and SharedPreferences', () async {
      final prefs = await SharedPreferences.getInstance();
      final provider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );

      final id1 = await provider.getOrCreateInstallationId();
      expect(id1.isNotEmpty, true);
      expect(secureStorageData['omninovel_installation_id'], id1);
      expect(prefs.getString('omninovel_installation_id'), id1);

      final id2 = await provider.getOrCreateInstallationId();
      expect(id2, id1);
    });

    test('reconciles from SharedPreferences to SecureStorage if SecureStorage was transiently wiped/empty (Fallback Promotion)', () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('omninovel_installation_id', 'canonical-fallback-id-123');

      // SecureStorage is currently empty
      expect(secureStorageData['omninovel_installation_id'], isNull);

      final provider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );

      final resolvedId = await provider.getOrCreateInstallationId();
      expect(resolvedId, 'canonical-fallback-id-123');
      // Promoted back to SecureStorage!
      expect(secureStorageData['omninovel_installation_id'], 'canonical-fallback-id-123');
    });

    test('reconciles to SecureStorage if SecureStorage and SharedPreferences conflict', () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('omninovel_installation_id', 'stale-prefs-id');
      secureStorageData['omninovel_installation_id'] = 'authoritative-secure-id';

      final provider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );

      final resolvedId = await provider.getOrCreateInstallationId();
      expect(resolvedId, 'authoritative-secure-id');
      // Overwrote stale prefs
      expect(prefs.getString('omninovel_installation_id'), 'authoritative-secure-id');
    });
  });

  group('Task 7A.1: Mobile GuestProfileIdentityProvider', () {
    test('creates, retrieves and rotates guestProfileId', () async {
      final prefs = await SharedPreferences.getInstance();
      final provider = GuestProfileIdentityProvider(prefs: prefs);

      final initialId = await provider.getOrCreateGuestProfileId();
      expect(initialId.isNotEmpty, true);
      expect(prefs.getString('omninovel_guest_profile_id'), initialId);

      // Rotate
      final newId = await provider.rotateGuestProfileId();
      expect(newId.isNotEmpty, true);
      expect(newId, isNot(equals(initialId)));
      expect(prefs.getString('omninovel_guest_profile_id'), newId);
    });

    test('quarantines old guest profile without silent destruction', () async {
      final prefs = await SharedPreferences.getInstance();
      final provider = GuestProfileIdentityProvider(prefs: prefs);

      final profileToQuarantine = await provider.getOrCreateGuestProfileId();
      await provider.quarantineGuestScope(profileToQuarantine);

      final quarantined = await provider.listQuarantinedGuestScopes();
      expect(quarantined, contains(profileToQuarantine));
    });
  });

  group('Task 7A.1: Mobile ActiveScopeCoordinator', () {
    test('starts in bootstrapping state with null activeScope and disallows user-state mutations', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      expect(coordinator.state, ActiveScopeState.bootstrapping);
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, false);
    });

    test('transitions bootstrapping -> guest when AuthStatus.unauthenticated', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      expect(coordinator.state, ActiveScopeState.guest);
      expect(coordinator.canMutateUserState, true);
      expect(coordinator.activeScope, startsWith('guest:'));
    });

    test('transitions bootstrapping -> account when AuthStatus.authenticated', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-mobile-999',
      );

      expect(coordinator.state, ActiveScopeState.account);
      expect(coordinator.canMutateUserState, true);
      expect(coordinator.activeScope, 'account:user-mobile-999');
    });

    test('fails closed when AuthStatus.authenticated with missing or empty userId (Zero account:unknown)', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      // Missing userId
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: null,
      );
      expect(coordinator.state, ActiveScopeState.bootstrapping);
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, false);

      // Whitespace userId
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: '   ',
      );
      expect(coordinator.state, ActiveScopeState.bootstrapping);
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, false);

      // Never produced account:unknown
      expect(coordinator.activeScope, isNot(equals('account:unknown')));
    });

    test('resolves multiple concurrent waitForResolvedScope() without hanging', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      final future1 = coordinator.waitForResolvedScope();
      final future2 = coordinator.waitForResolvedScope();

      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-waiter-111',
      );

      final results = await Future.wait<String>([future1, future2]);
      expect(results[0], 'account:user-waiter-111');
      expect(results[1], 'account:user-waiter-111');
      expect(coordinator.activeScope, 'account:user-waiter-111');
    });

    test('logout transition: rotates guestProfileId, keeps installationId intact, activates fresh guest', () async {
      final prefs = await SharedPreferences.getInstance();
      final installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );

      final initialInstallId = await installProvider.getOrCreateInstallationId();
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-logout-target',
      );

      // Perform logout
      await coordinator.onLogout();

      expect(coordinator.state, ActiveScopeState.guest);
      expect(coordinator.canMutateUserState, true);
      expect(coordinator.activeScope, startsWith('guest:'));
      expect(coordinator.activeScope, isNot(equals('account:user-logout-target')));

      // Installation ID MUST REMAIN STABLE
      final postLogoutInstallId = await installProvider.getOrCreateInstallationId();
      expect(postLogoutInstallId, initialInstallId);
    });
  });
}
