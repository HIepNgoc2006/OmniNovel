import 'package:flutter/material.dart';

/// Bảng màu cho 6 Rank Themes canonical trong OmniNovel
class RankThemePalette {
  static const Color defaultPrimary = Color(0xFF8B5CF6); // Modern Violet
  static const Color tuTienPrimary = Color(0xFF10B981);  // Emerald Jade
  static const Color gamePrimary = Color(0xFF06B6D4);    // Cyan System
  static const Color demonKingPrimary = Color(0xFFE11D48); // Crimson Rose
  static const Color magicianPrimary = Color(0xFF9333EA); // Arcane Purple
  static const Color sciFiPrimary = Color(0xFF0EA5E9);   // Neon Sky

  static const Map<String, Color> themeColors = {
    'DEFAULT': defaultPrimary,
    'TU_TIEN': tuTienPrimary,
    'GAME': gamePrimary,
    'DEMON_KING': demonKingPrimary,
    'MAGICIAN': magicianPrimary,
    'SCI_FI': sciFiPrimary,
  };

  static Color getPrimary(String? themeId) {
    if (themeId == null) return defaultPrimary;
    return themeColors[themeId.toUpperCase()] ?? defaultPrimary;
  }
}

/// Tiện ích lấy token màu động từ BuildContext
extension BuildContextThemeExtension on BuildContext {
  ThemeData get theme => Theme.of(this);
  ColorScheme get colorScheme => Theme.of(this).colorScheme;
  Color get primaryColor => Theme.of(this).colorScheme.primary;
}
