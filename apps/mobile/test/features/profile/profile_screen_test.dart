import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/storage/preferences_service.dart';
import 'package:omninovel_mobile/core/theme/theme_controller.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/gamification/models/gamification_models.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';
import 'package:omninovel_mobile/features/profile/presentation/profile_screen.dart';

class MockAuthService extends Mock implements AuthService {}
class MockGamificationRepository extends Mock implements GamificationRepository {}
class MockPreferencesService extends Mock implements IPreferencesService {}

void main() {
  late MockAuthService mockAuthService;
  late MockGamificationRepository mockGamificationRepo;
  late MockPreferencesService mockPrefs;
  late ThemeController themeController;

  const mockUser = User(
    id: 'user-1',
    email: 'reader@omninovel.com',
    username: 'DocGiaVip',
    role: 'READER',
  );

  const mockProgression = UserProgression(
    userId: 'user-1',
    level: 4,
    totalExp: '350',
    currentLevelExp: 350,
    nextLevelExp: 800,
    omnicoinBalance: '500',
    currentStreak: 2,
    maxStreak: 4,
    lastCheckinDate: '2026-09-24',
    hasCheckedInToday: true,
    rankTitle: 'Trúc Cơ Kỳ',
    activeThemeId: 'TU_TIEN',
    activeThemeName: 'Tu Tiên',
    progressPercent: 43,
    serverDateVN: '2026-09-24',
    serverNow: '2026-09-24T00:00:00.000Z',
    nextCheckinAt: '2026-09-24T17:00:00.000Z',
    secondsUntilNextCheckin: 3600,
  );

  final mockThemes = [
    const RankThemeItem(
      id: 'DEFAULT',
      name: 'Mặc định (Violet)',
      description: 'Giao diện tím tiêu chuẩn',
      isActive: true,
      currentRankTitle: 'Độc Giả',
    ),
    const RankThemeItem(
      id: 'TU_TIEN',
      name: 'Tu Tiên (Ngọc Bích)',
      description: 'Phong cách tu chân thanh thoát',
      isActive: true,
      currentRankTitle: 'Trúc Cơ Kỳ',
    ),
  ];

  setUp(() {
    mockAuthService = MockAuthService();
    mockGamificationRepo = MockGamificationRepository();
    mockPrefs = MockPreferencesService();

    when(() => mockPrefs.isOledMode()).thenReturn(false);
    when(() => mockPrefs.isDarkMode()).thenReturn(true);
    when(() => mockPrefs.getRankTheme(any())).thenReturn('TU_TIEN');
    when(() => mockPrefs.setRankTheme(any(), any())).thenAnswer((_) async => {});

    themeController = ThemeController(
      preferencesService: mockPrefs,
    );
    themeController.onAuthStateChanged(
      AuthState.authenticated(user: mockUser, accessToken: 'token-1'),
    );

    when(() => mockAuthService.state).thenReturn(
      AuthState.authenticated(user: mockUser, accessToken: 'token-1'),
    );
    when(() => mockGamificationRepo.getProgression(
          userId: any(named: 'userId'),
          forceRefresh: any(named: 'forceRefresh'),
        )).thenAnswer((_) async => mockProgression);
    when(() => mockGamificationRepo.getThemes(
          forceRefresh: any(named: 'forceRefresh'),
        )).thenAnswer((_) async => mockThemes);
    when(() => mockGamificationRepo.getLevelRewards(
          userId: any(named: 'userId'),
          forceRefresh: any(named: 'forceRefresh'),
        )).thenAnswer((_) async => []);
  });

  testWidgets('ProfileScreen renders header, wallet, themes grid, and responds to theme tap',
      (WidgetTester tester) async {
    when(() => mockGamificationRepo.changeRankTheme('DEFAULT'))
        .thenAnswer((_) async => {});

    await tester.pumpWidget(
      ChangeNotifierProvider<ThemeController>.value(
        value: themeController,
        child: MaterialApp(
          home: ProfileScreen(
            authService: mockAuthService,
            gamificationRepository: mockGamificationRepo,
          ),
        ),
      ),
    );

    // Initial load state
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Settle async futures
    await tester.pumpAndSettle();

    // Verify User Header info
    expect(find.text('DocGiaVip'), findsOneWidget);
    expect(find.text('Cấp 4'), findsWidgets);
    expect(find.text('Trúc Cơ Kỳ'), findsWidgets);

    // Verify OmniCoin Wallet card
    expect(find.text('500 Xu'), findsOneWidget);
    expect(find.text('Ví OmniCoin'), findsOneWidget);
    expect(find.text('Lịch sử'), findsOneWidget);

    // Verify Theme items
    expect(find.text('Tu Tiên (Ngọc Bích)'), findsOneWidget);
    expect(find.text('Mặc định (Violet)'), findsOneWidget);

    // Tap on DEFAULT theme card
    final defaultThemeKey = find.byKey(const Key('theme_card_DEFAULT'));
    expect(defaultThemeKey, findsOneWidget);
    await tester.ensureVisible(defaultThemeKey);
    await tester.pumpAndSettle();
    await tester.tap(defaultThemeKey);
    await tester.pumpAndSettle();

    verify(() => mockGamificationRepo.changeRankTheme('DEFAULT')).called(1);
    expect(themeController.currentThemeId, 'DEFAULT');
  });
}
