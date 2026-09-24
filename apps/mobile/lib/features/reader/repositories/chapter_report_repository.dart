import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/chapter_report_models.dart';

class ChapterReportRepository {
  final ApiClient _apiClient;

  ChapterReportRepository({required ApiClient apiClient})
      : _apiClient = apiClient;

  /// Gửi báo cáo lỗi nội dung chương truyện (POST /api/v1/chapters/:id/reports)
  Future<ChapterReportResult> sendReport({
    required String chapterId,
    required ChapterReportPayload payload,
  }) async {
    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.chapterReport(chapterId),
        data: payload.toJson(),
      );

      final data = response.data ?? <String, dynamic>{};
      return ChapterReportResult.fromJson(data);
    } on ApiError catch (e) {
      if (e.statusCode == 429 || e.code == 'TOO_MANY_REQUESTS') {
        final retryAfter = (e.meta?['retryAfter'] as num?)?.toInt() ?? 60;
        throw ChapterReportRateLimitException(
          retryAfter: retryAfter,
          message: e.message,
        );
      }

      if (e.statusCode == 409 || e.code == 'CHAPTER_REPORT_DUPLICATE') {
        throw ChapterReportDuplicateException(message: e.message);
      }

      rethrow;
    } catch (e) {
      final apiError = ErrorMapper.fromGeneric(e);
      if (apiError.statusCode == 429 || apiError.code == 'TOO_MANY_REQUESTS') {
        final retryAfter = (apiError.meta?['retryAfter'] as num?)?.toInt() ?? 60;
        throw ChapterReportRateLimitException(
          retryAfter: retryAfter,
          message: apiError.message,
        );
      }
      if (apiError.statusCode == 409 || apiError.code == 'CHAPTER_REPORT_DUPLICATE') {
        throw ChapterReportDuplicateException(message: apiError.message);
      }
      throw apiError;
    }
  }
}
