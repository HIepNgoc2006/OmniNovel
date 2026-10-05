import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/preferences_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('PreferencesService.clearPreferences() clears settings but preserves omninovel_* identity keys', () async {
    SharedPreferences.setMockInitialValues({
      'setting_dark_mode': true,
      'setting_oled_mode': false,
      'rank_theme_u1': 'THEME_GOLD',
      InstallationIdentityProvider.keyInstallationId: 'stable-device-uuid-123',
      GuestProfileIdentityProvider.keyGuestProfileId: 'active-guest-uuid-456',
      GuestProfileIdentityProvider.keyQuarantinedProfiles: <String>['old-guest-789'],
    });

    final prefs = await SharedPreferences.getInstance();
    final service = PreferencesService(prefs);

    await service.clearPreferences();

    // Settings must be cleared
    expect(prefs.getBool('setting_dark_mode'), isNull);
    expect(prefs.getBool('setting_oled_mode'), isNull);
    expect(prefs.getString('rank_theme_u1'), isNull);

    // Identity keys must be PRESERVED
    expect(prefs.getString(InstallationIdentityProvider.keyInstallationId), equals('stable-device-uuid-123'));
    expect(prefs.getString(GuestProfileIdentityProvider.keyGuestProfileId), equals('active-guest-uuid-456'));
    expect(prefs.getStringList(GuestProfileIdentityProvider.keyQuarantinedProfiles), equals(['old-guest-789']));
  });
}
