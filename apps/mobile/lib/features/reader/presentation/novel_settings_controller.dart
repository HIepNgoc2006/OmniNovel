import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/novel_block_models.dart';

/// Controller quản lý cài đặt hiển thị truyện chữ (NovelSettingsController).
///
/// **Hợp đồng kỹ thuật (#198):**
/// 1. Tách biệt rõ ràng giữa Color Repaint và Geometry Invalidation.
/// 2. Khi đổi Theme màu: Chỉ repaint màu sắc, không tính lại geometry.
/// 3. Khi đổi fontSize, lineHeight, fontFamily, padding: Báo hiệu tính lại geometry.
class NovelSettingsController extends ChangeNotifier {
  static const String _prefKey = 'omninovel_novel_typography_settings_v1';

  NovelTypographySettings _settings;
  final SharedPreferences? _prefs;

  NovelSettingsController({
    NovelTypographySettings initialSettings = const NovelTypographySettings(),
    SharedPreferences? prefs,
  })  : _settings = initialSettings,
        _prefs = prefs {
    _loadFromPrefs();
  }

  NovelTypographySettings get settings => _settings;

  void _loadFromPrefs() {
    if (_prefs == null) return;
    final jsonStr = _prefs.getString(_prefKey);
    if (jsonStr != null && jsonStr.isNotEmpty) {
      try {
        final Map<String, dynamic> data =
            jsonDecode(jsonStr) as Map<String, dynamic>;
        _settings = NovelTypographySettings.fromJson(data);
        notifyListeners();
      } catch (_) {
        // Fallback to default nếu json lỗi
      }
    }
  }

  Future<void> _saveToPrefs() async {
    if (_prefs == null) return;
    try {
      await _prefs.setString(_prefKey, jsonEncode(_settings.toJson()));
    } catch (_) {
      // Bỏ qua lỗi lưu cache prefs
    }
  }

  /// Cập nhật Theme (Chỉ kích hoạt color repaint)
  void setTheme(NovelReadingTheme theme) {
    if (_settings.theme == theme) return;
    _settings = _settings.copyWith(theme: theme);
    notifyListeners();
    _saveToPrefs();
  }

  /// Cập nhật Cỡ chữ (Yêu cầu re-layout geometry)
  void setFontSize(double size) {
    final clamped = size.clamp(12.0, 36.0);
    if (_settings.fontSize == clamped) return;
    _settings = _settings.copyWith(fontSize: clamped);
    notifyListeners();
    _saveToPrefs();
  }

  /// Cập nhật Giãn dòng (Yêu cầu re-layout geometry)
  void setLineHeight(double multiplier) {
    final clamped = multiplier.clamp(1.2, 2.5);
    if (_settings.lineHeightMultiplier == clamped) return;
    _settings = _settings.copyWith(lineHeightMultiplier: clamped);
    notifyListeners();
    _saveToPrefs();
  }

  /// Cập nhật Font Family (Yêu cầu re-layout geometry)
  void setFontFamily(NovelFontFamily family) {
    if (_settings.fontFamily == family) return;
    _settings = _settings.copyWith(fontFamily: family);
    notifyListeners();
    _saveToPrefs();
  }

  /// Kiểm tra xem sự thay đổi giữa 2 cấu hình có yêu cầu tính lại geometry hay không
  static bool requiresGeometryRecalculation(
    NovelTypographySettings oldSettings,
    NovelTypographySettings newSettings,
  ) {
    return oldSettings.fontSize != newSettings.fontSize ||
        oldSettings.lineHeightMultiplier != newSettings.lineHeightMultiplier ||
        oldSettings.fontFamily != newSettings.fontFamily ||
        oldSettings.horizontalPadding != newSettings.horizontalPadding ||
        oldSettings.paragraphSpacing != newSettings.paragraphSpacing;
  }
}
