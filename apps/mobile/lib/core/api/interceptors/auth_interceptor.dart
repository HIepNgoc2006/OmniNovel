import 'dart:async';
import 'package:dio/dio.dart';
import '../../auth/token_storage.dart';
import '../api_endpoints.dart';
import '../../logging/app_logger.dart';

typedef SessionExpiredCallback = void Function();

class AuthInterceptor extends QueuedInterceptor {
  final Dio _dio;
  final ITokenStorage _tokenStorage;
  final String _baseUrl;
  final SessionExpiredCallback? _onSessionExpired;
  final AppLogger _logger;

  Completer<String?>? _refreshCompleter;

  AuthInterceptor({
    required Dio dio,
    required ITokenStorage tokenStorage,
    required String baseUrl,
    SessionExpiredCallback? onSessionExpired,
    AppLogger logger = const AppLogger('AuthInterceptor'),
  })  : _dio = dio,
        _tokenStorage = tokenStorage,
        _baseUrl = baseUrl,
        _onSessionExpired = onSessionExpired,
        _logger = logger;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    // Không đính kèm access token cho các endpoint auth công khai
    final path = options.path;
    final isPublicAuth = path.contains(ApiEndpoints.login) ||
        path.contains(ApiEndpoints.register) ||
        path.contains(ApiEndpoints.refresh);

    if (!isPublicAuth && !options.headers.containsKey('Authorization')) {
      final token = await _tokenStorage.getAccessToken();
      if (token != null && token.isNotEmpty) {
        options.headers['Authorization'] = 'Bearer $token';
      }
    }

    return handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final response = err.response;
    final statusCode = response?.statusCode;
    final requestOptions = err.requestOptions;

    final path = requestOptions.path;
    final isAuthEndpoint = path.contains(ApiEndpoints.login) ||
        path.contains(ApiEndpoints.register) ||
        path.contains(ApiEndpoints.refresh);

    // Chỉ bắt lỗi 401 trên các endpoint được bảo vệ
    if (statusCode != 401 || isAuthEndpoint) {
      return handler.next(err);
    }

    // Đánh dấu request đã retry chưa để tránh vòng lặp vô hạn
    final alreadyRetried = requestOptions.extra['_retry'] == true;
    if (alreadyRetried) {
      return handler.next(err);
    }
    requestOptions.extra['_retry'] = true;

    // Kiểm tra xem token trong request có cũ hơn token đã có trong storage không
    // Nếu một request khác trong cùng đợt 401 đã hoàn tất refresh trước, tái sử dụng ngay!
    final authHeader = requestOptions.headers['Authorization'] as String?;
    final requestToken = authHeader?.replaceFirst('Bearer ', '').trim();
    final currentToken = await _tokenStorage.getAccessToken();

    if (currentToken != null &&
        currentToken.isNotEmpty &&
        requestToken != null &&
        currentToken != requestToken) {
      _logger.i('Token đã được cập nhật bởi một request khác. Tái sử dụng token mới để retry: ${requestOptions.uri}');
      requestOptions.headers['Authorization'] = 'Bearer $currentToken';
      try {
        final retryResponse = await _dio.fetch<dynamic>(requestOptions);
        return handler.resolve(retryResponse);
      } catch (e) {
        return handler.next(err);
      }
    }

    _logger.i('Bắt gặp 401 Unauthorized trên ${requestOptions.uri}. Kích hoạt cơ chế Single-Flight Refresh...');

    try {
      final newAccessToken = await _performSingleFlightRefresh();

      if (newAccessToken != null && newAccessToken.isNotEmpty) {
        requestOptions.headers['Authorization'] = 'Bearer $newAccessToken';
        _logger.i('Token refresh thành công. Tiến hành retry request: ${requestOptions.uri}');

        // Retry request bằng instance Dio cha
        final retryResponse = await _dio.fetch<dynamic>(requestOptions);
        return handler.resolve(retryResponse);
      } else {
        _logger.w('Không thể refresh token (null). Đăng xuất và điều hướng về Login.');
        await _handleLogout();
        return handler.next(err);
      }
    } catch (e, stack) {
      _logger.e('Ngoại lệ khi refresh token. Thực hiện deterministic logout.', e, stack);
      await _handleLogout();
      return handler.next(err);
    }
  }

  /// Single-Flight Concurrency Guard:
  /// Đảm bảo dù có N request cùng nhận 401 đồng thời, chỉ DUY NHẤT 1 API call refresh được gửi đi.
  Future<String?> _performSingleFlightRefresh() async {
    if (_refreshCompleter != null) {
      _logger.i('Một tiến trình refresh đang chạy, đợi kết quả chung...');
      return _refreshCompleter!.future;
    }

    _refreshCompleter = Completer<String?>();

    try {
      final currentRefreshToken = await _tokenStorage.getRefreshToken();
      if (currentRefreshToken == null || currentRefreshToken.isEmpty) {
        _logger.w('Không có Refresh Token trong Secure Storage.');
        _refreshCompleter!.complete(null);
        return null;
      }

      // Tạo một Dio client độc lập không gắn AuthInterceptor để gọi endpoint refresh
      final refreshDio = Dio(
        BaseOptions(
          baseUrl: _baseUrl,
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Cookie': 'refreshToken=$currentRefreshToken',
          },
        ),
      );
      refreshDio.httpClientAdapter = _dio.httpClientAdapter;

      final response = await refreshDio.post<Map<String, dynamic>>(
        ApiEndpoints.refresh,
        data: {
          'refreshToken': currentRefreshToken,
        },
      );

      final data = response.data;
      final newAccessToken = data?['accessToken'] as String?;
      final newRefreshToken = data?['refreshToken'] as String? ?? currentRefreshToken;

      if (newAccessToken != null && newAccessToken.isNotEmpty) {
        await _tokenStorage.saveTokens(
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        );
        _refreshCompleter!.complete(newAccessToken);
        return newAccessToken;
      } else {
        _refreshCompleter!.complete(null);
        return null;
      }
    } catch (e) {
      _refreshCompleter!.complete(null);
      return null;
    } finally {
      _refreshCompleter = null;
    }
  }

  Future<void> _handleLogout() async {
    await _tokenStorage.clearTokens();
    _onSessionExpired?.call();
  }
}
