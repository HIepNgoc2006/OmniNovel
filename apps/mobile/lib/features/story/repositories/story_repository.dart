import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/story_models.dart';

class StoryRepository {
  final ApiClient _apiClient;

  StoryRepository({required ApiClient apiClient}) : _apiClient = apiClient;

  /// Lấy danh sách truyện nổi bật và banner cho màn hình chính
  Future<FeaturedStoriesResponse> getFeaturedStories() async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(ApiEndpoints.storiesFeatured);
      final data = response.data ?? <String, dynamic>{};
      return FeaturedStoriesResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy chi tiết bộ truyện và danh sách chương theo slug
  Future<StoryDetail> getStoryBySlug(String slug) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(ApiEndpoints.storyBySlug(slug));
      final data = response.data ?? <String, dynamic>{};
      return StoryDetail.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }
}
