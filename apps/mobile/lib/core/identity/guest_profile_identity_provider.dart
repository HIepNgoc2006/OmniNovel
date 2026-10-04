import 'package:shared_preferences/shared_preferences.dart';
import 'installation_identity_provider.dart';

class GuestProfileIdentityProvider {
  static const keyGuestProfileId = 'omninovel_guest_profile_id';
  static const keyQuarantinedProfiles = 'omninovel_quarantined_guest_profiles';

  SharedPreferences? _prefs;
  String? _cachedProfileId;

  GuestProfileIdentityProvider({SharedPreferences? prefs}) : _prefs = prefs;

  Future<SharedPreferences> _getPrefs() async {
    final p = _prefs;
    if (p != null) return p;
    final instance = await SharedPreferences.getInstance();
    _prefs = instance;
    return instance;
  }

  /// Lấy hoặc tạo guestProfileId hiện hành.
  Future<String> getOrCreateGuestProfileId() async {
    final cached = _cachedProfileId;
    if (cached != null && cached.isNotEmpty) {
      return cached;
    }

    final prefs = await _getPrefs();
    final existing = prefs.getString(keyGuestProfileId);
    if (existing != null && existing.isNotEmpty) {
      _cachedProfileId = existing;
      return existing;
    }

    final newProfileId = generateUUIDv4();
    await prefs.setString(keyGuestProfileId, newProfileId);
    _cachedProfileId = newProfileId;
    return newProfileId;
  }

  /// Xoay guestProfileId sang UUIDv4 mới (sử dụng khi đăng xuất).
  /// Trả về ID mới tinh để khởi tạo fresh guest scope.
  Future<String> rotateGuestProfileId() async {
    final prefs = await _getPrefs();
    final newProfileId = generateUUIDv4();
    await prefs.setString(keyGuestProfileId, newProfileId);
    _cachedProfileId = newProfileId;
    return newProfileId;
  }

  /// Đưa guestProfileId vào danh sách cách ly để bảo toàn dữ liệu (chống silent destruction).
  Future<void> quarantineGuestScope(String profileId) async {
    if (profileId.isEmpty) return;
    final prefs = await _getPrefs();
    final list = prefs.getStringList(keyQuarantinedProfiles) ?? <String>[];
    if (!list.contains(profileId)) {
      list.add(profileId);
      await prefs.setStringList(keyQuarantinedProfiles, list);
    }
  }

  /// Lấy danh sách các guest profile IDs đã được cách ly trên thiết bị này.
  Future<List<String>> listQuarantinedGuestScopes() async {
    final prefs = await _getPrefs();
    return prefs.getStringList(keyQuarantinedProfiles) ?? <String>[];
  }
}
