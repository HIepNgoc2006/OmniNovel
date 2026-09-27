import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/models/offline_deletion_tombstone.dart';
import 'package:omninovel_mobile/features/offline/repositories/artifact_repository.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/artifact_download_client.dart';
import 'package:omninovel_mobile/features/offline/models/storage_policy_config.dart';
import 'package:omninovel_mobile/features/offline/services/bundle_installer.dart';
import 'package:omninovel_mobile/features/offline/services/disk_space_provider.dart';
import 'package:omninovel_mobile/features/offline/services/download_queue_manager.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:omninovel_mobile/features/offline/services/offline_deletion_service.dart';
import 'package:omninovel_mobile/features/offline/services/reader_lease_manager.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockDiskSpaceProvider extends Mock implements DiskSpaceProvider {}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('omninovel_storage_quota_test_');
  });

  tearDown(() {
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  group('Gate 1: DB Schema Migration v1 ➔ v2 & Canonical User Isolation', () {
    group('Gate 1A — Schema migration & legacy v1 fail-closed', () {
      test('Gate 1A.1: DB Migration v1 ➔ v2 drops legacy unowned data (fail-closed)', () async {
        final dbPath = p.join(tempDir.path, 'migration_test.db');

        // Bước 1: Khởi tạo database v1 với schema v1 cũ và chèn dữ liệu legacy
        final v1Db = await databaseFactoryFfi.openDatabase(
          dbPath,
          options: OpenDatabaseOptions(
            version: 1,
            onCreate: (db, version) async {
              await db.execute('''
                CREATE TABLE offline_chapters (
                  chapter_version_id TEXT PRIMARY KEY,
                  chapter_id TEXT NOT NULL,
                  story_id TEXT NOT NULL,
                  story_title TEXT NOT NULL,
                  chapter_number TEXT NOT NULL,
                  chapter_title TEXT,
                  media_format TEXT NOT NULL,
                  publication_format TEXT,
                  installed_dir TEXT NOT NULL,
                  total_files INTEGER NOT NULL,
                  total_bytes INTEGER NOT NULL,
                  installed_at INTEGER NOT NULL,
                  last_read_at INTEGER,
                  manifest_json TEXT NOT NULL
                );
              ''');
              await db.execute('''
                CREATE TABLE download_tasks (
                  task_id TEXT PRIMARY KEY,
                  chapter_version_id TEXT NOT NULL UNIQUE,
                  chapter_id TEXT NOT NULL,
                  story_id TEXT NOT NULL,
                  story_title TEXT NOT NULL,
                  chapter_number TEXT NOT NULL,
                  media_format TEXT NOT NULL,
                  status TEXT NOT NULL,
                  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                  total_bytes INTEGER NOT NULL DEFAULT 0,
                  progress_fraction REAL NOT NULL DEFAULT 0.0,
                  download_url TEXT,
                  sha256_hash TEXT,
                  error_message TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
              ''');
            },
          ),
        );

        // Chèn dữ liệu legacy v1 (không có thông tin user ownership)
        await v1Db.insert('offline_chapters', {
          'chapter_version_id': 'legacy_ver_101',
          'chapter_id': 'chap_101',
          'story_id': 'story_01',
          'story_title': 'Legacy Story',
          'chapter_number': '1',
          'chapter_title': 'Legacy Chapter 1',
          'media_format': 'COMIC',
          'installed_dir': 'installed/legacy_ver_101',
          'total_files': 5,
          'total_bytes': 10240,
          'installed_at': 100000,
          'manifest_json': '{}',
        });

        await v1Db.insert('download_tasks', {
          'task_id': 'legacy_task_101',
          'chapter_version_id': 'legacy_ver_101',
          'chapter_id': 'chap_101',
          'story_id': 'story_01',
          'story_title': 'Legacy Story',
          'chapter_number': '1',
          'media_format': 'COMIC',
          'status': 'READY',
          'downloaded_bytes': 10240,
          'total_bytes': 10240,
          'progress_fraction': 1.0,
          'created_at': 100000,
          'updated_at': 100000,
        });

        await v1Db.close();

        // Bước 2: Nâng cấp thông qua OfflineDatabase (version 2)
        final offlineDb = OfflineDatabase();
        final db = await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        expect(OfflineDatabase.databaseVersion, equals(2));

        // Bước 3: Kiểm tra cấu trúc schema v2
        final chapterColumns = await db.rawQuery('PRAGMA table_info(offline_chapters)');
        final chapterColNames = chapterColumns.map((c) => c['name'] as String).toList();
        expect(chapterColNames, contains('user_id'), reason: 'v2 offline_chapters must have user_id');
        expect(chapterColNames, contains('is_pinned'), reason: 'v2 offline_chapters must have is_pinned');

        final taskColumns = await db.rawQuery('PRAGMA table_info(download_tasks)');
        final taskColNames = taskColumns.map((c) => c['name'] as String).toList();
        expect(taskColNames, contains('user_id'), reason: 'v2 download_tasks must have user_id');

        final tombstoneColumns = await db.rawQuery('PRAGMA table_info(offline_deletion_tombstones)');
        final tombstoneColNames = tombstoneColumns.map((c) => c['name'] as String).toList();
        expect(tombstoneColNames, containsAll(['tombstone_id', 'user_id', 'chapter_version_id', 'created_at']));

        // Bước 4: Fail-closed invariant — Legacy unowned v1 records MUST NOT be promoted into v2 inventory
        final chapterCount = Sqflite.firstIntValue(
          await db.rawQuery('SELECT COUNT(*) FROM offline_chapters'),
        );
        expect(chapterCount, equals(0), reason: 'Legacy v1 unowned chapters must be excluded from v2 inventory');

        final taskCount = Sqflite.firstIntValue(
          await db.rawQuery('SELECT COUNT(*) FROM download_tasks'),
        );
        expect(taskCount, equals(0), reason: 'Legacy v1 unowned tasks must be excluded from v2 inventory');

        await offlineDb.close();
      });

      test('Gate 1A.2: Composite Primary Key & Unique Constraints allow cross-user same version', () async {
        final dbPath = p.join(tempDir.path, 'composite_test.db');
        final offlineDb = OfflineDatabase();
        final db = await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const versionId = 'shared_ver_202';

        // User A và User B có cùng chapter_version_id trong offline_chapters
        await db.insert('offline_chapters', {
          'user_id': 'user_a',
          'chapter_version_id': versionId,
          'chapter_id': 'chap_202',
          'story_id': 'story_02',
          'story_title': 'Solo Leveling',
          'chapter_number': '10',
          'media_format': 'COMIC',
          'installed_dir': 'files/offline/scope_a/installed/$versionId',
          'total_files': 10,
          'total_bytes': 20480,
          'installed_at': 200000,
          'manifest_json': '{}',
          'is_pinned': 0,
        });

        await db.insert('offline_chapters', {
          'user_id': 'user_b',
          'chapter_version_id': versionId,
          'chapter_id': 'chap_202',
          'story_id': 'story_02',
          'story_title': 'Solo Leveling',
          'chapter_number': '10',
          'media_format': 'COMIC',
          'installed_dir': 'files/offline/scope_b/installed/$versionId',
          'total_files': 10,
          'total_bytes': 20480,
          'installed_at': 200500,
          'manifest_json': '{}',
          'is_pinned': 1,
        });

        // Xác nhận cả 2 bản ghi cùng tồn tại độc lập
        final chapters = await db.query('offline_chapters', where: 'chapter_version_id = ?', whereArgs: [versionId]);
        expect(chapters.length, equals(2));

        // Trùng lặp (user_a, shared_ver_202) phải ném ngoại lệ khi dùng ConflictAlgorithm.abort
        expect(
          () async => await db.insert(
            'offline_chapters',
            {
              'user_id': 'user_a',
              'chapter_version_id': versionId,
              'chapter_id': 'chap_202',
              'story_id': 'story_02',
              'story_title': 'Solo Leveling',
              'chapter_number': '10',
              'media_format': 'COMIC',
              'installed_dir': 'files/offline/scope_a/installed/$versionId',
              'total_files': 10,
              'total_bytes': 20480,
              'installed_at': 201000,
              'manifest_json': '{}',
              'is_pinned': 0,
            },
            conflictAlgorithm: ConflictAlgorithm.abort,
          ),
          throwsA(isA<DatabaseException>()),
        );

        // Download Tasks: User A và User B có cùng chapter_version_id
        await db.insert('download_tasks', {
          'task_id': 'task_a_202',
          'user_id': 'user_a',
          'chapter_version_id': versionId,
          'chapter_id': 'chap_202',
          'story_id': 'story_02',
          'story_title': 'Solo Leveling',
          'chapter_number': '10',
          'media_format': 'COMIC',
          'status': 'READY',
          'downloaded_bytes': 20480,
          'total_bytes': 20480,
          'progress_fraction': 1.0,
          'created_at': 200000,
          'updated_at': 200000,
        });

        await db.insert('download_tasks', {
          'task_id': 'task_b_202',
          'user_id': 'user_b',
          'chapter_version_id': versionId,
          'chapter_id': 'chap_202',
          'story_id': 'story_02',
          'story_title': 'Solo Leveling',
          'chapter_number': '10',
          'media_format': 'COMIC',
          'status': 'DOWNLOADING',
          'downloaded_bytes': 5000,
          'total_bytes': 20480,
          'progress_fraction': 0.24,
          'created_at': 200500,
          'updated_at': 200500,
        });

        final tasks = await db.query('download_tasks', where: 'chapter_version_id = ?', whereArgs: [versionId]);
        expect(tasks.length, equals(2));

        // Trùng lặp download_tasks (user_a, versionId) phải throw exception
        expect(
          () async => await db.insert(
            'download_tasks',
            {
              'task_id': 'task_a_duplicate',
              'user_id': 'user_a',
              'chapter_version_id': versionId,
              'chapter_id': 'chap_202',
              'story_id': 'story_02',
              'story_title': 'Solo Leveling',
              'chapter_number': '10',
              'media_format': 'COMIC',
              'status': 'QUEUED',
              'downloaded_bytes': 0,
              'total_bytes': 20480,
              'progress_fraction': 0.0,
              'created_at': 201000,
              'updated_at': 201000,
            },
            conflictAlgorithm: ConflictAlgorithm.abort,
          ),
          throwsA(isA<DatabaseException>()),
        );

        await offlineDb.close();
      });

      test('Gate 1A.3: Tombstone uniqueness invariant UNIQUE(user_id, chapter_version_id)', () async {
        final dbPath = p.join(tempDir.path, 'tombstone_test.db');
        final offlineDb = OfflineDatabase();
        final db = await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const versionId = 'tombstone_ver_303';

        // User A và User B tạo tombstone cho cùng versionId -> Hợp lệ
        await db.insert('offline_deletion_tombstones', {
          'tombstone_id': 'tomb_a_1',
          'user_id': 'user_a',
          'chapter_version_id': versionId,
          'created_at': 300000,
        });

        await db.insert('offline_deletion_tombstones', {
          'tombstone_id': 'tomb_b_1',
          'user_id': 'user_b',
          'chapter_version_id': versionId,
          'created_at': 300100,
        });

        // User A tạo tombstone thứ hai cho cùng versionId -> Throw DatabaseException do UNIQUE(user_id, chapter_version_id)
        expect(
          () async => await db.insert(
            'offline_deletion_tombstones',
            {
              'tombstone_id': 'tomb_a_2',
              'user_id': 'user_a',
              'chapter_version_id': versionId,
              'created_at': 300200,
            },
            conflictAlgorithm: ConflictAlgorithm.abort,
          ),
          throwsA(isA<DatabaseException>()),
        );

        await offlineDb.close();
      });

      test('Gate 1A.4: Models serialization with userId, isPinned, and tombstone', () {
        // OfflineChapter serialization
        const chapter = OfflineChapter(
          userId: 'user_x',
          chapterVersionId: 'ver_999',
          chapterId: 'chap_999',
          storyId: 'story_999',
          storyTitle: 'Test Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: 'installed/ver_999',
          totalFiles: 3,
          totalBytes: 5000,
          installedAt: 123456,
          manifestJson: '{"test": 1}',
          isPinned: true,
        );

        final map = chapter.toMap();
        expect(map['user_id'], equals('user_x'));
        expect(map['is_pinned'], equals(1));

        final restored = OfflineChapter.fromMap(map);
        expect(restored.userId, equals('user_x'));
        expect(restored.isPinned, isTrue);
        expect(restored.chapterVersionId, equals('ver_999'));

        // DownloadTask serialization
        const task = DownloadTask(
          taskId: 'task_999',
          userId: 'user_x',
          chapterVersionId: 'ver_999',
          chapterId: 'chap_999',
          storyId: 'story_999',
          storyTitle: 'Test Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.ready,
          createdAt: 123456,
          updatedAt: 123456,
        );

        final taskMap = task.toMap();
        expect(taskMap['user_id'], equals('user_x'));

        final restoredTask = DownloadTask.fromMap(taskMap);
        expect(restoredTask.userId, equals('user_x'));
        expect(restoredTask.taskId, equals('task_999'));

        // OfflineDeletionTombstone serialization
        const tombstone = OfflineDeletionTombstone(
          tombstoneId: 'tomb_999',
          userId: 'user_x',
          chapterVersionId: 'ver_999',
          createdAt: 123456,
        );

        final tombstoneMap = tombstone.toMap();
        expect(tombstoneMap['tombstone_id'], equals('tomb_999'));
        expect(tombstoneMap['user_id'], equals('user_x'));
        expect(tombstoneMap['chapter_version_id'], equals('ver_999'));
        expect(tombstoneMap['created_at'], equals(123456));

        final restoredTombstone = OfflineDeletionTombstone.fromMap(tombstoneMap);
        expect(restoredTombstone.tombstoneId, equals('tomb_999'));
        expect(restoredTombstone.userId, equals('user_x'));
        expect(restoredTombstone.chapterVersionId, equals('ver_999'));
        expect(restoredTombstone.createdAt, equals(123456));
      });
    });

    group('Gate 1B — Repository user isolation', () {
      late OfflineDatabase offlineDb;
      late OfflineStorageRepository repoA;
      late OfflineStorageRepository repoB;

      setUp(() async {
        final dbPath = p.join(tempDir.path, 'repo_isolation_test.db');
        offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );
        repoA = OfflineStorageRepository(database: offlineDb, userId: 'user_a');
        repoB = OfflineStorageRepository(database: offlineDb, userId: 'user_b');
      });

      tearDown(() async {
        await offlineDb.close();
      });

      test('Gate 1B.1: OfflineChapters query, installation check, and deletion are isolated', () async {
        const sharedVersionId = 'ver_shared_001';

        const chapterA = OfflineChapter(
          userId: 'user_a',
          chapterVersionId: sharedVersionId,
          chapterId: 'chap_001',
          storyId: 'story_001',
          storyTitle: 'Story of User A',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: 'files/offline/scope_a/installed/$sharedVersionId',
          totalFiles: 5,
          totalBytes: 15000,
          installedAt: 1000,
          manifestJson: '{}',
        );

        const chapterB = OfflineChapter(
          userId: 'user_b',
          chapterVersionId: sharedVersionId,
          chapterId: 'chap_001',
          storyId: 'story_001',
          storyTitle: 'Story of User B',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: 'files/offline/scope_b/installed/$sharedVersionId',
          totalFiles: 8,
          totalBytes: 25000,
          installedAt: 2000,
          manifestJson: '{}',
        );

        await repoA.insertOfflineChapter(chapterA);
        await repoB.insertOfflineChapter(chapterB);

        // Kiểm tra độc lập khi lấy theo versionId
        final fetchedA = await repoA.getOfflineChapter(sharedVersionId);
        final fetchedB = await repoB.getOfflineChapter(sharedVersionId);

        expect(fetchedA, isNotNull);
        expect(fetchedA!.userId, equals('user_a'));
        expect(fetchedA.storyTitle, equals('Story of User A'));
        expect(fetchedA.totalBytes, equals(15000));

        expect(fetchedB, isNotNull);
        expect(fetchedB!.userId, equals('user_b'));
        expect(fetchedB.storyTitle, equals('Story of User B'));
        expect(fetchedB.totalBytes, equals(25000));

        // Kiểm tra isChapterInstalled
        expect(await repoA.isChapterInstalled(sharedVersionId), isTrue);
        expect(await repoB.isChapterInstalled(sharedVersionId), isTrue);

        // Xóa ở User A KHÔNG ĐƯỢC làm mất của User B
        await repoA.deleteOfflineChapter(sharedVersionId);

        expect(await repoA.isChapterInstalled(sharedVersionId), isFalse);
        expect(await repoA.getOfflineChapter(sharedVersionId), isNull);

        expect(await repoB.isChapterInstalled(sharedVersionId), isTrue);
        expect(await repoB.getOfflineChapter(sharedVersionId), isNotNull);
        expect((await repoB.getOfflineChapter(sharedVersionId))!.userId, equals('user_b'));
      });

      test('Gate 1B.2: DownloadTasks CRUD and status transitions are strictly isolated', () async {
        const sharedVersionId = 'ver_task_shared_002';
        const taskIdA = 'task_a_unique_id';
        const taskIdB = 'task_b_unique_id';

        const taskA = DownloadTask(
          taskId: taskIdA,
          userId: 'user_a',
          chapterVersionId: sharedVersionId,
          chapterId: 'chap_002',
          storyId: 'story_002',
          storyTitle: 'Story Task',
          chapterNumber: '2',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.queued,
          createdAt: 1000,
          updatedAt: 1000,
        );

        const taskB = DownloadTask(
          taskId: taskIdB,
          userId: 'user_b',
          chapterVersionId: sharedVersionId,
          chapterId: 'chap_002',
          storyId: 'story_002',
          storyTitle: 'Story Task',
          chapterNumber: '2',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.downloading,
          downloadedBytes: 300,
          totalBytes: 1000,
          progressFraction: 0.3,
          createdAt: 1000,
          updatedAt: 1000,
        );

        await repoA.insertTask(taskA);
        await repoB.insertTask(taskB);

        // Get by taskId: User A thấy taskA nhưng KHÔNG thấy taskB; User B thấy taskB nhưng KHÔNG thấy taskA
        final fetchedTaskAByA = await repoA.getTaskById(taskIdA);
        final fetchedTaskAByB = await repoB.getTaskById(taskIdA);

        expect(fetchedTaskAByA, isNotNull);
        expect(fetchedTaskAByA!.userId, equals('user_a'));
        expect(fetchedTaskAByA.status, equals(DownloadTaskStatus.queued));
        expect(fetchedTaskAByB, isNull, reason: 'User B must never access task of User A even via taskId');

        final fetchedTaskBByB = await repoB.getTaskById(taskIdB);
        final fetchedTaskBByA = await repoA.getTaskById(taskIdB);

        expect(fetchedTaskBByB, isNotNull);
        expect(fetchedTaskBByB!.userId, equals('user_b'));
        expect(fetchedTaskBByB.status, equals(DownloadTaskStatus.downloading));
        expect(fetchedTaskBByA, isNull, reason: 'User A must never access task of User B even via taskId');

        // Get by chapterVersionId: Mỗi repo chỉ trả về task của user đó
        expect((await repoA.getTaskByVersionId(sharedVersionId))!.taskId, equals(taskIdA));
        expect((await repoB.getTaskByVersionId(sharedVersionId))!.taskId, equals(taskIdB));

        // Update status repoA sang READY
        await repoA.updateTaskStatus(taskIdA, DownloadTaskStatus.ready);
        expect((await repoA.getTaskById(taskIdA))!.status, equals(DownloadTaskStatus.ready));
        // RepoB vẫn giữ DOWNLOADING không bị ảnh hưởng
        expect((await repoB.getTaskById(taskIdB))!.status, equals(DownloadTaskStatus.downloading));

        // User B cố ý gọi deleteTask(taskIdA) -> KHÔNG ĐƯỢC xóa task của User A
        await repoB.deleteTask(taskIdA);
        expect(await repoA.getTaskById(taskIdA), isNotNull, reason: 'User B cannot delete task belonging to User A');

        // Delete task ở User A
        await repoA.deleteTask(taskIdA);
        expect(await repoA.getTaskById(taskIdA), isNull);
        expect(await repoB.getTaskById(taskIdB), isNotNull);
      });

      test('Gate 1B.3: Query by storyId, chapterId, lastReadAt and pinning are isolated', () async {
        const sharedStoryId = 'story_multi';
        const sharedChapterId = 'chap_multi_003';
        const sharedVersionId = 'ver_multi_003';

        const chapterA = OfflineChapter(
          userId: 'user_a',
          chapterVersionId: sharedVersionId,
          chapterId: sharedChapterId,
          storyId: sharedStoryId,
          storyTitle: 'Multi Story',
          chapterNumber: '3',
          mediaFormat: 'NOVEL',
          installedDir: 'files/offline/scope_a/installed/$sharedVersionId',
          totalFiles: 1,
          totalBytes: 5000,
          installedAt: 1000,
          manifestJson: '{}',
          isPinned: false,
        );

        const chapterB = OfflineChapter(
          userId: 'user_b',
          chapterVersionId: sharedVersionId,
          chapterId: sharedChapterId,
          storyId: sharedStoryId,
          storyTitle: 'Multi Story',
          chapterNumber: '3',
          mediaFormat: 'NOVEL',
          installedDir: 'files/offline/scope_b/installed/$sharedVersionId',
          totalFiles: 1,
          totalBytes: 5000,
          installedAt: 1000,
          manifestJson: '{}',
          isPinned: true,
        );

        await repoA.insertOfflineChapter(chapterA);
        await repoB.insertOfflineChapter(chapterB);

        // Story list
        final listA = await repoA.getOfflineChaptersByStory(sharedStoryId);
        final listB = await repoB.getOfflineChaptersByStory(sharedStoryId);
        expect(listA.length, equals(1));
        expect(listA.first.userId, equals('user_a'));
        expect(listB.length, equals(1));
        expect(listB.first.userId, equals('user_b'));

        // By chapterId
        expect((await repoA.getOfflineChaptersByChapterId(sharedChapterId)).first.userId, equals('user_a'));
        expect((await repoB.getOfflineChaptersByChapterId(sharedChapterId)).first.userId, equals('user_b'));

        // Update lastReadAt
        await repoA.updateLastReadAt(sharedVersionId, 55555);
        await repoB.updateLastReadAt(sharedVersionId, 99999);

        expect((await repoA.getOfflineChapter(sharedVersionId))!.lastReadAt, equals(55555));
        expect((await repoB.getOfflineChapter(sharedVersionId))!.lastReadAt, equals(99999));

        // Pinning status
        expect((await repoA.getOfflineChapter(sharedVersionId))!.isPinned, isFalse);
        expect((await repoB.getOfflineChapter(sharedVersionId))!.isPinned, isTrue);

        await repoA.setChapterPinned(sharedVersionId, true);
        expect((await repoA.getOfflineChapter(sharedVersionId))!.isPinned, isTrue);
      });
    });

    group('Gate 1C — Queue/Resolver/Path isolation', () {
      test('Gate 1C.1: stableSafeScope is deterministic, path-safe and collision-free for distinct users', () {
        final scope1 = OfflineStoragePaths.stableSafeScope('user_alpha');
        final scope2 = OfflineStoragePaths.stableSafeScope('user_alpha');
        final scopeBeta = OfflineStoragePaths.stableSafeScope('user_beta');
        final scopeWithSymbols = OfflineStoragePaths.stableSafeScope('user/dir..\\test:name');

        // Deterministic
        expect(scope1, equals(scope2));
        expect(scope1, isNot(equals(scopeBeta)));

        // Path-safe: không chứa separator '/', '\', '..', ':', space
        expect(scopeWithSymbols, isNot(contains('/')));
        expect(scopeWithSymbols, isNot(contains(r'\')));
        expect(scopeWithSymbols, isNot(contains('..')));
        expect(scopeWithSymbols, isNot(contains(':')));
        expect(scopeWithSymbols, isNot(contains(' ')));
        // 64 hex chars
        expect(RegExp(r'^[a-f0-9]{64}$').hasMatch(scope1), isTrue);
      });

      test('Gate 1C.2: 3-Zone filesystem paths isolation across userScopes', () async {
        final basePath = p.join(tempDir.path, 'files', 'offline');
        final pathsA = OfflineStoragePaths(customBasePath: basePath, userId: 'user_a');
        final pathsB = OfflineStoragePaths(customBasePath: basePath, userId: 'user_b');

        final scopeA = OfflineStoragePaths.stableSafeScope('user_a');
        final scopeB = OfflineStoragePaths.stableSafeScope('user_b');

        // 3 Zones của User A
        final tmpA = await pathsA.getTmpDirPath();
        final stagingA = await pathsA.getStagingDirPath();
        final installedA = await pathsA.getInstalledDirPath();

        expect(tmpA, contains(scopeA));
        expect(tmpA, endsWith(p.join(scopeA, 'tmp')));
        expect(stagingA, endsWith(p.join(scopeA, 'staging')));
        expect(installedA, endsWith(p.join(scopeA, 'installed')));

        // 3 Zones của User B
        final tmpB = await pathsB.getTmpDirPath();
        final stagingB = await pathsB.getStagingDirPath();
        final installedB = await pathsB.getInstalledDirPath();

        expect(tmpB, contains(scopeB));
        expect(tmpB, endsWith(p.join(scopeB, 'tmp')));
        expect(stagingB, endsWith(p.join(scopeB, 'staging')));
        expect(installedB, endsWith(p.join(scopeB, 'installed')));

        // Hoàn toàn không giao nhau giữa A và B
        expect(tmpA, isNot(equals(tmpB)));
        expect(stagingA, isNot(equals(stagingB)));
        expect(installedA, isNot(equals(installedB)));

        // Cùng một versionId
        const versionId = 'ver_parallel_download_001';
        final partA = await pathsA.getPartFile(versionId);
        final partB = await pathsB.getPartFile(versionId);

        expect(partA.path, isNot(equals(partB.path)));

        // Tạo file .part đồng thời cho User A và User B
        await pathsA.ensureDirectoriesExist();
        await pathsB.ensureDirectoriesExist();

        await partA.writeAsString('PART_CONTENT_OF_USER_A');
        await partB.writeAsString('PART_CONTENT_OF_USER_B');

        expect(await partA.readAsString(), equals('PART_CONTENT_OF_USER_A'));
        expect(await partB.readAsString(), equals('PART_CONTENT_OF_USER_B'));

        // Xóa part của User A không chạm đến User B
        await pathsA.deletePartFile(versionId);
        expect(await partA.exists(), isFalse);
        expect(await partB.exists(), isTrue);
        expect(await partB.readAsString(), equals('PART_CONTENT_OF_USER_B'));
      });

      test('Gate 1C.3: Resolver User Isolation & Tombstone fail-closed', () async {
        final dbPath = p.join(tempDir.path, 'resolver_isolation_test.db');
        final basePath = p.join(tempDir.path, 'files', 'offline');

        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        final pathsA = OfflineStoragePaths(customBasePath: basePath, userId: 'user_a');
        final pathsB = OfflineStoragePaths(customBasePath: basePath, userId: 'user_b');

        final repoA = OfflineStorageRepository(database: offlineDb, userId: 'user_a');
        final repoB = OfflineStorageRepository(database: offlineDb, userId: 'user_b');

        final installerA = BundleInstaller(repository: repoA, storagePaths: pathsA);
        final installerB = BundleInstaller(repository: repoB, storagePaths: pathsB);

        final resolverA = OfflineContentResolver(
          repository: repoA,
          storagePaths: pathsA,
          bundleInstaller: installerA,
        );

        final resolverB = OfflineContentResolver(
          repository: repoB,
          storagePaths: pathsB,
          bundleInstaller: installerB,
        );

        const versionId = 'ver_resolver_shared';
        const chapterId = 'chap_resolver_shared';

        // Tạo installed payload cho User A
        final installedDirA = Directory(await pathsA.getInstalledPathForVersion(versionId));
        await installedDirA.create(recursive: true);

        final imgFile = File(p.join(installedDirA.path, '001.jpg'));
        final imgBytes = List.filled(100, 1);
        await imgFile.writeAsBytes(imgBytes);
        final realSha256 = sha256.convert(imgBytes).toString();

        final manifest = {
          'schemaVersion': 1,
          'chapterVersionId': versionId,
          'chapterId': chapterId,
          'storyId': 'story_res',
          'storyTitle': 'Resolver Story',
          'chapterNumber': '1',
          'mediaFormat': 'COMIC',
          'bundleType': 'OFFLINE_READER',
          'files': [
            {
              'path': '001.jpg',
              'size': 100,
              'sha256': realSha256,
            }
          ],
          'pages': [
            {
              'pageIndex': 0,
              'assetId': 'page_1',
              'fileName': '001.jpg',
              'width': 800,
              'height': 1200,
              'sha256': realSha256,
              'size': 100,
            }
          ],
        };

        final manifestFile = File(p.join(installedDirA.path, 'manifest.json'));
        await manifestFile.writeAsString(jsonEncode(manifest));

        final rootDirA = await pathsA.getRootOfflinePath();
        final installedDirRelativeA = p.relative(installedDirA.path, from: rootDirA);

        final chapterA = OfflineChapter(
          userId: 'user_a',
          chapterVersionId: versionId,
          chapterId: chapterId,
          storyId: 'story_res',
          storyTitle: 'Resolver Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: installedDirRelativeA,
          totalFiles: 2,
          totalBytes: 200,
          installedAt: DateTime.now().millisecondsSinceEpoch,
          manifestJson: jsonEncode(manifest),
        );

        await repoA.insertOfflineChapter(chapterA);

        // User A resolve thành công
        final resolvedA = await resolverA.resolveChapter(chapterId: chapterId);
        expect(resolvedA, isNotNull);
        expect(resolvedA!.offlineChapter.userId, equals('user_a'));
        expect(resolvedA.offlineChapter.chapterVersionId, equals(versionId));

        // User B resolve cùng chapterId -> PHẢI TRẢ VỀ NULL (User B chưa cài đặt, không được leak dữ liệu của User A)
        final resolvedB = await resolverB.resolveChapter(chapterId: chapterId);
        expect(resolvedB, isNull, reason: 'Resolver of User B must never leak or resolve chapter installed by User A');

        // Khi có Tombstone ở User A -> resolverA lập tức fail-closed trả về NULL (Invariant P0.1)
        await repoA.insertTombstone(OfflineDeletionTombstone(
          tombstoneId: 'tomb_res_a',
          userId: 'user_a',
          chapterVersionId: versionId,
          createdAt: DateTime.now().millisecondsSinceEpoch,
        ));

        final resolvedAAfterTombstone = await resolverA.resolveChapter(chapterId: chapterId);
        expect(resolvedAAfterTombstone, isNull, reason: 'Resolver must fail-closed if chapter has an active deletion tombstone');

        await offlineDb.close();
      });
    });

    group('Gate 1D — User Context Binding & Identifier Safety', () {
      test('Gate 1D.1: Rejection of empty/blank userId in OfflineStorageRepository and OfflineStoragePaths', () {
        final offlineDb = OfflineDatabase();
        expect(
          () => OfflineStorageRepository(database: offlineDb, userId: ''),
          throwsA(isA<ArgumentError>()),
        );
        expect(
          () => OfflineStorageRepository(database: offlineDb, userId: '   '),
          throwsA(isA<ArgumentError>()),
        );
        expect(
          () => OfflineStoragePaths(userId: ''),
          throwsA(isA<ArgumentError>()),
        );
        expect(
          () => OfflineStoragePaths(userId: '   '),
          throwsA(isA<ArgumentError>()),
        );
      });

      test('Gate 1D.2: Cross-context identity mismatch guard throws ArgumentError', () {
        final offlineDb = OfflineDatabase();
        final repoA = OfflineStorageRepository(database: offlineDb, userId: 'user_a');
        final pathsB = OfflineStoragePaths(userId: 'user_b');
        final pathsA = OfflineStoragePaths(userId: 'user_a');

        // BundleInstaller mismatch
        expect(
          () => BundleInstaller(repository: repoA, storagePaths: pathsB),
          throwsA(isA<ArgumentError>()),
        );

        // OfflineContentResolver mismatch (storagePaths mismatch)
        final installerA = BundleInstaller(repository: repoA, storagePaths: pathsA);
        expect(
          () => OfflineContentResolver(
            repository: repoA,
            storagePaths: pathsB,
            bundleInstaller: installerA,
          ),
          throwsA(isA<ArgumentError>()),
        );

        // OfflineContentResolver mismatch (bundleInstaller mismatch)
        final repoB = OfflineStorageRepository(database: offlineDb, userId: 'user_b');
        final installerB = BundleInstaller(repository: repoB, storagePaths: pathsB);
        expect(
          () => OfflineContentResolver(
            repository: repoA,
            storagePaths: pathsA,
            bundleInstaller: installerB,
          ),
          throwsA(isA<ArgumentError>()),
        );

        // DownloadQueueManager mismatch
        final mockApiClient = MockApiClient();
        final artifactRepo = ArtifactRepository(apiClient: mockApiClient);
        final downloadClient = ArtifactDownloadClient();

        expect(
          () => DownloadQueueManager(
            repository: repoA,
            artifactRepository: artifactRepo,
            downloadClient: downloadClient,
            storagePaths: pathsB,
          ),
          throwsA(isA<ArgumentError>()),
        );

        expect(
          () => DownloadQueueManager(
            repository: repoA,
            artifactRepository: artifactRepo,
            downloadClient: downloadClient,
            storagePaths: pathsA,
            bundleInstaller: installerB,
          ),
          throwsA(isA<ArgumentError>()),
        );
      });

      test('Gate 1D.3: stableSafeScope produces full 64-hex SHA-256 hash', () {
        final scope = OfflineStoragePaths.stableSafeScope('user_secure_test');
        expect(scope.length, equals(64));
        expect(RegExp(r'^[a-f0-9]{64}$').hasMatch(scope), isTrue);
      });

      test('Gate 1D.4: DownloadTask generated taskId scopes userScope and timestamp in microseconds', () async {
        final dbPath = p.join(tempDir.path, 'task_id_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        final pathsA = OfflineStoragePaths(customBasePath: tempDir.path, userId: 'user_alpha');
        final repoA = OfflineStorageRepository(database: offlineDb, userId: 'user_alpha');

        final mockApiClient = MockApiClient();
        final artifactRepo = ArtifactRepository(apiClient: mockApiClient);
        final downloadClient = ArtifactDownloadClient();

        final queue = DownloadQueueManager(
          repository: repoA,
          artifactRepository: artifactRepo,
          downloadClient: downloadClient,
          storagePaths: pathsA,
        );

        final task = await queue.enqueueTask(
          chapterVersionId: 'ver_race_check',
          chapterId: 'chap_race',
          storyId: 'story_race',
          storyTitle: 'Race Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          autoStart: false,
        );

        // taskId phải chứa userScope và versionId
        final expectedScope = pathsA.userScope;
        expect(task.taskId, startsWith('task_${expectedScope}_ver_race_check_'));
        expect(task.userId, equals('user_alpha'));

        await offlineDb.close();
      });
    });

    group('Gate 4: Reader In-Use Lease Protection & Deterministic Deletion Protocol', () {
      test('Gate 4.1: ReaderLeaseManager token semantics, ref-counting, and idempotent release', () {
        final leaseManager = ReaderLeaseManager();
        const userId = 'user_reader_1';
        const versionId = 'ver_novel_001';

        expect(leaseManager.isLeased(userId, versionId), isFalse);
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(0));

        // 1. Acquire first lease
        final token1 = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: versionId,
          readerSessionId: 'session_alpha',
        );

        expect(token1.userId, equals(userId));
        expect(token1.chapterVersionId, equals(versionId));
        expect(token1.readerSessionId, equals('session_alpha'));
        expect(token1.leaseId, isNotEmpty);
        expect(token1.acquiredAt, isPositive);

        expect(leaseManager.isLeased(userId, versionId), isTrue);
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));

        // 2. Acquire second lease on same chapter (different reader/session)
        final token2 = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: versionId,
          readerSessionId: 'session_beta',
        );

        expect(token2.leaseId, isNot(equals(token1.leaseId)));
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(2));
        expect(leaseManager.isLeased(userId, versionId), isTrue);

        // 3. User isolation check: User B has no lease on the same version
        expect(leaseManager.isLeased('user_reader_2', versionId), isFalse);
        expect(leaseManager.getActiveLeaseCount('user_reader_2', versionId), equals(0));

        // 4. Release token 1: token 2 remains active, ref-count drops to 1, still leased
        final released1 = leaseManager.releaseLease(token1);
        expect(released1, isTrue);
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));
        expect(leaseManager.isLeased(userId, versionId), isTrue);

        // 5. Idempotent release of token 1: returns false, does not throw, does not affect token 2
        final reReleased1 = leaseManager.releaseLease(token1);
        expect(reReleased1, isFalse);
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));
        expect(leaseManager.isLeased(userId, versionId), isTrue);

        // 6. Release token 2: ref-count drops to 0, isLeased becomes false
        final released2 = leaseManager.releaseLease(token2);
        expect(released2, isTrue);
        expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(0));
        expect(leaseManager.isLeased(userId, versionId), isFalse);

        // 7. Clear all leases
        leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: versionId,
          readerSessionId: 'session_gamma',
        );
        expect(leaseManager.isLeased(userId, versionId), isTrue);
        leaseManager.clearAll();
        expect(leaseManager.isLeased(userId, versionId), isFalse);
      });

      test('Gate 4.2: DiskSpaceProvider thin interface & StoragePolicyConfig data model', () async {
        final mockDisk = MockDiskSpaceProvider();
        when(() => mockDisk.getFreeBytes(any())).thenAnswer((_) async => 1073741824); // 1GB

        final freeBytes = await mockDisk.getFreeBytes('/data/user/0');
        expect(freeBytes, equals(1073741824));

        // StoragePolicyConfig defaults and copyWith
        const defaultConfig = StoragePolicyConfig();
        expect(defaultConfig.minFreeDiskHeadroomBytes, equals(524288000)); // 500MB
        expect(defaultConfig.maxOfflineStorageBytes, isNull); // unlimited by default
        expect(defaultConfig.lowDiskWarningFraction, equals(0.10));

        final customConfig = defaultConfig.copyWith(
          maxOfflineStorageBytes: 104857600, // 100MB
          minFreeDiskHeadroomBytes: 209715200, // 200MB
        );
        expect(customConfig.maxOfflineStorageBytes, equals(104857600));
        expect(customConfig.minFreeDiskHeadroomBytes, equals(209715200));
        expect(customConfig.lowDiskWarningFraction, equals(0.10));
      });

      test('Gate 4.3: Single Chapter Deletion blocked fail-closed when leased; purges cleanly after lease release', () async {
        final dbPath = p.join(tempDir.path, 'gate4_single_del_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const userId = 'user_del_single';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();

        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );

        const versionId = 'ver_del_001';
        final installedDir = await storagePaths.getInstalledDir(versionId);
        await installedDir.create(recursive: true);
        final payloadFile = File(p.join(installedDir.path, 'page_001.webp'));
        await payloadFile.writeAsBytes([1, 2, 3, 4]);

        const chapter = OfflineChapter(
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'chap_del_001',
          storyId: 'story_del_001',
          storyTitle: 'Deletion Test Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: 'files/offline/scope/installed/$versionId',
          totalFiles: 1,
          totalBytes: 4,
          installedAt: 123456,
          manifestJson: '{}',
        );
        await storageRepo.insertOfflineChapter(chapter);

        const task = DownloadTask(
          taskId: 'task_del_001',
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'chap_del_001',
          storyId: 'story_del_001',
          storyTitle: 'Deletion Test Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.ready,
          createdAt: 123456,
          updatedAt: 123456,
        );
        await storageRepo.insertTask(task);

        // 1. Acquire Lease -> Reader is currently reading
        final token = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: versionId,
          readerSessionId: 'reader_session_1',
        );

        // 2. Attempt deletion -> MUST throw ChapterInUseException
        expect(
          () => deletionService.deleteChapter(versionId),
          throwsA(isA<ChapterInUseException>()),
        );

        // Verify fail-closed: DB row and filesystem payload remain intact
        expect(await storageRepo.isChapterInstalled(versionId), isTrue);
        expect(await payloadFile.exists(), isTrue);
        expect(await storageRepo.getTombstone(versionId), isNull);

        // 3. Release lease
        leaseManager.releaseLease(token);

        // 4. Retry deletion -> MUST succeed
        await deletionService.deleteChapter(versionId);

        // Verify 3-step protocol execution:
        // - Row deleted from offline_chapters
        expect(await storageRepo.isChapterInstalled(versionId), isFalse);
        expect(await storageRepo.getOfflineChapter(versionId), isNull);
        // - Task deleted from download_tasks
        expect(await storageRepo.getTaskByVersionId(versionId), isNull);
        // - Tombstone deleted from offline_deletion_tombstones
        expect(await storageRepo.getTombstone(versionId), isNull);
        // - Filesystem payload purged
        expect(await installedDir.exists(), isFalse);

        await offlineDb.close();
      });

      test('Gate 4.4: Batch Story Deletion (All-or-Nothing) fail-closed if any chapter in story is leased', () async {
        final dbPath = p.join(tempDir.path, 'gate4_batch_del_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const userId = 'user_del_batch';
        const storyId = 'story_batch_target';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();

        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );

        // Tạo 3 chapters cho bộ truyện
        final versionIds = ['ver_b1', 'ver_b2', 'ver_b3'];
        final payloadFiles = <File>[];

        for (var i = 0; i < 3; i++) {
          final vId = versionIds[i];
          final dir = await storagePaths.getInstalledDir(vId);
          await dir.create(recursive: true);
          final file = File(p.join(dir.path, 'content.txt'));
          await file.writeAsString('content $i');
          payloadFiles.add(file);

          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: vId,
            chapterId: 'chap_b$i',
            storyId: storyId,
            storyTitle: 'Batch Story',
            chapterNumber: '${i + 1}',
            mediaFormat: 'COMIC',
            installedDir: 'files/offline/scope/installed/$vId',
            totalFiles: 1,
            totalBytes: 10,
            installedAt: 1000 + i,
            manifestJson: '{}',
          ));

          await storageRepo.insertTask(DownloadTask(
            taskId: 'task_$vId',
            userId: userId,
            chapterVersionId: vId,
            chapterId: 'chap_b$i',
            storyId: storyId,
            storyTitle: 'Batch Story',
            chapterNumber: '${i + 1}',
            mediaFormat: 'COMIC',
            status: DownloadTaskStatus.ready,
            createdAt: 1000 + i,
            updatedAt: 1000 + i,
          ));
        }

        // 1. Lease ONLY chapter 2 (ver_b2)
        final token = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: 'ver_b2',
          readerSessionId: 'reader_session_batch',
        );

        // 2. Attempt batch deletion of the whole story -> MUST FAIL CLOSED (All-or-Nothing)
        expect(
          () => deletionService.deleteStory(storyId),
          throwsA(isA<ChapterInUseException>()),
        );

        // Verify All-or-Nothing invariant: ALL 3 chapters remain completely untouched
        for (final vId in versionIds) {
          expect(await storageRepo.isChapterInstalled(vId), isTrue,
              reason: 'Chapter $vId must NOT be deleted when batch is aborted');
          expect(await storageRepo.getTaskByVersionId(vId), isNotNull);
          expect(await storageRepo.getTombstone(vId), isNull);
        }
        for (final file in payloadFiles) {
          expect(await file.exists(), isTrue);
        }

        // 3. Release lease on ver_b2
        leaseManager.releaseLease(token);

        // 4. Retry batch deletion -> MUST succeed cleanly for all chapters
        await deletionService.deleteStory(storyId);

        // Verify all 3 chapters purged completely
        for (final vId in versionIds) {
          expect(await storageRepo.isChapterInstalled(vId), isFalse);
          expect(await storageRepo.getTaskByVersionId(vId), isNull);
          expect(await storageRepo.getTombstone(vId), isNull);
          final dir = await storagePaths.getInstalledDir(vId);
          expect(await dir.exists(), isFalse);
        }

        await offlineDb.close();
      });

      test('Gate 4.5: Identity binding check in OfflineDeletionService', () {
        final offlineDb = OfflineDatabase();
        final repoA = OfflineStorageRepository(database: offlineDb, userId: 'user_a');
        final pathsB = OfflineStoragePaths(userId: 'user_b');
        final leaseManager = ReaderLeaseManager();

        expect(
          () => OfflineDeletionService(
            repository: repoA,
            storagePaths: pathsB,
            readerLeaseManager: leaseManager,
          ),
          throwsA(isA<ArgumentError>()),
        );
      });

      test('Gate 4.6: Deletion Reservation blocks acquireLease during deletion and releases cleanly', () {
        final leaseManager = ReaderLeaseManager();
        const userId = 'user_race_1';
        const versionId = 'ver_race_001';

        expect(leaseManager.isDeleting(userId, versionId), isFalse);

        // 1. Reserve deletion
        final reservation = leaseManager.reserveDeletion(
          userId: userId,
          chapterVersionId: versionId,
        );
        expect(reservation.userId, equals(userId));
        expect(reservation.chapterVersionId, equals(versionId));
        expect(leaseManager.isDeleting(userId, versionId), isTrue);

        // 2. Reader trying to acquire lease while deleting MUST FAIL
        expect(
          () => leaseManager.acquireLease(
            userId: userId,
            chapterVersionId: versionId,
            readerSessionId: 'session_race',
          ),
          throwsA(isA<ChapterDeletingException>()),
        );

        // 3. Second deletion reservation on same version MUST FAIL
        expect(
          () => leaseManager.reserveDeletion(
            userId: userId,
            chapterVersionId: versionId,
          ),
          throwsA(isA<ChapterDeletingException>()),
        );

        // 4. Release deletion reservation
        leaseManager.releaseDeletionReservation(reservation);
        expect(leaseManager.isDeleting(userId, versionId), isFalse);

        // 5. Reader can now acquire lease
        final token = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: versionId,
          readerSessionId: 'session_race',
        );
        expect(token.leaseId, isNotEmpty);

        // 6. Deletion reservation fails if already leased
        expect(
          () => leaseManager.reserveDeletion(
            userId: userId,
            chapterVersionId: versionId,
          ),
          throwsA(isA<ChapterInUseException>()),
        );

        leaseManager.releaseLease(token);
      });

      test('Gate 4.7: Batch Deletion Reservation is All-or-Nothing in RAM', () {
        final leaseManager = ReaderLeaseManager();
        const userId = 'user_race_batch';
        final versionIds = ['ver_rb1', 'ver_rb2', 'ver_rb3'];

        // Lease rb2
        final token = leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: 'ver_rb2',
          readerSessionId: 'session_b',
        );

        // Batch reservation must fail and NOT mark rb1 or rb3 as deleting
        expect(
          () => leaseManager.reserveDeletionBatch(
            userId: userId,
            chapterVersionIds: versionIds,
          ),
          throwsA(isA<ChapterInUseException>()),
        );
        expect(leaseManager.isDeleting(userId, 'ver_rb1'), isFalse);
        expect(leaseManager.isDeleting(userId, 'ver_rb2'), isFalse);
        expect(leaseManager.isDeleting(userId, 'ver_rb3'), isFalse);

        leaseManager.releaseLease(token);

        // Now batch reservation succeeds
        final reservations = leaseManager.reserveDeletionBatch(
          userId: userId,
          chapterVersionIds: versionIds,
        );
        expect(reservations.length, equals(3));
        expect(leaseManager.isDeleting(userId, 'ver_rb1'), isTrue);
        expect(leaseManager.isDeleting(userId, 'ver_rb2'), isTrue);
        expect(leaseManager.isDeleting(userId, 'ver_rb3'), isTrue);

        leaseManager.releaseDeletionReservationBatch(reservations);
        expect(leaseManager.isDeleting(userId, 'ver_rb1'), isFalse);
        expect(leaseManager.isDeleting(userId, 'ver_rb2'), isFalse);
        expect(leaseManager.isDeleting(userId, 'ver_rb3'), isFalse);
      });

      test('Gate 4.8: Single Chapter Deletion is idempotent after crash (existing tombstone resumes cleanly)', () async {
        final dbPath = p.join(tempDir.path, 'idempotent_single_del_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const userId = 'user_idempotent_1';
        const versionId = 'ver_idem_001';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();

        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );

        // Setup: chapter và installed folder
        final installedDir = await storagePaths.getInstalledDir(versionId);
        await installedDir.create(recursive: true);
        await File(p.join(installedDir.path, 'p1.jpg')).writeAsString('fake image');

        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'chap_idem_1',
          storyId: 'story_idem',
          storyTitle: 'Idem Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          installedDir: 'files/offline/scope/installed/$versionId',
          totalFiles: 1,
          totalBytes: 100,
          installedAt: 1000,
          manifestJson: '{}',
        ));

        await storageRepo.insertTask(DownloadTask(
          taskId: 'task_$versionId',
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'chap_idem_1',
          storyId: 'story_idem',
          storyTitle: 'Idem Story',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.ready,
          createdAt: 1000,
          updatedAt: 1000,
        ));

        // Giả lập crash sau Bước 1: Tombstone đã tồn tại, offline_chapters đã bị xóa
        await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_crashed_step1');
        expect(await storageRepo.getTombstone(versionId), isNotNull);
        expect(await storageRepo.isChapterInstalled(versionId), isFalse);

        // Gọi deleteChapter lần nữa -> Phải resume thành công, không ném SQLite UNIQUE constraint violation
        await deletionService.deleteChapter(versionId);

        // Verify hoàn tất xóa cả filesystem lẫn tombstone và task
        expect(await storageRepo.getTombstone(versionId), isNull);
        expect(await storageRepo.getTaskByVersionId(versionId), isNull);
        expect(await installedDir.exists(), isFalse);

        await offlineDb.close();
      });

      test('Gate 4.9: Batch Story Deletion is idempotent when partial tombstones pre-exist', () async {
        final dbPath = p.join(tempDir.path, 'idempotent_batch_del_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(
          customPath: dbPath,
          databaseFactory: databaseFactoryFfi,
        );

        const userId = 'user_idempotent_batch';
        const storyId = 'story_idem_batch';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();

        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );

        final versionIds = ['ver_ib1', 'ver_ib2', 'ver_ib3'];
        for (var i = 0; i < 3; i++) {
          final vId = versionIds[i];
          final dir = await storagePaths.getInstalledDir(vId);
          await dir.create(recursive: true);
          await File(p.join(dir.path, 'file.txt')).writeAsString('content $i');

          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: vId,
            chapterId: 'chap_ib$i',
            storyId: storyId,
            storyTitle: 'Idem Batch Story',
            chapterNumber: '${i + 1}',
            mediaFormat: 'COMIC',
            installedDir: 'files/offline/scope/installed/$vId',
            totalFiles: 1,
            totalBytes: 50,
            installedAt: 2000 + i,
            manifestJson: '{}',
          ));

          await storageRepo.insertTask(DownloadTask(
            taskId: 'task_$vId',
            userId: userId,
            chapterVersionId: vId,
            chapterId: 'chap_ib$i',
            storyId: storyId,
            storyTitle: 'Idem Batch Story',
            chapterNumber: '${i + 1}',
            mediaFormat: 'COMIC',
            status: DownloadTaskStatus.ready,
            createdAt: 2000 + i,
            updatedAt: 2000 + i,
          ));
        }

        // Giả lập crash sau khi chapter 1 (ver_ib1) đã bị ghi tombstone
        await storageRepo.ensureDeletionRevoked('ver_ib1', tombstoneId: 'tomb_pre_crashed');

        // Gọi deleteStory -> Tiếp tục thực thi idempotent cho toàn bộ truyện
        await deletionService.deleteStory(storyId);

        for (final vId in versionIds) {
          expect(await storageRepo.isChapterInstalled(vId), isFalse);
          expect(await storageRepo.getTombstone(vId), isNull);
          final dir = await storagePaths.getInstalledDir(vId);
          expect(await dir.exists(), isFalse);
        }

        await offlineDb.close();
      });
    });
  });
}
