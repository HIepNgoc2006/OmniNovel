import 'package:dio/dio.dart';
import '../config/app_config.dart';
import '../auth/token_storage.dart';
import '../errors/error_mapper.dart';
import 'interceptors/auth_interceptor.dart';
import 'interceptors/logging_interceptor.dart';

class ApiClient {
  late final Dio _dio;
  final ITokenStorage _tokenStorage;
  final SessionExpiredCallback? _onSessionExpired;

  ApiClient({
    required ITokenStorage tokenStorage,
    String? baseUrl,
    SessionExpiredCallback? onSessionExpired,
  })  : _tokenStorage = tokenStorage,
        _onSessionExpired = onSessionExpired {
    final config = AppConfig.instance;
    final resolvedBaseUrl = baseUrl ?? config.apiBaseUrl;

    _dio = Dio(
      BaseOptions(
        baseUrl: resolvedBaseUrl,
        connectTimeout: config.connectTimeout,
        receiveTimeout: config.receiveTimeout,
        sendTimeout: config.sendTimeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    _dio.interceptors.addAll([
      const LoggingInterceptor(),
      AuthInterceptor(
        dio: _dio,
        tokenStorage: _tokenStorage,
        baseUrl: resolvedBaseUrl,
        onSessionExpired: _onSessionExpired,
      ),
    ]);
  }

  Dio get rawDio => _dio;

  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    try {
      return await _dio.get<T>(path, queryParameters: queryParameters, options: options);
    } on DioException catch (e) {
      throw ErrorMapper.fromDioException(e);
    }
  }

  Future<Response<T>> post<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    try {
      return await _dio.post<T>(path, data: data, queryParameters: queryParameters, options: options);
    } on DioException catch (e) {
      throw ErrorMapper.fromDioException(e);
    }
  }

  Future<Response<T>> put<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    try {
      return await _dio.put<T>(path, data: data, queryParameters: queryParameters, options: options);
    } on DioException catch (e) {
      throw ErrorMapper.fromDioException(e);
    }
  }

  Future<Response<T>> delete<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    try {
      return await _dio.delete<T>(path, data: data, queryParameters: queryParameters, options: options);
    } on DioException catch (e) {
      throw ErrorMapper.fromDioException(e);
    }
  }
}
