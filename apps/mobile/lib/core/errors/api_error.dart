class ErrorDetail {
  final String field;
  final String issue;

  const ErrorDetail({
    required this.field,
    required this.issue,
  });

  factory ErrorDetail.fromJson(Map<String, dynamic> json) {
    return ErrorDetail(
      field: json['field'] as String? ?? 'unknown',
      issue: json['issue'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'field': field,
        'issue': issue,
      };

  @override
  String toString() => '$field: $issue';
}

class ApiError implements Exception {
  final String code;
  final String message;
  final String? requestId;
  final String? timestamp;
  final int? statusCode;
  final List<ErrorDetail>? details;
  final Map<String, dynamic>? meta;

  const ApiError({
    required this.code,
    required this.message,
    this.requestId,
    this.timestamp,
    this.statusCode,
    this.details,
    this.meta,
  });

  factory ApiError.fromJson(Map<String, dynamic> json, {int? statusCode}) {
    final errorPayload = json['error'];
    if (errorPayload is Map<String, dynamic>) {
      final detailsList = errorPayload['details'];
      return ApiError(
        code: errorPayload['code'] as String? ?? 'UNKNOWN_ERROR',
        message: errorPayload['message'] as String? ?? 'Đã xảy ra lỗi không xác định.',
        requestId: errorPayload['requestId'] as String?,
        timestamp: errorPayload['timestamp'] as String?,
        statusCode: statusCode,
        details: detailsList is List
            ? detailsList
                .whereType<Map<String, dynamic>>()
                .map(ErrorDetail.fromJson)
                .toList()
            : null,
        meta: errorPayload['meta'] as Map<String, dynamic>?,
      );
    }

    return ApiError(
      code: json['code'] as String? ?? 'UNKNOWN_ERROR',
      message: json['message'] as String? ?? 'Đã xảy ra lỗi không xác định.',
      statusCode: statusCode,
    );
  }

  factory ApiError.network({String? message}) {
    if (message != null) {
      return ApiError(
        code: 'NETWORK_ERROR',
        message: message,
      );
    }
    return const ApiError(
      code: 'NETWORK_ERROR',
      message: 'Không thể kết nối tới máy chủ. Vui lòng kiểm tra kết nối mạng.',
    );
  }

  factory ApiError.timeout() {
    return const ApiError(
      code: 'TIMEOUT',
      message: 'Kết nối mạng quá thời gian chờ. Vui lòng thử lại.',
    );
  }

  factory ApiError.unauthorized({String? message}) {
    if (message != null) {
      return ApiError(
        code: 'UNAUTHORIZED',
        statusCode: 401,
        message: message,
      );
    }
    return const ApiError(
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
    );
  }

  @override
  String toString() {
    return 'ApiError(code: $code, message: $message, statusCode: $statusCode, requestId: $requestId)';
  }
}
