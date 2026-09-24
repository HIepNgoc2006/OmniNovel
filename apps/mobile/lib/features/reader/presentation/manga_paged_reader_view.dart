import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../models/manga_reading_mode.dart';
import '../models/reader_models.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_controller.dart';
import 'reader_session_state.dart';

/// Widget hiển thị Manga lật trang chuyên dụng (Manga Paged Reader)
/// Hỗ trợ cả 2 chế độ:
/// - Manga RTL: Lật từ Phải sang Trái (Chuẩn Nhật Bản)
/// - Comic LTR: Lật từ Trái sang Phải (Chuẩn Tây phương)
/// Tái sử dụng 100% hạ tầng ReaderSessionController & ReaderImageCacheCoordinator
class MangaPagedReaderView extends StatefulWidget {
  /// Ngưỡng zoom cố định thống nhất: Phóng to vượt ngưỡng này sẽ khóa vuốt PageView
  static const double zoomLockThreshold = 1.05;

  final ReaderSessionController sessionController;
  final ReaderImageCacheCoordinator imageCacheCoordinator;
  final PageController pageController;
  final MangaReadingMode mode;
  final VoidCallback? onToggleHud;
  final void Function(int pageIndex, double progressPercentage, double scrollOffset)?
      onProgressChanged;

  const MangaPagedReaderView({
    super.key,
    required this.sessionController,
    required this.imageCacheCoordinator,
    required this.pageController,
    required this.mode,
    this.onToggleHud,
    this.onProgressChanged,
  });

  @override
  State<MangaPagedReaderView> createState() => _MangaPagedReaderViewState();
}

class _MangaPagedReaderViewState extends State<MangaPagedReaderView> {
  bool _isZoomed = false;

  void _onZoomChanged(bool isZoomed, double scale) {
    if (_isZoomed != isZoomed) {
      setState(() {
        _isZoomed = isZoomed;
      });
    }
  }

  void _handlePageChanged(int index, int targetWidth) {
    final totalPages = widget.sessionController.state.totalPages;
    if (totalPages == 0) return;

    // Reset zoom lock khi chuyển trang
    if (_isZoomed) {
      setState(() {
        _isZoomed = false;
      });
    }

    // 1. Kích hoạt chính sách 3 vùng bộ nhớ: Evict distant pages và Prefetch adjacent
    widget.sessionController.updateVisibleRange(
      context: context,
      startIndex: index,
      endIndex: index,
      focusedIndex: index,
      scrollOffset: index.toDouble(),
      maxScrollOffset: (totalPages - 1).toDouble(),
      targetWidth: targetWidth,
    );

    // 2. Tính toán tiến độ đọc (xử lý an toàn chapter 1 trang = 100%)
    final progress = totalPages <= 1
        ? 100.0
        : (((index + 1) / totalPages) * 100).clamp(0.0, 100.0);

    // 3. Báo cáo tiến độ (với paged mode, scrollOffset = index.toDouble())
    widget.onProgressChanged?.call(index, progress, index.toDouble());
  }

  void _nextPage() {
    final current = widget.sessionController.state.focusedPageIndex;
    final total = widget.sessionController.state.totalPages;
    if (current < total - 1 && widget.pageController.hasClients) {
      widget.pageController.animateToPage(
        current + 1,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeInOut,
      );
    }
  }

  void _previousPage() {
    final current = widget.sessionController.state.focusedPageIndex;
    if (current > 0 && widget.pageController.hasClients) {
      widget.pageController.animateToPage(
        current - 1,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeInOut,
      );
    }
  }

  void _handleTapUp(TapUpDetails details, BoxConstraints constraints) {
    final x = details.localPosition.dx;
    final w = constraints.maxWidth;

    // 1. Khi đang phóng to (isZoomed): Vô hiệu hóa tap lật trang, chỉ cho phép toggle HUD vùng giữa
    if (_isZoomed) {
      if (x >= w * 0.3 && x <= w * 0.7) {
        widget.onToggleHud?.call();
      }
      return;
    }

    // 2. Vùng trung tâm (30% - 70%): Bật / tắt HUD
    if (x >= w * 0.3 && x <= w * 0.7) {
      widget.onToggleHud?.call();
      return;
    }

    // 3. Phân vùng Trái / Phải theo chuẩn đọc
    final isRtl = widget.mode == MangaReadingMode.rtl;
    if (x < w * 0.3) {
      // Vùng Trái (0 - 30%)
      if (isRtl) {
        _nextPage();
      } else {
        _previousPage();
      }
    } else if (x > w * 0.7) {
      // Vùng Phải (70% - 100%)
      if (isRtl) {
        _previousPage();
      } else {
        _nextPage();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.sessionController,
      builder: (context, _) {
        final state = widget.sessionController.state;

        if (state.status == ReaderStatus.loading || state.status == ReaderStatus.initial) {
          return Center(
            child: CircularProgressIndicator(color: context.primaryColor),
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
                    state.errorMessage ?? 'Không thể tải chương truyện',
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
            final dpr = MediaQuery.of(context).devicePixelRatio;
            final targetWidth = (viewportWidth * dpr).round().clamp(720, 1600);

            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (details) => _handleTapUp(details, constraints),
              child: PageView.builder(
                controller: widget.pageController,
                reverse: widget.mode == MangaReadingMode.rtl,
                physics: _isZoomed
                    ? const NeverScrollableScrollPhysics()
                    : const ClampingScrollPhysics(),
                itemCount: state.pages.length,
                onPageChanged: (index) => _handlePageChanged(index, targetWidth),
                itemBuilder: (context, index) {
                  final page = state.pages[index];
                  final isFocused = state.focusedPageIndex == index;
                  final shouldRetain = state.windowResult.shouldRetainBitmap(index);

                  return _MangaPageItem(
                    key: ValueKey('${page.assetId}_$index'),
                    page: page,
                    pageIndex: index,
                    isActive: isFocused,
                    shouldRetainBitmap: shouldRetain,
                    coordinator: widget.imageCacheCoordinator,
                    targetWidth: targetWidth,
                    onZoomChanged: _onZoomChanged,
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

/// Mỗi trang truyện quản lý độc lập TransformationController của chính nó
class _MangaPageItem extends StatefulWidget {
  final ChapterPage page;
  final int pageIndex;
  final bool isActive;
  final bool shouldRetainBitmap;
  final ReaderImageCacheCoordinator coordinator;
  final int targetWidth;
  final void Function(bool isZoomed, double scale) onZoomChanged;

  const _MangaPageItem({
    super.key,
    required this.page,
    required this.pageIndex,
    required this.isActive,
    required this.shouldRetainBitmap,
    required this.coordinator,
    required this.targetWidth,
    required this.onZoomChanged,
  });

  @override
  State<_MangaPageItem> createState() => _MangaPageItemState();
}

class _MangaPageItemState extends State<_MangaPageItem> {
  late final TransformationController _transformationController;
  Future<String>? _urlFuture;
  bool _hasAutoRetried = false;
  bool _isAutoRetrying = false;

  @override
  void initState() {
    super.initState();
    _transformationController = TransformationController();
    _transformationController.addListener(_handleTransformChanged);

    if (widget.shouldRetainBitmap) {
      _urlFuture = widget.coordinator.getPageUrl(widget.page);
    }
  }

  void _handleTransformChanged() {
    if (!mounted || !widget.isActive) return;
    final scale = _transformationController.value.getMaxScaleOnAxis();
    widget.onZoomChanged(scale > MangaPagedReaderView.zoomLockThreshold, scale);
  }

  @override
  void didUpdateWidget(covariant _MangaPageItem oldWidget) {
    super.didUpdateWidget(oldWidget);

    // Khi trang mất active: lập tức reset scale về 1.0
    if (!widget.isActive && oldWidget.isActive) {
      final currentScale = _transformationController.value.getMaxScaleOnAxis();
      if (currentScale > 1.0) {
        _transformationController.value = Matrix4.identity();
      }
    }

    if (!oldWidget.shouldRetainBitmap && widget.shouldRetainBitmap) {
      _urlFuture = widget.coordinator.getPageUrl(widget.page);
    }
  }

  @override
  void dispose() {
    _transformationController.removeListener(_handleTransformChanged);
    _transformationController.dispose();
    super.dispose();
  }

  void _handleImageError(Object error) {
    if (_hasAutoRetried || _isAutoRetrying || !mounted) return;

    final errStr = error.toString().toLowerCase();
    final isHttp403 = errStr.contains('403') || errStr.contains('forbidden');

    if (isHttp403) {
      _hasAutoRetried = true;
      _isAutoRetrying = true;

      widget.coordinator.refreshPageUrl(widget.page).then((newUrl) {
        if (!mounted) return;
        setState(() {
          _isAutoRetrying = false;
          _urlFuture = Future.value(newUrl);
        });
      }).catchError((_) {
        if (!mounted) return;
        setState(() {
          _isAutoRetrying = false;
        });
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // Nếu trang nằm ngoài vùng window (distant page) -> không decode bitmap
    if (!widget.shouldRetainBitmap) {
      return Container(
        color: AppColors.oledBlack,
        alignment: Alignment.center,
        child: const Text(
          'Đang dọn bộ nhớ đệm...',
          style: TextStyle(color: AppColors.textMuted, fontSize: 12),
        ),
      );
    }

    return InteractiveViewer(
      transformationController: _transformationController,
      minScale: 1.0,
      maxScale: 3.5,
      clipBehavior: Clip.none,
      child: FutureBuilder<String>(
        future: _urlFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting || _isAutoRetrying) {
            return Container(
              color: AppColors.oledBlack,
              alignment: Alignment.center,
              child: SizedBox(
                width: 32,
                height: 32,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: context.primaryLightColor,
                ),
              ),
            );
          }

          if (snapshot.hasError || !snapshot.hasData || snapshot.data!.isEmpty) {
            return Container(
              color: AppColors.oledBlack,
              alignment: Alignment.center,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.broken_image_outlined, color: AppColors.error, size: 40),
                  const SizedBox(height: 8),
                  Text(
                    'Không thể tải ảnh trang ${widget.pageIndex + 1}',
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                  ),
                ],
              ),
            );
          }

          final downloadUrl = snapshot.data!;
          final imageProvider = widget.coordinator.getImageProvider(
            widget.page.assetId,
            downloadUrl,
            targetWidth: widget.targetWidth,
            page: widget.page,
          );

          return Container(
            color: AppColors.oledBlack,
            alignment: Alignment.center,
            child: Image(
              image: imageProvider,
              fit: BoxFit.contain,
              width: double.infinity,
              height: double.infinity,
              errorBuilder: (context, error, stackTrace) {
                _handleImageError(error);
                return Container(
                  color: AppColors.oledBlack,
                  alignment: Alignment.center,
                  child: const Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.broken_image, color: AppColors.error, size: 36),
                      SizedBox(height: 6),
                      Text(
                        'Lỗi giải mã ảnh',
                        style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                      ),
                    ],
                  ),
                );
              },
              frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
                if (wasSynchronouslyLoaded || frame != null) {
                  return child;
                }
                return Container(
                  color: AppColors.oledBlack,
                  alignment: Alignment.center,
                  child: SizedBox(
                    width: 28,
                    height: 28,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: context.primaryColor,
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
