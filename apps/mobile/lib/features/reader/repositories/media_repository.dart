import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../core/errors/error_mapper.dart';
import '../models/reader_models.dart';

class _CachedMediaUrl {
  final String downloadUrl;
  final DateTime expiresAt;

  _CachedMediaUrl({
    required this.downloadUrl,
    required this.expiresAt,
  });

  bool get isValid => DateTime.now().isBefore(expiresAt);
}

class MediaRepository {
  final ApiClient _apiClient;

  // In-memory cache signed URL theo assetId để tuân thủ giới hạn anti-leech 60 req/phút
  final Map<String, _CachedMediaUrl> _urlCache = {};

  MediaRepository({required ApiClient apiClient}) : _apiClient = apiClient;

  /// Lấy presigned download URL cho MediaAsset từ backend
  /// Tự động cache theo expiresInSeconds (trừ buffer an toàn 60 giây)
  Future<String> getMediaDownloadUrl(String assetId, {bool forceRefresh = false}) async {
    if (!forceRefresh) {
      final cached = _urlCache[assetId];
      if (cached != null && cached.isValid) {
        return cached.downloadUrl;
      }
    }

    try {
      final response = await _apiClient.get<Map<String, dynamic>>(ApiEndpoints.mediaUrl(assetId));
      final data = response.data ?? <String, dynamic>{};
      final parsed = PresignedMediaUrlResponse.fromJson(data);

      // Trừ 60 giây buffer an toàn trước khi token/URL thực sự hết hạn
      final ttlSeconds = parsed.expiresInSeconds > 60 ? parsed.expiresInSeconds - 60 : parsed.expiresInSeconds;
      _urlCache[assetId] = _CachedMediaUrl(
        downloadUrl: parsed.downloadUrl,
        expiresAt: DateTime.now().add(Duration(seconds: ttlSeconds)),
      );

      return parsed.downloadUrl;
    } on ApiError {
      rethrow;
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  /// Xóa cache cho assetId cụ thể (ví dụ khi bị 403 Forbidden lúc tải ảnh)
  void invalidate(String assetId) {
    _urlCache.remove(assetId);
  }

  /// Dọn dẹp toàn bộ cache URL
  void clearCache() {
    _urlCache.clear();
  }
}
