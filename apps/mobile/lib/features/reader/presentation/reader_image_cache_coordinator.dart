import 'package:flutter/widgets.dart';
import '../models/reader_models.dart';
import '../repositories/media_repository.dart';

class ReaderImageCacheCoordinator {
  final MediaRepository _mediaRepository;

  // Map lưu trữ NetworkImage provider đã khởi tạo theo assetId để thực hiện evict chính xác
  final Map<String, NetworkImage> _activeProviders = {};

  ReaderImageCacheCoordinator({required MediaRepository mediaRepository})
      : _mediaRepository = mediaRepository;

  /// Lấy presigned URL cho trang
  Future<String> getPageUrl(ChapterPage page) async {
    return _mediaRepository.getMediaDownloadUrl(page.assetId);
  }

  /// Khởi tạo hoặc lấy lại ImageProvider đã có, lưu lại để sau này evict
  ImageProvider getImageProvider(String assetId, String downloadUrl) {
    return _activeProviders.putIfAbsent(
      assetId,
      () => NetworkImage(downloadUrl),
    );
  }

  /// Tải trước (precache/prefetch) các trang trong vùng ADJACENT
  Future<void> prefetchAdjacentPages({
    required BuildContext context,
    required List<ChapterPage> pages,
    required Set<int> adjacentIndexes,
  }) async {
    for (final index in adjacentIndexes) {
      if (index < 0 || index >= pages.length) continue;
      final page = pages[index];

      try {
        final url = await _mediaRepository.getMediaDownloadUrl(page.assetId);
        final provider = getImageProvider(page.assetId, url);
        if (context.mounted) {
          await precacheImage(provider, context);
        }
      } catch (_) {
        // Bỏ qua lỗi mạng khi prefetch, để viewport tự động retry khi scroll tới
      }
    }
  }

  /// Thu hồi và giải phóng bitmap khỏi Flutter ImageCache cho các trang DISTANT
  void evictDistantBitmaps({
    required List<ChapterPage> pages,
    required Set<int> distantIndexes,
  }) {
    for (final index in distantIndexes) {
      if (index < 0 || index >= pages.length) continue;
      final page = pages[index];

      final provider = _activeProviders.remove(page.assetId);
      if (provider != null) {
        provider.evict();
      }
    }
  }

  /// Dọn sạch toàn bộ providers và image cache khi thoát Reader
  void dispose() {
    for (final provider in _activeProviders.values) {
      provider.evict();
    }
    _activeProviders.clear();
  }
}
