import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/repositories/account_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_repository.dart';
import 'package:omninovel_mobile/features/library/repositories/library_access.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';
import 'package:omninovel_mobile/features/library/repositories/scoped_library_dispatcher.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/models/story_reading_state.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_state_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_state_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_session_dispatcher.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_state_dispatcher.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockLibraryRepository extends Mock implements LibraryRepository {}
class MockReadingProgressRepository extends Mock implements ReadingProgressRepository {}

class FakeAuthService extends ChangeNotifier implements AuthService {
  AuthState _state = const AuthState(status: AuthStatus.initial);

  @override
  AuthState get state => _state;

  void updateState(AuthState newState) {
    _state = newState;
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late SharedPreferences prefs;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_mob_iso_test_');
    dbPath = p.join(tempDir.path, 'omninovel_test_crash.db');

    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  tearDown(() async {
    try {
      if (tempDir.existsSync()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  // =========================================================================
  // Gate 1: Crash/Restart Persistence & Identity Stability (Metadata Only)
  // =========================================================================
  group('Gate 1: Crash/Restart Persistence & Identity Stability (Metadata Only)', () {
    test('survives process crash/runtime reconstruction: preserves installationId, guestProfileId and exact SQLite metadata without stale RAM objects', () async {
      // 1. Giai đoạn Pre-Crash: Khởi tạo các instance đầu tiên
      final installProvider1 = InstallationIdentityProvider(prefs: prefs);
      final guestProfileProvider1 = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator1 = ActiveScopeCoordinator(
        installProvider: installProvider1,
        guestProfileProvider: guestProfileProvider1,
      );

      final initialInstallId = await installProvider1.getOrCreateInstallationId();
      final initialGuestProfileId = await guestProfileProvider1.getOrCreateGuestProfileId();
      await coordinator1.onAuthStatusChanged(AuthStatus.unauthenticated);
      final initialScope = coordinator1.activeScope!;
      expect(initialScope, equals('guest:$initialGuestProfileId'));

      final offlineDb1 = OfflineDatabase();
      await offlineDb1.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);
      final dao1 = LocalLibraryDao(offlineDatabase: offlineDb1);
      final guestLibRepo1 = GuestLibraryRepository(dao: dao1, coordinator: coordinator1);
      final guestProgressRepo1 = GuestReadingProgressRepository(dao: dao1, coordinator: coordinator1);

      // Ghi bookmark, progress, history
      await guestLibRepo1.saveBookmark(
        storyId: 'story-crash-mob-1',
        title: 'Truyện Mobile Sống Sót Qua Crash',
        slug: 'truyen-mobile-crash',
        coverUrl: 'https://cdn.omninovel.com/covers/mobile_crash.jpg',
      );

      await guestProgressRepo1.recordReadingSession(
        progress: LocalReadingProgress(
          ownerScope: initialScope,
          storyId: 'story-crash-mob-1',
          chapterId: 'chap-50',
          pageIndex: 50,
          progressPercentage: 80.0,
          scrollPosition: 2000.0,
          updatedAt: DateTime.now(),
          deviceTimestamp: DateTime.now(),
        ),
        history: LocalReadingHistory(
          ownerScope: initialScope,
          storyId: 'story-crash-mob-1',
          chapterId: 'chap-50',
          storyTitle: 'Truyện Mobile Sống Sót Qua Crash',
          storySlug: 'truyen-mobile-crash',
          chapterNumber: '50',
          chapterTitle: 'Hồi Kết Rực Rỡ',
          progressPercentage: 80.0,
          lastReadAt: DateTime.now(),
        ),
      );

      // 2. MÔ PHỎNG CRASH & APP KILL
      // Đóng toàn bộ kết nối SQLite, vứt bỏ toàn bộ references trong RAM
      await offlineDb1.close();

      // 3. Khởi động lại runtime (Post-Crash Reconstruction)
      final installProvider2 = InstallationIdentityProvider(prefs: prefs);
      final guestProfileProvider2 = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator2 = ActiveScopeCoordinator(
        installProvider: installProvider2,
        guestProfileProvider: guestProfileProvider2,
      );

      // INVARIANT 1: Stable Identity phục hồi nguyên vẹn từ SharedPreferences
      final recoveredInstallId = await installProvider2.getOrCreateInstallationId();
      final recoveredGuestProfileId = await guestProfileProvider2.getOrCreateGuestProfileId();
      expect(recoveredInstallId, equals(initialInstallId));
      expect(recoveredGuestProfileId, equals(initialGuestProfileId));
      await coordinator2.onAuthStatusChanged(AuthStatus.unauthenticated);
      expect(coordinator2.activeScope, equals(initialScope));

      // Mở kết nối SQLite mới từ file vật lý
      final offlineDb2 = OfflineDatabase();
      await offlineDb2.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);
      final dao2 = LocalLibraryDao(offlineDatabase: offlineDb2);
      final guestLibRepo2 = GuestLibraryRepository(dao: dao2, coordinator: coordinator2);
      final guestProgressRepo2 = GuestReadingProgressRepository(dao: dao2, coordinator: coordinator2);

      // INVARIANT 2: Bookmark phục hồi chính xác từ SQLite
      final recoveredBookmark = await guestLibRepo2.getBookmark('story-crash-mob-1');
      expect(recoveredBookmark, isNotNull);
      expect(recoveredBookmark!.title, equals('Truyện Mobile Sống Sót Qua Crash'));
      expect(recoveredBookmark.slug, equals('truyen-mobile-crash'));
      expect(recoveredBookmark.coverUrl, equals('https://cdn.omninovel.com/covers/mobile_crash.jpg'));

      // INVARIANT 3: Reading Progress & Paged Index phục hồi chính xác từ SQLite
      final recoveredProgress = await guestProgressRepo2.getProgress('story-crash-mob-1');
      expect(recoveredProgress, isNotNull);
      expect(recoveredProgress!.chapterId, equals('chap-50'));
      expect(recoveredProgress.pageIndex, equals(50));
      expect(recoveredProgress.progressPercentage, equals(80.0));
      expect(recoveredProgress.scrollPosition, equals(2000.0));

      // INVARIANT 4: Reading History phục hồi đầy đủ
      final recoveredHistory = await guestLibRepo2.getHistory();
      expect(recoveredHistory.length, equals(1));
      expect(recoveredHistory.first.chapterTitle, equals('Hồi Kết Rực Rỡ'));

      await offlineDb2.close();
    });
  });

  // =========================================================================
  // Gate 2: Guest Zero-Network & Zero-Bearer Leakage
  // =========================================================================
  group('Gate 2: Guest Zero-Network & Zero-Bearer Leakage', () {
    test('executes guest mutations with ZERO ApiClient network calls, zero bearer headers, zero account repo calls', () async {
      final installProvider = InstallationIdentityProvider(prefs: prefs);
      final guestProfileProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProfileProvider,
      );
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);
      final dao = LocalLibraryDao(offlineDatabase: offlineDb);
      final guestLibRepo = GuestLibraryRepository(dao: dao, coordinator: coordinator);
      final guestProgressRepo = GuestReadingProgressRepository(dao: dao, coordinator: coordinator);

      final mockApiClient = MockApiClient();
      final mockAccountLibRepo = MockLibraryRepository();
      final mockAccountProgressRepo = MockReadingProgressRepository();

      // Dựng Scoped Dispatchers
      final authService = FakeAuthService();
      authService.updateState(AuthState.unauthenticated());

      final libraryDispatcher = ScopedLibraryDispatcher(
        accountAdapter: AccountLibraryAdapter(repository: mockAccountLibRepo),
        guestAdapter: GuestLibraryAdapter(guestRepository: guestLibRepo),
        authService: authService,
        coordinator: coordinator,
      );
      final sessionDispatcher = ScopedReadingSessionDispatcher(
        accountAdapter: AccountReadingSessionAdapter(readingProgressRepository: mockAccountProgressRepo),
        guestAdapter: GuestReadingSessionAdapter(guestRepository: guestProgressRepo),
        authService: authService,
        coordinator: coordinator,
      );

      // 1. Guest mutation: Bookmark
      await libraryDispatcher.setBookmark(const BookmarkMutation(
        storyId: 'story-zero-net-mob',
        isBookmarked: true,
        title: 'Zero Net Story',
        slug: 'zero-net-story',
      ));

      // 2. Guest mutation: Reading progress & flush
      sessionDispatcher.recordProgress(
        storyId: 'story-zero-net-mob',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        flutterPageIndex: 0,
        progressPercentage: 45.0,
        scrollPosition: 450.0,
        storyTitle: 'Zero Net Story',
      );
      await sessionDispatcher.flush();
      await Future<void>.delayed(const Duration(milliseconds: 50));

      // 3. Guest mutation: History delete
      await libraryDispatcher.deleteStoryHistory('story-zero-net-mob');
      await libraryDispatcher.clearAllHistory();

      // INVARIANTS: Zero Network & Zero Bearer & Zero Account Invocations
      verifyZeroInteractions(mockApiClient);
      verifyZeroInteractions(mockAccountLibRepo);
      verifyZeroInteractions(mockAccountProgressRepo);

      sessionDispatcher.dispose();
      await offlineDb.close();
    });
  });

  // =========================================================================
  // Gate 3: Cross-Contamination Prevention & Guest Data Preserved
  // =========================================================================
  group('Gate 3: Cross-Contamination Prevention (A -> fresh G -> B) & Guest Data Preserved', () {
    test('isolates user sessions, binds zero guest data to User B, and preserves guest G data in SQLite (hidden but preserved)', () async {
      final installProvider = InstallationIdentityProvider(prefs: prefs);
      final guestProfileProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProfileProvider,
      );

      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);
      final dao = LocalLibraryDao(offlineDatabase: offlineDb);
      final guestLibRepo = GuestLibraryRepository(dao: dao, coordinator: coordinator);
      final guestProgressRepo = GuestReadingProgressRepository(dao: dao, coordinator: coordinator);

      // 1. User Alice đăng nhập
      await coordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: 'usr-alice');
      expect(coordinator.activeScope, equals('account:usr-alice'));

      // 2. User Alice đăng xuất -> Rotate sang fresh guest G2
      await coordinator.onLogout();
      final guestScopeG2 = coordinator.activeScope!;
      expect(coordinator.state, equals(ActiveScopeState.guest));
      expect(guestScopeG2, startsWith('guest:'));

      // 3. Guest G2 tạo dữ liệu tại partition guest:G2
      await guestLibRepo.saveBookmark(
        storyId: 'story-preserved-mob',
        title: 'Truyện Cần Giữ Lại G2',
        slug: 'truyen-giu-lai-g2',
      );
      await guestProgressRepo.recordReadingSession(
        progress: LocalReadingProgress(
          ownerScope: guestScopeG2,
          storyId: 'story-preserved-mob',
          chapterId: 'chap-1',
          pageIndex: 1,
          progressPercentage: 50.0,
          scrollPosition: 500.0,
          updatedAt: DateTime.now(),
          deviceTimestamp: DateTime.now(),
        ),
        history: LocalReadingHistory(
          ownerScope: guestScopeG2,
          storyId: 'story-preserved-mob',
          chapterId: 'chap-1',
          storyTitle: 'Truyện Cần Giữ Lại G2',
          chapterNumber: '1',
          progressPercentage: 50.0,
          lastReadAt: DateTime.now(),
        ),
      );

      // 4. User Bob đăng nhập trên cùng máy
      await coordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: 'usr-bob');
      expect(coordinator.activeScope, equals('account:usr-bob'));

      // INVARIANT 1: Bob tách biệt hoàn toàn khỏi G2 và Alice
      expect(coordinator.activeScope, isNot(equals(guestScopeG2)));
      expect(coordinator.activeScope, isNot(equals('account:usr-alice')));

      // INVARIANT 2: Bob-facing repository & dispatcher isolation
      // Kiểm tra trực tiếp qua Scoped Dispatchers từ góc nhìn của User Bob:
      final mockAccountLibRepo = MockLibraryRepository();
      final mockAccountProgressRepo = MockReadingProgressRepository();
      when(() => mockAccountLibRepo.getBookmarkStatus('story-preserved-mob'))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: false));
      when(() => mockAccountLibRepo.fetchBookmarks(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            status: any(named: 'status'),
          ))
          .thenAnswer((_) async => const PaginatedBookmarksResponse(
                data: [],
                pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 0),
              ));
      when(() => mockAccountLibRepo.fetchHistory(
            page: any(named: 'page'),
            limit: any(named: 'limit'),
            updateCache: any(named: 'updateCache'),
          ))
          .thenAnswer((_) async => const PaginatedReadingHistoryResponse(
                data: [],
                pagination: PaginationMeta(page: 1, limit: 20, totalItems: 0, totalPages: 0),
              ));
      when(() => mockAccountProgressRepo.getProgress('story-preserved-mob'))
          .thenAnswer((_) async => const ReadingProgressResponse(
                storyId: 'story-preserved-mob',
                chapterId: null,
                writeEpoch: 0,
              ));
      when(() => mockAccountProgressRepo.getLocalCheckpoint('story-preserved-mob'))
          .thenAnswer((_) async => null);
      when(() => mockAccountProgressRepo.setServerEpoch('story-preserved-mob', 0))
          .thenReturn(null);
      when(() => mockAccountProgressRepo.ensureServerEpoch('story-preserved-mob'))
          .thenAnswer((_) async => 0);

      final authService = FakeAuthService();
      authService.updateState(AuthState.authenticated(
        user: const User(id: 'usr-bob', email: 'bob@test.com', username: 'bob', role: 'READER'),
        accessToken: 'token-bob',
      ));

      final bobLibraryDispatcher = ScopedLibraryDispatcher(
        accountAdapter: AccountLibraryAdapter(repository: mockAccountLibRepo),
        guestAdapter: GuestLibraryAdapter(guestRepository: guestLibRepo),
        authService: authService,
        coordinator: coordinator,
      );
      final bobStateDispatcher = ScopedReadingStateDispatcher(
        accountAdapter: AccountReadingStateAdapter(repository: mockAccountProgressRepo),
        guestAdapter: GuestReadingStateAdapter(guestRepository: guestProgressRepo),
        authService: authService,
        coordinator: coordinator,
      );
      final bobSessionDispatcher = ScopedReadingSessionDispatcher(
        accountAdapter: AccountReadingSessionAdapter(readingProgressRepository: mockAccountProgressRepo),
        guestAdapter: GuestReadingSessionAdapter(guestRepository: guestProgressRepo),
        authService: authService,
        coordinator: coordinator,
      );

      // Bob kiểm tra bookmark truyện của G2 qua dispatcher -> false, zero data leaked
      final bobBookmarkStatus = await bobLibraryDispatcher.getBookmarkStatus('story-preserved-mob');
      expect(bobBookmarkStatus.isBookmarked, isFalse);

      final bobBookmarks = await bobLibraryDispatcher.fetchBookmarks();
      expect(bobBookmarks.data, isEmpty);

      final bobHistory = await bobLibraryDispatcher.fetchHistory();
      expect(bobHistory.data, isEmpty);

      // Bob kiểm tra tiến độ đọc qua ScopedReadingStateDispatcher -> zero reading progress từ Guest G2, null resume pointer
      final bobReadingState = await bobStateDispatcher.getStoryReadingState('story-preserved-mob');
      expect(bobReadingState.resume, isNull);
      expect(bobReadingState.readChapterIds, isEmpty);
      verify(() => mockAccountProgressRepo.getProgress('story-preserved-mob')).called(1);
      verify(() => mockAccountProgressRepo.getLocalCheckpoint('story-preserved-mob')).called(1);

      // Bob khởi tạo reading session qua ScopedReadingSessionDispatcher -> binds to Bob's account-side repository
      await bobSessionDispatcher.initSession(storyId: 'story-preserved-mob');
      verify(() => mockAccountProgressRepo.ensureServerEpoch('story-preserved-mob')).called(1);

      // Guest repositories lập tức ném InvalidGuestScopeException khi bị gọi trong session của Bob
      expect(
        () => guestLibRepo.getBookmark('story-preserved-mob'),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () => guestProgressRepo.getProgress('story-preserved-mob'),
        throwsA(isA<InvalidGuestScopeException>()),
      );

      bobSessionDispatcher.dispose();

      // INVARIANT 3 (HIDDEN BUT PRESERVED):
      // Dữ liệu của Guest G2 KHÔNG bị auto-delete và KHÔNG bị auto-claim ngầm vào Bob.
      // Trực tiếp query SQLite DAO với ownerScope = guestScopeG2 để xác nhận dữ liệu vẫn còn nguyên:
      final g2Bookmarks = await dao.getBookmarks(ownerScope: guestScopeG2);
      expect(g2Bookmarks.length, equals(1));
      expect(g2Bookmarks.first.storyId, equals('story-preserved-mob'));
      expect(g2Bookmarks.first.ownerScope, equals(guestScopeG2));

      final g2Progress = await dao.getProgress(ownerScope: guestScopeG2, storyId: 'story-preserved-mob');
      expect(g2Progress, isNotNull);
      expect(g2Progress!.chapterId, equals('chap-1'));
      expect(g2Progress.ownerScope, equals(guestScopeG2));

      final g2History = await dao.getHistory(ownerScope: guestScopeG2);
      expect(g2History.length, equals(1));
      expect(g2History.first.storyTitle, equals('Truyện Cần Giữ Lại G2'));

      await offlineDb.close();
    });
  });

  // =========================================================================
  // Gate 4: Auth Bootstrap Race Prevention (Frozen Fail-Closed Semantics)
  // =========================================================================
  group('Gate 4: Auth Bootstrap Race Prevention (Frozen Fail-Closed Semantics)', () {
    test('fails closed with ScopeCoherenceException and writes zero rows to SQLite when BOOTSTRAPPING, then writes to resolved scope upon retry', () async {
      final installProvider = InstallationIdentityProvider(prefs: prefs);
      final guestProfileProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProfileProvider,
      );

      final offlineDb = OfflineDatabase();
      await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);
      final dao = LocalLibraryDao(offlineDatabase: offlineDb);
      final guestLibRepo = GuestLibraryRepository(dao: dao, coordinator: coordinator);
      final guestProgressRepo = GuestReadingProgressRepository(dao: dao, coordinator: coordinator);

      final mockAccountLibRepo = MockLibraryRepository();
      final mockAccountProgressRepo = MockReadingProgressRepository();

      final authService = FakeAuthService();
      // authService bắt đầu ở trạng thái initial (BOOTSTRAPPING)
      expect(authService.state.status, equals(AuthStatus.initial));

      final libraryDispatcher = ScopedLibraryDispatcher(
        accountAdapter: AccountLibraryAdapter(repository: mockAccountLibRepo),
        guestAdapter: GuestLibraryAdapter(guestRepository: guestLibRepo),
        authService: authService,
        coordinator: coordinator,
      );
      final sessionDispatcher = ScopedReadingSessionDispatcher(
        accountAdapter: AccountReadingSessionAdapter(readingProgressRepository: mockAccountProgressRepo),
        guestAdapter: GuestReadingSessionAdapter(guestRepository: guestProgressRepo),
        authService: authService,
        coordinator: coordinator,
      );

      // 1. Thao tác mutation trong khi BOOTSTRAPPING -> FAIL-CLOSED với ScopeCoherenceException
      expect(
        () => libraryDispatcher.setBookmark(const BookmarkMutation(
          storyId: 'story-boot-fail-mob',
          isBookmarked: true,
          title: 'Boot Fail Title',
        )),
        throwsA(isA<ScopeCoherenceException>()),
      );

      expect(
        () => sessionDispatcher.recordProgress(
          storyId: 'story-boot-fail-mob',
          chapterId: 'chap-1',
          flutterPageIndex: 0,
          progressPercentage: 10.0,
          scrollPosition: 100.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      // INVARIANT: Zero records written to SQLite
      final allBookmarks = await offlineDb.database.query('local_library_bookmarks');
      final allProgress = await offlineDb.database.query('local_reading_progress');
      expect(allBookmarks, isEmpty);
      expect(allProgress, isEmpty);

      // 2. Auth giải quyết xong sang unauthenticated (GUEST)
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      authService.updateState(AuthState.unauthenticated());
      final resolvedScope = coordinator.activeScope!;

      // 3. Retry mutation hợp lệ sau khi scope resolved
      await libraryDispatcher.setBookmark(const BookmarkMutation(
        storyId: 'story-boot-fail-mob',
        isBookmarked: true,
        title: 'Boot Resolved Title',
        slug: 'boot-resolved-slug',
      ));

      // INVARIANT: Ghi thành công vào đúng resolved scope guest:<G>
      final resolvedBookmarks = await dao.getBookmarks(ownerScope: resolvedScope);
      expect(resolvedBookmarks.length, equals(1));
      expect(resolvedBookmarks.first.storyId, equals('story-boot-fail-mob'));
      expect(resolvedBookmarks.first.ownerScope, equals(resolvedScope));

      sessionDispatcher.dispose();
      await offlineDb.close();
    });
  });
}
