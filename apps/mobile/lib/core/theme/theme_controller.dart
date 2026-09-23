import 'package:flutter/material.dart';
import '../auth/auth_state.dart';
import '../storage/preferences_service.dart';
import '../../app/theme/app_theme.dart';
import 'theme_tokens.dart';

/// Quản lý Theme toàn ứng dụng (OLED, Dark, và Dynamic Rank Themes)
/// Hỗ trợ Multi-User Lifecycle, Optimistic switch + Rollback, Server-Local Reconciliation.
class ThemeController extends ChangeNotifier {
  final IPreferencesService _preferencesService;
  String _currentThemeId;
  String? _activeUserId;
  bool _isOledMode = false;
  bool _isDarkMode = true;

  ThemeController({
    required IPreferencesService preferencesService,
    String initialThemeId = 'DEFAULT',
    String? initialUserId,
  })  : _preferencesService = preferencesService,
        _currentThemeId = initialThemeId,
        _activeUserId = initialUserId {
    _isOledMode = _preferencesService.isOledMode();
    _isDarkMode = _preferencesService.isDarkMode();
  }

  String get currentThemeId => _currentThemeId;
  String? get activeUserId => _activeUserId;
  bool get isOledMode => _isOledMode;
  bool get isDarkMode => _isDarkMode;

  /// ThemeData hiện tại được tính toán từ chế độ hiển thị và Rank Theme Accent
  ThemeData get currentTheme {
    final primaryColor = RankThemePalette.getPrimary(_currentThemeId);
    if (_isOledMode) {
      return AppTheme.oledTheme(primaryColor);
    }
    return AppTheme.darkTheme(primaryColor);
  }

  /// Lắng nghe AuthState để chuyển đổi theme theo User Session
  void onAuthStateChanged(AuthState state) {
    if (!state.isAuthenticated) {
      if (_activeUserId != null || _currentThemeId != 'DEFAULT') {
        _activeUserId = null;
        _applyTheme('DEFAULT');
      }
      return;
    }

    final newUserId = state.user?.id;
    if (newUserId != null && newUserId != _activeUserId) {
      _activeUserId = newUserId;
      final savedTheme = _preferencesService.getRankTheme(newUserId) ?? 'DEFAULT';
      _applyTheme(savedTheme);
    }
  }

  /// Đối chiếu và đồng bộ với Rank Theme từ Server (SSoT)
  Future<void> reconcileFromServer(String serverThemeId) async {
    final userId = _activeUserId;
    if (userId == null) return;

    if (_currentThemeId != serverThemeId) {
      _currentThemeId = serverThemeId;
      await _preferencesService.setRankTheme(userId, serverThemeId);
      notifyListeners();
    }
  }

  /// Thay đổi theme lạc quan (Optimistic Switch) kèm cơ chế Rollback nếu API lỗi
  Future<void> setRankTheme(
    String newThemeId, {
    Future<void> Function()? onSyncToServer,
  }) async {
    final previousTheme = _currentThemeId;
    final userId = _activeUserId;

    _currentThemeId = newThemeId;
    if (userId != null) {
      await _preferencesService.setRankTheme(userId, newThemeId);
    }
    notifyListeners();

    if (onSyncToServer != null) {
      try {
        await onSyncToServer();
      } catch (error) {
        // Rollback nếu gọi API thất bại
        _currentThemeId = previousTheme;
        if (userId != null) {
          await _preferencesService.setRankTheme(userId, previousTheme);
        }
        notifyListeners();
        rethrow;
      }
    }
  }

  /// Thay đổi chế độ OLED
  Future<void> setOledMode(bool isOled) async {
    if (_isOledMode == isOled) return;
    _isOledMode = isOled;
    await _preferencesService.setOledMode(isOled);
    notifyListeners();
  }

  /// Thay đổi chế độ Dark Mode
  Future<void> setDarkMode(bool isDark) async {
    if (_isDarkMode == isDark) return;
    _isDarkMode = isDark;
    await _preferencesService.setDarkMode(isDark);
    notifyListeners();
  }

  void _applyTheme(String themeId) {
    if (_currentThemeId == themeId) return;
    _currentThemeId = themeId;
    notifyListeners();
  }
}
