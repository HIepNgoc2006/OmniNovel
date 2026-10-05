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
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/repositories/account_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_repository.dart';
import 'package:omninovel_mobile/features/library/repositories/library_access.dart';
import 'package:omninovel_mobile/features/library/repositories/library_repository.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockLibraryRepository extends Mock implements LibraryRepository {}
class MockSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  group('Task 1: Library Adapters & Ports', () {
    late MockLibraryRepository mockAccountRepo;
    late Directory tempDir;
    late OfflineDatabase offlineDb;
    late LocalLibraryDao dao;
    late ActiveScopeCoordinator coordinator;
    late GuestLibraryRepository guestRepo;

    setUp(() async {
      mockAccountRepo = MockLibraryRepository();

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      final mockSecure = MockSecureStorage();
      final secureData = <String, String>{};
      when(() => mockSecure.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key]]);
      when(() => mockSecure.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key]] = inv.namedArguments[#value]);

      final installProvider = InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs);
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      coordinator = ActiveScopeCoordinator(installProvider: installProvider, guestProfileProvider: guestProvider);
      await coordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      tempDir = await Directory.systemTemp.createTemp('lib_adapter_test_');
      final dbPath = p.join(tempDir.path, 'test_offline.db');
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );
      dao = LocalLibraryDao(offlineDatabase: offlineDb);

      guestRepo = GuestLibraryRepository(coordinator: coordinator, dao: dao);
    });

    tearDown(() async {
      await offlineDb.close();
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('AccountLibraryAdapter delegates all calls to LibraryRepository', () async {
      final adapter = AccountLibraryAdapter(repository: mockAccountRepo);

      when(() => mockAccountRepo.getBookmarkStatus('story-1'))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));
      when(() => mockAccountRepo.setBookmark('story-1', true))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));

      final status = await adapter.getBookmarkStatus('story-1');
      expect(status.isBookmarked, isTrue);

      const mutation = BookmarkMutation(
        storyId: 'story-1',
        isBookmarked: true,
        title: 'Title 1',
        slug: 'slug-1',
      );
      final res = await adapter.setBookmark(mutation);
      expect(res.isBookmarked, isTrue);

      verify(() => mockAccountRepo.setBookmark('story-1', true)).called(1);
    });

    test('GuestLibraryAdapter saves BookmarkMutation with metadata to SQLite without network', () async {
      final adapter = GuestLibraryAdapter(guestRepository: guestRepo);

      const mutation = BookmarkMutation(
        storyId: 'story-guest-1',
        isBookmarked: true,
        title: 'Truyện Khách',
        slug: 'truyen-khach',
        coverUrl: 'https://cdn.example.com/cover.jpg',
      );

      final res = await adapter.setBookmark(mutation);
      expect(res.isBookmarked, isTrue);

      // Kiểm tra getBookmarkStatus
      final status = await adapter.getBookmarkStatus('story-guest-1');
      expect(status.isBookmarked, isTrue);

      // Kiểm tra fetchBookmarks
      final bookmarksRes = await adapter.fetchBookmarks(page: 1, limit: 10);
      expect(bookmarksRes.data.length, equals(1));
      final item = bookmarksRes.data.first;
      expect(item.story.id, equals('story-guest-1'));
      expect(item.story.title, equals('Truyện Khách'));
      expect(item.story.slug, equals('truyen-khach'));
      expect(item.story.coverUrl, equals('https://cdn.example.com/cover.jpg'));

      // Kiểm tra getCachedBookmarks
      final cached = adapter.getCachedBookmarks();
      expect(cached.length, equals(1));
      expect(cached.first.story.id, equals('story-guest-1'));

      // Xóa bookmark
      const unbookmarkMutation = BookmarkMutation(
        storyId: 'story-guest-1',
        isBookmarked: false,
        title: 'Truyện Khách',
      );
      final unres = await adapter.setBookmark(unbookmarkMutation);
      expect(unres.isBookmarked, isFalse);

      final afterDelete = await adapter.fetchBookmarks(page: 1, limit: 10);
      expect(afterDelete.data.isEmpty, isTrue);
    });
  });
}
