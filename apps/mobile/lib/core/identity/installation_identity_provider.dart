import 'dart:math' as math;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Helper sinh chuẩn UUIDv4 RFC4122
String generateUUIDv4() {
  final random = math.Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx

  final buffer = StringBuffer();
  for (var i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) {
      buffer.write('-');
    }
    buffer.write(bytes[i].toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

class InstallationIdentityProvider {
  static const keyInstallationId = 'omninovel_installation_id';

  final FlutterSecureStorage _secureStorage;
  SharedPreferences? _prefs;
  String? _cachedId;

  InstallationIdentityProvider({
    FlutterSecureStorage? secureStorage,
    SharedPreferences? prefs,
  })  : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _prefs = prefs;

  Future<SharedPreferences> _getPrefs() async {
    final p = _prefs;
    if (p != null) return p;
    final instance = await SharedPreferences.getInstance();
    _prefs = instance;
    return instance;
  }

  /// Lấy hoặc tạo installationId bền vững duy nhất cho thiết bị.
  /// Tuyệt đối KHÔNG reset khi người dùng đăng xuất.
  ///
  /// Reconcile & Fallback Policy (Guardrail 2):
  /// - Nếu SecureStorage có ID: SecureStorage là SSoT, reconcile sang SharedPreferences nếu thiếu/lệch.
  /// - Nếu SecureStorage tạm rỗng nhưng SharedPreferences có ID: Promote ID từ SharedPreferences sang SecureStorage.
  /// - Nếu cả 2 đều rỗng: Sinh UUIDv4 mới và ghi vào cả 2 storage.
  Future<String> getOrCreateInstallationId() async {
    final cached = _cachedId;
    if (cached != null && cached.isNotEmpty) {
      return cached;
    }

    String? secureId;
    try {
      secureId = await _secureStorage.read(key: keyInstallationId);
    } catch (_) {
      // SecureStorage tạm thời gặp lỗi phần cứng/keystore
    }

    final prefs = await _getPrefs();
    final prefsId = prefs.getString(keyInstallationId);

    if (secureId != null && secureId.isNotEmpty) {
      if (prefsId != secureId) {
        await prefs.setString(keyInstallationId, secureId);
      }
      _cachedId = secureId;
      return secureId;
    }

    if (prefsId != null && prefsId.isNotEmpty) {
      try {
        await _secureStorage.write(key: keyInstallationId, value: prefsId);
      } catch (_) {}
      _cachedId = prefsId;
      return prefsId;
    }

    final newId = generateUUIDv4();
    try {
      await _secureStorage.write(key: keyInstallationId, value: newId);
    } catch (_) {}
    await prefs.setString(keyInstallationId, newId);
    _cachedId = newId;
    return newId;
  }
}
