import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'bootstrap.dart';
import '../core/auth/auth_service.dart';
import '../core/api/api_client.dart';
import '../core/storage/preferences_service.dart';
import '../core/theme/theme_controller.dart';
import '../../features/gamification/repositories/gamification_repository.dart';

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
        Provider<ApiClient>.value(value: bootstrapResult.apiClient),
        Provider<PreferencesService>.value(value: bootstrapResult.preferencesService),
        Provider<GamificationRepository>.value(value: bootstrapResult.gamificationRepository),
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
          );
        },
      ),
    );
  }
}
