import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late LocalLibraryDao dao;
  late MockSecureStorage mockSecureStorage;
  late Map<String, String> secureStorageData;
  late InstallationIdentityProvider installProvider;
  late GuestProfileIdentityProvider guestProfileProvider;
  late ActiveScopeCoordinator coordinator;
  late GuestReadingProgressRepository repository;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    mockSecureStorage = MockSecureStorage();
    secureStorageData = {};
    when(() => mockSecureStorage.read(key: any(named: 'key')))
        .thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      return secureStorageData[key];
    });
    when(() => mockSecureStorage.write(
          key: any(named: 'key'),
          value: any(named: 'value'),
        )).thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      final value = invocation.namedArguments[#value] as String;
      secureStorageData[key] = value;
    });
    when(() => mockSecureStorage.delete(key: any(named: 'key')))
        .thenAnswer((invocation) async {
      final key = invocation.namedArguments[#key] as String;
      secureStorageData.remove(key);
    });

    tempDir = await Directory.systemTemp.createTemp('omninovel_guest_prog_test_');
    dbPath = p.join(tempDir.path, 'guest_prog_test.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
    );
    dao = LocalLibraryDao(offlineDatabase: offlineDb);

    installProvider = InstallationIdentityProvider(
      secureStorage: mockSecureStorage,
      prefs: prefs,
    );
    guestProfileProvider = GuestProfileIdentityProvider(prefs: prefs);
    coordinator = ActiveScopeCoordinator(
      installProvider: installProvider,
      guestProfileProvider: guestProfileProvider,
    );
    repository = GuestReadingProgressRepository(
      coordinator: coordinator,
      dao: dao,
    );
  });

  tearDown(() async {
    try {
      if (offlineDb.isInitialized) {
        await offlineDb.database.close();
      }
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('7A.5c: GuestReadingProgressRepository Invariants & Atomic Sessions', () {
    test('1. Repository auto-injects ownerScope and maintains current progress', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final currentScope = coordinator.activeScope!;

      final now = DateTime.now().toUtc();
      final progress = LocalReadingProgress(
        ownerScope: 'ignored-scope', // Repository MUST override this with currentScope
        storyId: 'story-manga-1',
        chapterId: 'chap-10',
        chapterVersionId: 'ver-10',
        readingMode: 'MANGA_PAGED',
        progressPercentage: 50.0,
        scrollPosition: 0.0,
        pageIndex: 15,
        updatedAt: now,
        deviceTimestamp: now,
      );

      await repository.saveProgress(progress);

      final retrieved = await repository.getProgress('story-manga-1');
      expect(retrieved, isNotNull);
      // Invariant 1: Scope was injected from active coordinator
      expect(retrieved!.ownerScope, currentScope);
      expect(retrieved.storyId, 'story-manga-1');
      expect(retrieved.chapterId, 'chap-10');
      expect(retrieved.pageIndex, 15);
      expect(retrieved.scrollPosition, 0.0);
    });

    test('2. Fail-Closed: Throws InvalidGuestScopeException when coordinator is not in guest scope', () async {
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'usr-acc-123',
      );

      final now = DateTime.now().toUtc();
      final dummyProgress = LocalReadingProgress(
        ownerScope: 'guest:dummy',
        storyId: 'story-1',
        chapterId: 'c1',
        progressPercentage: 10.0,
        scrollPosition: 0.0,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final dummyHistory = LocalReadingHistory(
        ownerScope: 'guest:dummy',
        storyId: 'story-1',
        chapterId: 'c1',
        storyTitle: 'Story 1',
        chapterNumber: '1',
        progressPercentage: 10.0,
        lastReadAt: now,
      );

      expect(
        () async => await repository.getProgress('story-1'),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.saveProgress(dummyProgress),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.recordReadingSession(
          progress: dummyProgress,
          history: dummyHistory,
        ),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.getReadChapterIds('story-1'),
        throwsA(isA<InvalidGuestScopeException>()),
      );
    });

    test('3. Atomic reading session: commits progress and history together with Monotonic MAX', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final currentScope = coordinator.activeScope!;

      final now = DateTime.now().toUtc();

      // Session 1: User reads chapter 5 up to 92% (paged mode: page 27)
      final prog1 = LocalReadingProgress(
        ownerScope: '',
        storyId: 'story-test',
        chapterId: 'chap-5',
        readingMode: 'MANGA_PAGED',
        progressPercentage: 92.0,
        scrollPosition: 0.0,
        pageIndex: 27,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final hist1 = LocalReadingHistory(
        ownerScope: '',
        storyId: 'story-test',
        chapterId: 'chap-5',
        storyTitle: 'Test Manga',
        chapterNumber: '5',
        progressPercentage: 92.0,
        lastReadAt: now,
      );

      await repository.recordReadingSession(progress: prog1, history: hist1);

      var savedProg = await repository.getProgress('story-test');
      expect(savedProg!.progressPercentage, 92.0);
      expect(savedProg.pageIndex, 27);
      expect(savedProg.scrollPosition, 0.0);

      var readIds = await repository.getReadChapterIds('story-test');
      expect(readIds, contains('chap-5'));

      // Session 2: User rereads chapter 5 from page 1 (progress 5%)
      final later = now.add(const Duration(hours: 1));
      final prog2 = LocalReadingProgress(
        ownerScope: '',
        storyId: 'story-test',
        chapterId: 'chap-5',
        readingMode: 'MANGA_PAGED',
        progressPercentage: 5.0,
        scrollPosition: 0.0,
        pageIndex: 1,
        updatedAt: later,
        deviceTimestamp: later,
      );
      final hist2 = LocalReadingHistory(
        ownerScope: '',
        storyId: 'story-test',
        chapterId: 'chap-5',
        storyTitle: 'Test Manga',
        chapterNumber: '5',
        progressPercentage: 5.0,
        lastReadAt: later,
      );

      await repository.recordReadingSession(progress: prog2, history: hist2);

      // Invariant 5: Current progress reflects new reading position (page 1, 5%)
      savedProg = await repository.getProgress('story-test');
      expect(savedProg!.progressPercentage, 5.0);
      expect(savedProg.pageIndex, 1);

      // Invariant 5: History retained Monotonic MAX (92%), read status does NOT regress
      final histItem = await dao.getHistoryItem(
        ownerScope: currentScope,
        storyId: 'story-test',
        chapterId: 'chap-5',
      );
      expect(histItem!.progressPercentage, 92.0);
      expect(histItem.lastReadAt.millisecondsSinceEpoch, later.millisecondsSinceEpoch);

      readIds = await repository.getReadChapterIds('story-test');
      expect(readIds, contains('chap-5'));
    });

    test('4. Atomic rollback: if history write or hook fails, progress is NOT updated', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      final now = DateTime.now().toUtc();
      final initialProg = LocalReadingProgress(
        ownerScope: '',
        storyId: 'story-rollback',
        chapterId: 'chap-1',
        progressPercentage: 30.0,
        scrollPosition: 100.0,
        pageIndex: 3,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final initialHist = LocalReadingHistory(
        ownerScope: '',
        storyId: 'story-rollback',
        chapterId: 'chap-1',
        storyTitle: 'Rollback Demo',
        chapterNumber: '1',
        progressPercentage: 30.0,
        lastReadAt: now,
      );
      await repository.recordReadingSession(progress: initialProg, history: initialHist);

      // Attempt second session which fails midway
      final failedProg = LocalReadingProgress(
        ownerScope: '',
        storyId: 'story-rollback',
        chapterId: 'chap-2',
        progressPercentage: 70.0,
        scrollPosition: 700.0,
        pageIndex: 7,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final failedHist = LocalReadingHistory(
        ownerScope: '',
        storyId: 'story-rollback',
        chapterId: 'chap-2',
        storyTitle: 'Rollback Demo',
        chapterNumber: '2',
        progressPercentage: 70.0,
        lastReadAt: now,
      );

      expect(
        () async => await repository.recordReadingSession(
          progress: failedProg,
          history: failedHist,
          onBeforeCommitHook: () async {
            throw Exception('Mid-transaction crash');
          },
        ),
        throwsA(isA<Exception>()),
      );

      // Verify that progress is still at chapter 1, 30% (rolled back)
      final currentProg = await repository.getProgress('story-rollback');
      expect(currentProg!.chapterId, 'chap-1');
      expect(currentProg.progressPercentage, 30.0);

      // Verify that chapter 2 history was NOT saved
      final readIds = await repository.getReadChapterIds('story-rollback');
      expect(readIds, isNot(contains('chap-2')));
    });

    test('5. Paged & Novel Canonical Fields: preserves 1-based pageIndex and anchorBlockId without encoding hacks', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      final now = DateTime.now().toUtc();

      // Novel session
      final novelProg = LocalReadingProgress(
        ownerScope: '',
        storyId: 'story-novel-clean',
        chapterId: 'chap-novel-1',
        readingMode: 'NOVEL',
        progressPercentage: 75.25,
        scrollPosition: 4120.0,
        pageIndex: 1,
        anchorBlockId: 'novel_para_88',
        textOffset: 45,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final novelHist = LocalReadingHistory(
        ownerScope: '',
        storyId: 'story-novel-clean',
        chapterId: 'chap-novel-1',
        storyTitle: 'Reincarnated as a Slime',
        chapterNumber: '1',
        progressPercentage: 75.25,
        lastReadAt: now,
      );

      await repository.recordReadingSession(progress: novelProg, history: novelHist);

      final saved = await repository.getProgress('story-novel-clean');
      expect(saved, isNotNull);
      expect(saved!.readingMode, 'NOVEL');
      expect(saved.anchorBlockId, 'novel_para_88');
      expect(saved.textOffset, 45);
      expect(saved.scrollPosition, 4120.0);
      expect(saved.pageIndex, 1);
    });
  });
}
