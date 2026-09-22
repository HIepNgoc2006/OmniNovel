import 'package:dio/dio.dart';
import 'api_error.dart';

export 'api_error.dart';

class ErrorMapper {
  static ApiError fromDioException(DioException error) {
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return ApiError.timeout();

      case DioExceptionType.badResponse:
        final response = error.response;
        if (response != null && response.data is Map<String, dynamic>) {
          return ApiError.fromJson(
            response.data as Map<String, dynamic>,
            statusCode: response.statusCode,
          );
        }

        final statusCode = response?.statusCode;
        return ApiError(
          code: _mapStatusCodeToCode(statusCode),
          message: response?.statusMessage ?? 'Máy chủ phản hồi lỗi.',
          statusCode: statusCode,
        );

      case DioExceptionType.connectionError:
        return ApiError.network();

      case DioExceptionType.cancel:
        return const ApiError(
          code: 'REQUEST_CANCELLED',
          message: 'Yêu cầu đã bị hủy bỏ.',
        );

      case DioExceptionType.unknown:
      default:
        return ApiError.network(
          message: error.message ?? 'Lỗi kết nối mạng không xác định.',
        );
    }
  }

  static String _mapStatusCodeToCode(int? statusCode) {
    switch (statusCode) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      case 500:
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}
