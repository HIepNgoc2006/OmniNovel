import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/auth_scope_bridge.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockTokenStorage extends Mock implements ITokenStorage {}
class MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockApiClient mockApiClient;
  late MockTokenStorage mockTokenStorage;
  late MockSecureStorage mockSecureStorage;
  late Map<String, String> secureStorageData;
  late SharedPreferences prefs;

  late InstallationIdentityProvider installProvider;
  late GuestProfileIdentityProvider guestProvider;
  late ActiveScopeCoordinator coordinator;
  late AuthService authService;
  late AuthScopeBridge bridge;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();

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

    mockApiClient = MockApiClient();
    mockTokenStorage = MockTokenStorage();

    installProvider = InstallationIdentityProvider(
      secureStorage: mockSecureStorage,
      prefs: prefs,
    );
    guestProvider = GuestProfileIdentityProvider(prefs: prefs);

    coordinator = ActiveScopeCoordinator(
      installProvider: installProvider,
      guestProfileProvider: guestProvider,
    );

    authService = AuthService(
      apiClient: mockApiClient,
      tokenStorage: mockTokenStorage,
    );

    bridge = AuthScopeBridge(
      authService: authService,
      coordinator: coordinator,
    );
    bridge.attach();
  });

  tearDown(() {
    bridge.dispose();
  });

  group('Task 7A.6 Step 1: AuthScopeBridge & Identity Lifecycle Transitions', () {
    test('Scenario 1: Cold boot without tokens => BOOTSTRAPPING -> guest:G persisted', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);

      expect(coordinator.state, equals(ActiveScopeState.bootstrapping));
      expect(coordinator.activeScope, isNull);

      await authService.initializeAuth();
      await bridge.settle();

      expect(coordinator.state, equals(ActiveScopeState.guest));
      expect(coordinator.activeScope, startsWith('guest:'));
      final guestScope1 = coordinator.activeScope!;

      // Khởi động lại giả lập (re-read prefs) vẫn trỏ về đúng guest:G persisted
      final persistedGuestId = prefs.getString(GuestProfileIdentityProvider.keyGuestProfileId);
      expect(persistedGuestId, isNotNull);
      expect(guestScope1, equals('guest:$persistedGuestId'));
    });

    test('Scenario 2: Cold boot with valid account tokens => BOOTSTRAPPING -> account:A (never guest:* transiently)', () async {
      final observedScopes = <String?>[];
      coordinator.addListener(() {
        observedScopes.add(coordinator.activeScope);
      });

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'valid_access_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh_token');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me))
          .thenAnswer((_) async => Response(
                requestOptions: RequestOptions(path: ApiEndpoints.me),
                statusCode: 200,
                data: {
                  'id': 'user-alpha-123',
                  'username': 'alpha_reader',
                  'email': 'alpha@omninovel.com',
                  'role': 'READER',
                },
              ));

      await authService.initializeAuth();
      await bridge.settle();

      // P0 Zero-Bypass: Authenticated state enters transitioning, awaiting claim resolution
      expect(coordinator.state, equals(ActiveScopeState.transitioning));
      expect(coordinator.activeScope, isNull);

      // Claim finalization opens account
      await coordinator.resolveToAccount(
        'user-alpha-123',
        expectedGeneration: coordinator.transitionGeneration,
      );
      expect(coordinator.state, equals(ActiveScopeState.account));
      expect(coordinator.activeScope, equals('account:user-alpha-123'));

      // P0 Invariant: Tuyệt đối không bao giờ xuất hiện guest:* trong quá trình cold-boot có account tokens
      for (final s in observedScopes) {
        if (s != null) {
          expect(s, isNot(startsWith('guest:')),
              reason: 'Transient guest scope leaked during cold account boot: $s');
        }
      }
    });

    test('Scenario 3: guest:G1 -> login starts -> login fails => returns to SAME guest:G1 (no rotation)', () async {
      // 1. Cold boot thành Guest G1
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      await authService.initializeAuth();
      await bridge.settle();

      final initialGuestScope = coordinator.activeScope;
      expect(initialGuestScope, startsWith('guest:'));
      final g1 = initialGuestScope!;

      // 2. Login thất bại
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenThrow(const ApiError(
        code: 'UNAUTHORIZED',
        message: 'Sai mật khẩu',
        statusCode: 401,
      ));

      expect(
        () => authService.login(identifier: 'reader', password: 'wrong_password'),
        throwsA(isA<ApiError>()),
      );

      await bridge.settle();

      // P0 Invariant: Login thất bại KHÔNG rotate guestProfileId
      expect(coordinator.state, equals(ActiveScopeState.guest));
      expect(coordinator.activeScope, equals(g1));
    });

    test('Scenario 4: guest:G1 -> login succeeds User A => account:A', () async {
      // 1. Cold boot thành Guest G1
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      await authService.initializeAuth();
      await bridge.settle();

      final g1 = coordinator.activeScope!;
      expect(g1, startsWith('guest:'));

      // 2. Login thành công User A
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: {
              'user': {
                'id': 'user_A',
                'username': 'userA',
                'email': 'userA@omninovel.com',
                'role': 'READER',
              },
              'accessToken': 'token_A',
              'refreshToken': 'refresh_A',
            },
          ));
      when(() => mockTokenStorage.saveTokens(
            accessToken: 'token_A',
            refreshToken: 'refresh_A',
          )).thenAnswer((_) async {});

      await authService.login(identifier: 'userA', password: 'password123');
      await bridge.settle();

      // P0 Zero-Bypass: Login enters transitioning, only resolveToAccount opens account
      expect(coordinator.state, equals(ActiveScopeState.transitioning));
      expect(coordinator.activeScope, isNull);

      await coordinator.resolveToAccount(
        'user_A',
        expectedGeneration: coordinator.transitionGeneration,
      );

      expect(coordinator.state, equals(ActiveScopeState.account));
      expect(coordinator.activeScope, equals('account:user_A'));
    });

    test('Scenario 5: account:A -> logout => guest:G2 (G2 != G1, installationId unchanged)', () async {
      final initialInstallId = await installProvider.getOrCreateInstallationId();

      // 1. Cold boot không token tạo G1
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      await authService.initializeAuth();
      await bridge.settle();
      final g1 = coordinator.activeScope!;

      // 2. Login User A
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: {
              'user': {
                'id': 'user_A',
                'username': 'userA',
                'email': 'userA@omninovel.com',
                'role': 'READER',
              },
              'accessToken': 'token_A',
              'refreshToken': 'refresh_A',
            },
          ));
      when(() => mockTokenStorage.saveTokens(
            accessToken: 'token_A',
            refreshToken: 'refresh_A',
          )).thenAnswer((_) async {});

      await authService.login(identifier: 'userA', password: 'password123');
      await bridge.settle();
      await coordinator.resolveToAccount(
        'user_A',
        expectedGeneration: coordinator.transitionGeneration,
      );
      expect(coordinator.activeScope, equals('account:user_A'));

      // 3. User A Logout
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'refresh_A');
      when(() => mockApiClient.post<void>(
            ApiEndpoints.logout,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.logout),
            statusCode: 200,
          ));
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      await authService.logout();
      await bridge.settle();

      // P0 Invariant: Logout rotate sang fresh guest:G2, G2 != G1
      expect(coordinator.state, equals(ActiveScopeState.guest));
      final g2 = coordinator.activeScope!;
      expect(g2, startsWith('guest:'));
      expect(g2, isNot(equals(g1)));
      expect(g2, isNot(equals('account:user_A')));

      // P0 Invariant: installationId giữ nguyên không đổi xuyên suốt
      final postLogoutInstallId = await installProvider.getOrCreateInstallationId();
      expect(postLogoutInstallId, equals(initialInstallId));
    });

    test('Scenario 6: account:A -> session expired => guest:G3 fresh', () async {
      // 1. Cold boot với account token
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'valid_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me))
          .thenAnswer((_) async => Response(
                requestOptions: RequestOptions(path: ApiEndpoints.me),
                statusCode: 200,
                data: {
                  'id': 'user_A',
                  'username': 'userA',
                  'email': 'userA@omninovel.com',
                  'role': 'READER',
                },
              ));
      await authService.initializeAuth();
      await bridge.settle();
      await coordinator.resolveToAccount(
        'user_A',
        expectedGeneration: coordinator.transitionGeneration,
      );
      expect(coordinator.activeScope, equals('account:user_A'));

      // 2. Kích hoạt session expired
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});
      authService.handleSessionExpired();
      await bridge.settle();

      // P0 Invariant: Session expired là unauthenticated từ authenticated -> rotate fresh guest
      expect(coordinator.state, equals(ActiveScopeState.guest));
      final g3 = coordinator.activeScope!;
      expect(g3, startsWith('guest:'));
      expect(g3, isNot(equals('account:user_A')));
    });

    test('Synchronization Gate: settle() waits for async coordinator resolution before router or repo queries', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);

      final initFuture = authService.initializeAuth();
      // settle() đảm bảo đợi xong
      await initFuture;
      await bridge.settle();

      expect(coordinator.canMutateUserState, isTrue);
      expect(coordinator.activeScope, isNotNull);
    });

    test('Fail-closed: authenticated state with missing userId does not leak account:unknown', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'token_without_user');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'refresh_without_user');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me))
          .thenAnswer((_) async => Response(
                requestOptions: RequestOptions(path: ApiEndpoints.me),
                statusCode: 200,
                data: {
                  'id': '  ', // empty / whitespace id
                  'username': 'invalid',
                  'email': 'invalid@omninovel.com',
                  'role': 'READER',
                },
              ));

      await authService.initializeAuth();
      await bridge.settle();

      // Coordinator fail-closed: ở lại bootstrapping, activeScope là null
      expect(coordinator.state, equals(ActiveScopeState.bootstrapping));
      expect(coordinator.activeScope, isNull);
      expect(coordinator.canMutateUserState, isFalse);
    });
  });
}
