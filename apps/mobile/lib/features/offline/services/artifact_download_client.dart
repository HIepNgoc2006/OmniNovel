import 'package:dio/dio.dart';

/// Ngoại lệ ném ra khi URL tải từ object storage bị hết hạn (HTTP 403).
/// TUYỆT ĐỐI KHÔNG kích hoạt flow refresh JWT token của Core API khi gặp lỗi này!
class StorageUrlExpiredException implements Exception {
  final String message;
  final int statusCode;

  const StorageUrlExpiredException({
    this.message = 'Presigned download URL has expired (HTTP 403)',
    this.statusCode = 403,
  });

  @override
  String toString() => 'StorageUrlExpiredException: $message ($statusCode)';
}

/// Client chuyên dụng tải tệp nhị phân artifact từ MinIO/S3 object storage.
///
/// BẤT BIẾN KIẾN TRÚC P0.2 & P0.4:
/// 1. Tách biệt hoàn toàn khỏi Core API Dio: KHÔNG đăng ký AuthInterceptor.
/// 2. Chống rò rỉ JWT token: Tuyệt đối không đính kèm header `Authorization: Bearer <jwt>`.
/// 3. Zero Auth Trigger on 403: HTTP 403 từ storage báo hiệu URL presigned hết hạn,
///    không bao giờ được kích hoạt làm mới JWT session của ứng dụng.
class ArtifactDownloadClient {
  late final Dio _dio;

  ArtifactDownloadClient({Dio? customDio}) {
    if (customDio != null) {
      _dio = customDio;
    } else {
      _dio = Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(minutes: 5),
          sendTimeout: const Duration(seconds: 15),
          headers: {
            'Accept-Encoding': 'identity', // Tránh nén gzip tự động làm lệch byte range
          },
        ),
      );
    }
  }

  Dio get rawDio => _dio;

  /// Stream tải gói tệp từ URL presigned.
  /// Hỗ trợ gửi header `Range: bytes=<startByte>-` khi `startByte > 0`.
  Future<Response<ResponseBody>> downloadStream(
    String url, {
    int startByte = 0,
    CancelToken? cancelToken,
  }) async {
    final Map<String, dynamic> headers = {
      'Accept-Encoding': 'identity',
    };

    if (startByte > 0) {
      headers['Range'] = 'bytes=$startByte-';
    }

    try {
      final response = await _dio.get<ResponseBody>(
        url,
        options: Options(
          responseType: ResponseType.stream,
          headers: headers,
          validateStatus: (status) {
            // Chấp nhận 200 OK và 206 Partial Content
            return status != null && (status >= 200 && status < 300);
          },
        ),
        cancelToken: cancelToken,
      );

      return response;
    } on DioException catch (e) {
      if (e.response?.statusCode == 403) {
        // Ném lỗi đặc thù để DownloadQueueManager nhận diện và làm mới presigned URL qua Core API
        throw StorageUrlExpiredException(
          message: 'Presigned URL đã hết hạn từ máy chủ lưu trữ (${e.message})',
          statusCode: 403,
        );
      }
      rethrow;
    }
  }
}
