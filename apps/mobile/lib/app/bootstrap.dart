import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../core/config/app_config.dart';
import '../core/storage/preferences_service.dart';
import '../core/auth/token_storage.dart';
import '../core/auth/auth_service.dart';
import '../core/api/api_client.dart';
import '../core/logging/app_logger.dart';
import '../core/theme/theme_controller.dart';
import '../../features/gamification/repositories/gamification_repository.dart';
import 'router/app_router.dart';

class BootstrapResult {
  final AuthService authService;
  final ApiClient apiClient;
  final PreferencesService preferencesService;
  final ThemeController themeController;
  final GamificationRepository gamificationRepository;
  final GoRouter router;

  const BootstrapResult({
    required this.authService,
    required this.apiClient,
    required this.preferencesService,
    required this.themeController,
    required this.gamificationRepository,
    required this.router,
  });
}

class AppBootstrap {
  static Future<BootstrapResult> run({
    Environment environment = Environment.dev,
    String? customBaseUrl,
  }) async {
    WidgetsFlutterBinding.ensureInitialized();
    const logger = AppLogger('Bootstrap');
    logger.i('Bắt đầu khởi động OmniNovel Mobile...');

    // 1. Config
    AppConfig.initialize(
      environment: environment,
      customBaseUrl: customBaseUrl,
    );

    // 2. Storage & Preferences
    final preferencesService = await PreferencesService.create();
    final tokenStorage = SecureTokenStorage();

    // 3. API Client & AuthService wiring
    late final AuthService authService;
    final apiClient = ApiClient(
      tokenStorage: tokenStorage,
      onSessionExpired: () => authService.handleSessionExpired(),
    );

    authService = AuthService(
      apiClient: apiClient,
      tokenStorage: tokenStorage,
    );

    // 4. Check initial auth session
    await authService.initializeAuth();

    // 4b. Setup ThemeController & Prime initial auth state
    final currentUserId = authService.state.user?.id;
    final initialThemeId = (currentUserId != null
            ? preferencesService.getRankTheme(currentUserId)
            : null) ??
        'DEFAULT';
    final themeController = ThemeController(
      preferencesService: preferencesService,
      initialThemeId: initialThemeId,
      initialUserId: currentUserId,
    );
    authService.addListener(() => themeController.onAuthStateChanged(authService.state));
    themeController.onAuthStateChanged(authService.state);

    // 4c. Setup GamificationRepository
    final gamificationRepository = GamificationRepository(
      apiClient: apiClient,
      themeController: themeController,
    );

    // 5. Router
    final router = AppRouter.create(
      authService: authService,
      apiClient: apiClient,
      gamificationRepository: gamificationRepository,
    );

    logger.i('Khởi động OmniNovel Mobile thành công.');
    return BootstrapResult(
      authService: authService,
      apiClient: apiClient,
      preferencesService: preferencesService,
      themeController: themeController,
      gamificationRepository: gamificationRepository,
      router: router,
    );
  }
}
