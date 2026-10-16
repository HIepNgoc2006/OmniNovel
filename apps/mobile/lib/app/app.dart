import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'bootstrap.dart';
import '../core/auth/auth_service.dart';
import '../core/api/api_client.dart';
import '../core/claim/guest_claim_coordinator.dart';
import '../core/storage/preferences_service.dart';
import '../core/storage/local_library_dao.dart';
import '../core/identity/active_scope_coordinator.dart';
import '../core/theme/theme_controller.dart';
import '../../features/claim/presentation/guest_claim_listener.dart';
import '../../features/gamification/repositories/gamification_repository.dart';
import '../../features/library/repositories/guest_library_repository.dart';
import '../../features/reader/repositories/guest_reading_progress_repository.dart';

class OmniNovelApp extends StatelessWidget {
  final BootstrapResult bootstrapResult;

  const OmniNovelApp({
    super.key,
    required this.bootstrapResult,
  });

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthService>.value(value: bootstrapResult.authService),
        ChangeNotifierProvider<ThemeController>.value(value: bootstrapResult.themeController),
        ChangeNotifierProvider<ActiveScopeCoordinator>.value(value: bootstrapResult.activeScopeCoordinator),
        ChangeNotifierProvider<GuestClaimCoordinator>.value(value: bootstrapResult.guestClaimCoordinator),
        Provider<ApiClient>.value(value: bootstrapResult.apiClient),
        Provider<PreferencesService>.value(value: bootstrapResult.preferencesService),
        Provider<GamificationRepository>.value(value: bootstrapResult.gamificationRepository),
        Provider<GuestLibraryRepository>.value(value: bootstrapResult.guestLibraryRepository),
        Provider<GuestReadingProgressRepository>.value(value: bootstrapResult.guestReadingProgressRepository),
        Provider<LocalLibraryDao>.value(value: bootstrapResult.localLibraryDao),
      ],
      child: ListenableBuilder(
        listenable: bootstrapResult.themeController,
        builder: (context, _) {
          final theme = bootstrapResult.themeController.currentTheme;
          return MaterialApp.router(
            title: 'OmniNovel',
            debugShowCheckedModeBanner: false,
            theme: theme,
            darkTheme: theme,
            themeMode: ThemeMode.dark,
            routerConfig: bootstrapResult.router,
            builder: (context, child) {
              return GuestClaimListener(
                child: child ?? const SizedBox.shrink(),
              );
            },
          );
        },
      ),
    );
  }
}

