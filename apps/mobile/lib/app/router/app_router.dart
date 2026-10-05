import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/auth_state.dart';
import '../../core/identity/active_scope_coordinator.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/gamification/repositories/gamification_repository.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/library/presentation/library_screen.dart';
import '../../features/library/repositories/account_library_adapter.dart';
import '../../features/library/repositories/guest_library_adapter.dart';
import '../../features/library/repositories/guest_library_repository.dart';
import '../../features/library/repositories/library_access.dart';
import '../../features/library/repositories/library_repository.dart';
import '../../features/library/repositories/scoped_library_dispatcher.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/reader/models/manga_reading_mode.dart';
import '../../features/reader/presentation/reader_screen.dart';
import '../../features/reader/repositories/account_reading_session_adapter.dart';
import '../../features/reader/repositories/chapter_report_repository.dart';
import '../../features/reader/repositories/chapter_repository.dart';
import '../../features/reader/repositories/guest_reading_progress_repository.dart';
import '../../features/reader/repositories/guest_reading_session_adapter.dart';
import '../../features/reader/repositories/media_repository.dart';
import '../../features/reader/repositories/reading_progress_repository.dart';
import '../../features/reader/repositories/reading_session_access.dart';
import '../../features/reader/repositories/scoped_reading_session_dispatcher.dart';
import '../../features/search/presentation/search_screen.dart';
import '../../features/story/presentation/story_detail_screen.dart';
import '../../features/story/repositories/story_repository.dart';

class AppRouter {
  static GoRouter create({
    required AuthService authService,
    required ApiClient apiClient,
    SharedPreferences? prefs,
    StoryRepository? storyRepository,
    ChapterRepository? chapterRepository,
    MediaRepository? mediaRepository,
    ReadingProgressRepository? readingProgressRepository,
    LibraryRepository? libraryRepository,
    GamificationRepository? gamificationRepository,
    ChapterReportRepository? chapterReportRepository,
    ActiveScopeCoordinator? activeScopeCoordinator,
    GuestLibraryRepository? guestLibraryRepository,
    GuestReadingProgressRepository? guestReadingProgressRepository,
    LibraryAccess? libraryAccess,
    ReadingSessionAccess? readingSessionAccess,
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
          prefs: prefs,
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

    final effectiveLibraryAccess = libraryAccess ??
        (activeScopeCoordinator != null && guestLibraryRepository != null
            ? ScopedLibraryDispatcher(
                authService: authService,
                coordinator: activeScopeCoordinator,
                accountAdapter: AccountLibraryAdapter(repository: effectiveLibraryRepo),
                guestAdapter: GuestLibraryAdapter(guestRepository: guestLibraryRepository),
              )
            : AccountLibraryAdapter(repository: effectiveLibraryRepo));

    final effectiveSessionAccess = readingSessionAccess ??
        (activeScopeCoordinator != null && guestReadingProgressRepository != null
            ? ScopedReadingSessionDispatcher(
                authService: authService,
                coordinator: activeScopeCoordinator,
                accountAdapter: AccountReadingSessionAdapter(
                  readingProgressRepository: effectiveProgressRepo,
                  gamificationRepository: effectiveGamificationRepo,
                ),
                guestAdapter: GuestReadingSessionAdapter(
                  guestRepository: guestReadingProgressRepository,
                ),
              )
            : AccountReadingSessionAdapter(
                readingProgressRepository: effectiveProgressRepo,
                gamificationRepository: effectiveGamificationRepo,
              ));

    bool wasAuthenticated = authService.state.isAuthenticated;

    return GoRouter(
      initialLocation: '/home',
      refreshListenable: authService,
      redirect: (BuildContext context, GoRouterState state) {
        final authState = authService.state;

        // Đang kiểm tra token ở khởi động
        if (authState.status == AuthStatus.initial) {
          return null;
        }

        final location = state.matchedLocation;
        final isLoggingIn = location == '/login';
        final isProfile = location == '/profile';

        // 1. Account-only route: /profile
        if (isProfile) {
          if (authState.isAuthenticated) {
            wasAuthenticated = true;
            return null;
          }
          // Explicit logout từ /profile -> canonical /home
          if (wasAuthenticated) {
            return '/home';
          }
          // Guest truy cập /profile -> login + returnTo
          final target = Uri.encodeComponent(state.uri.toString());
          return '/login?returnTo=$target';
        }

        // Cập nhật trạng thái auth sau khi đã rời khỏi /profile
        wasAuthenticated = authState.isAuthenticated;

        // 2. Màn hình /login
        if (isLoggingIn) {
          if (authState.isAuthenticated) {
            final returnTo = state.uri.queryParameters['returnTo'];
            if (returnTo != null &&
                returnTo.isNotEmpty &&
                returnTo.startsWith('/') &&
                !returnTo.startsWith('/login')) {
              return returnTo;
            }
            return '/home';
          }
          return null;
        }

        // 3. Public whitelist và unknown routes (để GoRouter tự xử lý 404, không ép về /login)
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
            libraryAccess: effectiveLibraryAccess,
            scopeCoordinator: activeScopeCoordinator,
          ),
        ),
        GoRoute(
          path: '/library',
          builder: (context, state) => LibraryScreen(
            libraryAccess: effectiveLibraryAccess,
            libraryRepository: effectiveLibraryRepo,
            scopeCoordinator: activeScopeCoordinator,
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
              libraryAccess: effectiveLibraryAccess,
              scopeCoordinator: activeScopeCoordinator,
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
              sessionAccess: effectiveSessionAccess,
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
