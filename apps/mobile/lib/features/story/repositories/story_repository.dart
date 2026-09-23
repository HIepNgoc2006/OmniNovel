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

  /// Lấy danh sách thể loại chuẩn từ server (Canonical Genres)
  Future<List<Genre>> getGenres() async {
    try {
      final response = await _apiClient.get<List<dynamic>>(ApiEndpoints.genres);
      final list = response.data ?? <dynamic>[];
      return list
          .map((item) => Genre.fromJson(item as Map<String, dynamic>))
          .toList();
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy bảng xếp hạng Top Comics và Top Novels
  Future<StoryRankingsResponse> getRankings() async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(ApiEndpoints.storiesRankings);
      final data = response.data ?? <String, dynamic>{};
      return StoryRankingsResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Tìm kiếm & lọc danh sách truyện theo tiêu chí kèm phân trang
  Future<PaginatedStoriesResponse> getStories(FindStoriesParams params) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.stories,
        queryParameters: params.toQueryParams(),
      );
      final data = response.data ?? <String, dynamic>{};
      return PaginatedStoriesResponse.fromJson(data);
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
