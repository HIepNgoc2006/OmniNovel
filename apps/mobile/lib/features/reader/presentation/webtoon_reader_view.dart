import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../models/reader_models.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_controller.dart';
import 'reader_session_state.dart';
import 'webtoon_geometry_calculator.dart';

class WebtoonReaderView extends StatefulWidget {
  final ReaderSessionController controller;
  final ReaderImageCacheCoordinator imageCacheCoordinator;
  final ScrollController? scrollController;
  final int initialPageIndex;
  final void Function(int pageIndex, double progressPercentage, double scrollOffset)?
      onProgressChanged;

  const WebtoonReaderView({
    super.key,
    required this.controller,
    required this.imageCacheCoordinator,
    this.scrollController,
    this.initialPageIndex = 0,
    this.onProgressChanged,
  });

  @override
  State<WebtoonReaderView> createState() => _WebtoonReaderViewState();
}

class _WebtoonReaderViewState extends State<WebtoonReaderView> {
  late final ScrollController _scrollController;
  bool _internalScrollController = false;

  WebtoonGeometryCalculator? _geometryCalculator;
  double? _lastViewportWidth;
  bool _hasRestoredInitialPosition = false;
  double _lastScrollOffset = 0.0;

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

  bool _onScrollNotification(
    ScrollNotification notification,
    double viewportWidth,
    double viewportHeight,
    int targetWidth,
  ) {
    if (notification is ScrollUpdateNotification) {
      final metrics = notification.metrics;
      final totalPages = widget.controller.state.totalPages;
      if (totalPages <= 0 || _geometryCalculator == null) return false;

      final currentOffset = metrics.pixels;
      final direction = currentOffset >= _lastScrollOffset
          ? ScrollDirectionPreference.down
          : ScrollDirectionPreference.up;
      _lastScrollOffset = currentOffset;

      final (startIndex, endIndex) = _geometryCalculator!.findVisibleRange(
        currentOffset,
        metrics.viewportDimension,
      );

      final focusedPageIndex = _geometryCalculator!.findFocusedPage(
        currentOffset,
        metrics.viewportDimension,
        direction: direction,
      );

      widget.controller.updateVisibleRange(
        context: context,
        startIndex: startIndex,
        endIndex: endIndex,
        focusedIndex: focusedPageIndex,
        scrollOffset: currentOffset,
        maxScrollOffset: metrics.maxScrollExtent,
        targetWidth: targetWidth,
      );

      final progress = metrics.maxScrollExtent > 0
          ? ((currentOffset / metrics.maxScrollExtent) * 100).clamp(0.0, 100.0)
          : ((focusedPageIndex / totalPages) * 100).clamp(0.0, 100.0);

      widget.onProgressChanged?.call(focusedPageIndex, progress, currentOffset);
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

        return LayoutBuilder(
          builder: (context, constraints) {
            final viewportWidth = constraints.maxWidth;
            final viewportHeight = constraints.maxHeight;
            final dpr = MediaQuery.of(context).devicePixelRatio;
            final targetWidth = (viewportWidth * dpr).round().clamp(720, 1600);

            if (_geometryCalculator == null || _lastViewportWidth != viewportWidth) {
              _geometryCalculator = WebtoonGeometryCalculator(
                viewportWidth: viewportWidth,
                pages: state.pages,
              );
              _lastViewportWidth = viewportWidth;
            }

            // An toàn Resume: Chỉ nhảy vị trí một lần sau khi layout đầu tiên hoàn tất
            if (!_hasRestoredInitialPosition &&
                widget.initialPageIndex > 0 &&
                state.pages.isNotEmpty) {
              _hasRestoredInitialPosition = true;
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (!mounted || !_scrollController.hasClients) return;
                final targetOffset =
                    _geometryCalculator!.getOffsetForPage(widget.initialPageIndex);
                _scrollController.jumpTo(targetOffset);
              });
            }

            return NotificationListener<ScrollNotification>(
              onNotification: (notification) => _onScrollNotification(
                notification,
                viewportWidth,
                viewportHeight,
                targetWidth,
              ),
              child: ListView.builder(
                controller: _scrollController,
                physics: const BouncingScrollPhysics(),
                addAutomaticKeepAlives: false, // Evict widget khi ra khỏi viewport
                addRepaintBoundaries: true, // Phân tách render tree cho 120/144Hz
                itemCount: state.pages.length,
                itemBuilder: (context, index) {
                  final page = state.pages[index];
                  final shouldRetain = state.windowResult.shouldRetainBitmap(index);

                  return _WebtoonPageItem(
                    key: ValueKey('${page.assetId}_$index'),
                    page: page,
                    pageIndex: index,
                    shouldRetainBitmap: shouldRetain,
                    coordinator: widget.imageCacheCoordinator,
                    targetWidth: targetWidth,
                  );
                },
              ),
            );
          },
        );
      },
    );
  }
}

class _WebtoonPageItem extends StatefulWidget {
  final ChapterPage page;
  final int pageIndex;
  final bool shouldRetainBitmap;
  final ReaderImageCacheCoordinator coordinator;
  final int targetWidth;

  const _WebtoonPageItem({
    super.key,
    required this.page,
    required this.pageIndex,
    required this.shouldRetainBitmap,
    required this.coordinator,
    required this.targetWidth,
  });

  @override
  State<_WebtoonPageItem> createState() => _WebtoonPageItemState();
}

class _WebtoonPageItemState extends State<_WebtoonPageItem> {
  Future<String>? _urlFuture;
  bool _hasAutoRetried = false;
  bool _isAutoRetrying = false;

  @override
  void initState() {
    super.initState();
    if (widget.shouldRetainBitmap) {
      _urlFuture = widget.coordinator.getPageUrl(widget.page);
    }
  }

  @override
  void didUpdateWidget(covariant _WebtoonPageItem oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.shouldRetainBitmap && _urlFuture == null) {
      _urlFuture = widget.coordinator.getPageUrl(widget.page);
    }
  }

  void _triggerOneShotRecovery() {
    if (_hasAutoRetried || _isAutoRetrying) return;
    _hasAutoRetried = true;
    _isAutoRetrying = true;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      setState(() {
        _urlFuture = widget.coordinator.refreshPageUrl(widget.page).whenComplete(() {
          if (mounted) {
            setState(() {
              _isAutoRetrying = false;
            });
          }
        });
      });
    });
  }

  void _manualRetry() {
    setState(() {
      _hasAutoRetried = false;
      _isAutoRetrying = false;
      _urlFuture = widget.coordinator.refreshPageUrl(widget.page);
    });
  }

  @override
  Widget build(BuildContext context) {
    // Duy trì aspect ratio cố định để ngăn chặn hiện tượng giật nhảy layout (content jump)
    return AspectRatio(
      aspectRatio: widget.page.aspectRatio,
      child: Container(
        color: AppColors.oledBlack,
        alignment: Alignment.center,
        child: !widget.shouldRetainBitmap
            ? _buildPlaceholder(text: 'Trang ${widget.pageIndex + 1}')
            : FutureBuilder<String>(
                future: _urlFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting ||
                      _isAutoRetrying) {
                    return _buildLoadingPlaceholder();
                  }

                  if (snapshot.hasError || !snapshot.hasData) {
                    if (!_hasAutoRetried) {
                      _triggerOneShotRecovery();
                      return _buildLoadingPlaceholder();
                    }
                    return _buildErrorPlaceholder(onRetry: _manualRetry);
                  }

                  final downloadUrl = snapshot.data!;
                  final imageProvider = widget.coordinator.getImageProvider(
                    widget.page.assetId,
                    downloadUrl,
                    targetWidth: widget.targetWidth,
                    page: widget.page,
                  );

                  return Image(
                    image: imageProvider,
                    fit: BoxFit.fitWidth,
                    filterQuality: FilterQuality.medium,
                    errorBuilder: (context, error, stackTrace) {
                      if (!_hasAutoRetried) {
                        _triggerOneShotRecovery();
                        return _buildLoadingPlaceholder();
                      }
                      return _buildErrorPlaceholder(onRetry: _manualRetry);
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

  Widget _buildErrorPlaceholder({VoidCallback? onRetry}) {
    return Container(
      color: AppColors.darkSurface,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.broken_image, color: AppColors.textMuted, size: 32),
          const SizedBox(height: 8),
          const Text(
            'Lỗi tải ảnh',
            style: TextStyle(color: AppColors.textMuted, fontSize: 12),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 8),
            TextButton(
              onPressed: onRetry,
              child: const Text('Thử lại', style: TextStyle(fontSize: 12)),
            ),
          ],
        ],
      ),
    );
  }
}
