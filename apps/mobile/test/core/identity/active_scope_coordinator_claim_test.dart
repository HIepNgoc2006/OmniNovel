import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/auth_scope_bridge.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockSecureStorage extends Mock implements FlutterSecureStorage {}
class MockAuthService extends Mock implements AuthService {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockSecureStorage mockSecureStorage;
  late InstallationIdentityProvider installProvider;
  late GuestProfileIdentityProvider guestProvider;
  late ActiveScopeCoordinator coordinator;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    mockSecureStorage = MockSecureStorage();
    when(() => mockSecureStorage.read(key: any(named: 'key'))).thenAnswer((_) async => null);
    when(() => mockSecureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
        .thenAnswer((_) async {});
    when(() => mockSecureStorage.delete(key: any(named: 'key'))).thenAnswer((_) async {});

    installProvider = InstallationIdentityProvider(
      secureStorage: mockSecureStorage,
      prefs: prefs,
    );
    guestProvider = GuestProfileIdentityProvider(prefs: prefs);

    coordinator = ActiveScopeCoordinator(
      installProvider: installProvider,
      guestProfileProvider: guestProvider,
    );
  });

  group('Task 4: Zero-Bypass Single Authority & Generation Guard', () {
    test('1. onAuthStatusChanged(authenticated) ALWAYS transitions to transitioning, NEVER account directly', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-p0-111',
      );

      // P0 Zero-Bypass Invariant:
      // State MUST be transitioning
      expect(coordinator.state, equals(ActiveScopeState.transitioning));
      // activeScope MUST be null (no premature account:user-p0-111)
      expect(coordinator.activeScope, isNull);
      // canMutateUserState MUST be false
      expect(coordinator.canMutateUserState, isFalse);
      // generation MUST be > 0
      expect(coordinator.transitionGeneration, equals(1));
    });

    test('2. Duplicate authenticated notification for same user does NOT bump transitionGeneration', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-p0-111',
      );
      final gen1 = coordinator.transitionGeneration;
      expect(gen1, equals(1));

      // Duplicate notification
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-p0-111',
      );
      final gen2 = coordinator.transitionGeneration;

      // Invariant: generation counter does not bump on duplicate notification
      expect(gen2, equals(gen1));
    });

    test('3. New user authentication DOES bump transitionGeneration', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-A',
      );
      expect(coordinator.transitionGeneration, equals(1));

      // User switched to User B
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-B',
      );
      expect(coordinator.transitionGeneration, equals(2));
      expect(coordinator.state, equals(ActiveScopeState.transitioning));
    });

    test('4. resolveToAccount with matching expectedGeneration opens account scope and flushes waiters', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-p0-222',
      );

      final waiterFuture = coordinator.waitForResolvedScope();
      expect(coordinator.canMutateUserState, isFalse);

      final currentGen = coordinator.transitionGeneration;
      await coordinator.resolveToAccount('user-p0-222', expectedGeneration: currentGen);

      // Successfully resolved
      expect(coordinator.state, equals(ActiveScopeState.account));
      expect(coordinator.activeScope, equals('account:user-p0-222'));
      expect(coordinator.canMutateUserState, isTrue);

      final resolvedScope = await waiterFuture;
      expect(resolvedScope, equals('account:user-p0-222'));
    });

    test('5. resolveToAccount with stale expectedGeneration is dropped silently (fail-closed, keeps transitioning)', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-old',
      );
      final staleGen = coordinator.transitionGeneration; // 1

      // New transition happens (e.g. user-new)
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-new',
      );
      expect(coordinator.transitionGeneration, equals(2));

      // Stale callback from user-old returns with gen 1
      await coordinator.resolveToAccount('user-old', expectedGeneration: staleGen);

      // Invariant: Dropped! Still in transitioning for user-new
      expect(coordinator.state, equals(ActiveScopeState.transitioning));
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, isFalse);
    });

    test('6. resolveToAccount throws StateError if called when state is NOT transitioning', () async {
      // Coordinator is in bootstrapping
      expect(coordinator.state, equals(ActiveScopeState.bootstrapping));

      expect(
        () => coordinator.resolveToAccount('user-fail', expectedGeneration: 0),
        throwsA(isA<StateError>()),
      );
    });

    test('7. resolveToAccount falls back to bootstrapping if userId is empty or whitespace', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-valid',
      );
      final gen = coordinator.transitionGeneration;

      await coordinator.resolveToAccount('   ', expectedGeneration: gen);

      // Invariant: Never leak account:unknown, fall back to bootstrapping
      expect(coordinator.state, equals(ActiveScopeState.bootstrapping));
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, isFalse);
    });

    test('8. markPendingUnavailable records error and keeps transitioning', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'user-error',
      );

      coordinator.markPendingUnavailable('Network timeout during claim');

      expect(coordinator.state, equals(ActiveScopeState.transitioning));
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, isFalse);
    });
  });

  group('Task 4: AuthScopeBridge Error Observability & Serialization', () {
    test('Bridge captures transition errors in lastError and stays fail-closed', () async {
      final mockAuth = MockAuthService();
      final currentState = AuthState.initial();
      when(() => mockAuth.state).thenAnswer((_) => currentState);

      final bridge = AuthScopeBridge(
        authService: mockAuth,
        coordinator: coordinator,
      );
      bridge.attach();

      expect(bridge.lastError, isNull);
      bridge.dispose();
    });
  });
}
