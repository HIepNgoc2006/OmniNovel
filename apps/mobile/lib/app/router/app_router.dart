import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/auth_state.dart';
import '../../core/api/api_client.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/story/presentation/story_detail_screen.dart';
import '../../features/story/repositories/story_repository.dart';
import '../../features/reader/presentation/reader_screen.dart';
import '../../features/reader/repositories/chapter_repository.dart';
import '../../features/reader/repositories/media_repository.dart';
import '../../features/reader/repositories/reading_progress_repository.dart';

class AppRouter {
  static GoRouter create({
    required AuthService authService,
    required ApiClient apiClient,
    StoryRepository? storyRepository,
    ChapterRepository? chapterRepository,
    MediaRepository? mediaRepository,
    ReadingProgressRepository? readingProgressRepository,
  }) {
    final effectiveStoryRepo =
        storyRepository ?? StoryRepository(apiClient: apiClient);
    final effectiveChapterRepo =
        chapterRepository ?? ChapterRepository(apiClient: apiClient);
    final effectiveMediaRepo =
        mediaRepository ?? MediaRepository(apiClient: apiClient);
    final effectiveProgressRepo = readingProgressRepository ??
        ReadingProgressRepository(apiClient: apiClient);

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
        GoRoute(
          path: '/story/:slug',
          builder: (context, state) {
            final slug = state.pathParameters['slug']!;
            return StoryDetailScreen(
              slug: slug,
              storyRepository: effectiveStoryRepo,
              readingProgressRepository: effectiveProgressRepo,
            );
          },
        ),
        GoRoute(
          path: '/reader/:chapterId',
          builder: (context, state) {
            final chapterId = state.pathParameters['chapterId']!;
            final storyId = state.uri.queryParameters['storyId'] ?? '';
            final pageIndexStr = state.uri.queryParameters['pageIndex'];
            final initialPageIndex =
                pageIndexStr != null ? (int.tryParse(pageIndexStr) ?? 0) : 0;
            return ReaderScreen(
              key: ValueKey('reader_$chapterId'),
              chapterId: chapterId,
              storyId: storyId,
              initialPageIndex: initialPageIndex,
              chapterRepository: effectiveChapterRepo,
              mediaRepository: effectiveMediaRepo,
              readingProgressRepository: effectiveProgressRepo,
            );
          },
        ),
      ],
    );
  }
}

