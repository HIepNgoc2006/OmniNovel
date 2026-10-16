import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockTokenStorage extends Mock implements ITokenStorage {}

void main() {
  group('AuthService Tests', () {
    late MockApiClient mockApiClient;
    late MockTokenStorage mockTokenStorage;
    late AuthService authService;

    setUp(() {
      mockApiClient = MockApiClient();
      mockTokenStorage = MockTokenStorage();
      authService = AuthService(
        apiClient: mockApiClient,
        tokenStorage: mockTokenStorage,
      );
    });

    test('initial state is AuthStatus.initial', () {
      expect(authService.state.status, equals(AuthStatus.initial));
    });

    test('initializeAuth with no stored tokens sets unauthenticated', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);

      await authService.initializeAuth();

      expect(authService.state.status, equals(AuthStatus.unauthenticated));
    });

    test('login success saves tokens and sets state to authenticated', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: {
              'user': {
                'id': 'u-123',
                'username': 'testreader',
                'email': 'reader@omninovel.com',
                'role': 'READER',
              },
              'accessToken': 'jwt_access_token_123',
              'refreshToken': 'jwt_refresh_token_456',
            },
          ));

      when(() => mockTokenStorage.saveTokens(
            accessToken: 'jwt_access_token_123',
            refreshToken: 'jwt_refresh_token_456',
          )).thenAnswer((_) async {});

      await authService.login(
        identifier: 'testreader',
        password: 'Password123!',
      );

      expect(authService.state.status, equals(AuthStatus.authenticated));
      expect(authService.state.user?.username, equals('testreader'));
      expect(authService.state.accessToken, equals('jwt_access_token_123'));
      verify(() => mockTokenStorage.saveTokens(
            accessToken: 'jwt_access_token_123',
            refreshToken: 'jwt_refresh_token_456',
          )).called(1);
    });

    test('login failure rethrows ApiError and sets unauthenticated with message', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenThrow(const ApiError(
        code: 'UNAUTHORIZED',
        message: 'Tên đăng nhập hoặc mật khẩu không chính xác.',
        statusCode: 401,
      ));

      expect(
        () => authService.login(identifier: 'wrong', password: 'wrong'),
        throwsA(isA<ApiError>()),
      );

      await Future<void>.delayed(Duration.zero);
      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      expect(
        authService.state.errorMessage,
        equals('Tên đăng nhập hoặc mật khẩu không chính xác.'),
      );
    });

    test('logout clears secure tokens and transitions state to unauthenticated', () async {
      when(() => mockTokenStorage.getRefreshToken())
          .thenAnswer((_) async => 'token_to_revoke');
      when(() => mockApiClient.post<void>(
            ApiEndpoints.logout,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.logout),
            statusCode: 200,
          ));
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      await authService.logout();

      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      verify(() => mockTokenStorage.clearTokens()).called(1);
    });

    test('register success saves tokens and transitions state to authenticated', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.register,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.register),
            statusCode: 201,
            data: {
              'user': {
                'id': 'u-reg-123',
                'username': 'newreader',
                'email': 'newreader@omninovel.com',
                'role': 'READER',
              },
              'accessToken': 'jwt_reg_token_123',
              'refreshToken': 'jwt_reg_refresh_456',
            },
          ));

      when(() => mockTokenStorage.saveTokens(
            accessToken: 'jwt_reg_token_123',
            refreshToken: 'jwt_reg_refresh_456',
          )).thenAnswer((_) async {});

      await authService.register(
        username: 'newreader',
        email: 'newreader@omninovel.com',
        password: 'Password123!',
      );

      expect(authService.state.status, equals(AuthStatus.authenticated));
      expect(authService.state.user?.username, equals('newreader'));
      expect(authService.state.accessToken, equals('jwt_reg_token_123'));
      verify(() => mockTokenStorage.saveTokens(
            accessToken: 'jwt_reg_token_123',
            refreshToken: 'jwt_reg_refresh_456',
          )).called(1);
    });

    test('register failure rethrows ApiError and sets unauthenticated with message', () async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.register,
            data: any<dynamic>(named: 'data'),
          )).thenThrow(const ApiError(
        code: 'CONFLICT',
        message: 'Tên người dùng hoặc email đã tồn tại.',
        statusCode: 409,
      ));

      expect(
        () => authService.register(
          username: 'existing',
          email: 'existing@omninovel.com',
          password: 'Password123!',
        ),
        throwsA(isA<ApiError>()),
      );

      await Future<void>.delayed(Duration.zero);
      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      expect(
        authService.state.errorMessage,
        equals('Tên người dùng hoặc email đã tồn tại.'),
      );
    });

    test('P0-1: initializeAuth network error with valid tokens enters Pending Verification (never authenticated, never wipe tokens)', () async {
      // Future exp (+1 hour)
      final futureExp = (DateTime.now().millisecondsSinceEpoch ~/ 1000) + 3600;
      final payload = base64Url.encode(utf8.encode(jsonEncode({
        'sub': 'user-ac09',
        'username': 'offline_user',
        'role': 'READER',
        'exp': futureExp,
      }))).replaceAll('=', '');
      final mockJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.$payload.dummy_signature';

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => mockJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh');

      // /auth/me throws network timeout error
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
          error: 'Connection timed out',
        ),
      );

      await authService.initializeAuth();

      // P0-1 Invariant: Chuyển sang pendingVerification, KHÔNG BAO GIỜ tự coi là authenticated!
      expect(authService.state.status, equals(AuthStatus.pendingVerification));
      expect(authService.state.isAuthenticated, isFalse);
      expect(authService.state.isPendingVerification, isTrue);
      expect(authService.state.user?.id, equals('user-ac09'));
      verifyNever(() => mockTokenStorage.clearTokens());
    });

    test('P0-1: initializeAuth with expired token (exp in past) -> unauthenticated, does not enter pendingVerification', () async {
      // Expired exp (-1 hour in the past)
      final pastExp = (DateTime.now().millisecondsSinceEpoch ~/ 1000) - 3600;
      final payload = base64Url.encode(utf8.encode(jsonEncode({
        'sub': 'expired-user',
        'username': 'expired_user',
        'role': 'READER',
        'exp': pastExp,
      }))).replaceAll('=', '');
      final expiredJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.$payload.dummy_signature';

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => expiredJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'expired_refresh');

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      await authService.initializeAuth();

      // Invariant: Expired JWT cannot be trusted offline -> sets unauthenticated
      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      expect(authService.state.isAuthenticated, isFalse);
    });

    test('P0-1: initializeAuth with tampered / corrupted JWT payload -> unauthenticated', () async {
      const tamperedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.corrupted_not_valid_base64_json!@#.dummy_sig';

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => tamperedJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'some_refresh');

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      await authService.initializeAuth();

      // Invariant: Corrupted JWT cannot be parsed -> unauthenticated
      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      expect(authService.state.isAuthenticated, isFalse);
    });

    test('initializeAuth 401 Unauthorized clears tokens and sets unauthenticated', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'expired_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'expired_refresh');

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          response: Response(
            requestOptions: RequestOptions(path: ApiEndpoints.me),
            statusCode: 401,
          ),
          type: DioExceptionType.badResponse,
        ),
      );
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      await authService.initializeAuth();

      expect(authService.state.status, equals(AuthStatus.unauthenticated));
      verify(() => mockTokenStorage.clearTokens()).called(1);
    });
  });
}

