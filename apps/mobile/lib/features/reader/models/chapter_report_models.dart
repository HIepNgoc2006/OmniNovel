/// Danh mục 7 loại lỗi chuẩn tắc của hệ thống Báo cáo Lỗi Chương truyện (Phase 5C.6)
enum ChapterReportErrorType {
  imageCorrupt('IMAGE_CORRUPT', 'Hình ảnh bị hỏng / không tải được'),
  wrongOrder('WRONG_ORDER', 'Sai thứ tự trang'),
  translationError('TRANSLATION_ERROR', 'Lỗi bản dịch / dịch sai ngữ cảnh'),
  typo('TYPO', 'Lỗi chính tả / ngữ pháp'),
  inappropriateContent('INAPPROPRIATE_CONTENT', 'Nội dung không phù hợp / độc hại'),
  copyrightInfringement('COPYRIGHT_INFRINGEMENT', 'Vi phạm bản quyền'),
  other('OTHER', 'Lỗi khác');

  final String code;
  final String label;

  const ChapterReportErrorType(this.code, this.label);

  static ChapterReportErrorType fromCode(String code) {
    return ChapterReportErrorType.values.firstWhere(
      (e) => e.code == code,
      orElse: () => ChapterReportErrorType.other,
    );
  }
}

/// Trạng thái xử lý báo cáo
enum ChapterReportStatus {
  pending('PENDING', 'Chờ xử lý'),
  investigating('INVESTIGATING', 'Đang xử lý'),
  resolved('RESOLVED', 'Đã giải quyết'),
  rejected('REJECTED', 'Đã từ chối');

  final String code;
  final String label;

  const ChapterReportStatus(this.code, this.label);

  static ChapterReportStatus fromCode(String code) {
    return ChapterReportStatus.values.firstWhere(
      (e) => e.code == code,
      orElse: () => ChapterReportStatus.pending,
    );
  }
}

/// Dữ liệu gửi lên Backend khi báo lỗi
class ChapterReportPayload {
  final String chapterVersionId;
  final ChapterReportErrorType errorType;
  final int? pageNumber;
  final String? anchorBlockId;
  final String? description;

  const ChapterReportPayload({
    required this.chapterVersionId,
    required this.errorType,
    this.pageNumber,
    this.anchorBlockId,
    this.description,
  });

  Map<String, dynamic> toJson() {
    final map = <String, dynamic>{
      'chapterVersionId': chapterVersionId,
      'errorType': errorType.code,
    };
    if (pageNumber != null) {
      map['pageNumber'] = pageNumber;
    }
    if (anchorBlockId != null && anchorBlockId!.isNotEmpty) {
      map['anchorBlockId'] = anchorBlockId;
    }
    if (description != null && description!.trim().isNotEmpty) {
      map['description'] = description!.trim();
    }
    return map;
  }
}

/// Kết quả trả về sau khi tạo báo cáo thành công (201 Created)
class ChapterReportResult {
  final bool success;
  final String reportId;
  final ChapterReportStatus status;
  final String message;

  const ChapterReportResult({
    required this.success,
    required this.reportId,
    required this.status,
    required this.message,
  });

  factory ChapterReportResult.fromJson(Map<String, dynamic> json) {
    return ChapterReportResult(
      success: json['success'] == true,
      reportId: json['reportId'] as String? ?? '',
      status: ChapterReportStatus.fromCode(json['status'] as String? ?? 'PENDING'),
      message: json['message'] as String? ?? 'Báo cáo lỗi đã được ghi nhận.',
    );
  }
}

/// Ngoại lệ Rate Limit (429) mang metadata đếm ngược
class ChapterReportRateLimitException implements Exception {
  final int retryAfter;
  final String message;

  const ChapterReportRateLimitException({
    required this.retryAfter,
    required this.message,
  });

  @override
  String toString() => 'ChapterReportRateLimitException: $message (retryAfter: $retryAfter)';
}

/// Ngoại lệ Duplicate (409)
class ChapterReportDuplicateException implements Exception {
  final String message;

  const ChapterReportDuplicateException({
    required this.message,
  });

  @override
  String toString() => 'ChapterReportDuplicateException: $message';
}
