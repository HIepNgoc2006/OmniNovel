import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/offline_storage_paths.dart';
import 'package:omninovel_mobile/features/offline/models/download_task.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/models/offline_deletion_tombstone.dart';
import 'package:omninovel_mobile/features/offline/repositories/offline_storage_repository.dart';
import 'package:omninovel_mobile/features/offline/services/bundle_installer.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

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
        // 16 hex chars
        expect(RegExp(r'^[a-f0-9]{16}$').hasMatch(scope1), isTrue);
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
  });
}
