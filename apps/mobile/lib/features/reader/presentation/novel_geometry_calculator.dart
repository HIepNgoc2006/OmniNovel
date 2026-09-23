import 'package:flutter/material.dart';
import '../models/novel_block_models.dart';
import 'novel_layout_metrics.dart';

/// Máy tính hình học đo đạc kích thước và vị trí cuộn cho từng khối văn bản (Novel Geometry Calculator).
///
/// Hỗ trợ:
/// 1. Tính toán chiều cao chính xác từng block dựa trên TextPainter và NovelLayoutMetrics.
/// 2. Mảng offset tích lũy (`cumulativeOffsets`) phục vụ binary search vị trí cuộn O(log N).
/// 3. Định vị chính xác offset cuộn cho `anchorBlockId` (Block-Level Exact Resume).
class NovelGeometryCalculator {
  final List<NovelBlockItem> blocks;
  final NovelTypographySettings settings;
  final double contentWidth;

  final List<double> blockHeights = [];
  final List<double> cumulativeOffsets = [];
  final Map<String, int> _anchorToIndexMap = {};

  double totalHeight = 0.0;

  NovelGeometryCalculator({
    required this.blocks,
    required this.settings,
    required double containerWidth,
  }) : contentWidth = (containerWidth - (settings.horizontalPadding * 2)).clamp(100.0, 4000.0) {
    _calculateGeometry();
  }

  void _calculateGeometry() {
    blockHeights.clear();
    cumulativeOffsets.clear();
    _anchorToIndexMap.clear();

    double currentOffset = 0.0;

    for (int i = 0; i < blocks.length; i++) {
      final block = blocks[i];

      // Ghi nhận map anchor
      if (block.anchorBlockId != null && block.anchorBlockId!.isNotEmpty) {
        _anchorToIndexMap[block.anchorBlockId!] = i;
      }

      cumulativeOffsets.add(currentOffset);

      final height = _measureBlockHeight(block);
      blockHeights.add(height);

      // Cộng thêm khoảng cách đoạn (spacing) giữa các block
      final spacing = block.isDivider ? 8.0 : settings.paragraphSpacing;
      currentOffset += height + spacing;
    }

    totalHeight = currentOffset;
  }

  double _measureBlockHeight(NovelBlockItem block) {
    if (block.isDivider) {
      return NovelLayoutMetrics.dividerHeight;
    }

    if (block.isIllustration) {
      double height = NovelLayoutMetrics.illustrationDefaultHeight;
      if (block.illustrationCaption != null && block.illustrationCaption!.isNotEmpty) {
        final textSpan = TextSpan(
          text: block.illustrationCaption,
          style: settings.fontFamily.textStyle(
            fontSize: settings.fontSize * 0.85,
            color: settings.theme.secondaryTextColor,
          ),
        );
        final painter = TextPainter(
          text: textSpan,
          textDirection: TextDirection.ltr,
          maxLines: 3,
        )..layout(maxWidth: contentWidth);
        height += painter.size.height + 12.0; // Margin caption
      }
      return height;
    }

    // Với Text, Heading, Blockquote
    double textAvailableWidth = contentWidth;
    if (block.isBlockquote) {
      textAvailableWidth -= (NovelLayoutMetrics.blockquoteBorderWidth + NovelLayoutMetrics.blockquoteLeftPadding + 16.0);
    }
    textAvailableWidth = textAvailableWidth.clamp(50.0, 4000.0);

    final textSpan = NovelLayoutMetrics.buildRichTextSpan(block, settings);
    final painter = TextPainter(
      text: textSpan,
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: textAvailableWidth);

    double blockHeight = painter.size.height;
    if (block.isBlockquote) {
      blockHeight += 16.0; // Padding trên dưới của blockquote
    }

    return blockHeight;
  }

  /// Tìm block index đang nằm ở vị trí cuộn `scrollOffset` bằng Binary Search O(log N)
  int findIndexAtOffset(double scrollOffset) {
    if (blocks.isEmpty) return 0;
    if (scrollOffset <= 0.0) return 0;
    if (scrollOffset >= totalHeight) return blocks.length - 1;

    int low = 0;
    int high = cumulativeOffsets.length - 1;
    int candidate = 0;

    while (low <= high) {
      final mid = (low + high) ~/ 2;
      final startOffset = cumulativeOffsets[mid];

      if (startOffset <= scrollOffset) {
        candidate = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return candidate.clamp(0, blocks.length - 1);
  }

  /// Lấy offset Y chuẩn xác để cuộn tới đầu một `anchorBlockId`
  double? getOffsetForAnchor(String? anchorBlockId) {
    if (anchorBlockId == null) return null;
    final index = _anchorToIndexMap[anchorBlockId];
    if (index == null || index < 0 || index >= cumulativeOffsets.length) {
      return null;
    }
    return cumulativeOffsets[index];
  }

  /// Lấy offset Y theo index
  double getOffsetForIndex(int index) {
    if (index <= 0 || cumulativeOffsets.isEmpty) return 0.0;
    if (index >= cumulativeOffsets.length) return cumulativeOffsets.last;
    return cumulativeOffsets[index];
  }
}
