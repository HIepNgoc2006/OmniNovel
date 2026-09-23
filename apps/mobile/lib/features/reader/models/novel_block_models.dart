import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Các phân loại khối văn bản trong tài liệu Novel (#198)
enum NovelBlockType {
  heading,
  dialogue,
  narration,
  blockquote,
  illustration,
  divider,
}

/// 4 chủ đề đọc truyện chữ tối ưu cho mắt và tấm nền màn hình
enum NovelReadingTheme {
  light,
  sepia,
  dark,
  oled,
}

extension NovelReadingThemeExtension on NovelReadingTheme {
  String get displayName {
    switch (this) {
      case NovelReadingTheme.light:
        return 'Sáng';
      case NovelReadingTheme.sepia:
        return 'Sepia';
      case NovelReadingTheme.dark:
        return 'Tối';
      case NovelReadingTheme.oled:
        return 'OLED';
    }
  }

  Color get backgroundColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFFFAF9F6);
      case NovelReadingTheme.sepia:
        return const Color(0xFFF4ECD8);
      case NovelReadingTheme.dark:
        return const Color(0xFF1E1E1E);
      case NovelReadingTheme.oled:
        return const Color(0xFF000000);
    }
  }

  Color get textColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFF1A1A1A);
      case NovelReadingTheme.sepia:
        return const Color(0xFF5B4636);
      case NovelReadingTheme.dark:
        return const Color(0xFFD1D5DB);
      case NovelReadingTheme.oled:
        return const Color(0xFFE5E7EB);
    }
  }

  Color get secondaryTextColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFF6B7280);
      case NovelReadingTheme.sepia:
        return const Color(0xFF8C7355);
      case NovelReadingTheme.dark:
        return const Color(0xFF9CA3AF);
      case NovelReadingTheme.oled:
        return const Color(0xFF6B7280);
    }
  }

  Color get dividerColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFFE5E7EB);
      case NovelReadingTheme.sepia:
        return const Color(0xFFD8CCB0);
      case NovelReadingTheme.dark:
        return const Color(0xFF374151);
      case NovelReadingTheme.oled:
        return const Color(0xFF262626);
    }
  }

  Color get cardBackgroundColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFFF3F4F6);
      case NovelReadingTheme.sepia:
        return const Color(0xFFECE1C4);
      case NovelReadingTheme.dark:
        return const Color(0xFF262626);
      case NovelReadingTheme.oled:
        return const Color(0xFF171717);
    }
  }

  Color get blockquoteBorderColor {
    switch (this) {
      case NovelReadingTheme.light:
        return const Color(0xFF3B82F6);
      case NovelReadingTheme.sepia:
        return const Color(0xFFA67C52);
      case NovelReadingTheme.dark:
        return const Color(0xFF60A5FA);
      case NovelReadingTheme.oled:
        return const Color(0xFF3B82F6);
    }
  }
}

/// Font chữ tiểu thuyết: Sans-serif hiện đại vs Serif cổ điển
enum NovelFontFamily {
  sansSerif,
  serif,
}

extension NovelFontFamilyExtension on NovelFontFamily {
  String get displayName {
    switch (this) {
      case NovelFontFamily.sansSerif:
        return 'Không chân (Sans)';
      case NovelFontFamily.serif:
        return 'Có chân (Serif)';
    }
  }

  TextStyle textStyle({
    required double fontSize,
    required Color color,
    double? height,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
  }) {
    if (!GoogleFonts.config.allowRuntimeFetching) {
      return TextStyle(
        fontSize: fontSize,
        color: color,
        height: height,
        fontWeight: fontWeight,
        fontStyle: fontStyle,
      );
    }

    switch (this) {
      case NovelFontFamily.sansSerif:
        return GoogleFonts.inter(
          fontSize: fontSize,
          color: color,
          height: height,
          fontWeight: fontWeight,
          fontStyle: fontStyle,
        );
      case NovelFontFamily.serif:
        return GoogleFonts.literata(
          fontSize: fontSize,
          color: color,
          height: height,
          fontWeight: fontWeight,
          fontStyle: fontStyle,
        );
    }
  }
}

/// Cấu hình hiển thị Typography và Theme đọc truyện chữ
class NovelTypographySettings {
  final double fontSize;
  final double lineHeightMultiplier;
  final NovelFontFamily fontFamily;
  final NovelReadingTheme theme;
  final double horizontalPadding;
  final double paragraphSpacing;

  const NovelTypographySettings({
    this.fontSize = 18.0,
    this.lineHeightMultiplier = 1.6,
    this.fontFamily = NovelFontFamily.sansSerif,
    this.theme = NovelReadingTheme.light,
    this.horizontalPadding = 20.0,
    this.paragraphSpacing = 16.0,
  });

  NovelTypographySettings copyWith({
    double? fontSize,
    double? lineHeightMultiplier,
    NovelFontFamily? fontFamily,
    NovelReadingTheme? theme,
    double? horizontalPadding,
    double? paragraphSpacing,
  }) {
    return NovelTypographySettings(
      fontSize: fontSize ?? this.fontSize,
      lineHeightMultiplier: lineHeightMultiplier ?? this.lineHeightMultiplier,
      fontFamily: fontFamily ?? this.fontFamily,
      theme: theme ?? this.theme,
      horizontalPadding: horizontalPadding ?? this.horizontalPadding,
      paragraphSpacing: paragraphSpacing ?? this.paragraphSpacing,
    );
  }

  Map<String, dynamic> toJson() => {
        'fontSize': fontSize,
        'lineHeightMultiplier': lineHeightMultiplier,
        'fontFamily': fontFamily.name,
        'theme': theme.name,
        'horizontalPadding': horizontalPadding,
        'paragraphSpacing': paragraphSpacing,
      };

  factory NovelTypographySettings.fromJson(Map<String, dynamic> json) {
    return NovelTypographySettings(
      fontSize: (json['fontSize'] as num?)?.toDouble() ?? 18.0,
      lineHeightMultiplier:
          (json['lineHeightMultiplier'] as num?)?.toDouble() ?? 1.6,
      fontFamily: json['fontFamily'] == 'serif'
          ? NovelFontFamily.serif
          : NovelFontFamily.sansSerif,
      theme: NovelReadingTheme.values.firstWhere(
        (t) => t.name == json['theme'],
        orElse: () => NovelReadingTheme.light,
      ),
      horizontalPadding:
          (json['horizontalPadding'] as num?)?.toDouble() ?? 20.0,
      paragraphSpacing: (json['paragraphSpacing'] as num?)?.toDouble() ?? 16.0,
    );
  }
}

/// Cấu trúc các node dòng (Inline Spans)
abstract class NovelInlineSpan {
  const NovelInlineSpan();
}

class TextSpanItem extends NovelInlineSpan {
  final String text;
  final bool isBold;
  final bool isItalic;

  const TextSpanItem({
    required this.text,
    this.isBold = false,
    this.isItalic = false,
  });
}

class RubySpanItem extends NovelInlineSpan {
  final String baseText;
  final String rubyText;
  final String? parenthesisText;

  const RubySpanItem({
    required this.baseText,
    required this.rubyText,
    this.parenthesisText,
  });
}

class InlineIllustrationItem extends NovelInlineSpan {
  final String src;
  final String? alt;

  const InlineIllustrationItem({
    required this.src,
    this.alt,
  });
}

/// Khối nội dung trong truyện chữ (Novel Block Item)
class NovelBlockItem {
  /// Canonical Anchor ID do pipeline phát hành (hoặc null nếu là legacy HTML)
  final String? anchorBlockId;

  /// Phân loại khối (Heading, Narration, Dialogue, Blockquote, Illustration, Divider)
  final NovelBlockType blockType;

  /// Danh sách các span nội dòng (Text, Ruby, Inline Image)
  final List<NovelInlineSpan> inlineSpans;

  /// Chuỗi thuần túy phục vụ tính toán layout / plain-text preview
  final String rawText;

  /// Cấp độ tiêu đề (1-6) nếu là heading
  final int level;

  /// Đường dẫn hình ảnh minh họa (nếu là khối illustration)
  final String? illustrationSrc;

  /// Chú thích ảnh minh họa
  final String? illustrationCaption;

  /// Alt text của ảnh minh họa
  final String? illustrationAlt;

  const NovelBlockItem({
    this.anchorBlockId,
    required this.blockType,
    this.inlineSpans = const [],
    required this.rawText,
    this.level = 1,
    this.illustrationSrc,
    this.illustrationCaption,
    this.illustrationAlt,
  });

  bool get isHeading => blockType == NovelBlockType.heading;
  bool get isIllustration => blockType == NovelBlockType.illustration;
  bool get isDivider => blockType == NovelBlockType.divider;
  bool get isBlockquote => blockType == NovelBlockType.blockquote;
}
