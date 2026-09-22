import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/reader_models.dart';

class ChapterRepository {
  final ApiClient _apiClient;

  ChapterRepository({required ApiClient apiClient}) : _apiClient = apiClient;

  /// Lấy chi tiết chương truyện, danh sách trang và thông tin điều hướng
  Future<ChapterDetail> getChapterDetail(
    String chapterId, {
    String? versionId,
  }) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.chapterDetails(chapterId),
        queryParameters: versionId != null ? {'versionId': versionId} : null,
      );
      final data = response.data ?? <String, dynamic>{};
      return ChapterDetail.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }
}
