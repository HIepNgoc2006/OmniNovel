import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../models/reader_models.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_controller.dart';
import 'reader_session_state.dart';

class WebtoonReaderView extends StatefulWidget {
  final ReaderSessionController controller;
  final ReaderImageCacheCoordinator imageCacheCoordinator;
  final ScrollController? scrollController;
  final void Function(int pageIndex, double progressPercentage, double scrollOffset)?
      onProgressChanged;

  const WebtoonReaderView({
    super.key,
    required this.controller,
    required this.imageCacheCoordinator,
    this.scrollController,
    this.onProgressChanged,
  });

  @override
  State<WebtoonReaderView> createState() => _WebtoonReaderViewState();
}

class _WebtoonReaderViewState extends State<WebtoonReaderView> {
  late final ScrollController _scrollController;
  bool _internalScrollController = false;

  @override
  void initState() {
    super.initState();
    if (widget.scrollController != null) {
      _scrollController = widget.scrollController!;
    } else {
      _scrollController = ScrollController();
      _internalScrollController = true;
    }
  }

  @override
  void dispose() {
    if (_internalScrollController) {
      _scrollController.dispose();
    }
    super.dispose();
  }

  bool _onScrollNotification(ScrollNotification notification) {
    if (notification is ScrollUpdateNotification) {
      final metrics = notification.metrics;
      final totalPages = widget.controller.state.totalPages;
      if (totalPages <= 0 || metrics.maxScrollExtent <= 0) return false;

      // Ước lượng trang hiện tại dựa trên tỷ lệ cuộn
      final scrollFraction = (metrics.pixels / metrics.maxScrollExtent).clamp(0.0, 1.0);
      final estimatedCurrentPage = (scrollFraction * (totalPages - 1)).round();
      final startIndex = (estimatedCurrentPage - 1).clamp(0, totalPages - 1);
      final endIndex = (estimatedCurrentPage + 1).clamp(0, totalPages - 1);

      widget.controller.updateVisibleRange(
        context: context,
        startIndex: startIndex,
        endIndex: endIndex,
        scrollOffset: metrics.pixels,
        maxScrollOffset: metrics.maxScrollExtent,
      );

      final progress = scrollFraction * 100;
      widget.onProgressChanged?.call(estimatedCurrentPage, progress, metrics.pixels);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final state = widget.controller.state;

        if (state.status == ReaderStatus.loading) {
          return const Center(
            child: CircularProgressIndicator(color: AppColors.primary),
          );
        }

        if (state.status == ReaderStatus.error) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(24.0),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, color: AppColors.error, size: 48),
                  const SizedBox(height: 16),
                  Text(
                    state.errorMessage ?? 'Không thể tải chương truyện.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: AppColors.textPrimary),
                  ),
                ],
              ),
            ),
          );
        }

        if (state.pages.isEmpty) {
          return const Center(
            child: Text(
              'Chương này chưa có trang nào.',
              style: TextStyle(color: AppColors.textMuted),
            ),
          );
        }

        return NotificationListener<ScrollNotification>(
          onNotification: _onScrollNotification,
          child: ListView.builder(
            controller: _scrollController,
            physics: const BouncingScrollPhysics(),
            addAutomaticKeepAlives: false, // Evict widget khi ra khỏi viewport
            addRepaintBoundaries: true, // Phân tách render tree cho 120Hz mượt mà
            itemCount: state.pages.length,
            itemBuilder: (context, index) {
              final page = state.pages[index];
              final shouldRetain = state.windowResult.shouldRetainBitmap(index);

              return _WebtoonPageItem(
                page: page,
                pageIndex: index,
                shouldRetainBitmap: shouldRetain,
                coordinator: widget.imageCacheCoordinator,
              );
            },
          ),
        );
      },
    );
  }
}

class _WebtoonPageItem extends StatelessWidget {
  final ChapterPage page;
  final int pageIndex;
  final bool shouldRetainBitmap;
  final ReaderImageCacheCoordinator coordinator;

  const _WebtoonPageItem({
    required this.page,
    required this.pageIndex,
    required this.shouldRetainBitmap,
    required this.coordinator,
  });

  @override
  Widget build(BuildContext context) {
    // Duy trì aspect ratio cố định để ngăn chặn hiện tượng nhảy khung hình (content jump)
    return AspectRatio(
      aspectRatio: page.aspectRatio,
      child: Container(
        color: AppColors.oledBlack,
        alignment: Alignment.center,
        child: !shouldRetainBitmap
            ? _buildPlaceholder(text: 'Trang ${pageIndex + 1}')
            : FutureBuilder<String>(
                future: coordinator.getPageUrl(page),
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return _buildLoadingPlaceholder();
                  }

                  if (snapshot.hasError || !snapshot.hasData) {
                    return _buildErrorPlaceholder();
                  }

                  final downloadUrl = snapshot.data!;
                  final imageProvider = coordinator.getImageProvider(
                    page.assetId,
                    downloadUrl,
                  );

                  return Image(
                    image: imageProvider,
                    fit: BoxFit.fitWidth,
                    filterQuality: FilterQuality.medium,
                    errorBuilder: (context, error, stackTrace) {
                      return _buildErrorPlaceholder();
                    },
                    loadingBuilder: (context, child, loadingProgress) {
                      if (loadingProgress == null) return child;
                      return _buildLoadingPlaceholder(
                        progress: loadingProgress.expectedTotalBytes != null
                            ? loadingProgress.cumulativeBytesLoaded /
                                loadingProgress.expectedTotalBytes!
                            : null,
                      );
                    },
                  );
                },
              ),
      ),
    );
  }

  Widget _buildPlaceholder({required String text}) {
    return Container(
      color: AppColors.darkSurface,
      alignment: Alignment.center,
      child: Text(
        text,
        style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
      ),
    );
  }

  Widget _buildLoadingPlaceholder({double? progress}) {
    return Container(
      color: AppColors.darkSurface,
      alignment: Alignment.center,
      child: SizedBox(
        width: 24,
        height: 24,
        child: CircularProgressIndicator(
          value: progress,
          strokeWidth: 2,
          color: AppColors.primary,
        ),
      ),
    );
  }

  Widget _buildErrorPlaceholder() {
    return Container(
      color: AppColors.darkSurface,
      alignment: Alignment.center,
      child: const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.broken_image, color: AppColors.textMuted, size: 32),
          SizedBox(height: 8),
          Text(
            'Lỗi tải ảnh',
            style: TextStyle(color: AppColors.textMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}
