import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'bootstrap.dart';
import 'theme/app_theme.dart';
import '../core/auth/auth_service.dart';
import '../core/api/api_client.dart';
import '../core/storage/preferences_service.dart';

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
        Provider<ApiClient>.value(value: bootstrapResult.apiClient),
        Provider<PreferencesService>.value(value: bootstrapResult.preferencesService),
      ],
      child: MaterialApp.router(
        title: 'OmniNovel',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.darkTheme,
        darkTheme: bootstrapResult.preferencesService.isOledMode()
            ? AppTheme.oledTheme
            : AppTheme.darkTheme,
        themeMode: ThemeMode.dark,
        routerConfig: bootstrapResult.router,
      ),
    );
  }
}
