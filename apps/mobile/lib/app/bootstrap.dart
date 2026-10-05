import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';
import '../core/config/app_config.dart';
import '../core/storage/preferences_service.dart';
import '../core/auth/token_storage.dart';
import '../core/auth/auth_service.dart';
import '../core/api/api_client.dart';
import '../core/identity/installation_identity_provider.dart';
import '../core/identity/guest_profile_identity_provider.dart';
import '../core/identity/active_scope_coordinator.dart';
import '../core/identity/auth_scope_bridge.dart';
import '../core/storage/offline_database.dart';
import '../core/storage/local_library_dao.dart';
import '../core/logging/app_logger.dart';
import '../core/theme/theme_controller.dart';
import '../../features/gamification/repositories/gamification_repository.dart';
import '../../features/library/repositories/guest_library_repository.dart';
import '../../features/reader/repositories/guest_reading_progress_repository.dart';
import 'router/app_router.dart';

class BootstrapResult {
  final AuthService authService;
  final ApiClient apiClient;
  final PreferencesService preferencesService;
  final ThemeController themeController;
  final GamificationRepository gamificationRepository;
  final GoRouter router;
  final ActiveScopeCoordinator activeScopeCoordinator;
  final GuestLibraryRepository guestLibraryRepository;
  final GuestReadingProgressRepository guestReadingProgressRepository;
  final LocalLibraryDao localLibraryDao;
  final AuthScopeBridge authScopeBridge;
  final OfflineDatabase offlineDatabase;

  const BootstrapResult({
    required this.authService,
    required this.apiClient,
    required this.preferencesService,
    required this.themeController,
    required this.gamificationRepository,
    required this.router,
    required this.activeScopeCoordinator,
    required this.guestLibraryRepository,
    required this.guestReadingProgressRepository,
    required this.localLibraryDao,
    required this.authScopeBridge,
    required this.offlineDatabase,
  });
}

class AppBootstrap {
  static Future<BootstrapResult> run({
    Environment environment = Environment.dev,
    String? customBaseUrl,
    OfflineDatabase? customOfflineDatabase,
    ITokenStorage? customTokenStorage,
    FlutterSecureStorage? customSecureStorage,
  }) async {
    WidgetsFlutterBinding.ensureInitialized();
    const logger = AppLogger('Bootstrap');
    logger.i('Bắt đầu khởi động OmniNovel Mobile...');

    // 1. Config
    AppConfig.initialize(
      environment: environment,
      customBaseUrl: customBaseUrl,
    );

    // 2. Storage & Canonical Preferences
    final preferencesService = await PreferencesService.create();
    final rawPrefs = preferencesService.rawPrefs;
    final tokenStorage = customTokenStorage ?? SecureTokenStorage(storage: customSecureStorage);

    // 2b. Identity Providers (Canonical rawPrefs injection - không gọi getInstance() phân tán)
    final installProvider = InstallationIdentityProvider(
      secureStorage: customSecureStorage,
      prefs: rawPrefs,
    );
    final guestProfileProvider = GuestProfileIdentityProvider(prefs: rawPrefs);

    // 2c. ActiveScopeCoordinator
    final activeScopeCoordinator = ActiveScopeCoordinator(
      installProvider: installProvider,
      guestProfileProvider: guestProfileProvider,
    );

    // 2d. OfflineDatabase & LocalLibraryDao (SQLite v3 schema)
    final offlineDatabase = customOfflineDatabase ?? OfflineDatabase();
    if (!offlineDatabase.isInitialized) {
      await offlineDatabase.initialize();
    }
    final localLibraryDao = LocalLibraryDao(offlineDatabase: offlineDatabase);

    // 2e. Guest Repositories
    final guestLibraryRepository = GuestLibraryRepository(
      dao: localLibraryDao,
      coordinator: activeScopeCoordinator,
    );
    final guestReadingProgressRepository = GuestReadingProgressRepository(
      dao: localLibraryDao,
      coordinator: activeScopeCoordinator,
    );

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

    // 3b. AuthScopeBridge wiring & synchronization gate
    final authScopeBridge = AuthScopeBridge(
      authService: authService,
      coordinator: activeScopeCoordinator,
    );
    authScopeBridge.attach();

    // 4. Check initial auth session & await synchronization gate
    // P0 Invariant: Chờ settle() và waitForResolvedScope() hoàn tất trước khi tạo Router
    await authService.initializeAuth();
    await authScopeBridge.settle();
    await activeScopeCoordinator.waitForResolvedScope();

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
      prefs: rawPrefs,
      gamificationRepository: gamificationRepository,
      activeScopeCoordinator: activeScopeCoordinator,
      guestLibraryRepository: guestLibraryRepository,
      guestReadingProgressRepository: guestReadingProgressRepository,
    );

    logger.i('Khởi động OmniNovel Mobile thành công. Scope: ${activeScopeCoordinator.activeScope}');
    return BootstrapResult(
      authService: authService,
      apiClient: apiClient,
      preferencesService: preferencesService,
      themeController: themeController,
      gamificationRepository: gamificationRepository,
      router: router,
      activeScopeCoordinator: activeScopeCoordinator,
      guestLibraryRepository: guestLibraryRepository,
      guestReadingProgressRepository: guestReadingProgressRepository,
      localLibraryDao: localLibraryDao,
      authScopeBridge: authScopeBridge,
      offlineDatabase: offlineDatabase,
    );
  }
}
