import 'package:dio/dio.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/studio_models.dart';

class StudioRepository {
  final ApiClient _apiClient;

  StudioRepository({required ApiClient apiClient}) : _apiClient = apiClient;

  /// Lấy chi tiết thẩm quyền của Translation Job (Metadata, Context, ReviewSummary, Permissions)
  Future<TranslationJobReviewDetailResponse> getJobDetail(String jobId) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.aiJobDetail(jobId),
      );
      final data = response.data ?? <String, dynamic>{};
      return TranslationJobReviewDetailResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy danh sách ảnh preview kết quả dịch (Manga/Webtoon) theo bounded window
  Future<TranslationJobPreviewsResponse> getPreviews(
    String jobId, {
    int? fromPage,
    int? toPage,
  }) async {
    try {
      final queryParams = <String, dynamic>{};
      if (fromPage != null) queryParams['fromPage'] = fromPage;
      if (toPage != null) queryParams['toPage'] = toPage;

      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.aiJobPreviews(jobId),
        queryParameters: queryParams.isNotEmpty ? queryParams : null,
      );
      final data = response.data ?? <String, dynamic>{};
      return TranslationJobPreviewsResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy danh sách phân đoạn dịch song ngữ (Novel) có phân trang
  Future<TranslationJobSegmentsResponse> getSegments(
    String jobId, {
    int page = 1,
    int limit = 50,
  }) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.aiJobSegments(jobId),
        queryParameters: {
          'page': page,
          'limit': limit,
        },
      );
      final data = response.data ?? <String, dynamic>{};
      return TranslationJobSegmentsResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Gửi lệnh xuất bản bản dịch với header Idempotency-Key
  Future<ApplyTranslationJobResponse> applyJob(
    String jobId,
    ApplyTranslationJobRequest request, {
    required String idempotencyKey,
  }) async {
    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.aiJobApply(jobId),
        data: request.toJson(),
        options: Options(
          headers: {
            'Idempotency-Key': idempotencyKey,
          },
        ),
      );
      final data = response.data ?? <String, dynamic>{};
      return ApplyTranslationJobResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy toàn bộ các Translation Jobs đang ở trạng thái READY_FOR_REVIEW của truyện (xử lý đầy đủ phân trang)
  Future<List<TranslationJobSummaryDto>> getAllReadyForReviewJobs(String storyId) async {
    final List<TranslationJobSummaryDto> allJobs = [];
    int currentPage = 1;
    const int pageLimit = 100;
    int totalPages = 1;

    try {
      while (currentPage <= totalPages) {
        final response = await _apiClient.get<Map<String, dynamic>>(
          ApiEndpoints.aiJobs,
          queryParameters: {
            'storyId': storyId,
            'status': TranslationJobStatus.readyForReview.toServerString(),
            'page': currentPage,
            'limit': pageLimit,
          },
        );

        final data = response.data ?? <String, dynamic>{};
        final paginated = PaginatedTranslationJobsResponse.fromJson(data);
        allJobs.addAll(paginated.data);

        totalPages = paginated.totalPages;
        currentPage++;

        if (paginated.data.isEmpty) break;
      }

      return allJobs;
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Nhóm các Translation Jobs READY_FOR_REVIEW theo chapterId (giữ nguyên thứ tự deterministic từ server)
  Future<Map<String, List<TranslationJobSummaryDto>>> getJobsByChapterForStory(String storyId) async {
    final jobs = await getAllReadyForReviewJobs(storyId);
    final Map<String, List<TranslationJobSummaryDto>> map = {};

    for (final job in jobs) {
      final chapterId = job.chapterId;
      if (chapterId != null && chapterId.isNotEmpty) {
        map.putIfAbsent(chapterId, () => []).add(job);
      }
    }

    return map;
  }
}
