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
import 'package:omninovel_mobile/features/library/repositories/guest_library_repository.dart';
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
  late GuestLibraryRepository repository;

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

    tempDir = await Directory.systemTemp.createTemp('omninovel_guest_lib_test_');
    dbPath = p.join(tempDir.path, 'guest_lib_test.db');
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
    repository = GuestLibraryRepository(
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

  group('7A.5b: GuestLibraryRepository Invariants & Scoped Isolation', () {
    test('1. Repository auto-injects ownerScope and manages bookmarks seamlessly', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final currentScope = coordinator.activeScope!;
      expect(currentScope, startsWith('guest:'));

      // Check initially empty
      expect(await repository.isBookmarked('story-solo'), isFalse);
      expect(await repository.getBookmarks(), isEmpty);

      // Save bookmark
      await repository.saveBookmark(
        storyId: 'story-solo',
        title: 'Solo Leveling',
        slug: 'solo-leveling',
        coverUrl: 'https://cdn.example.com/cover.jpg',
      );

      // Verify bookmark is stored
      expect(await repository.isBookmarked('story-solo'), isTrue);
      final bms = await repository.getBookmarks();
      expect(bms.length, 1);
      expect(bms.first.ownerScope, currentScope);
      expect(bms.first.storyId, 'story-solo');
      expect(bms.first.title, 'Solo Leveling');

      // Delete bookmark
      await repository.deleteBookmark('story-solo');
      expect(await repository.isBookmarked('story-solo'), isFalse);
      expect(await repository.getBookmarks(), isEmpty);
    });

    test('2. Fail-Closed: Throws InvalidGuestScopeException when coordinator is in account or non-guest scope', () async {
      // Set to authenticated with an account
      await coordinator.onAuthStatusChanged(
        AuthStatus.authenticated,
        userId: 'usr-account-999',
      );
      expect(coordinator.state, ActiveScopeState.account);
      expect(coordinator.activeScope, 'account:usr-account-999');

      // Invariant 2: Cannot execute guest bookmark operations with account scope
      expect(
        () async => await repository.isBookmarked('story-solo'),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.saveBookmark(
          storyId: 'story-solo',
          title: 'Solo Leveling',
        ),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.getBookmarks(),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.getHistory(),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.deleteStoryHistory('story-solo'),
        throwsA(isA<InvalidGuestScopeException>()),
      );
      expect(
        () async => await repository.clearAllHistory(),
        throwsA(isA<InvalidGuestScopeException>()),
      );
    });

    test('3. Scope Isolation: Rotating guest profile results in clean empty library, previous profile preserved', () async {
      // 1. Initial Guest session
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final guest1 = coordinator.activeScope!;

      await repository.saveBookmark(
        storyId: 'shared-story-id',
        title: 'Story Guest 1',
      );
      expect(await repository.isBookmarked('shared-story-id'), isTrue);

      // Save a history item in Guest 1
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: guest1,
        storyId: 'shared-story-id',
        chapterId: 'chap-1',
        storyTitle: 'Story Guest 1',
        chapterNumber: '1',
        progressPercentage: 60.0,
        lastReadAt: DateTime.now().toUtc(),
      ));
      expect((await repository.getHistory()).length, 1);

      // 2. Rotate to new Guest session (e.g. through logout rotation)
      await coordinator.onLogout();
      final guest2 = coordinator.activeScope!;
      expect(guest2, isNot(equals(guest1)));
      expect(guest2, startsWith('guest:'));

      // New guest library is completely clean
      expect(await repository.isBookmarked('shared-story-id'), isFalse);
      expect(await repository.getBookmarks(), isEmpty);
      expect(await repository.getHistory(), isEmpty);

      // Bookmark different story in Guest 2
      await repository.saveBookmark(
        storyId: 'guest-2-exclusive',
        title: 'Exclusive for Guest 2',
      );
      expect(await repository.isBookmarked('guest-2-exclusive'), isTrue);

      // Verify in DAO that Guest 1 data is untouched in SQLite
      final g1Bookmarks = await dao.getBookmarks(ownerScope: guest1);
      expect(g1Bookmarks.length, 1);
      expect(g1Bookmarks.first.storyId, 'shared-story-id');
      final g1History = await dao.getHistory(ownerScope: guest1);
      expect(g1History.length, 1);
      expect(g1History.first.chapterId, 'chap-1');
    });

    test('4. History Management: deleteStoryHistory and clearAllHistory delete BOTH history and progress while leaving bookmarks intact', () async {
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final currentScope = coordinator.activeScope!;
      final now = DateTime.now().toUtc();

      // 1. Save bookmarks for story-alpha and story-beta
      await repository.saveBookmark(storyId: 'story-alpha', title: 'Story Alpha');
      await repository.saveBookmark(storyId: 'story-beta', title: 'Story Beta');

      // 2. Save progress for story-alpha and story-beta
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: currentScope,
        storyId: 'story-alpha',
        chapterId: 'c1',
        progressPercentage: 85.0,
        scrollPosition: 800.0,
        pageIndex: 1,
        updatedAt: now,
        deviceTimestamp: now,
      ));
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: currentScope,
        storyId: 'story-beta',
        chapterId: 'c1',
        progressPercentage: 40.0,
        scrollPosition: 400.0,
        pageIndex: 1,
        updatedAt: now,
        deviceTimestamp: now,
      ));

      // 3. Save history for story-alpha and story-beta
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: currentScope,
        storyId: 'story-alpha',
        chapterId: 'c1',
        storyTitle: 'Story Alpha',
        chapterNumber: '1',
        progressPercentage: 85.0,
        lastReadAt: now,
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: currentScope,
        storyId: 'story-beta',
        chapterId: 'c1',
        storyTitle: 'Story Beta',
        chapterNumber: '1',
        progressPercentage: 40.0,
        lastReadAt: now,
      ));

      expect((await repository.getHistory()).length, 2);
      expect(await repository.getReadChapterIds('story-alpha'), contains('c1'));
      expect(await repository.getReadChapterIds('story-beta'), isEmpty);
      expect(await dao.getProgress(ownerScope: currentScope, storyId: 'story-alpha'), isNotNull);

      // 4. Delete single story history: Invariant: deletes history AND progress, leaves bookmark
      await repository.deleteStoryHistory('story-alpha');
      final histAfterDelete = await repository.getHistory();
      expect(histAfterDelete.length, 1);
      expect(histAfterDelete.first.storyId, 'story-beta');

      // Progress for story-alpha is deleted (no resurrection on resume)
      expect(await dao.getProgress(ownerScope: currentScope, storyId: 'story-alpha'), isNull);
      expect(await dao.getProgress(ownerScope: currentScope, storyId: 'story-beta'), isNotNull);
      expect(await repository.getReadChapterIds('story-alpha'), isEmpty);

      // Bookmark for story-alpha remains completely intact!
      expect(await repository.isBookmarked('story-alpha'), isTrue);

      // 5. Clear all history: deletes remaining history AND progress, leaves bookmarks
      await repository.clearAllHistory();
      expect(await repository.getHistory(), isEmpty);
      expect(await dao.getProgress(ownerScope: currentScope, storyId: 'story-beta'), isNull);

      // Both bookmarks remain completely intact!
      expect(await repository.isBookmarked('story-alpha'), isTrue);
      expect(await repository.isBookmarked('story-beta'), isTrue);
    });
  });
}
