import 'package:dio/dio.dart';
import '../../logging/app_logger.dart';

class LoggingInterceptor extends Interceptor {
  final AppLogger _logger;

  const LoggingInterceptor([this._logger = const AppLogger('Dio')]);

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    _logger.d('--> ${options.method} ${options.uri}');
    return handler.next(options);
  }

  @override
  void onResponse(Response<dynamic> response, ResponseInterceptorHandler handler) {
    _logger.d('<-- ${response.statusCode} ${response.requestOptions.uri}');
    return handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    _logger.w('<-- ERROR ${err.response?.statusCode} ${err.requestOptions.uri}: ${err.message}');
    return handler.next(err);
  }
}
