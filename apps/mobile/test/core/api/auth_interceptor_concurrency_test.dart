import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/api/interceptors/auth_interceptor.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';

class InMemoryTokenStorage implements ITokenStorage {
  String? accessToken;
  String? refreshToken;

  InMemoryTokenStorage({
    this.accessToken = 'expired_initial_access_token',
    this.refreshToken = 'valid_initial_refresh_token',
  });

  @override
  Future<String?> getAccessToken() async => accessToken;

  @override
  Future<String?> getRefreshToken() async => refreshToken;

  @override
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  @override
  Future<void> saveAccessToken(String accessToken) async {
    this.accessToken = accessToken;
  }

  @override
  Future<void> clearTokens() async {
    accessToken = null;
    refreshToken = null;
  }
}

void main() {
  group('AuthInterceptor Concurrency & Mutex Tests (Gate 5A Requirements)', () {
    late InMemoryTokenStorage tokenStorage;
    late Dio dio;
    int refreshCallCount = 0;
    bool sessionExpiredCalled = false;

    setUp(() {
      tokenStorage = InMemoryTokenStorage();
      refreshCallCount = 0;
      sessionExpiredCalled = false;

      dio = Dio(BaseOptions(
        baseUrl: 'http://test-api.local',
        connectTimeout: const Duration(seconds: 5),
        receiveTimeout: const Duration(seconds: 5),
      ));
    });

    test('Single-Flight Mutex: 5 concurrent 401 requests trigger refresh EXACTLY ONCE and all 5 succeed', () async {
      final authInterceptor = AuthInterceptor(
        dio: dio,
        tokenStorage: tokenStorage,
        baseUrl: 'http://test-api.local',
        onSessionExpired: () => sessionExpiredCalled = true,
      );
      dio.interceptors.add(authInterceptor);

      // Custom mock adapter simulating server behavior
      dio.httpClientAdapter = _MockHttpAdapter(
        onFetch: (options) async {
          final uriPath = options.uri.path;

          // Xử lý endpoint /auth/refresh
          if (uriPath.contains('/auth/refresh')) {
            refreshCallCount++;
            // Giả lập network latency 40ms để kiểm chứng lock chạy đồng thời
            await Future<void>.delayed(const Duration(milliseconds: 40));
            return ResponseBody.fromString(
              '{"accessToken":"refreshed_access_token_999","refreshToken":"refreshed_refresh_token_999"}',
              200,
              headers: {
                Headers.contentTypeHeader: [Headers.jsonContentType],
              },
            );
          }

          // Xử lý các request protected
          final authHeader = options.headers['Authorization'] as String?;
          if (authHeader == 'Bearer refreshed_access_token_999') {
            return ResponseBody.fromString(
              '{"status":"ok","path":"$uriPath"}',
              200,
              headers: {
                Headers.contentTypeHeader: [Headers.jsonContentType],
              },
            );
          } else {
            // Token ban đầu đã hết hạn -> trả về 401
            return ResponseBody.fromString(
              '{"error":{"code":"UNAUTHORIZED","message":"Access Token expired"}}',
              401,
              headers: {
                Headers.contentTypeHeader: [Headers.jsonContentType],
              },
            );
          }
        },
      );

      // Bắn 5 request đồng thời song song khi access token đang hết hạn
      final futures = [
        dio.get<Map<String, dynamic>>('/data-1'),
        dio.get<Map<String, dynamic>>('/data-2'),
        dio.get<Map<String, dynamic>>('/data-3'),
        dio.get<Map<String, dynamic>>('/data-4'),
        dio.get<Map<String, dynamic>>('/data-5'),
      ];

      final responses = await Future.wait(futures);

      // 1. Toàn bộ 5 requests đều retry thành công với HTTP 200
      expect(responses.length, equals(5));
      for (final res in responses) {
        expect(res.statusCode, equals(200));
        expect((res.data as Map<String, dynamic>)['status'], equals('ok'));
      }

      // 2. Refresh token BẮT BUỘC chỉ được gọi DUY NHẤT 1 LẦN (Single-Flight guarantee)
      expect(refreshCallCount, equals(1));

      // 3. Token mới được lưu lại vào TokenStorage
      expect(tokenStorage.accessToken, equals('refreshed_access_token_999'));
      expect(tokenStorage.refreshToken, equals('refreshed_refresh_token_999'));
      expect(sessionExpiredCalled, isFalse);
    });

    test('Deterministic Logout: When refresh returns 401, clear tokens and notify session expired', () async {
      final authInterceptor = AuthInterceptor(
        dio: dio,
        tokenStorage: tokenStorage,
        baseUrl: 'http://test-api.local',
        onSessionExpired: () => sessionExpiredCalled = true,
      );
      dio.interceptors.add(authInterceptor);

      dio.httpClientAdapter = _MockHttpAdapter(
        onFetch: (options) async {
          final uriPath = options.uri.path;
          if (uriPath.contains('/auth/refresh')) {
            refreshCallCount++;
            // Refresh token cũng không hợp lệ -> 401
            return ResponseBody.fromString(
              '{"error":{"code":"UNAUTHORIZED","message":"Refresh token revoked"}}',
              401,
              headers: {
                Headers.contentTypeHeader: [Headers.jsonContentType],
              },
            );
          }

          // Protected endpoint luôn 401 với token hiện tại
          return ResponseBody.fromString(
            '{"error":{"code":"UNAUTHORIZED","message":"Access token expired"}}',
            401,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        },
      );

      // Gửi request
      expect(
        () => dio.get<Map<String, dynamic>>('/protected-endpoint'),
        throwsA(isA<DioException>()),
      );

      // Chờ microtasks hoàn tất
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(refreshCallCount, equals(1));
      expect(sessionExpiredCalled, isTrue);
      expect(tokenStorage.accessToken, isNull);
      expect(tokenStorage.refreshToken, isNull);
    });
  });
}

class _MockHttpAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) onFetch;

  _MockHttpAdapter({required this.onFetch});

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return onFetch(options);
  }

  @override
  void close({bool force = false}) {}
}
