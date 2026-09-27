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
import 'package:omninovel_mobile/features/offline/services/active_checkpoint_provider.dart';
import 'package:omninovel_mobile/features/offline/services/storage_admission_coordinator.dart';
import 'package:omninovel_mobile/features/offline/services/storage_quota_manager.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
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

    group('Gate 2 & Gate 3: Startup Reconciliation v2 & Deletion Precedence', () {
      test('Gate 2.1 & 3.1: Tombstone wins absolute precedence over 5D.4 Recovery (Never Reconstruct)', () async {
        final dbPath = p.join(tempDir.path, 'gate2_prec_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_prec_1';
        const versionId = 'ver_tomb_prevails';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final installer = BundleInstaller(
          storagePaths: storagePaths,
          repository: storageRepo,
        );

        // Setup: Thư mục installed có manifest và file hợp lệ 100% VÀ DownloadTask ở PAUSED (trạng thái recoverable của 5D.4)
        final pageContent = utf8.encode('page-content-gate21');
        final pageSha = sha256.convert(pageContent).toString();
        final manifest = {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': versionId,
          'chapterId': 'c1',
          'storyId': 's1',
          'chapterTitle': 'Phục hồi Gate 2.1',
          'mediaFormat': 'COMIC',
          'files': [
            {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
          ]
        };

        final installedDir = await storagePaths.getInstalledDir(versionId);
        await installedDir.create(recursive: true);
        await File(p.join(installedDir.path, 'manifest.json')).writeAsString(jsonEncode(manifest));
        final pageFile = File(p.join(installedDir.path, 'pages', '001.webp'));
        await pageFile.parent.create(recursive: true);
        await pageFile.writeAsBytes(pageContent);

        await storageRepo.insertTask(DownloadTask(
          taskId: 'task_$versionId',
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'c1',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.paused,
          createdAt: 1000,
          updatedAt: 1000,
        ));

        // Nhưng CÓ deletion tombstone (mô phỏng crash giữa Step 1 và Step 2 khi xóa)
        await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_$versionId');
        expect(await storageRepo.getTombstone(versionId), isNotNull);

        // Chạy Startup Reconciliation v2
        final report = await installer.reconcileOnStartup();

        // Verify: Thư mục vật lý BỊ PURGE, tombstone được finalize, và KHÔNG BAO GIỜ bị 5D.4 reconstruct!
        expect(await installedDir.exists(), isFalse);
        expect(await storageRepo.getTombstone(versionId), isNull);
        expect(await storageRepo.isChapterInstalled(versionId), isFalse);
        expect(await storageRepo.getTaskByVersionId(versionId), isNull);
        expect(report.reconstructedRows, equals(0));
        expect(report.finalizedTombstones, equals(1));

        await offlineDb.close();
      });

      test('Gate 2.2: Crash after purge (tombstone exists, files already gone) finalizes cleanly', () async {
        final dbPath = p.join(tempDir.path, 'gate2_crash_post_purge.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_prec_2';
        const versionId = 'ver_tomb_purged';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final installer = BundleInstaller(
          storagePaths: storagePaths,
          repository: storageRepo,
        );

        // Filesystem không có folder (đã purge trước khi crash)
        await storageRepo.insertTask(DownloadTask(
          taskId: 'task_$versionId',
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'c2',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '2',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.ready,
          createdAt: 1000,
          updatedAt: 1000,
        ));
        await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_post_purge');

        final report = await installer.reconcileOnStartup();
        expect(await storageRepo.getTombstone(versionId), isNull);
        expect(await storageRepo.getTaskByVersionId(versionId), isNull);
        expect(report.finalizedTombstones, equals(1));

        await offlineDb.close();
      });

      test('Gate 3.2: 5D.4 recovery reconstructs row when payload is valid and NO tombstone exists', () async {
        final dbPath = p.join(tempDir.path, 'gate3_recovery_clean.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_prec_3';
        const versionId = 'ver_valid_no_tomb';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final installer = BundleInstaller(
          storagePaths: storagePaths,
          repository: storageRepo,
        );

        final pageContent = utf8.encode('page-content-gate32');
        final pageSha = sha256.convert(pageContent).toString();
        final manifest = {
          'schemaVersion': 1,
          'bundleType': 'OFFLINE_READER',
          'chapterVersionId': versionId,
          'chapterId': 'c3',
          'storyId': 's1',
          'chapterTitle': 'Phục hồi Gate 3.2',
          'mediaFormat': 'COMIC',
          'files': [
            {'path': 'pages/001.webp', 'size': pageContent.length, 'sha256': pageSha}
          ]
        };

        final installedDir = await storagePaths.getInstalledDir(versionId);
        await installedDir.create(recursive: true);
        await File(p.join(installedDir.path, 'manifest.json')).writeAsString(jsonEncode(manifest));
        final pageFile = File(p.join(installedDir.path, 'pages', '001.webp'));
        await pageFile.parent.create(recursive: true);
        await pageFile.writeAsBytes(pageContent);

        await storageRepo.insertTask(DownloadTask(
          taskId: 'task_$versionId',
          userId: userId,
          chapterVersionId: versionId,
          chapterId: 'c3',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '3',
          mediaFormat: 'COMIC',
          status: DownloadTaskStatus.paused,
          createdAt: 1000,
          updatedAt: 1000,
        ));

        // KHÔNG có tombstone
        expect(await storageRepo.getTombstone(versionId), isNull);

        final report = await installer.reconcileOnStartup();
        // 5D.4 recovery tái tạo thành công
        expect(report.reconstructedRows, equals(1));
        expect(await storageRepo.isChapterInstalled(versionId), isTrue);

        await offlineDb.close();
      });
    });

    // =========================================================================
    // Gate 5: Deterministic LRU Eviction Engine & Quota Management
    // =========================================================================
    group('Gate 5: Deterministic LRU Eviction Engine & Quota Management', () {
      test('Gate 5.1: Deterministic Candidate Selection & Ordering', () async {
        final dbPath = p.join(tempDir.path, 'gate5_ordering_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_order';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
        );

        // Chèn 5 chapters với các tiêu chí khác nhau
        Future<void> insertChapterHelper({
          required String versionId,
          required int installedAt,
          int? lastReadAt,
        }) async {
          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: versionId,
            chapterId: 'c_$versionId',
            storyId: 's1',
            storyTitle: 'Story 1',
            chapterNumber: '1',
            chapterTitle: 'Chap',
            mediaFormat: 'COMIC',
            installedDir: 'installed/$versionId',
            totalFiles: 1,
            totalBytes: 1000,
            installedAt: installedAt,
            lastReadAt: lastReadAt,
            manifestJson: '{}',
          ));
        }

        // 1. Chưa đọc, installed 100, id 'ver_unread_b'
        await insertChapterHelper(versionId: 'ver_unread_b', installedAt: 100, lastReadAt: null);
        // 2. Chưa đọc, installed 100, id 'ver_unread_a' (tie-breaker: ver_unread_a < ver_unread_b)
        await insertChapterHelper(versionId: 'ver_unread_a', installedAt: 100, lastReadAt: null);
        // 3. Chưa đọc, installed 200, id 'ver_unread_c' (cài sau A & B)
        await insertChapterHelper(versionId: 'ver_unread_c', installedAt: 200, lastReadAt: null);
        // 4. Đã đọc lúc 500, installed 50
        await insertChapterHelper(versionId: 'ver_read_old', installedAt: 50, lastReadAt: 500);
        // 5. Đã đọc lúc 1500, installed 50
        await insertChapterHelper(versionId: 'ver_read_new', installedAt: 50, lastReadAt: 1500);

        final candidates = await quotaManager.getCandidates();
        final candidateIds = candidates.map((c) => c.chapterVersionId).toList();

        // Thứ tự tất định kỳ vọng:
        // 1. ver_unread_a (chưa đọc, installed 100, id 'a')
        // 2. ver_unread_b (chưa đọc, installed 100, id 'b')
        // 3. ver_unread_c (chưa đọc, installed 200)
        // 4. ver_read_old (đã đọc 500)
        // 5. ver_read_new (đã đọc 1500)
        expect(candidateIds, equals([
          'ver_unread_a',
          'ver_unread_b',
          'ver_unread_c',
          'ver_read_old',
          'ver_read_new',
        ]));

        await offlineDb.close();
      });

      test('Gate 5.2: Multi-layer Exclusions (Pinned, Leased, Deleting, Custom Excluded)', () async {
        final dbPath = p.join(tempDir.path, 'gate5_exclusions_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_excl';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
        );

        Future<void> insertChapterHelper({
          required String versionId,
          bool isPinned = false,
        }) async {
          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: versionId,
            chapterId: 'c_$versionId',
            storyId: 's1',
            storyTitle: 'Story 1',
            chapterNumber: '1',
            chapterTitle: 'Chap',
            mediaFormat: 'COMIC',
            installedDir: 'installed/$versionId',
            totalFiles: 1,
            totalBytes: 1000,
            installedAt: 100,
            isPinned: isPinned,
            manifestJson: '{}',
          ));
        }

        await insertChapterHelper(versionId: 'ver_pinned', isPinned: true);
        await insertChapterHelper(versionId: 'ver_leased');
        await insertChapterHelper(versionId: 'ver_deleting');
        await insertChapterHelper(versionId: 'ver_checkpoint_excluded');
        await insertChapterHelper(versionId: 'ver_valid_candidate');

        // Setup active lease cho ver_leased
        leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: 'ver_leased',
          readerSessionId: 'session_1',
        );

        // Setup deletion reservation cho ver_deleting
        leaseManager.reserveDeletion(
          userId: userId,
          chapterVersionId: 'ver_deleting',
        );

        // Kiểm tra danh sách candidates với excludedVersionIds chứa ver_checkpoint_excluded
        final candidates = await quotaManager.getCandidates(
          excludedVersionIds: {'ver_checkpoint_excluded'},
        );

        expect(candidates.length, equals(1));
        expect(candidates.first.chapterVersionId, equals('ver_valid_candidate'));

        await offlineDb.close();
      });

      test('Gate 5.3: Eviction Delegation via OfflineDeletionService (Zero Direct File Purge)', () async {
        final dbPath = p.join(tempDir.path, 'gate5_delegation_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_delegate';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        // Cấu hình: Headroom 500 MB (524,288,000 bytes)
        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        const versionId1 = 'ver_evict_1';
        const versionId2 = 'ver_evict_2';
        const bytesPerChap = 10000000; // 10 MB

        // Tạo 2 chapter trên đĩa và trong DB
        for (final vId in [versionId1, versionId2]) {
          final installedDir = await storagePaths.getInstalledDir(vId);
          await installedDir.create(recursive: true);
          await File(p.join(installedDir.path, 'test.dat')).writeAsString('content_$vId');

          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: vId,
            chapterId: 'c_$vId',
            storyId: 's1',
            storyTitle: 'S',
            chapterNumber: '1',
            chapterTitle: 'Chap',
            mediaFormat: 'COMIC',
            installedDir: 'installed/$vId',
            totalFiles: 1,
            totalBytes: bytesPerChap,
            installedAt: 100,
            manifestJson: '{}',
          ));
        }

        // Mock: Free bytes hiện tại là 505,000,000.
        // Gói tải mới incomingBytes = 10,000,000 (10 MB).
        // Sau khi tải, projectedFree = 495,000,000 < 500,000,000 (thiếu 5,000,000 bytes).
        // LRU cần evict 1 chapter (10 MB >= 5 MB cần thiết).
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 505000000);

        final result = await quotaManager.evictToFit(incomingBytes: 10000000);

        expect(result.evictedChapters.length, equals(1));
        expect(result.evictedChapters.first.chapterVersionId, equals(versionId1));
        expect(result.evictedBytes, equals(bytesPerChap));

        // Xác minh 3-step deletion protocol được hoàn tất đầy đủ:
        // 1. Row DB đã bị xóa
        expect(await storageRepo.isChapterInstalled(versionId1), isFalse);
        // 2. Filesystem đã bị purge sạch sẽ
        expect(await (await storagePaths.getInstalledDir(versionId1)).exists(), isFalse);
        // 3. Tombstone không còn tồn tại
        expect(await storageRepo.getTombstone(versionId1), isNull);

        // Chapter 2 vẫn an toàn nguyên vẹn
        expect(await storageRepo.isChapterInstalled(versionId2), isTrue);

        await offlineDb.close();
      });

      test('Gate 5.4: InsufficientStorageException when candidates cannot fulfill eviction requirement (fail-closed)', () async {
        final dbPath = p.join(tempDir.path, 'gate5_insufficient_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_insufficient';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        // Quota = 30 MB (30,000,000 bytes), Headroom = 100 MB
        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 100000000,
            maxOfflineStorageBytes: 30000000,
          ),
        );

        const vId = 'ver_quota_only';
        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: vId,
          chapterId: 'c1',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          chapterTitle: 'Chap',
          mediaFormat: 'COMIC',
          installedDir: 'installed/$vId',
          totalFiles: 1,
          totalBytes: 10000000, // 10 MB
          installedAt: 100,
          manifestJson: '{}',
        ));

        // Free bytes = 200 MB (dư dả so với headroom 100 MB)
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 200000000);

        // Tải thêm 50 MB -> tổng used = 60 MB > maxQuota 30 MB -> cần evict 30 MB.
        // Nhưng candidates chỉ có 1 chapter (10 MB) -> không đủ giải phóng 30 MB!
        // Kỳ vọng ném InsufficientStorageException (fail-closed)
        await expectLater(
          () => quotaManager.evictToFit(incomingBytes: 50000000),
          throwsA(isA<InsufficientStorageException>()),
        );

        await offlineDb.close();
      });

      test('Gate 5.5: evictToQuota cleans storage down to maxOfflineStorageBytes', () async {
        final dbPath = p.join(tempDir.path, 'gate5_evict_to_quota_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_quota_clean';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 100000000,
            maxOfflineStorageBytes: 30000000,
          ),
        );

        // Thêm 4 chapters x 10 MB (tổng cộng 40 MB > quota 30 MB -> cần giải phóng ít nhất 10 MB)
        for (int i = 1; i <= 4; i++) {
          await storageRepo.insertOfflineChapter(OfflineChapter(
            userId: userId,
            chapterVersionId: 'ver_batch_$i',
            chapterId: 'c$i',
            storyId: 's1',
            storyTitle: 'S',
            chapterNumber: '$i',
            chapterTitle: 'Chap',
            mediaFormat: 'COMIC',
            installedDir: 'installed/ver_batch_$i',
            totalFiles: 1,
            totalBytes: 10000000,
            installedAt: 100 * i,
            manifestJson: '{}',
          ));
        }

        expect(await storageRepo.getTotalStorageBytes(), equals(40000000));

        final quotaResult = await quotaManager.evictToQuota();
        expect(quotaResult.evictedBytes, greaterThanOrEqualTo(10000000));
        expect(await storageRepo.getTotalStorageBytes(), lessThanOrEqualTo(30000000));

        await offlineDb.close();
      });

      // =======================================================================
      // Gate 5B: LRU Production Semantics Hardening
      // =======================================================================
      test('Gate 5B.1: StorageQuotaManager automatically excludes active checkpoints from ActiveCheckpointProvider', () async {
        final dbPath = p.join(tempDir.path, 'gate5b_cp_exclusion_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_5b_cp';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();
        final checkpointProvider = InMemoryCheckpointProvider({'ver_protected_by_cp'});

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          checkpointProvider: checkpointProvider,
        );

        // Chèn 2 chapters
        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: 'ver_protected_by_cp',
          chapterId: 'c1',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          chapterTitle: 'Chap 1',
          mediaFormat: 'COMIC',
          installedDir: 'installed/ver_protected_by_cp',
          totalFiles: 1,
          totalBytes: 1000,
          installedAt: 100,
          manifestJson: '{}',
        ));

        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: 'ver_freely_evictable',
          chapterId: 'c2',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '2',
          chapterTitle: 'Chap 2',
          mediaFormat: 'COMIC',
          installedDir: 'installed/ver_freely_evictable',
          totalFiles: 1,
          totalBytes: 1000,
          installedAt: 200,
          manifestJson: '{}',
        ));

        // Caller KHÔNG truyền excludedVersionIds nhưng quotaManager vẫn tự động loại trừ ver_protected_by_cp
        final candidates = await quotaManager.getCandidates();
        expect(candidates.length, equals(1));
        expect(candidates.first.chapterVersionId, equals('ver_freely_evictable'));

        await offlineDb.close();
      });

      test('Gate 5B.2: evictToQuota reports explicit isSatisfied = false and throws in strict mode', () async {
        final dbPath = p.join(tempDir.path, 'gate5b_unsatisfied_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_lru_5b_unsatisfied';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        // Quota = 10 MB, current used = 20 MB -> cần evict 10 MB
        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            maxOfflineStorageBytes: 10000000,
          ),
        );

        // Chèn 2 chapters x 10 MB
        const vId1 = 'ver_leased_cannot_evict';
        const vId2 = 'ver_pinned_cannot_evict';
        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: vId1,
          chapterId: 'c1',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          chapterTitle: 'Chap 1',
          mediaFormat: 'COMIC',
          installedDir: 'installed/$vId1',
          totalFiles: 1,
          totalBytes: 10000000,
          installedAt: 100,
          manifestJson: '{}',
        ));
        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: vId2,
          chapterId: 'c2',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '2',
          chapterTitle: 'Chap 2',
          mediaFormat: 'COMIC',
          installedDir: 'installed/$vId2',
          totalFiles: 1,
          totalBytes: 10000000,
          installedAt: 200,
          isPinned: true, // Pinned -> loại trừ
          manifestJson: '{}',
        ));

        // Lease vId1
        leaseManager.acquireLease(
          userId: userId,
          chapterVersionId: vId1,
          readerSessionId: 'session_active',
        );

        // 1. Chế độ non-strict: Không ném lỗi nhưng trả isSatisfied = false (không silent success)
        final nonStrictResult = await quotaManager.evictToQuota(strict: false);
        expect(nonStrictResult.isSatisfied, isFalse);
        expect(nonStrictResult.evictedBytes, equals(0));
        expect(nonStrictResult.requiredBytes, equals(10000000));

        // 2. Chế độ strict: Ném InsufficientStorageException (fail-closed)
        await expectLater(
          () => quotaManager.evictToQuota(strict: true),
          throwsA(isA<InsufficientStorageException>()),
        );

        await offlineDb.close();
      });

      test('Gate 5B.3: SharedPreferencesCheckpointProvider extracts all valid chapterVersionIds scoped to current user', () async {
        const userId = 'user_target';
        SharedPreferences.setMockInitialValues({
          'omninovel_reading_checkpoint_${userId}_story1': jsonEncode({
            'storyId': 'story1',
            'chapterId': 'c1',
            'chapterVersionId': 'ver_cp_story1',
            'pageIndex': 5,
            'progressPercentage': 50.0,
            'scrollPosition': 100.0,
            'updatedAt': DateTime.now().toIso8601String(),
            'isDirty': false,
          }),
          'omninovel_reading_checkpoint_${userId}_story2': jsonEncode({
            'storyId': 'story2',
            'chapterId': 'c2',
            'chapterVersionId': 'ver_cp_story2',
            'pageIndex': 1,
            'progressPercentage': 10.0,
            'scrollPosition': 0.0,
            'updatedAt': DateTime.now().toIso8601String(),
            'isDirty': false,
          }),
          // Checkpoint của user KHÁC -> không được phép lọt vào
          'omninovel_reading_checkpoint_other_user_story3': jsonEncode({
            'storyId': 'story3',
            'chapterId': 'c3',
            'chapterVersionId': 'ver_cp_other_user',
            'pageIndex': 2,
            'progressPercentage': 20.0,
            'scrollPosition': 0.0,
            'updatedAt': DateTime.now().toIso8601String(),
            'isDirty': false,
          }),
        });

        final provider = SharedPreferencesCheckpointProvider(userId: userId);
        final protectedIds = await provider.getProtectedVersionIds();

        expect(protectedIds, containsAll(['ver_cp_story1', 'ver_cp_story2']));
        expect(protectedIds.contains('ver_cp_other_user'), isFalse);
      });
    });

    // =========================================================================
    // Gate 6: Pre-Download Quota & Headroom Admission Guard
    // =========================================================================
    group('Gate 6: Pre-Download Quota & Headroom Admission Guard', () {
      test('Gate 6.1: Sufficient headroom admits download without eviction and tracks RAM reservation', () async {
        final dbPath = p.join(tempDir.path, 'gate6_1_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_gate6_1';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000, // 500 MB
          ),
        );

        final coordinator = StorageAdmissionCoordinator(
          diskSpaceProvider: diskProvider,
          storageQuotaManager: quotaManager,
          storagePaths: storagePaths,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        // Free disk = 1,000 MB (dư dả so với headroom 500 MB)
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 1000000000);

        // Admit 100 MB
        final token = await coordinator.admitDownload(
          taskId: 'task_g6_1',
          chapterVersionId: 'ver_g6_1',
          requiredBytes: 100000000,
        );

        expect(token.taskId, equals('task_g6_1'));
        expect(token.reservedBytes, equals(100000000));
        expect(coordinator.totalReservedDownloadBytes, equals(100000000));
        expect(coordinator.hasReservation('task_g6_1'), isTrue);

        // Giải phóng
        coordinator.releaseReservation('task_g6_1');
        expect(coordinator.totalReservedDownloadBytes, equals(0));
        expect(coordinator.hasReservation('task_g6_1'), isFalse);

        await offlineDb.close();
      });

      test('Gate 6.2: Eviction-assisted admission evicts LRU candidates to fulfill shortfall and re-checks free space', () async {
        final dbPath = p.join(tempDir.path, 'gate6_2_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_gate6_2';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000, // 500 MB
          ),
        );

        final coordinator = StorageAdmissionCoordinator(
          diskSpaceProvider: diskProvider,
          storageQuotaManager: quotaManager,
          storagePaths: storagePaths,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        // Chèn 1 candidate cũ 50 MB
        const vOld = 'ver_old_evictable';
        final oldInstalledDir = await storagePaths.getInstalledDir(vOld);
        await oldInstalledDir.create(recursive: true);
        await File(p.join(oldInstalledDir.path, 'old.dat')).writeAsString('old');

        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: vOld,
          chapterId: 'c_old',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          chapterTitle: 'Chap Old',
          mediaFormat: 'COMIC',
          installedDir: 'installed/$vOld',
          totalFiles: 1,
          totalBytes: 50000000, // 50 MB
          installedAt: 100,
          manifestJson: '{}',
        ));

        // Free disk hiện tại = 520 MB.
        // Task cần 50 MB -> projected = 470 MB < 500 MB (thiếu 30 MB).
        // Sau khi evict candidate 50 MB, free disk tăng lên 570 MB.
        int callCount = 0;
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async {
          callCount++;
          if (callCount <= 2) {
            return 520000000; // Ban đầu & kiểm tra trong evictToFit
          }
          return 570000000; // Sau khi eviction thành công
        });

        final token = await coordinator.admitDownload(
          taskId: 'task_g6_2',
          chapterVersionId: 'ver_g6_2_new',
          requiredBytes: 50000000,
        );

        expect(token.reservedBytes, equals(50000000));
        expect(await storageRepo.isChapterInstalled(vOld), isFalse); // Đã bị evict
        expect(await oldInstalledDir.exists(), isFalse); // Filesystem sạch

        coordinator.releaseReservation('task_g6_2');
        await offlineDb.close();
      });

      test('Gate 6.3: Cannot satisfy shortfall due to pinned/protected candidates fails closed with 0 byte downloaded', () async {
        final dbPath = p.join(tempDir.path, 'gate6_3_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_gate6_3';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        final coordinator = StorageAdmissionCoordinator(
          diskSpaceProvider: diskProvider,
          storageQuotaManager: quotaManager,
          storagePaths: storagePaths,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        // Chèn chapter bị PINNED (không thể evict)
        const vPinned = 'ver_pinned_immortal';
        await storageRepo.insertOfflineChapter(OfflineChapter(
          userId: userId,
          chapterVersionId: vPinned,
          chapterId: 'c_pin',
          storyId: 's1',
          storyTitle: 'S',
          chapterNumber: '1',
          chapterTitle: 'Chap Pin',
          mediaFormat: 'COMIC',
          installedDir: 'installed/$vPinned',
          totalFiles: 1,
          totalBytes: 50000000,
          installedAt: 100,
          isPinned: true, // PINNED
          manifestJson: '{}',
        ));

        // Free disk = 510 MB. Cần 50 MB -> thiếu 40 MB.
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 510000000);

        // Kỳ vọng ném StorageAdmissionDeniedException
        await expectLater(
          () => coordinator.admitDownload(
            taskId: 'task_g6_3',
            chapterVersionId: 'ver_g6_3_incoming',
            requiredBytes: 50000000,
          ),
          throwsA(isA<StorageAdmissionDeniedException>()),
        );

        expect(coordinator.totalReservedDownloadBytes, equals(0));
        await offlineDb.close();
      });

      test('Gate 6.4: Concurrent admission ledger prevents overcommitting shared free disk budget', () async {
        final dbPath = p.join(tempDir.path, 'gate6_4_test.db');
        final offlineDb = OfflineDatabase();
        await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

        const userId = 'user_gate6_4';
        final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
        final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
        final leaseManager = ReaderLeaseManager();
        final deletionService = OfflineDeletionService(
          repository: storageRepo,
          storagePaths: storagePaths,
          readerLeaseManager: leaseManager,
        );
        final diskProvider = MockDiskSpaceProvider();

        final quotaManager = StorageQuotaManager(
          repository: storageRepo,
          storagePaths: storagePaths,
          deletionService: deletionService,
          readerLeaseManager: leaseManager,
          diskSpaceProvider: diskProvider,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000, // 500 MB
          ),
        );

        final coordinator = StorageAdmissionCoordinator(
          diskSpaceProvider: diskProvider,
          storageQuotaManager: quotaManager,
          storagePaths: storagePaths,
          config: const StoragePolicyConfig(
            minFreeDiskHeadroomBytes: 500000000,
          ),
        );

        // Free disk = 800 MB -> dung lượng khả dụng tối đa = 800 - 500 = 300 MB.
        when(() => diskProvider.getFreeBytes(any())).thenAnswer((_) async => 800000000);

        // Task 1 xin 200 MB -> Đủ (còn lại 100 MB khả dụng)
        final token1 = await coordinator.admitDownload(
          taskId: 'task_concurrent_1',
          chapterVersionId: 'ver_c1',
          requiredBytes: 200000000,
        );
        expect(token1.reservedBytes, equals(200000000));
        expect(coordinator.totalReservedDownloadBytes, equals(200000000));

        // Task 2 đồng thời xin 200 MB -> Bị từ chối vì chỉ còn 100 MB khả dụng!
        await expectLater(
          () => coordinator.admitDownload(
            taskId: 'task_concurrent_2',
            chapterVersionId: 'ver_c2',
            requiredBytes: 200000000,
          ),
          throwsA(isA<StorageAdmissionDeniedException>()),
        );

        // Task 1 hoàn thành và giải phóng
        coordinator.releaseReservation('task_concurrent_1');
        expect(coordinator.totalReservedDownloadBytes, equals(0));

        // Task 2 thử lại sau khi Task 1 đã release -> THÀNH CÔNG!
        final token2 = await coordinator.admitDownload(
          taskId: 'task_concurrent_2',
          chapterVersionId: 'ver_c2',
          requiredBytes: 200000000,
        );
        expect(token2.reservedBytes, equals(200000000));
        expect(coordinator.totalReservedDownloadBytes, equals(200000000));

        coordinator.releaseReservation('task_concurrent_2');
        await offlineDb.close();
      });
    });
  });
}
