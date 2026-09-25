import 'dart:io';
import 'package:flutter/widgets.dart';
import '../models/reader_models.dart';
import '../repositories/media_repository.dart';

class _ActiveImageEntry {
  final String url;
  final int? targetWidth;
  final ImageProvider provider;
  final int estimatedSizeBytes;

  const _ActiveImageEntry({
    required this.url,
    required this.targetWidth,
    required this.provider,
    required this.estimatedSizeBytes,
  });
}

/// Bộ điều phối bộ nhớ ảnh Reader (Image Cache Coordinator)
/// 1. Giới hạn giải mã theo targetWidth qua ResizeImage chống OOM với ảnh Webtoon siêu lớn.
/// 2. Quản lý Provider Key đa chiều (assetId, targetWidth, url), tự động evict và đổi provider khi URL xoay vòng (signed URL rotation).
/// 3. Hỗ trợ one-shot recovery khi signed URL hết hạn (403).
/// 4. Kiểm soát ngân sách bộ nhớ (Memory-Budget-Aware Prefetch): Giới hạn tổng RAM bitmap của adjacent pages trong khoảng an toàn (60-90MB).
/// 5. Hỗ trợ chế độ Offline: Cấp phát FileImage trực tiếp từ App-Private sandbox với 0 network call.
class ReaderImageCacheCoordinator {
  final MediaRepository _mediaRepository;

  /// Ngân sách bộ nhớ tối đa dành cho ảnh giải mã (mặc định 80MB)
  final int imageBudgetBytes;

  // Map lưu trữ thông tin ảnh đang hoạt động theo assetId
  final Map<String, _ActiveImageEntry> _activeEntries = {};

  // Map lưu trữ tệp cục bộ khi hoạt động ở chế độ ngoại tuyến
  final Map<String, File> _localAssetFiles = {};

  ReaderImageCacheCoordinator({
    required MediaRepository mediaRepository,
    this.imageBudgetBytes = 80 * 1024 * 1024, // 80 MB
  }) : _mediaRepository = mediaRepository;

  /// Đăng ký danh sách tệp cục bộ cho các assetId ngoại tuyến
  void registerLocalAssetFiles(Map<String, File> localFiles) {
    _localAssetFiles.addAll(localFiles);
  }

  /// Xóa sạch danh sách tệp cục bộ ngoại tuyến
  void clearLocalAssetFiles() {
    _localAssetFiles.clear();
  }

  /// Kiểm tra assetId có phải là tệp cục bộ hay không
  bool isAssetLocal(String assetId) => _localAssetFiles.containsKey(assetId);

  /// Lấy đối tượng File cục bộ nếu có
  File? getLocalAssetFile(String assetId) => _localAssetFiles[assetId];

  /// Lấy URL hoặc đường dẫn ảnh cho trang (0 network request nếu là tệp cục bộ)
  Future<String> getPageUrl(ChapterPage page) async {
    final local = _localAssetFiles[page.assetId];
    if (local != null) {
      return local.path;
    }
    return _mediaRepository.getMediaDownloadUrl(page.assetId);
  }

  /// Làm mới Presigned URL khi gặp lỗi 403 / hết hạn token và xóa bỏ provider cũ (chỉ online)
  Future<String> refreshPageUrl(ChapterPage page) async {
    final local = _localAssetFiles[page.assetId];
    if (local != null) {
      return local.path;
    }
    invalidateAndEvict(page.assetId);
    return _mediaRepository.getMediaDownloadUrl(
      page.assetId,
      forceRefresh: true,
    );
  }

  /// Tính toán dung lượng RAM bitmap giải mã ước lượng (RGBA 4 bytes/pixel)
  static int estimateDecodedBytes(ChapterPage page, int targetWidth) {
    if (targetWidth <= 0) return 0;
    final ratio = page.aspectRatio > 0 ? page.aspectRatio : 0.65;
    final height = (targetWidth / ratio).round();
    return targetWidth * height * 4;
  }

  /// Khởi tạo hoặc tái sử dụng ImageProvider có giới hạn kích thước giải mã (ResizeImage).
  /// Cấp phát FileImage cho tệp cục bộ và NetworkImage cho URL online.
  ImageProvider getImageProvider(
    String assetId,
    String downloadUrl, {
    int? targetWidth,
    ChapterPage? page,
  }) {
    final existing = _activeEntries[assetId];
    if (existing != null) {
      if (existing.url == downloadUrl && existing.targetWidth == targetWidth) {
        return existing.provider;
      }
      // URL hoặc kích thước thay đổi (xoay vòng signed URL): giải phóng provider cũ
      existing.provider.evict();
      _activeEntries.remove(assetId);
    }

    final local = _localAssetFiles[assetId];
    final isLocal = local != null || (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://'));
    final ImageProvider baseProvider = isLocal
        ? FileImage(local ?? File(downloadUrl))
        : NetworkImage(downloadUrl);

    final ImageProvider provider = (targetWidth != null && targetWidth > 0)
        ? ResizeImage(baseProvider, width: targetWidth, allowUpscaling: false)
        : baseProvider;

    final estimatedBytes = (page != null && targetWidth != null)
        ? estimateDecodedBytes(page, targetWidth)
        : 0;

    _activeEntries[assetId] = _ActiveImageEntry(
      url: downloadUrl,
      targetWidth: targetWidth,
      provider: provider,
      estimatedSizeBytes: estimatedBytes,
    );

    return provider;
  }

  /// Tổng dung lượng RAM bitmap ước tính của các trang đang được quản lý
  int get currentDecodedBytes {
    int total = 0;
    for (final entry in _activeEntries.values) {
      total += entry.estimatedSizeBytes;
    }
    return total;
  }

  /// Tải trước (precache) các trang trong vùng ADJACENT có kiểm soát ngân sách bộ nhớ (Memory Budget)
  Future<void> prefetchAdjacentPages({
    required BuildContext context,
    required List<ChapterPage> pages,
    required Set<int> adjacentIndexes,
    int? targetWidth,
  }) async {
    int projectedBytes = currentDecodedBytes;

    for (final index in adjacentIndexes) {
      if (index < 0 || index >= pages.length) continue;
      final page = pages[index];

      // Kiểm tra xem trang này đã được nạp chưa
      if (!_activeEntries.containsKey(page.assetId)) {
        if (targetWidth != null && targetWidth > 0) {
          final pageBytes = estimateDecodedBytes(page, targetWidth);
          // Nếu việc tải thêm trang này vượt quá ngân sách bộ nhớ (imageBudgetBytes), dừng prefetch
          if (projectedBytes + pageBytes > imageBudgetBytes) {
            continue;
          }
          projectedBytes += pageBytes;
        }
      }

      try {
        final url = await _mediaRepository.getMediaDownloadUrl(page.assetId);
        final provider = getImageProvider(
          page.assetId,
          url,
          targetWidth: targetWidth,
          page: page,
        );
        if (context.mounted) {
          await precacheImage(
            provider,
            context,
            onError: (exception, stackTrace) {
              // Bỏ qua lỗi mạng/decode khi prefetch trong background hoặc khi chạy offline/test
            },
          );
        }
      } catch (_) {
        // Bỏ qua lỗi mạng khi prefetch, để viewport tự động retry/recover khi scroll tới
      }
    }
  }

  /// Xóa cache và thu hồi bitmap khỏi Flutter ImageCache cho assetId cụ thể
  void invalidateAndEvict(String assetId) {
    _mediaRepository.invalidate(assetId);
    final entry = _activeEntries.remove(assetId);
    if (entry != null) {
      entry.provider.evict();
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

      final entry = _activeEntries.remove(page.assetId);
      if (entry != null) {
        entry.provider.evict();
      }
    }
  }

  /// Dọn sạch toàn bộ providers và image cache khi thoát Reader
  void dispose() {
    for (final entry in _activeEntries.values) {
      entry.provider.evict();
    }
    _activeEntries.clear();
    _localAssetFiles.clear();
  }
}
