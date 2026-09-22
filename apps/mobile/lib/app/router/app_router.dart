import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/auth_state.dart';
import '../../core/api/api_client.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/home/presentation/home_screen.dart';

class AppRouter {
  static GoRouter create({
    required AuthService authService,
    required ApiClient apiClient,
  }) {
    return GoRouter(
      initialLocation: '/home',
      refreshListenable: authService,
      redirect: (BuildContext context, GoRouterState state) {
        final authState = authService.state;
        final isLoggingIn = state.matchedLocation == '/login';

        // Đang kiểm tra token ở khởi động
        if (authState.status == AuthStatus.initial) {
          return null;
        }

        // Chưa đăng nhập mà truy cập route khác ngoài login
        if (!authState.isAuthenticated) {
          return isLoggingIn ? null : '/login';
        }

        // Đã đăng nhập mà đang ở màn login -> đưa về home
        if (isLoggingIn) {
          return '/home';
        }

        return null;
      },
      routes: [
        GoRoute(
          path: '/login',
          builder: (context, state) => LoginScreen(authService: authService),
        ),
        GoRoute(
          path: '/home',
          builder: (context, state) => HomeScreen(
            authService: authService,
            apiClient: apiClient,
          ),
        ),
      ],
    );
  }
}
