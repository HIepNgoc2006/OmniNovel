import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/errors/error_mapper.dart';

void main() {
  group('ErrorMapper & ApiError Tests (NestJS Contract Alignment)', () {
    test('maps structured 400 Bad Request with details array', () {
      final dioException = DioException(
        requestOptions: RequestOptions(path: '/api/v1/chapters/123/reports'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/chapters/123/reports'),
          statusCode: 400,
          data: {
            'error': {
              'code': 'BAD_REQUEST',
              'message': 'Dữ liệu yêu cầu không hợp lệ.',
              'requestId': 'req-test-123',
              'timestamp': '2026-09-22T00:00:00.000Z',
              'details': [
                {'field': 'reason', 'issue': 'reason should not be empty'},
                {'field': 'pageNumber', 'issue': 'pageNumber must be a positive number'}
              ],
            }
          },
        ),
        type: DioExceptionType.badResponse,
      );

      final apiError = ErrorMapper.fromDioException(dioException);

      expect(apiError.code, equals('BAD_REQUEST'));
      expect(apiError.message, equals('Dữ liệu yêu cầu không hợp lệ.'));
      expect(apiError.statusCode, equals(400));
      expect(apiError.requestId, equals('req-test-123'));
      expect(apiError.details, isNotNull);
      expect(apiError.details!.length, equals(2));
      expect(apiError.details![0].field, equals('reason'));
      expect(apiError.details![0].issue, equals('reason should not be empty'));
    });

    test('maps 401 Unauthorized with custom server message', () {
      final dioException = DioException(
        requestOptions: RequestOptions(path: '/api/v1/auth/me'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/auth/me'),
          statusCode: 401,
          data: {
            'error': {
              'code': 'UNAUTHORIZED',
              'message': 'Refresh Token không hợp lệ hoặc đã hết hạn.',
              'requestId': 'req-auth-401',
            }
          },
        ),
        type: DioExceptionType.badResponse,
      );

      final apiError = ErrorMapper.fromDioException(dioException);

      expect(apiError.code, equals('UNAUTHORIZED'));
      expect(apiError.message, equals('Refresh Token không hợp lệ hoặc đã hết hạn.'));
      expect(apiError.statusCode, equals(401));
      expect(apiError.requestId, equals('req-auth-401'));
    });

    test('maps 409 Conflict with meta information', () {
      final dioException = DioException(
        requestOptions: RequestOptions(path: '/api/v1/chapters/1/versions/draft/commit'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/chapters/1/versions/draft/commit'),
          statusCode: 409,
          data: {
            'error': {
              'code': 'CONFLICT',
              'message': 'Phiên bản chương đã bị thay đổi bởi người khác.',
              'requestId': 'req-conflict-1',
              'meta': {
                'currentVersion': 3,
                'expectedVersion': 2,
              }
            }
          },
        ),
        type: DioExceptionType.badResponse,
      );

      final apiError = ErrorMapper.fromDioException(dioException);

      expect(apiError.code, equals('CONFLICT'));
      expect(apiError.statusCode, equals(409));
      expect(apiError.meta, isNotNull);
      expect(apiError.meta!['currentVersion'], equals(3));
    });

    test('maps Dio connection timeout to ApiError.timeout()', () {
      final dioException = DioException(
        requestOptions: RequestOptions(path: '/api/v1/stories'),
        type: DioExceptionType.connectionTimeout,
      );

      final apiError = ErrorMapper.fromDioException(dioException);

      expect(apiError.code, equals('TIMEOUT'));
      expect(apiError.message, contains('thời gian chờ'));
    });

    test('maps Dio connection error to ApiError.network()', () {
      final dioException = DioException(
        requestOptions: RequestOptions(path: '/api/v1/stories'),
        type: DioExceptionType.connectionError,
      );

      final apiError = ErrorMapper.fromDioException(dioException);

      expect(apiError.code, equals('NETWORK_ERROR'));
      expect(apiError.message, contains('kết nối mạng'));
    });
  });
}
