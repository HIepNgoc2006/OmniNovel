import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_v3_migration_test_');
    dbPath = p.join(tempDir.path, 'migration_test.db');
  });

  tearDown(() async {
    try {
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('Task 7A.2: OfflineDatabase v2 -> v3 Migration Invariants', () {
    test('preserves 100% v2 data row-for-row and provisions new local library tables', () async {
      // 1. Khởi tạo một SQLite database ở schema v2
      final v2Db = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 2,
          onConfigure: (db) async {
            await db.execute('PRAGMA foreign_keys = ON;');
          },
          onCreate: (db, version) async {
            // Tạo 3 bảng v2 nguyên bản
            await db.execute('''
              CREATE TABLE offline_chapters (
                chapter_version_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
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
                manifest_json TEXT NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, chapter_version_id)
              );
            ''');

            await db.execute('''
              CREATE TABLE download_tasks (
                task_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chapter_version_id TEXT NOT NULL,
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
                updated_at INTEGER NOT NULL,
                UNIQUE(user_id, chapter_version_id)
              );
            ''');

            await db.execute('''
              CREATE TABLE offline_deletion_tombstones (
                tombstone_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chapter_version_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(user_id, chapter_version_id)
              );
            ''');
          },
        ),
      );

      // 2. Chèn dữ liệu thực tế vào cả 3 bảng v2
      await v2Db.insert('offline_chapters', {
        'chapter_version_id': 'v-chapter-1',
        'user_id': 'user-phase5d',
        'chapter_id': 'c-101',
        'story_id': 's-202',
        'story_title': 'Legacy Story Title',
        'chapter_number': '12',
        'chapter_title': 'Chapter Twelve',
        'media_format': 'COMIC',
        'publication_format': 'PAGE',
        'installed_dir': '/offline/payloads/v-chapter-1',
        'total_files': 25,
        'total_bytes': 15000000,
        'installed_at': 1710000000,
        'last_read_at': 1710005000,
        'manifest_json': '{"verified":true}',
        'is_pinned': 1,
      });

      await v2Db.insert('download_tasks', {
        'task_id': 'task-download-99',
        'user_id': 'user-phase5d',
        'chapter_version_id': 'v-chapter-2',
        'chapter_id': 'c-102',
        'story_id': 's-202',
        'story_title': 'Legacy Story Title',
        'chapter_number': '13',
        'media_format': 'NOVEL',
        'status': 'DOWNLOADING',
        'downloaded_bytes': 500000,
        'total_bytes': 1000000,
        'progress_fraction': 0.5,
        'created_at': 1710010000,
        'updated_at': 1710010500,
      });

      await v2Db.insert('offline_deletion_tombstones', {
        'tombstone_id': 'tombstone-77',
        'user_id': 'user-phase5d',
        'chapter_version_id': 'v-chapter-3',
        'created_at': 1710020000,
      });

      // Đóng DB v2
      await v2Db.close();

      // 3. Mở lại thông qua OfflineDatabase (kích hoạt upgrade lên v3)
      final offlineDb = OfflineDatabase();
      final migratedDb = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      // 4. Kiểm tra Database Version
      final currentVersion = await migratedDb.getVersion();
      expect(currentVersion, greaterThanOrEqualTo(3), reason: 'Database version must be upgraded to at least 3');

      // 5. Invariant 1: Toàn bộ dữ liệu v2 còn nguyên vẹn 100%
      final chapters = await migratedDb.query('offline_chapters');
      expect(chapters.length, 1);
      expect(chapters.first['chapter_version_id'], 'v-chapter-1');
      expect(chapters.first['user_id'], 'user-phase5d');
      expect(chapters.first['is_pinned'], 1);

      final tasks = await migratedDb.query('download_tasks');
      expect(tasks.length, 1);
      expect(tasks.first['task_id'], 'task-download-99');
      expect(tasks.first['status'], 'DOWNLOADING');

      final tombstones = await migratedDb.query('offline_deletion_tombstones');
      expect(tombstones.length, 1);
      expect(tombstones.first['tombstone_id'], 'tombstone-77');

      // 6. Invariant 2: Ba bảng Local Library mới tồn tại và ban đầu rỗng
      final initialBookmarks = await migratedDb.query('local_library_bookmarks');
      expect(initialBookmarks, isEmpty);

      final initialProgress = await migratedDb.query('local_reading_progress');
      expect(initialProgress, isEmpty);

      final initialHistory = await migratedDb.query('local_reading_history');
      expect(initialHistory, isEmpty);

      // 7. Invariant 3: Thao tác CRUD hợp lệ trên 3 bảng Local Library mới
      await migratedDb.insert('local_library_bookmarks', {
        'owner_scope': 'guest:profile-001',
        'story_id': 'story-alpha',
        'title': 'Alpha Novel',
        'slug': 'alpha-novel',
        'cover_url': 'https://example.com/cover.jpg',
        'created_at': 1710030000,
      });

      await migratedDb.insert('local_reading_progress', {
        'owner_scope': 'guest:profile-001',
        'story_id': 'story-alpha',
        'chapter_id': 'chapter-01',
        'chapter_version_id': 'ver-01',
        'reading_mode': 'WEBTOON',
        'progress_percentage': 85.5,
        'scroll_position': 1420.0,
        'page_index': 1,
        'anchor_block_id': null,
        'text_offset': null,
        'updated_at': 1710030500,
        'device_timestamp': 1710030500000,
      });

      await migratedDb.insert('local_reading_history', {
        'owner_scope': 'guest:profile-001',
        'story_id': 'story-alpha',
        'chapter_id': 'chapter-01',
        'chapter_version_id': 'ver-01',
        'story_title': 'Alpha Novel',
        'story_slug': 'alpha-novel',
        'story_cover_url': 'https://example.com/cover.jpg',
        'chapter_number': '1',
        'chapter_title': 'The Beginning',
        'progress_percentage': 85.5,
        'last_read_at': 1710030500,
      });

      final queryBookmarks = await migratedDb.query(
        'local_library_bookmarks',
        where: 'owner_scope = ?',
        whereArgs: ['guest:profile-001'],
      );
      expect(queryBookmarks.length, 1);
      expect(queryBookmarks.first['title'], 'Alpha Novel');

      final queryProgress = await migratedDb.query(
        'local_reading_progress',
        where: 'owner_scope = ? AND story_id = ?',
        whereArgs: ['guest:profile-001', 'story-alpha'],
      );
      expect(queryProgress.length, 1);
      expect(queryProgress.first['progress_percentage'], 85.5);

      final queryHistory = await migratedDb.query(
        'local_reading_history',
        where: 'owner_scope = ?',
        whereArgs: ['guest:profile-001'],
      );
      expect(queryHistory.length, 1);
      expect(queryHistory.first['chapter_title'], 'The Beginning');

      // 8. Invariant 4: Vi phạm Composite Primary Key sẽ bị chặn bởi SQLite
      expect(
        () async => await migratedDb.insert('local_library_bookmarks', {
          'owner_scope': 'guest:profile-001',
          'story_id': 'story-alpha', // Trùng composite key (owner_scope, story_id)
          'title': 'Duplicate',
          'created_at': 1710040000,
        }),
        throwsA(isA<DatabaseException>()),
      );

      // Đóng kết nối
      await offlineDb.close();
    });
  });
}
