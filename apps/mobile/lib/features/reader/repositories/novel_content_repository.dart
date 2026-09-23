import 'package:dio/dio.dart';
import '../../../core/errors/error_mapper.dart';
import 'media_repository.dart';

/// Repository phụ trách tải và lưu đệm nội dung tiểu thuyết (NOVEL_HTML).
///
/// **Security Invariant (P0):**
/// Tuyệt đối KHÔNG sử dụng `ApiClient.rawDio` (vốn có gắn `AuthInterceptor`) để gửi request
/// tới presigned URL trên MinIO / CDN, nhằm tránh rò rỉ JWT Bearer token ra máy chủ bên ngoài.
/// Repository này sử dụng một dedicated plain `Dio` client hoàn toàn không có `AuthInterceptor`.
class NovelContentRepository {
  final MediaRepository _mediaRepository;
  final Dio _assetDio;

  // In-memory cache nội dung HTML theo assetId
  final Map<String, String> _htmlCache = {};

  NovelContentRepository({
    required MediaRepository mediaRepository,
    Dio? assetDio,
  })  : _mediaRepository = mediaRepository,
        _assetDio = assetDio ??
            Dio(
              BaseOptions(
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 30),
                responseType: ResponseType.plain,
              ),
            );

  /// Lấy nội dung HTML của chapter qua assetId với cơ chế one-shot 403 recovery
  Future<String> loadNovelHtml(String assetId) async {
    // 1. Kiểm tra cache trong bộ nhớ
    if (_htmlCache.containsKey(assetId)) {
      return _htmlCache[assetId]!;
    }

    // 2. Lấy presigned download URL từ MediaRepository (sử dụng ApiClient có auth)
    final downloadUrl = await _mediaRepository.getMediaDownloadUrl(assetId);

    try {
      final html = await _fetchHtmlFromUrl(downloadUrl);
      _htmlCache[assetId] = html;
      return html;
    } on DioException catch (e) {
      // 3. One-shot 403 Recovery: Nếu presigned URL hết hạn (HTTP 403)
      if (e.response?.statusCode == 403) {
        _mediaRepository.invalidate(assetId);
        final freshUrl = await _mediaRepository.getMediaDownloadUrl(
          assetId,
          forceRefresh: true,
        );
        final freshHtml = await _fetchHtmlFromUrl(freshUrl);
        _htmlCache[assetId] = freshHtml;
        return freshHtml;
      }
      throw ErrorMapper.fromDioException(e);
    } catch (e) {
      throw ErrorMapper.fromGeneric(e);
    }
  }

  Future<String> _fetchHtmlFromUrl(String url) async {
    final response = await _assetDio.get<String>(
      url,
      options: Options(
        responseType: ResponseType.plain,
        // Bảo đảm không có Authorization header nào được gửi
        headers: {},
      ),
    );
    return response.data ?? '';
  }

  /// Xóa cache cho assetId cụ thể
  void invalidate(String assetId) {
    _htmlCache.remove(assetId);
  }

  /// Dọn dẹp toàn bộ bộ nhớ cache
  void clearCache() {
    _htmlCache.clear();
  }
}
