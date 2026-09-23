import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/storage/preferences_service.dart';
import 'package:omninovel_mobile/core/theme/theme_controller.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';

class MockPreferencesService extends Mock implements IPreferencesService {}
class MockGamificationRepository extends Mock implements GamificationRepository {}

void main() {
  late MockPreferencesService mockPrefs;
  late MockGamificationRepository mockGamificationRepo;
  late ThemeController controller;

  const userA = User(
    id: 'user-A',
    username: 'UserA',
    email: 'usera@example.com',
    role: 'READER',
  );

  const userB = User(
    id: 'user-B',
    username: 'UserB',
    email: 'userb@example.com',
    role: 'READER',
  );

  setUp(() {
    mockPrefs = MockPreferencesService();
    mockGamificationRepo = MockGamificationRepository();

    when(() => mockPrefs.isOledMode()).thenReturn(false);
    when(() => mockPrefs.isDarkMode()).thenReturn(true);
    when(() => mockPrefs.getRankTheme(any())).thenReturn(null);
    when(() => mockPrefs.setRankTheme(any(), any())).thenAnswer((_) async => {});

    controller = ThemeController(
      preferencesService: mockPrefs,
    );
  });

  group('ThemeController Multi-User Auth & State Transition Tests', () {
    test('User A -> Logout -> User B switch transitions themes cleanly', () async {
      // 1. Initial unauthenticated state: DEFAULT
      expect(controller.currentThemeId, 'DEFAULT');

      // 2. User A logs in with TU_TIEN saved locally
      when(() => mockPrefs.getRankTheme('user-A')).thenReturn('TU_TIEN');
      controller.onAuthStateChanged(AuthState.authenticated(user: userA, accessToken: 'token-A'));
      expect(controller.currentThemeId, 'TU_TIEN');

      // 3. User A logs out -> reverts to DEFAULT
      controller.onAuthStateChanged(AuthState.unauthenticated());
      expect(controller.currentThemeId, 'DEFAULT');

      // 4. User B logs in with GAME saved locally
      when(() => mockPrefs.getRankTheme('user-B')).thenReturn('GAME');
      controller.onAuthStateChanged(AuthState.authenticated(user: userB, accessToken: 'token-B'));
      expect(controller.currentThemeId, 'GAME');

      // 5. User B logs out -> reverts to DEFAULT
      controller.onAuthStateChanged(AuthState.unauthenticated());
      expect(controller.currentThemeId, 'DEFAULT');
    });

    test('Optimistic theme switch and rollback on API failure', () async {
      when(() => mockPrefs.getRankTheme('user-A')).thenReturn('DEFAULT');
      controller.onAuthStateChanged(AuthState.authenticated(user: userA, accessToken: 'token-A'));

      when(() => mockGamificationRepo.changeRankTheme('DEMON_KING'))
          .thenAnswer((_) async => {});

      // Successful switch
      await controller.setRankTheme(
        'DEMON_KING',
        onSyncToServer: () => mockGamificationRepo.changeRankTheme('DEMON_KING'),
      );
      expect(controller.currentThemeId, 'DEMON_KING');
      verify(() => mockPrefs.setRankTheme('user-A', 'DEMON_KING')).called(1);

      // Failed switch with rollback
      when(() => mockGamificationRepo.changeRankTheme('MAGICIAN'))
          .thenThrow(Exception('Network error'));

      try {
        await controller.setRankTheme(
          'MAGICIAN',
          onSyncToServer: () => mockGamificationRepo.changeRankTheme('MAGICIAN'),
        );
      } catch (_) {}

      // Rolled back to DEMON_KING
      expect(controller.currentThemeId, 'DEMON_KING');
    });

    test('reconcileFromServer updates theme when server differs from local cache', () async {
      when(() => mockPrefs.getRankTheme('user-A')).thenReturn('DEFAULT');
      controller.onAuthStateChanged(AuthState.authenticated(user: userA, accessToken: 'token-A'));
      expect(controller.currentThemeId, 'DEFAULT');

      await controller.reconcileFromServer('SCI_FI');
      expect(controller.currentThemeId, 'SCI_FI');
      verify(() => mockPrefs.setRankTheme('user-A', 'SCI_FI')).called(1);
    });
  });
}
