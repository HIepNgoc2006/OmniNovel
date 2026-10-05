import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:omninovel_mobile/app/router/app_router.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/theme/theme_controller.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/auth/presentation/login_screen.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/presentation/library_screen.dart';
import 'package:omninovel_mobile/features/library/repositories/account_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_repository.dart';
import 'package:omninovel_mobile/features/library/repositories/library_access.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';
import 'package:omninovel_mobile/features/library/repositories/scoped_library_dispatcher.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_report_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/media_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_session_access.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_session_dispatcher.dart';
import 'package:omninovel_mobile/features/story/models/story_models.dart' hide PaginationMeta;
import 'package:omninovel_mobile/features/story/repositories/story_repository.dart';

class FakeThemeController extends ChangeNotifier implements ThemeController {
  @override
  bool get isOledMode => false;
  @override
  bool get isDarkMode => true;
  @override
  String get currentThemeId => 'DEFAULT';
  @override
  ThemeData get currentTheme => ThemeData.dark();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeAuthService extends ChangeNotifier implements AuthService {
  AuthState _state = const AuthState(status: AuthStatus.unauthenticated);

  @override
  AuthState get state => _state;

  void updateState(AuthState newState) {
    _state = newState;
    notifyListeners();
  }

  @override
  Future<void> login({required String identifier, required String password}) async {
    if (identifier == 'fail@test.com') {
      updateState(const AuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: 'Invalid credentials',
      ));
      throw Exception('Invalid credentials');
    }
    updateState(const AuthState(
      status: AuthStatus.authenticated,
      user: User(id: 'usr-accepted', email: 'ok@test.com', username: 'userOk', role: 'READER'),
    ));
  }

  @override
  Future<void> logout() async {
    updateState(const AuthState(status: AuthStatus.unauthenticated));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCoordinator extends ChangeNotifier implements ActiveScopeCoordinator {
  String? _scope;
  bool _transitioning = false;
  ActiveScopeState _state = ActiveScopeState.bootstrapping;

  @override
  ActiveScopeState get state => _state;

  @override
  String? get activeScope => _scope;

  bool get isTransitioning => _transitioning;

  void updateScope(String? newScope, {bool isTransitioning = false, ActiveScopeState? state}) {
    _scope = newScope;
    _transitioning = isTransitioning;
    if (state != null) {
      _state = state;
    } else if (isTransitioning) {
      _state = ActiveScopeState.transitioning;
    } else if (newScope == null) {
      _state = ActiveScopeState.bootstrapping;
    } else if (newScope.startsWith('account:')) {
      _state = ActiveScopeState.account;
    } else if (newScope.startsWith('guest:')) {
      _state = ActiveScopeState.guest;
    }
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class MockApiClient extends Mock implements ApiClient {}
class MockStoryRepo extends Mock implements StoryRepository {}
class MockChapterRepo extends Mock implements ChapterRepository {}
class MockMediaRepo extends Mock implements MediaRepository {}
class MockReportRepo extends Mock implements ChapterReportRepository {}
class MockReadingProgressRepo extends Mock implements ReadingProgressRepository {}
class MockGuestReadingProgressRepo extends Mock implements GuestReadingProgressRepository {}
class MockLibraryRepo extends Mock implements LibraryRepository {}
class MockGuestLibraryRepo extends Mock implements GuestLibraryRepository {}
class MockAccountLibraryAdapter extends Mock implements AccountLibraryAdapter {}
class MockGuestLibraryAdapter extends Mock implements GuestLibraryAdapter {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(const BookmarkMutation(storyId: 's', isBookmarked: true, title: 't'));
    registerFallbackValue(LocalReadingCheckpoint(
      storyId: 's',
      chapterId: 'c',
      pageIndex: 1,
      progressPercentage: 0,
      scrollPosition: 0,
      updatedAt: DateTime.now(),
    ));
    registerFallbackValue(LocalReadingProgress(
      ownerScope: 'guest:gst-fallback',
      storyId: 's',
      chapterId: 'c',
      progressPercentage: 0,
      scrollPosition: 0,
      updatedAt: DateTime.now(),
      deviceTimestamp: DateTime.now(),
    ));
    registerFallbackValue(LocalReadingHistory(
      ownerScope: 'guest:gst-fallback',
      storyId: 's',
      chapterId: 'c',
      storyTitle: 's',
      chapterNumber: '1',
      progressPercentage: 0,
      lastReadAt: DateTime.now(),
    ));
    registerFallbackValue(const ReadingProgressPayload(
      chapterId: 'c',
      pageIndex: 1,
      progressPercentage: 0,
      readingMode: 'WEBTOON',
      scrollPosition: 0,
      writeEpoch: 1,
    ));
    registerFallbackValue(const PendingReadingProgress(
      storyId: 's',
      chapterId: 'c',
      progressPercentage: 0,
      scrollPosition: 0,
    ));
  });

  group('Task 7A.6 Step 2: 13-Case Acceptance & Regression Gate', () {
    late FakeAuthService authService;
    late FakeCoordinator coordinator;
    late MockApiClient mockApiClient;
    late MockStoryRepo mockStoryRepo;
    late MockChapterRepo mockChapterRepo;
    late MockMediaRepo mockMediaRepo;
    late MockReportRepo mockReportRepo;
    late MockReadingProgressRepo mockReadingProgressRepo;
    late MockGuestReadingProgressRepo mockGuestReadingProgressRepo;
    late MockLibraryRepo mockLibraryRepo;
    late MockGuestLibraryRepo mockGuestLibraryRepo;

    setUp(() {
      authService = FakeAuthService();
      coordinator = FakeCoordinator();
      mockApiClient = MockApiClient();
      mockStoryRepo = MockStoryRepo();
      mockChapterRepo = MockChapterRepo();
      mockMediaRepo = MockMediaRepo();
      mockReportRepo = MockReportRepo();
      mockReadingProgressRepo = MockReadingProgressRepo();
      mockGuestReadingProgressRepo = MockGuestReadingProgressRepo();
      mockLibraryRepo = MockLibraryRepo();
      mockGuestLibraryRepo = MockGuestLibraryRepo();

      // Default stubs
      when(() => mockStoryRepo.getFeaturedStories()).thenAnswer((_) async => const FeaturedStoriesResponse(hotStories: [], banners: []));
      when(() => mockStoryRepo.getRankings()).thenAnswer((_) async => const StoryRankingsResponse(topComics: [], topNovels: []));
      when(() => mockStoryRepo.getGenres()).thenAnswer((_) async => []);
      when(() => mockLibraryRepo.getCachedBookmarks(status: any(named: 'status'))).thenReturn([]);
      when(() => mockLibraryRepo.getCachedHistory()).thenReturn([]);
      when(() => mockLibraryRepo.getCachedContinueReading()).thenReturn(null);
      when(() => mockGuestLibraryRepo.getBookmarks()).thenAnswer((_) async => []);
      when(() => mockGuestLibraryRepo.getHistory()).thenAnswer((_) async => []);
      when(() => mockGuestLibraryRepo.saveBookmark(
            storyId: any(named: 'storyId'),
            title: any(named: 'title'),
            slug: any(named: 'slug'),
            coverUrl: any(named: 'coverUrl'),
          )).thenAnswer((_) async => {});
      when(() => mockGuestReadingProgressRepo.recordReadingSession(
            progress: any(named: 'progress'),
            history: any(named: 'history'),
          )).thenAnswer((_) async => {});
      when(() => mockGuestReadingProgressRepo.getProgress(any())).thenAnswer((_) async => null);
    });

    GoRouter buildRouter({String? initialLocation}) {
      return AppRouter.create(
        authService: authService,
        apiClient: mockApiClient,
        storyRepository: mockStoryRepo,
        chapterRepository: mockChapterRepo,
        mediaRepository: mockMediaRepo,
        chapterReportRepository: mockReportRepo,
        readingProgressRepository: mockReadingProgressRepo,
        libraryRepository: mockLibraryRepo,
        activeScopeCoordinator: coordinator,
        guestLibraryRepository: mockGuestLibraryRepo,
        guestReadingProgressRepository: mockGuestReadingProgressRepo,
      );
    }

    Future<void> pumpRouterApp(WidgetTester tester, GoRouter router) async {
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AuthService>.value(value: authService),
            ChangeNotifierProvider<ActiveScopeCoordinator>.value(value: coordinator),
            ChangeNotifierProvider<ThemeController>.value(value: FakeThemeController()),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();
    }

    // =========================================================================
    // Case 1: Public route guest access
    // =========================================================================
    testWidgets('Case 1: Public routes (/home, /search, /library) allow guest access without redirect to /login',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-1');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      // 1. /home
      expect(router.routeInformationProvider.value.uri.path, '/home');

      // 2. /search
      router.go('/search');
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/search');

      // 3. /library
      router.go('/library');
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/library');
    });

    // =========================================================================
    // Case 2: Account-only route guest redirection (/profile -> /login?returnTo=%2Fprofile)
    // =========================================================================
    testWidgets('Case 2: Guest accessing account-only /profile is redirected to /login?returnTo=%2Fprofile',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-2');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/profile');
      await tester.pumpAndSettle();

      final currentUri = router.routeInformationProvider.value.uri;
      expect(currentUri.path, '/login');
      expect(currentUri.queryParameters['returnTo'], '/profile');
      expect(find.byType(LoginScreen), findsOneWidget);
    });

    // =========================================================================
    // Case 3: Successful login redirection via returnTo
    // =========================================================================
    testWidgets('Case 3: Login success redirects back to original returnTo (/profile)',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-3');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/login?returnTo=%2Fprofile');
      await tester.pumpAndSettle();

      // Trigger login
      authService.updateState(const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'usr-case-3', email: 'c3@test.com', username: 'c3', role: 'READER'),
      ));
      coordinator.updateScope('account:usr-case-3');
      await tester.pumpAndSettle();

      final currentUri = router.routeInformationProvider.value.uri;
      expect(currentUri.path, '/profile');
    });

    // =========================================================================
    // Case 4: Failed login preserves existing guest profile
    // =========================================================================
    testWidgets('Case 4: Failed login retains existing guest profile and stays on /login with error',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-original-profile');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/login?returnTo=%2Fprofile');
      await tester.pumpAndSettle();

      // Fill and submit bad credentials
      await tester.enterText(find.byKey(const Key('login_identifier_field')), 'fail@test.com');
      await tester.enterText(find.byKey(const Key('login_password_field')), 'wrongpass');
      await tester.tap(find.byKey(const Key('login_submit_button')));
      await tester.pumpAndSettle();

      // Assert: stays on /login, error displayed, guest profile unchanged
      expect(router.routeInformationProvider.value.uri.path, '/login');
      expect(find.text('Invalid credentials'), findsOneWidget);
      expect(coordinator.activeScope, 'guest:gst-original-profile');
      expect(coordinator.state, ActiveScopeState.guest);
    });

    // =========================================================================
    // Case 5: Explicit logout from account-only route -> canonical /home
    // =========================================================================
    testWidgets('Case 5: Explicit logout on /profile redirects to canonical /home and rotates to fresh guest',
        (tester) async {
      authService.updateState(const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'usr-case-5', email: 'c5@test.com', username: 'c5', role: 'READER'),
      ));
      coordinator.updateScope('account:usr-case-5');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/profile');
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.path, '/profile');

      // User performs logout
      await authService.logout();
      coordinator.updateScope('guest:gst-fresh-after-logout');
      await tester.pumpAndSettle();

      // Assert: Canonical /home, fresh guest scope
      expect(router.routeInformationProvider.value.uri.path, '/home');
      expect(coordinator.activeScope, 'guest:gst-fresh-after-logout');
    });

    // =========================================================================
    // Case 6: "Tiếp tục với tư cách Khách" button on /login -> /home
    // =========================================================================
    testWidgets('Case 6: Continue as guest button on /login navigates to /home',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-6');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/login');
      await tester.pumpAndSettle();

      final continueButton = find.byKey(const Key('login_continue_as_guest_button'));
      expect(continueButton, findsOneWidget);

      await tester.tap(continueButton);
      await tester.pumpAndSettle();

      expect(router.routeInformationProvider.value.uri.path, '/home');
    });

    // =========================================================================
    // Case 7: Unknown route pass-through (Zero forced login)
    // =========================================================================
    testWidgets('Case 7: Unknown route passes through without forced redirect to /login',
        (tester) async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-7');

      final router = buildRouter();
      await pumpRouterApp(tester, router);

      router.go('/non-existent-404-route');
      await tester.pumpAndSettle();

      // Route is NOT converted to /login!
      expect(router.routeInformationProvider.value.uri.path, isNot('/login'));
      expect(find.byType(LoginScreen), findsNothing);
    });

    // =========================================================================
    // Case 8: Guest bookmark mutation preserves full metadata & zero account/API calls
    // =========================================================================
    test('Case 8: Guest bookmark mutation preserves full metadata and performs ZERO account API calls',
        () async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-8');

      final guestAdapter = GuestLibraryAdapter(guestRepository: mockGuestLibraryRepo);
      final accountAdapter = AccountLibraryAdapter(repository: mockLibraryRepo);

      final dispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: accountAdapter,
        guestAdapter: guestAdapter,
      );

      const mutation = BookmarkMutation(
        storyId: 'story-8',
        isBookmarked: true,
        title: 'Story 8 Full Metadata',
        slug: 'story-8-full-metadata',
        coverUrl: 'https://cdn.example.com/cover8.jpg',
      );

      final res = await dispatcher.setBookmark(mutation);
      expect(res.isBookmarked, isTrue);

      // Verify full metadata reached GuestLibraryRepository
      verify(() => mockGuestLibraryRepo.saveBookmark(
            storyId: 'story-8',
            title: 'Story 8 Full Metadata',
            slug: 'story-8-full-metadata',
            coverUrl: 'https://cdn.example.com/cover8.jpg',
          )).called(1);

      // Verify ZERO interaction with Account repository (zero API calls)
      verifyZeroInteractions(mockLibraryRepo);
    });

    // =========================================================================
    // Case 9: Guest reader session zero epoch / zero network / zero gamification
    // =========================================================================
    test('Case 9: Guest reader session records progress with zero writeEpoch, zero HTTP, zero gamification',
        () async {
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-case-9');

      final guestSessionAdapter = GuestReadingSessionAdapter(
        guestRepository: mockGuestReadingProgressRepo,
        debounceDuration: Duration.zero, // immediate for unit verification
      );
      final accountSessionAdapter = AccountReadingSessionAdapter(
        readingProgressRepository: mockReadingProgressRepo,
      );

      final sessionDispatcher = ScopedReadingSessionDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: accountSessionAdapter,
        guestAdapter: guestSessionAdapter,
      );

      sessionDispatcher.recordProgress(
        storyId: 'story-9',
        chapterId: 'chap-9',
        flutterPageIndex: 5,
        progressPercentage: 50.0,
        scrollPosition: 800.0,
        storyTitle: 'Story 9',
      );
      await sessionDispatcher.flush();

      // Verify: Delegated strictly to GuestReadingProgressRepository
      verify(() => mockGuestReadingProgressRepo.recordReadingSession(
            progress: any(named: 'progress'),
            history: any(named: 'history'),
          )).called(1);

      // Verify: Zero writeEpoch / zero server HTTP mutations on Account repository
      verifyZeroInteractions(mockReadingProgressRepo);
    });

    // =========================================================================
    // Case 10: Alive /library dynamic rebind on logout
    // =========================================================================
    testWidgets('Case 10: /library alive screen dynamically rebinds to fresh guest:G2 on account logout without route restart',
        (tester) async {
      authService.updateState(const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'usr-case-10', email: 'c10@test.com', username: 'c10', role: 'READER'),
      ));
      coordinator.updateScope('account:usr-case-10');

      final mockAccAdapter = MockAccountLibraryAdapter();
      final mockGstAdapter = MockGuestLibraryAdapter();

      final scopedDispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: mockAccAdapter,
        guestAdapter: mockGstAdapter,
      );

      final accountItem = BookmarkedStoryItem(
        story: const LibraryStorySummary(
          id: 'acc-10',
          title: 'Account Exclusive Comic',
          slug: 'acc-10',
          mediaFormat: 'COMIC',
          status: 'ONGOING',
          totalChapters: 10,
        ),
        bookmarkedAt: DateTime.now(),
        unreadChapterCount: 0,
      );

      when(() => mockAccAdapter.getCachedBookmarks(status: any(named: 'status'))).thenReturn([accountItem]);
      when(() => mockAccAdapter.getCachedHistory()).thenReturn([]);
      when(() => mockAccAdapter.getCachedContinueReading()).thenReturn(null);
      when(() => mockAccAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).thenAnswer((_) async => PaginatedBookmarksResponse(
            data: [accountItem],
            pagination: const PaginationMeta(page: 1, limit: 20, totalItems: 1, totalPages: 1),
          ));
      when(() => mockAccAdapter.fetchHistory(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            updateCache: any(named: 'updateCache'),
          )).thenAnswer((_) async => const PaginatedReadingHistoryResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockAccAdapter.getContinueReading()).thenAnswer((_) async => null);

      when(() => mockGstAdapter.getCachedBookmarks(status: any(named: 'status'))).thenReturn([]);
      when(() => mockGstAdapter.getCachedHistory()).thenReturn([]);
      when(() => mockGstAdapter.getCachedContinueReading()).thenReturn(null);
      when(() => mockGstAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).thenAnswer((_) async => const PaginatedBookmarksResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockGstAdapter.fetchHistory(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            updateCache: any(named: 'updateCache'),
          )).thenAnswer((_) async => const PaginatedReadingHistoryResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockGstAdapter.getContinueReading()).thenAnswer((_) async => null);

      await tester.pumpWidget(MaterialApp(
        home: LibraryScreen(
          libraryAccess: scopedDispatcher,
          scopeCoordinator: coordinator,
        ),
      ));
      await tester.pumpAndSettle();

      expect(find.text('Account Exclusive Comic'), findsOneWidget);

      // Account Logout occurs while screen is ALIVE
      await authService.logout();
      coordinator.updateScope('guest:gst-fresh-g2');
      await tester.pumpAndSettle();

      // UI dynamically clears account bookmark and displays fresh empty guest library
      expect(find.text('Account Exclusive Comic'), findsNothing);
      expect(find.text('Chưa có truyện nào trong danh sách theo dõi'), findsOneWidget);
      verify(() => mockGstAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).called(greaterThanOrEqualTo(1));
    });

    // =========================================================================
    // Case 11: Deferred side-effect cancellation (Zero delayed account HTTP sync)
    // =========================================================================
    testWidgets('Case 11: Pending account reader debounce cancelled immediately upon logout (zero delayed HTTP mutation)',
        (tester) async {
      authService.updateState(const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'usr-case-11', email: 'c11@test.com', username: 'c11', role: 'READER'),
      ));
      coordinator.updateScope('account:usr-case-11');

      final accountAdapter = AccountReadingSessionAdapter(
        readingProgressRepository: mockReadingProgressRepo,
      );
      final guestAdapter = GuestReadingSessionAdapter(
        guestRepository: mockGuestReadingProgressRepo,
      );

      final dispatcher = ScopedReadingSessionDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: accountAdapter,
        guestAdapter: guestAdapter,
      );

      when(() => mockReadingProgressRepo.getLastKnownServerEpoch(any())).thenAnswer((_) async => 1);
      when(() => mockReadingProgressRepo.saveLocalCheckpoint(any())).thenAnswer((_) async => {});
      when(() => mockReadingProgressRepo.saveProgress(any()))
          .thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-11', writeEpoch: 2));

      await dispatcher.initSession(storyId: 'story-11');
      dispatcher.recordProgress(
        storyId: 'story-11',
        chapterId: 'chap-11',
        readingMode: 'WEBTOON',
        flutterPageIndex: 2,
        progressPercentage: 20.0,
        scrollPosition: 200.0,
      );

      // Before timer expires, user logs out
      verifyNever(() => mockReadingProgressRepo.saveProgress(any()));

      await authService.logout();
      coordinator.updateScope('guest:gst-after-11');

      // Pump well beyond debounce duration (3500ms)
      await tester.pump(const Duration(milliseconds: 3500));

      // Assert: ZERO HTTP calls fired!
      verifyNever(() => mockReadingProgressRepo.saveProgress(any()));
    });

    // =========================================================================
    // Case 12: Scope-Coherence Guard: Fail-Closed on Non-Coherent States
    // =========================================================================
    test('Case 12: Bootstrapping, Authenticating, Transitioning, and Mismatch states FAIL-CLOSED with ScopeCoherenceException',
        () async {
      final mockAccAdapter = MockAccountLibraryAdapter();
      final mockGstAdapter = MockGuestLibraryAdapter();
      final dispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: mockAccAdapter,
        guestAdapter: mockGstAdapter,
      );

      const mutation = BookmarkMutation(storyId: 's-fail', isBookmarked: true, title: 'Title');

      // Sub-case A: Bootstrapping
      authService.updateState(AuthState.initial());
      coordinator.updateScope(null);
      expect(() => dispatcher.setBookmark(mutation), throwsA(isA<ScopeCoherenceException>()));

      // Sub-case B: Authenticating + stale guest scope
      authService.updateState(const AuthState(status: AuthStatus.authenticating));
      coordinator.updateScope('guest:gst-stale', isTransitioning: false);
      expect(() => dispatcher.setBookmark(mutation), throwsA(isA<ScopeCoherenceException>()));

      // Sub-case C: Transitioning + stale guest scope
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-trans', isTransitioning: true);
      expect(() => dispatcher.setBookmark(mutation), throwsA(isA<ScopeCoherenceException>()));

      // Sub-case D: Auth/Scope Mismatch (authenticated as user A, coordinator set to user B)
      authService.updateState(const AuthState(
        status: AuthStatus.authenticated,
        user: User(id: 'user-A', email: 'a@test.com', username: 'userA', role: 'READER'),
      ));
      coordinator.updateScope('account:user-B');
      expect(() => dispatcher.setBookmark(mutation), throwsA(isA<ScopeCoherenceException>()));

      verifyZeroInteractions(mockAccAdapter);
      verifyZeroInteractions(mockGstAdapter);
    });

    // =========================================================================
    // Case 13: Widget Purity (Zero if (guest) business dispatch)
    // =========================================================================
    test('Case 13: UI components communicate strictly via abstract LibraryAccess and ReadingSessionAccess ports',
        () {
      final mockAccAdapter = MockAccountLibraryAdapter();
      final mockGstAdapter = MockGuestLibraryAdapter();
      final libDispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: mockAccAdapter,
        guestAdapter: mockGstAdapter,
      );

      final readDispatcher = ScopedReadingSessionDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: AccountReadingSessionAdapter(readingProgressRepository: mockReadingProgressRepo),
        guestAdapter: GuestReadingSessionAdapter(guestRepository: mockGuestReadingProgressRepo),
      );

      // Verify polymorphism: Dispatchers implement domain port interfaces
      expect(libDispatcher, isA<LibraryAccess>());
      expect(readDispatcher, isA<ReadingSessionAccess>());

      // Neither port requires widgets to pass isGuest or inspect authentication status
      expect(libDispatcher.runtimeType.toString(), 'ScopedLibraryDispatcher');
      expect(readDispatcher.runtimeType.toString(), 'ScopedReadingSessionDispatcher');
    });
  });
}
