import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/app/app.dart';
import 'package:omninovel_mobile/app/bootstrap.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockSecureStorage extends Mock implements FlutterSecureStorage {}
class MockTokenStorage extends Mock implements ITokenStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  group('Task 7A.6 Step 1: AppBootstrap & OmniNovelApp Integration', () {
    late Database testDb;
    late OfflineDatabase offlineDb;
    late MockSecureStorage mockSecureStorage;
    late MockTokenStorage mockTokenStorage;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      mockSecureStorage = MockSecureStorage();
      mockTokenStorage = MockTokenStorage();

      when(() => mockSecureStorage.read(key: any(named: 'key')))
          .thenAnswer((_) async => null);
      when(() => mockSecureStorage.write(
            key: any(named: 'key'),
            value: any(named: 'value'),
          )).thenAnswer((_) async {});

      when(() => mockTokenStorage.getAccessToken())
          .thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken())
          .thenAnswer((_) async => null);

      testDb = await databaseFactoryFfi.openDatabase(
        inMemoryDatabasePath,
        options: OpenDatabaseOptions(
          version: 3,
          onCreate: (db, version) async {
            // Tạo các bảng v3 cho test
            await db.execute('''
              CREATE TABLE local_library_bookmarks (
                owner_scope TEXT NOT NULL,
                story_id TEXT NOT NULL,
                title TEXT NOT NULL,
                slug TEXT,
                cover_url TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (owner_scope, story_id)
              );
            ''');
            await db.execute('''
              CREATE TABLE local_reading_progress (
                owner_scope TEXT NOT NULL,
                story_id TEXT NOT NULL,
                chapter_id TEXT NOT NULL,
                chapter_version_id TEXT,
                reading_mode TEXT NOT NULL,
                progress_percentage REAL NOT NULL,
                scroll_position REAL NOT NULL,
                page_index INTEGER NOT NULL DEFAULT 1,
                anchor_block_id TEXT,
                text_offset INTEGER,
                updated_at INTEGER NOT NULL,
                device_timestamp INTEGER NOT NULL,
                PRIMARY KEY (owner_scope, story_id)
              );
            ''');
            await db.execute('''
              CREATE TABLE local_reading_history (
                owner_scope TEXT NOT NULL,
                story_id TEXT NOT NULL,
                chapter_id TEXT NOT NULL,
                chapter_version_id TEXT,
                story_title TEXT NOT NULL,
                story_slug TEXT,
                story_cover_url TEXT,
                chapter_number TEXT NOT NULL,
                chapter_title TEXT,
                progress_percentage REAL NOT NULL,
                last_read_at INTEGER NOT NULL,
                PRIMARY KEY (owner_scope, story_id, chapter_id)
              );
            ''');
          },
        ),
      );
      offlineDb = OfflineDatabase(customDb: testDb);
    });

    tearDown(() async {
      await testDb.close();
    });

    test('AppBootstrap.run() initializes in correct order and produces settled scope', () async {
      final result = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customSecureStorage: mockSecureStorage,
        customTokenStorage: mockTokenStorage,
      );

      // Invariant 1-3: DI đầy đủ instances
      expect(result.activeScopeCoordinator, isNotNull);
      expect(result.guestLibraryRepository, isNotNull);
      expect(result.guestReadingProgressRepository, isNotNull);
      expect(result.localLibraryDao, isNotNull);
      expect(result.authScopeBridge, isNotNull);

      // Invariant 4: Cold boot không token đã settle thành guest scope
      expect(result.activeScopeCoordinator.state, equals(ActiveScopeState.guest));
      expect(result.activeScopeCoordinator.activeScope, startsWith('guest:'));
      expect(result.activeScopeCoordinator.canMutateUserState, isTrue);

      // Canonical rawPrefs được dùng
      final prefs = result.preferencesService.rawPrefs;
      final storedGuestId = prefs.getString('omninovel_guest_profile_id');
      expect(storedGuestId, isNotNull);
      expect(result.activeScopeCoordinator.activeScope, equals('guest:$storedGuestId'));
    });

    test('AppBootstrap.run() completes bootstrapReady when cold-booting authenticated without hanging on waitForResolvedScope', () async {
      const mockJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWJvb3QtOTk5IiwidXNlcm5hbWUiOiJib290X3VzZXIiLCJyb2xlIjoiUkVBREVSIn0.dummy_signature';
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => mockJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh');

      final result = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customSecureStorage: mockSecureStorage,
        customTokenStorage: mockTokenStorage,
      );

      // Router is created and bootstrap completes cleanly without deadlock
      expect(result.router, isNotNull);
      // P0-1 Invariant: Khi offline, auth state là pendingVerification (không tự ý coi là authenticated)
      expect(result.authService.state.isPendingVerification, isTrue);
      expect(result.authService.state.user?.id, equals('user-boot-999'));
      expect(result.activeScopeCoordinator.state, equals(ActiveScopeState.guest));
      expect(result.activeScopeCoordinator.canMutateUserState, isTrue);
    });


    testWidgets('OmniNovelApp exposes all DI providers through MultiProvider without error', (tester) async {
      final result = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customSecureStorage: mockSecureStorage,
        customTokenStorage: mockTokenStorage,
      );

      await tester.pumpWidget(OmniNovelApp(bootstrapResult: result));
      await tester.pump();

      final context = tester.element(find.byType(MaterialApp));

      // Kiểm tra tất cả providers được expose đúng
      expect(Provider.of<ActiveScopeCoordinator>(context, listen: false), isNotNull);
      expect(Provider.of<GuestLibraryRepository>(context, listen: false), isNotNull);
      expect(Provider.of<GuestReadingProgressRepository>(context, listen: false), isNotNull);
      expect(Provider.of<LocalLibraryDao>(context, listen: false), isNotNull);

      // Xả hết timer timeout kết nối mạng do HomeScreen khởi tạo khi render công khai
      await tester.pump(const Duration(seconds: 35));
    });
  });
}
