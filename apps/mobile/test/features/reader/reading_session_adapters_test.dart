import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_session_adapter.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockCoordinator extends Mock implements ReadingProgressCoordinator {}
class MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  group('Task 1: Reading Session Adapters & Ports', () {
    late Directory tempDir;
    late OfflineDatabase offlineDb;
    late LocalLibraryDao dao;
    late ActiveScopeCoordinator coordinator;
    late GuestReadingProgressRepository guestRepo;
    late MockCoordinator mockAccountCoordinator;

    setUp(() async {
      mockAccountCoordinator = MockCoordinator();

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      final mockSecure = MockSecureStorage();
      final secureData = <String, String>{};
      when(() => mockSecure.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key]]);
      when(() => mockSecure.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String);

      final installProvider = InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs);
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      coordinator = ActiveScopeCoordinator(installProvider: installProvider, guestProfileProvider: guestProvider);
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      tempDir = await Directory.systemTemp.createTemp('reader_adapter_test_');
      final dbPath = p.join(tempDir.path, 'test_offline.db');
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );
      dao = LocalLibraryDao(offlineDatabase: offlineDb);

      guestRepo = GuestReadingProgressRepository(coordinator: coordinator, dao: dao);
    });

    tearDown(() async {
      await offlineDb.close();
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('AccountReadingSessionAdapter delegates to ReadingProgressCoordinator', () async {
      final adapter = AccountReadingSessionAdapter(coordinator: mockAccountCoordinator);

      when(() => mockAccountCoordinator.startSession('story-acc-1')).thenAnswer((_) async {});
      when(() => mockAccountCoordinator.recordProgress(
            storyId: any(named: 'storyId'),
            chapterId: any(named: 'chapterId'),
            chapterVersionId: any(named: 'chapterVersionId'),
            readingMode: any(named: 'readingMode'),
            flutterPageIndex: any(named: 'flutterPageIndex'),
            progressPercentage: any(named: 'progressPercentage'),
            scrollPosition: any(named: 'scrollPosition'),
            anchorBlockId: any(named: 'anchorBlockId'),
            textOffset: any(named: 'textOffset'),
          )).thenReturn(null);

      await adapter.initSession(storyId: 'story-acc-1');
      verify(() => mockAccountCoordinator.startSession('story-acc-1')).called(1);

      adapter.recordProgress(
        storyId: 'story-acc-1',
        chapterId: 'chap-1',
        flutterPageIndex: 2,
        progressPercentage: 50.0,
        scrollPosition: 120.0,
      );
      verify(() => mockAccountCoordinator.recordProgress(
            storyId: 'story-acc-1',
            chapterId: 'chap-1',
            chapterVersionId: null,
            readingMode: 'WEBTOON',
            flutterPageIndex: 2,
            progressPercentage: 50.0,
            scrollPosition: 120.0,
            anchorBlockId: null,
            textOffset: null,
          )).called(1);
    });

    test('GuestReadingSessionAdapter records atomic reading session with rich metadata to SQLite', () async {
      final adapter = GuestReadingSessionAdapter(
        guestRepository: guestRepo,
        debounceDuration: const Duration(milliseconds: 10),
      );

      adapter.recordProgress(
        storyId: 'story-guest-1',
        chapterId: 'chap-1',
        flutterPageIndex: 4, // 1-based sẽ là 5
        progressPercentage: 85.0,
        scrollPosition: 500.0,
        storyTitle: 'Bộ Truyện Khách',
        storySlug: 'bo-truyen-khach',
        storyCoverUrl: 'https://cdn.example.com/c1.jpg',
        chapterNumber: '1',
        chapterTitle: 'Chương mở đầu',
      );

      // Flush ngay lập tức
      await adapter.flush();

      // Kiểm tra trong SQLite qua GuestReadingProgressRepository
      final progress = await guestRepo.getProgress('story-guest-1');
      expect(progress, isNotNull);
      expect(progress!.chapterId, equals('chap-1'));
      expect(progress.pageIndex, equals(5));
      expect(progress.progressPercentage, equals(85.0));

      final readChapters = await guestRepo.getReadChapterIds('story-guest-1', threshold: 80.0);
      expect(readChapters, contains('chap-1'));
    });
  });
}
