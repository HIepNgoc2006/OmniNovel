import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/presentation/library_screen.dart';
import 'package:omninovel_mobile/features/library/repositories/account_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/library_access.dart';
import 'package:omninovel_mobile/features/library/repositories/scoped_library_dispatcher.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_session_dispatcher.dart';

class FakeAuthService extends ChangeNotifier implements AuthService {
  AuthState _state = const AuthState(status: AuthStatus.unauthenticated);

  @override
  AuthState get state => _state;

  void updateState(AuthState newState) {
    _state = newState;
    notifyListeners();
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

class MockProgressRepo extends Mock implements ReadingProgressRepository {}
class MockGuestProgressRepo extends Mock implements GuestReadingProgressRepository {}
class MockAccountLibraryAdapter extends Mock implements AccountLibraryAdapter {}
class MockGuestLibraryAdapter extends Mock implements GuestLibraryAdapter {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    registerFallbackValue(LocalReadingCheckpoint(
      storyId: 's',
      chapterId: 'c',
      pageIndex: 1,
      progressPercentage: 0,
      scrollPosition: 0,
      updatedAt: DateTime.now(),
    ));
    registerFallbackValue(const ReadingProgressPayload(
      chapterId: 'chap-1',
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

  group('Task 3 Guardrail P0 #1: Deferred Side Effects Cancellation Guard', () {
    late FakeAuthService authService;
    late FakeCoordinator coordinator;
    late MockProgressRepo mockProgressRepo;
    late MockGuestProgressRepo mockGuestProgressRepo;
    late AccountReadingSessionAdapter accountAdapter;
    late GuestReadingSessionAdapter guestAdapter;
    late ScopedReadingSessionDispatcher dispatcher;

    setUp(() {
      authService = FakeAuthService();
      coordinator = FakeCoordinator();
      mockProgressRepo = MockProgressRepo();
      mockGuestProgressRepo = MockGuestProgressRepo();

      accountAdapter = AccountReadingSessionAdapter(
        readingProgressRepository: mockProgressRepo,
      );

      guestAdapter = GuestReadingSessionAdapter(
        guestRepository: mockGuestProgressRepo,
      );

      dispatcher = ScopedReadingSessionDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: accountAdapter,
        guestAdapter: guestAdapter,
      );
    });

    tearDown(() {
      dispatcher.dispose();
    });

    testWidgets('Pending account debounce is cancelled immediately upon logout (zero delayed HTTP mutation)',
        (tester) async {
      // 1. Khởi tạo trạng thái Account Coherent
      authService.updateState(
        const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'usr-p0', email: 'p0@test.com', username: 'p0', role: 'READER'),
        ),
      );
      coordinator.updateScope('account:usr-p0');

      when(() => mockProgressRepo.getLastKnownServerEpoch(any()))
          .thenAnswer((_) async => 1);
      when(() => mockProgressRepo.saveLocalCheckpoint(any()))
          .thenAnswer((_) async => {});
      when(() => mockProgressRepo.saveProgress(any()))
          .thenAnswer((_) async => const ReadingProgressResponse(storyId: 'story-p0', writeEpoch: 2));

      // Bắt đầu session và record progress (kích hoạt debounce timer 2500ms)
      await dispatcher.initSession(storyId: 'story-p0');
      dispatcher.recordProgress(
        storyId: 'story-p0',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        flutterPageIndex: 3,
        progressPercentage: 45.0,
        scrollPosition: 1200.0,
      );

      // Verify: Debounce timer đang chạy, saveProgress CHƯA được gọi
      verifyNever(() => mockProgressRepo.saveProgress(any()));

      // 2. Chuyển đổi trạng thái Logout: unauthenticated + guest:G2
      // FakeAuthService & FakeCoordinator tự notifyListeners() tới dispatcher
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-new-scope');

      // 3. Cho thời gian trôi qua vượt xa chu kỳ debounce 2500ms
      await tester.pump(const Duration(milliseconds: 3500));

      // 4. Invariant Assertion: Debounce cũ đã bị cancelPendingEffects() hủy, không có HTTP mutation nào được gọi!
      verifyNever(() => mockProgressRepo.saveProgress(any()));
    });
  });

  group('Task 3 Guardrail P0 #2: Dynamic Screen Reactivity on Alive Screen', () {
    late FakeAuthService authService;
    late FakeCoordinator coordinator;
    late MockAccountLibraryAdapter mockAccountAdapter;
    late MockGuestLibraryAdapter mockGuestAdapter;
    late ScopedLibraryDispatcher libraryDispatcher;

    setUp(() {
      authService = FakeAuthService();
      coordinator = FakeCoordinator();
      mockAccountAdapter = MockAccountLibraryAdapter();
      mockGuestAdapter = MockGuestLibraryAdapter();

      libraryDispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: mockAccountAdapter,
        guestAdapter: mockGuestAdapter,
      );
    });

    testWidgets('/library alive screen dynamically rebinds from account to fresh guest:G2 without app restart',
        (tester) async {
      // 1. Ban đầu: Màn hình /library sống với Account Coherent
      authService.updateState(
        const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'usr-alive', email: 'alive@test.com', username: 'alive', role: 'READER'),
        ),
      );
      coordinator.updateScope('account:usr-alive');

      final accountItem = BookmarkedStoryItem(
        story: const LibraryStorySummary(
          id: 'acc-s1',
          title: 'Account Truyện Đang Theo Dõi',
          slug: 'acc-s1',
          mediaFormat: 'COMIC',
          status: 'ONGOING',
          totalChapters: 10,
        ),
        bookmarkedAt: DateTime.now(),
        unreadChapterCount: 0,
      );

      when(() => mockAccountAdapter.getCachedBookmarks(status: any(named: 'status')))
          .thenReturn([accountItem]);
      when(() => mockAccountAdapter.getCachedHistory()).thenReturn([]);
      when(() => mockAccountAdapter.getCachedContinueReading()).thenReturn(null);
      when(() => mockAccountAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).thenAnswer((_) async => PaginatedBookmarksResponse(
            data: [accountItem],
            pagination: const PaginationMeta(page: 1, limit: 20, totalItems: 1, totalPages: 1),
          ));
      when(() => mockAccountAdapter.fetchHistory(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            updateCache: any(named: 'updateCache'),
          )).thenAnswer((_) async => const PaginatedReadingHistoryResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockAccountAdapter.getContinueReading()).thenAnswer((_) async => null);

      // Chuẩn bị dữ liệu cho Guest: Ban đầu rỗng (fresh G2)
      when(() => mockGuestAdapter.getCachedBookmarks(status: any(named: 'status')))
          .thenReturn([]);
      when(() => mockGuestAdapter.getCachedHistory()).thenReturn([]);
      when(() => mockGuestAdapter.getCachedContinueReading()).thenReturn(null);
      when(() => mockGuestAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).thenAnswer((_) async => const PaginatedBookmarksResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockGuestAdapter.fetchHistory(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            updateCache: any(named: 'updateCache'),
          )).thenAnswer((_) async => const PaginatedReadingHistoryResponse(
            data: [],
            pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 1),
          ));
      when(() => mockGuestAdapter.getContinueReading()).thenAnswer((_) async => null);

      // Render LibraryScreen với libraryDispatcher và coordinator
      await tester.pumpWidget(
        MaterialApp(
          home: LibraryScreen(
            libraryAccess: libraryDispatcher,
            scopeCoordinator: coordinator,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Xác nhận UI đang hiển thị truyện của Account
      expect(find.text('Account Truyện Đang Theo Dõi'), findsOneWidget);

      // 2. Chuyển đổi Scope: LOGOUT xảy ra trong khi LibraryScreen đang SỐNG
      authService.updateState(AuthState.unauthenticated());
      coordinator.updateScope('guest:gst-fresh-g2');

      // Chờ phản ứng revalidate ngầm của LibraryScreen
      await tester.pumpAndSettle();

      // 3. Invariant Assertion: LibraryScreen tự động rebind sang guest:gst-fresh-g2
      // Truyện của account đã biến mất, màn hình hiển thị trạng thái rỗng của guest G2
      expect(find.text('Account Truyện Đang Theo Dõi'), findsNothing);
      expect(find.text('Chưa có truyện nào trong danh sách theo dõi'), findsOneWidget);

      // Verify: GuestAdapter được gọi để nạp lại dữ liệu cho guest
      verify(() => mockGuestAdapter.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          )).called(greaterThanOrEqualTo(1));
    });
  });

  group('Task 3 Mini-Remediation: Scope-Coherence Guard with Explicit AuthStatus and State', () {
    late FakeAuthService authService;
    late FakeCoordinator coordinator;
    late MockAccountLibraryAdapter mockAccountLibraryAdapter;
    late MockGuestLibraryAdapter mockGuestLibraryAdapter;
    late MockProgressRepo mockProgressRepo;
    late MockGuestProgressRepo mockGuestProgressRepo;
    late AccountReadingSessionAdapter accountSessionAdapter;
    late GuestReadingSessionAdapter guestSessionAdapter;
    late ScopedLibraryDispatcher libraryDispatcher;
    late ScopedReadingSessionDispatcher readingDispatcher;

    setUp(() {
      authService = FakeAuthService();
      coordinator = FakeCoordinator();
      mockAccountLibraryAdapter = MockAccountLibraryAdapter();
      mockGuestLibraryAdapter = MockGuestLibraryAdapter();
      mockProgressRepo = MockProgressRepo();
      mockGuestProgressRepo = MockGuestProgressRepo();

      libraryDispatcher = ScopedLibraryDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: mockAccountLibraryAdapter,
        guestAdapter: mockGuestLibraryAdapter,
      );

      accountSessionAdapter = AccountReadingSessionAdapter(
        readingProgressRepository: mockProgressRepo,
      );
      guestSessionAdapter = GuestReadingSessionAdapter(
        guestRepository: mockGuestProgressRepo,
      );

      readingDispatcher = ScopedReadingSessionDispatcher(
        authService: authService,
        coordinator: coordinator,
        accountAdapter: accountSessionAdapter,
        guestAdapter: guestSessionAdapter,
      );
    });

    tearDown(() {
      libraryDispatcher.dispose();
      readingDispatcher.dispose();
    });

    test('AuthStatus.authenticating + activeScope=guest:G => setBookmark & recordProgress FAIL-CLOSED', () async {
      authService.updateState(const AuthState(status: AuthStatus.authenticating));
      // Coordinator vẫn giữ stale guest scope và trạng thái guest
      coordinator.updateScope('guest:gst-stale-test', isTransitioning: false);

      const mutation = BookmarkMutation(storyId: 's-race', isBookmarked: true, title: 'Title');

      // 1. Library mutation throws ScopeCoherenceException
      expect(
        () => libraryDispatcher.setBookmark(mutation),
        throwsA(isA<ScopeCoherenceException>()),
      );

      // 2. Reading session recordProgress throws ScopeCoherenceException
      expect(
        () => readingDispatcher.recordProgress(
          storyId: 's-race',
          chapterId: 'c-race',
          flutterPageIndex: 1,
          progressPercentage: 10.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      // 3. ZERO interaction with both Guest and Account adapters
      verifyZeroInteractions(mockAccountLibraryAdapter);
      verifyZeroInteractions(mockGuestLibraryAdapter);
      verifyZeroInteractions(mockProgressRepo);
      verifyZeroInteractions(mockGuestProgressRepo);
    });

    test('AuthStatus.unauthenticated + coordinator.state=transitioning + stale activeScope=guest:G => FAIL-CLOSED', () async {
      authService.updateState(AuthState.unauthenticated());
      // Coordinator đang transitioning
      coordinator.updateScope('guest:gst-stale-transitioning', isTransitioning: true);

      const mutation = BookmarkMutation(storyId: 's-trans', isBookmarked: true, title: 'Title');

      expect(
        () => libraryDispatcher.setBookmark(mutation),
        throwsA(isA<ScopeCoherenceException>()),
      );

      expect(
        () => readingDispatcher.recordProgress(
          storyId: 's-trans',
          chapterId: 'c-trans',
          flutterPageIndex: 2,
          progressPercentage: 20.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountLibraryAdapter);
      verifyZeroInteractions(mockGuestLibraryAdapter);
      verifyZeroInteractions(mockProgressRepo);
      verifyZeroInteractions(mockGuestProgressRepo);
    });
  });
}
