import 'package:shared_preferences/shared_preferences.dart';

abstract class IPreferencesService {
  Future<void> setDarkMode(bool isDark);
  bool isDarkMode();
  Future<void> setOledMode(bool isOled);
  bool isOledMode();
  Future<void> clearPreferences();
}

class PreferencesService implements IPreferencesService {
  final SharedPreferences _prefs;

  static const _keyDarkMode = 'setting_dark_mode';
  static const _keyOledMode = 'setting_oled_mode';

  PreferencesService(this._prefs);

  static Future<PreferencesService> create() async {
    final prefs = await SharedPreferences.getInstance();
    return PreferencesService(prefs);
  }

  @override
  Future<void> setDarkMode(bool isDark) async {
    await _prefs.setBool(_keyDarkMode, isDark);
  }

  @override
  bool isDarkMode() {
    return _prefs.getBool(_keyDarkMode) ?? true; // Default to dark mode
  }

  @override
  Future<void> setOledMode(bool isOled) async {
    await _prefs.setBool(_keyOledMode, isOled);
  }

  @override
  bool isOledMode() {
    return _prefs.getBool(_keyOledMode) ?? false;
  }

  @override
  Future<void> clearPreferences() async {
    await _prefs.clear();
  }
}
