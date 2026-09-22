import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/reading_progress_models.dart';

class ReadingProgressRepository {
  final ApiClient _apiClient;
  final SharedPreferences? _prefs;

  static const String _checkpointPrefix = 'omninovel_reading_checkpoint_';

  ReadingProgressRepository({
    required ApiClient apiClient,
    SharedPreferences? prefs,
  })  : _apiClient = apiClient,
        _prefs = prefs;

  /// Lưu tiến độ đọc lên server Core API
  Future<ReadingProgressResponse> saveProgress(
      ReadingProgressPayload payload) async {
    try {
      final response = await _apiClient.put<Map<String, dynamic>>(
        ApiEndpoints.readingProgress,
        data: payload.toJson(),
      );
      final data = response.data ?? <String, dynamic>{};
      return ReadingProgressResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lấy tiến độ đọc của một bộ truyện từ server
  Future<ReadingProgressResponse> getProgress(String storyId) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        ApiEndpoints.storyReadingProgress(storyId),
      );
      final data = response.data ?? <String, dynamic>{};
      return ReadingProgressResponse.fromJson(data);
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Lưu checkpoint tức thì vào SharedPreferences để bảo vệ tiến độ khi bị kill app
  Future<void> saveLocalCheckpoint(LocalReadingCheckpoint checkpoint) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = '$_checkpointPrefix${checkpoint.storyId}';
    await prefs.setString(key, jsonEncode(checkpoint.toJson()));
  }

  /// Đọc checkpoint cục bộ từ SharedPreferences
  Future<LocalReadingCheckpoint?> getLocalCheckpoint(String storyId) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = '$_checkpointPrefix$storyId';
    final raw = prefs.getString(key);
    if (raw == null || raw.isEmpty) return null;

    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      return LocalReadingCheckpoint.fromJson(json);
    } catch (_) {
      return null;
    }
  }

  /// Xóa checkpoint cục bộ của một bộ truyện
  Future<void> clearLocalCheckpoint(String storyId) async {
    final prefs = _prefs ?? await SharedPreferences.getInstance();
    final key = '$_checkpointPrefix$storyId';
    await prefs.remove(key);
  }
}
