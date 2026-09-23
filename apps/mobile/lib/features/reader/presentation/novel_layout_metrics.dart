import 'package:flutter/material.dart';
import '../models/novel_block_models.dart';

/// Single Source of Truth (SSoT) định nghĩa các quy tắc layout và kiểu chữ (Typography)
/// dùng chung 100% giữa `NovelGeometryCalculator` (đo đạc kích thước) và widget hiển thị.
class NovelLayoutMetrics {
  static const double dividerHeight = 24.0;
  static const double illustrationDefaultHeight = 300.0;
  static const double blockquoteBorderWidth = 4.0;
  static const double blockquoteLeftPadding = 16.0;

  /// Lấy hệ số phóng đại font chữ theo cấp độ tiêu đề
  static double getHeadingMultiplier(int level) {
    switch (level) {
      case 1:
        return 1.5;
      case 2:
        return 1.35;
      case 3:
        return 1.2;
      case 4:
        return 1.1;
      default:
        return 1.0;
    }
  }

  /// Trả về TextStyle cơ sở cho từng block theo cấu hình typography hiện tại
  static TextStyle resolveBaseTextStyle(
    NovelBlockItem block,
    NovelTypographySettings settings, {
    Color? overrideColor,
  }) {
    final textColor = overrideColor ?? settings.theme.textColor;
    double baseSize = settings.fontSize;
    FontWeight weight = FontWeight.normal;
    FontStyle style = FontStyle.normal;

    if (block.isHeading) {
      baseSize *= getHeadingMultiplier(block.level);
      weight = FontWeight.bold;
    } else if (block.blockType == NovelBlockType.dialogue) {
      weight = FontWeight.w500;
    } else if (block.blockType == NovelBlockType.blockquote) {
      style = FontStyle.italic;
    }

    return settings.fontFamily.textStyle(
      fontSize: baseSize,
      color: textColor,
      height: settings.lineHeightMultiplier,
      fontWeight: weight,
      fontStyle: style,
    );
  }

  /// Xây dựng TextSpan hoàn chỉnh (bao gồm inline bold, italic, ruby)
  static TextSpan buildRichTextSpan(
    NovelBlockItem block,
    NovelTypographySettings settings, {
    Color? overrideColor,
  }) {
    final baseStyle = resolveBaseTextStyle(block, settings, overrideColor: overrideColor);

    if (block.inlineSpans.isEmpty) {
      return TextSpan(text: block.rawText, style: baseStyle);
    }

    final children = <InlineSpan>[];

    for (final item in block.inlineSpans) {
      if (item is TextSpanItem) {
        children.add(
          TextSpan(
            text: item.text,
            style: baseStyle.copyWith(
              fontWeight: item.isBold ? FontWeight.bold : baseStyle.fontWeight,
              fontStyle: item.isItalic ? FontStyle.italic : baseStyle.fontStyle,
            ),
          ),
        );
      } else if (item is RubySpanItem) {
        // Render ngữ nghĩa Ruby: "baseText (rubyText)"
        final rubyAnnotation = item.parenthesisText != null
            ? '${item.baseText}(${item.rubyText})'
            : '${item.baseText} (${item.rubyText})';

        children.add(
          TextSpan(
            text: rubyAnnotation,
            style: baseStyle.copyWith(
              color: settings.theme.secondaryTextColor,
            ),
          ),
        );
      }
    }

    return TextSpan(children: children, style: baseStyle);
  }
}
