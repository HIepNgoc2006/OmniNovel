import 'dart:io';
import 'package:flutter/material.dart';
import '../models/novel_block_models.dart';
import 'novel_geometry_calculator.dart';
import 'novel_layout_metrics.dart';
import 'novel_settings_controller.dart';
import 'reading_progress_coordinator.dart';

/// Trình đọc tiểu thuyết / truyện chữ chuyên dụng (NovelReaderView)
///
/// **Các hợp đồng kỹ thuật cốt lõi (#198):**
/// 1. SSoT Resumption: Ưu tiên `anchorBlockId` -> `scrollPosition` (best-effort) -> `progressPercentage` (approximate).
/// 2. Capture Before Rebuild: Giữ vững vị trí đọc khi đổi cỡ chữ / giãn dòng.
/// 3. Báo cáo tiến độ: Tự động tính toán block index đang ở viewport đỉnh và thông báo tới `ReadingProgressCoordinator`.
/// 4. Đổi Theme màu: Chỉ kích hoạt color repaint (không re-layout hay jump offset).
/// 5. Offline Resolution (Phase 5D.5): Hỗ trợ Image.file cho ảnh minh họa cục bộ và strict whitelist chặn tải mạng.
class NovelReaderView extends StatefulWidget {
  final String storyId;
  final String chapterId;
  final String? chapterVersionId;
  final List<NovelBlockItem> blocks;
  final ReadingProgressCoordinator coordinator;
  final NovelSettingsController settingsController;
  final String? initialAnchorBlockId;
  final double? initialScrollPosition;
  final double? initialProgressPercentage;
  final bool isOffline;
  final Set<String>? allowedIllustrationPaths;
  final VoidCallback? onTap;
  final ValueChanged<String?>? onAnchorChanged;

  const NovelReaderView({
    super.key,
    required this.storyId,
    required this.chapterId,
    this.chapterVersionId,
    required this.blocks,
    required this.coordinator,
    required this.settingsController,
    this.initialAnchorBlockId,
    this.initialScrollPosition,
    this.initialProgressPercentage,
    this.isOffline = false,
    this.allowedIllustrationPaths,
    this.onTap,
    this.onAnchorChanged,
  });

  @override
  State<NovelReaderView> createState() => _NovelReaderViewState();
}

class _NovelReaderViewState extends State<NovelReaderView> {
  final ScrollController _scrollController = ScrollController();

  NovelGeometryCalculator? _calculator;
  NovelTypographySettings? _lastSettings;
  double? _lastWidth;
  bool _resumptionCompleted = false;
  String? _lastEmittedAnchor;

  void _emitAnchor(String? anchor) {
    if (_lastEmittedAnchor != anchor) {
      _lastEmittedAnchor = anchor;
      widget.onAnchorChanged?.call(anchor);
    }
  }

  @override
  void initState() {
    super.initState();
    widget.settingsController.addListener(_onSettingsChanged);
  }

  @override
  void dispose() {
    widget.settingsController.removeListener(_onSettingsChanged);
    _scrollController.dispose();
    super.dispose();
  }

  void _onSettingsChanged() {
    final newSettings = widget.settingsController.settings;
    if (_lastSettings != null &&
        NovelSettingsController.requiresGeometryRecalculation(_lastSettings!, newSettings)) {
      // 1. Capture: Đọc anchor block hiện tại ở đỉnh màn hình trước khi tính lại layout
      final currentOffset = _scrollController.hasClients ? _scrollController.offset : 0.0;
      final currentIdx = _calculator?.findIndexAtOffset(currentOffset) ?? 0;
      final currentAnchor = (currentIdx >= 0 && currentIdx < widget.blocks.length)
          ? widget.blocks[currentIdx].anchorBlockId
          : null;

      // 2. Cập nhật layout mới
      if (_lastWidth != null) {
        _calculator = NovelGeometryCalculator(
          blocks: widget.blocks,
          settings: newSettings,
          containerWidth: _lastWidth!,
        );

        // 3. Re-anchor: Cuộn tới anchor block đã lưu để người dùng không bị trôi vị trí
        if (currentAnchor != null) {
          final newOffset = _calculator!.getOffsetForAnchor(currentAnchor);
          if (newOffset != null) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (_scrollController.hasClients) {
                _scrollController.jumpTo(newOffset);
              }
            });
          }
        }
      }
    }
    _lastSettings = newSettings;
    setState(() {});
  }

  void _performInitialResumption() {
    if (_resumptionCompleted || _calculator == null) return;
    _resumptionCompleted = true;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;

      // 1. Ưu tiên cao nhất: Canonical anchorBlockId
      if (widget.initialAnchorBlockId != null) {
        final targetOffset = _calculator!.getOffsetForAnchor(widget.initialAnchorBlockId);
        if (targetOffset != null) {
          _scrollController.jumpTo(targetOffset);
          return;
        }
      }

      // 2. Ưu tiên thứ hai: scrollPosition (best-effort cho Legacy HTML)
      if (widget.initialScrollPosition != null && widget.initialScrollPosition! > 0.0) {
        final maxScroll = _scrollController.position.maxScrollExtent;
        final target = widget.initialScrollPosition!.clamp(0.0, maxScroll);
        _scrollController.jumpTo(target);
        return;
      }

      // 3. Ưu tiên thứ ba: progressPercentage (approximate fallback cho Legacy HTML)
      if (widget.initialProgressPercentage != null && widget.initialProgressPercentage! > 0.0) {
        final maxScroll = _scrollController.position.maxScrollExtent;
        final target = (widget.initialProgressPercentage! / 100.0 * maxScroll).clamp(0.0, maxScroll);
        _scrollController.jumpTo(target);
        return;
      }

      // 4. Mặc định: Đầu chương (0.0)
      final currentOffset = _scrollController.hasClients ? _scrollController.offset : 0.0;
      final currentIdx = _calculator?.findIndexAtOffset(currentOffset) ?? 0;
      final currentAnchor = (currentIdx >= 0 && currentIdx < widget.blocks.length)
          ? widget.blocks[currentIdx].anchorBlockId
          : null;
      _emitAnchor(currentAnchor);
    });
  }

  void _onScrollNotification(ScrollNotification notification) {
    if (_calculator == null || widget.blocks.isEmpty) return;

    final offset = notification.metrics.pixels;
    final currentIdx = _calculator!.findIndexAtOffset(offset);
    final currentBlock = widget.blocks[currentIdx];

    _emitAnchor(currentBlock.anchorBlockId);

    final maxScroll = notification.metrics.maxScrollExtent;
    final progressPercentage = maxScroll > 0.0 ? (offset / maxScroll * 100.0).clamp(0.0, 100.0) : 0.0;

    widget.coordinator.recordProgress(
      storyId: widget.storyId,
      chapterId: widget.chapterId,
      chapterVersionId: widget.chapterVersionId,
      readingMode: 'NOVEL',
      flutterPageIndex: 0,
      progressPercentage: progressPercentage,
      scrollPosition: offset,
      anchorBlockId: currentBlock.anchorBlockId,
      textOffset: 0,
    );
  }

  @override
  Widget build(BuildContext context) {
    final settings = widget.settingsController.settings;
    final theme = settings.theme;

    return LayoutBuilder(
      builder: (context, constraints) {
        if (_calculator == null || _lastWidth != constraints.maxWidth) {
          _lastWidth = constraints.maxWidth;
          _lastSettings = settings;
          _calculator = NovelGeometryCalculator(
            blocks: widget.blocks,
            settings: settings,
            containerWidth: constraints.maxWidth,
          );
          _performInitialResumption();
        }

        return Container(
          color: theme.backgroundColor,
          child: GestureDetector(
            onTap: widget.onTap,
            behavior: HitTestBehavior.opaque,
            child: NotificationListener<ScrollNotification>(
              onNotification: (notification) {
                if (notification is ScrollUpdateNotification) {
                  _onScrollNotification(notification);
                }
                return false;
              },
              child: ListView.builder(
                controller: _scrollController,
                physics: const AlwaysScrollableScrollPhysics(),
                padding: EdgeInsets.symmetric(
                  horizontal: settings.horizontalPadding,
                  vertical: 24.0,
                ),
                itemCount: widget.blocks.length,
                itemBuilder: (context, index) {
                  final block = widget.blocks[index];
                  return Padding(
                    padding: EdgeInsets.only(
                      bottom: block.isDivider ? 8.0 : settings.paragraphSpacing,
                    ),
                    child: _NovelBlockWidget(
                      block: block,
                      settings: settings,
                      isOffline: widget.isOffline,
                      allowedIllustrationPaths: widget.allowedIllustrationPaths,
                    ),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Widget hiển thị từng block đoạn văn theo quy chuẩn NovelLayoutMetrics
class _NovelBlockWidget extends StatelessWidget {
  final NovelBlockItem block;
  final NovelTypographySettings settings;
  final bool isOffline;
  final Set<String>? allowedIllustrationPaths;

  const _NovelBlockWidget({
    required this.block,
    required this.settings,
    this.isOffline = false,
    this.allowedIllustrationPaths,
  });

  @override
  Widget build(BuildContext context) {
    final theme = settings.theme;

    if (block.isDivider) {
      return SizedBox(
        height: NovelLayoutMetrics.dividerHeight,
        child: Center(
          child: Divider(
            color: theme.dividerColor,
            thickness: 1.0,
            indent: 40.0,
            endIndent: 40.0,
          ),
        ),
      );
    }

    if (block.isIllustration) {
      final src = block.illustrationSrc;
      final isLocal = src != null && !src.startsWith('http://') && !src.startsWith('https://');

      Widget imageWidget;
      if (src == null || src.isEmpty) {
        imageWidget = const SizedBox.shrink();
      } else if (isLocal) {
        final filePath = src.startsWith('file://') ? src.replaceFirst('file://', '') : src;
        // P1.1 Strict Canonical Whitelist:
        // Ở chế độ offline (hoặc khi có allowedIllustrationPaths), CHỈ render ảnh cục bộ
        // nếu đường dẫn tuyệt đối nằm chính xác trong allowedIllustrationPaths từ manifest.
        // Mọi đường dẫn lạ (/data/..., relative, file:///etc/...) ngoài whitelist đều bị chặn!
        final isAllowed = !isOffline ||
            (allowedIllustrationPaths != null && allowedIllustrationPaths!.contains(filePath));

        if (isAllowed) {
          imageWidget = Image.file(
            File(filePath),
            fit: BoxFit.contain,
            errorBuilder: (_, __, ___) => Container(
              height: 180.0,
              color: theme.cardBackgroundColor,
              child: Center(
                child: Icon(Icons.broken_image, color: theme.secondaryTextColor),
              ),
            ),
          );
        } else {
          // Chặn các đường dẫn local không hợp lệ nằm ngoài whitelist
          imageWidget = Container(
            height: 180.0,
            color: theme.cardBackgroundColor,
            child: Center(
              child: Icon(Icons.broken_image, color: theme.secondaryTextColor),
            ),
          );
        }
      } else if (isOffline) {
        // P1.2 Strict Whitelist: Chặn tuyệt đối tải ảnh ngoại lai qua mạng khi ở chế độ offline
        imageWidget = Container(
          height: 180.0,
          color: theme.cardBackgroundColor,
          child: Center(
            child: Icon(Icons.broken_image, color: theme.secondaryTextColor),
          ),
        );
      } else {
        imageWidget = Image.network(
          src,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => Container(
            height: 180.0,
            color: theme.cardBackgroundColor,
            child: Center(
              child: Icon(Icons.broken_image, color: theme.secondaryTextColor),
            ),
          ),
        );
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8.0),
            child: imageWidget,
          ),
          if (block.illustrationCaption != null && block.illustrationCaption!.isNotEmpty) ...[
            const SizedBox(height: 8.0),
            Text(
              block.illustrationCaption!,
              textAlign: TextAlign.center,
              style: settings.fontFamily.textStyle(
                fontSize: settings.fontSize * 0.85,
                color: theme.secondaryTextColor,
                fontStyle: FontStyle.italic,
              ),
            ),
          ],
        ],
      );
    }

    if (block.isBlockquote) {
      return Container(
        decoration: BoxDecoration(
          color: theme.cardBackgroundColor.withValues(alpha: 0.5),
          border: Border(
            left: BorderSide(
              color: theme.blockquoteBorderColor,
              width: NovelLayoutMetrics.blockquoteBorderWidth,
            ),
          ),
          borderRadius: const BorderRadius.horizontal(right: Radius.circular(8.0)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        child: Text.rich(
          NovelLayoutMetrics.buildRichTextSpan(block, settings),
        ),
      );
    }

    // Heading, Dialogue, Narration thông thường
    return Text.rich(
      NovelLayoutMetrics.buildRichTextSpan(block, settings),
    );
  }
}
