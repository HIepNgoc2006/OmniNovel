import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/auth_state.dart';
import '../../core/api/api_client.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/library/presentation/library_screen.dart';
import '../../features/library/repositories/library_repository.dart';
import '../../features/search/presentation/search_screen.dart';
import '../../features/story/presentation/story_detail_screen.dart';
import '../../features/story/repositories/story_repository.dart';
import '../../features/reader/models/manga_reading_mode.dart';
import '../../features/reader/presentation/reader_screen.dart';
import '../../features/gamification/repositories/gamification_repository.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/reader/repositories/chapter_report_repository.dart';
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
    LibraryRepository? libraryRepository,
    GamificationRepository? gamificationRepository,
    ChapterReportRepository? chapterReportRepository,
  }) {
    final effectiveStoryRepo =
        storyRepository ?? StoryRepository(apiClient: apiClient);
    final effectiveChapterRepo =
        chapterRepository ?? ChapterRepository(apiClient: apiClient);
    final effectiveMediaRepo =
        mediaRepository ?? MediaRepository(apiClient: apiClient);
    final effectiveReportRepo =
        chapterReportRepository ?? ChapterReportRepository(apiClient: apiClient);
    final effectiveProgressRepo = readingProgressRepository ??
        ReadingProgressRepository(
          apiClient: apiClient,
          userIdProvider: () => authService.state.user?.id,
        );
    final effectiveLibraryRepo = libraryRepository ??
        LibraryRepository(
          apiClient: apiClient,
          progressRepository: effectiveProgressRepo,
          userIdProvider: () => authService.state.user?.id,
        );
    final effectiveGamificationRepo = gamificationRepository ??
        GamificationRepository(apiClient: apiClient);

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
            storyRepository: effectiveStoryRepo,
            libraryRepository: effectiveLibraryRepo,
          ),
        ),
        GoRoute(
          path: '/library',
          builder: (context, state) => LibraryScreen(
            libraryRepository: effectiveLibraryRepo,
          ),
        ),
        GoRoute(
          path: '/profile',
          builder: (context, state) => ProfileScreen(
            authService: authService,
            gamificationRepository: effectiveGamificationRepo,
          ),
        ),
        GoRoute(
          path: '/search',
          builder: (context, state) {
            final initialSearch = state.uri.queryParameters['q'] ??
                state.uri.queryParameters['search'];
            final initialGenre = state.uri.queryParameters['genre'];
            final initialFormat = state.uri.queryParameters['format'];
            final initialSort = state.uri.queryParameters['sort'];
            return SearchScreen(
              storyRepository: effectiveStoryRepo,
              initialSearch: initialSearch,
              initialGenre: initialGenre,
              initialFormat: initialFormat,
              initialSort: initialSort,
            );
          },
        ),
        GoRoute(
          path: '/story/:slug',
          builder: (context, state) {
            final slug = state.pathParameters['slug']!;
            return StoryDetailScreen(
              slug: slug,
              storyRepository: effectiveStoryRepo,
              readingProgressRepository: effectiveProgressRepo,
              libraryRepository: effectiveLibraryRepo,
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
            final modeStr = state.uri.queryParameters['mode'];
            final initialMode = MangaReadingMode.fromName(modeStr);
            final initialAnchorBlockId =
                state.uri.queryParameters['anchorBlockId'];
            final scrollPosStr = state.uri.queryParameters['scrollPosition'];
            final initialScrollPosition =
                scrollPosStr != null ? double.tryParse(scrollPosStr) : null;
            final progressPctStr =
                state.uri.queryParameters['progressPercentage'];
            final initialProgressPercentage =
                progressPctStr != null ? double.tryParse(progressPctStr) : null;
            return ReaderScreen(
              key: ValueKey('reader_$chapterId'),
              chapterId: chapterId,
              storyId: storyId,
              initialPageIndex: initialPageIndex,
              initialMode: initialMode,
              initialAnchorBlockId: initialAnchorBlockId,
              initialScrollPosition: initialScrollPosition,
              initialProgressPercentage: initialProgressPercentage,
              chapterRepository: effectiveChapterRepo,
              mediaRepository: effectiveMediaRepo,
              readingProgressRepository: effectiveProgressRepo,
              gamificationRepository: effectiveGamificationRepo,
              authService: authService,
              reportRepository: effectiveReportRepo,
            );
          },
        ),
      ],
    );
  }
}

