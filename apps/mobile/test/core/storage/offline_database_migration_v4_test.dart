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
    tempDir = await Directory.systemTemp.createTemp('omninovel_v4_migration_test_');
    dbPath = p.join(tempDir.path, 'migration_v4_test.db');
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

  group('Task 1: OfflineDatabase v3 -> v4 Migration Invariants', () {
    test('preserves 100% v3 data across 6 tables and provisions 9-column guest_claim_recovery_journal', () async {
      // 1. Khởi tạo một SQLite database ở schema v3 với đầy đủ 6 bảng
      final v3Db = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 3,
          onConfigure: (db) async {
            await db.execute('PRAGMA foreign_keys = ON;');
          },
          onCreate: (db, version) async {
            // 3 bảng v2 (Offline Content & Download)
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

            // 3 bảng v3 (Local Library & Reading Progress)
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

      // 2. Chèn dữ liệu mẫu vào cả 6 bảng v3
      await v3Db.insert('offline_chapters', {
        'chapter_version_id': 'v-chapter-1',
        'user_id': 'user-100',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Solo Leveling',
        'chapter_number': '1',
        'media_format': 'MANGA',
        'installed_dir': '/files/offline/user-100/v-chapter-1',
        'total_files': 20,
        'total_bytes': 15000000,
        'installed_at': 1710000000,
        'manifest_json': '{"version":1}',
        'is_pinned': 1,
      });

      await v3Db.insert('download_tasks', {
        'task_id': 'task-99',
        'user_id': 'user-100',
        'chapter_version_id': 'v-chapter-2',
        'chapter_id': 'c-2',
        'story_id': 's-1',
        'story_title': 'Solo Leveling',
        'chapter_number': '2',
        'media_format': 'MANGA',
        'status': 'DOWNLOADING',
        'downloaded_bytes': 500000,
        'total_bytes': 1000000,
        'progress_fraction': 0.5,
        'created_at': 1710010000,
        'updated_at': 1710010500,
      });

      await v3Db.insert('offline_deletion_tombstones', {
        'tombstone_id': 'tombstone-77',
        'user_id': 'user-100',
        'chapter_version_id': 'v-chapter-3',
        'created_at': 1710020000,
      });

      await v3Db.insert('local_library_bookmarks', {
        'owner_scope': 'guest:g-profile-1',
        'story_id': 'story-omega',
        'title': 'Omega Quest',
        'slug': 'omega-quest',
        'cover_url': 'https://cdn.example.com/cover.jpg',
        'created_at': 1710030000,
      });

      await v3Db.insert('local_reading_progress', {
        'owner_scope': 'guest:g-profile-1',
        'story_id': 'story-omega',
        'chapter_id': 'chapter-10',
        'chapter_version_id': 'ver-10',
        'reading_mode': 'PAGED',
        'progress_percentage': 85.5,
        'scroll_position': 0.0,
        'page_index': 17,
        'anchor_block_id': null,
        'text_offset': null,
        'updated_at': 1710035000,
        'device_timestamp': 1710035000,
      });

      await v3Db.insert('local_reading_history', {
        'owner_scope': 'guest:g-profile-1',
        'story_id': 'story-omega',
        'chapter_id': 'chapter-10',
        'chapter_version_id': 'ver-10',
        'story_title': 'Omega Quest',
        'story_slug': 'omega-quest',
        'story_cover_url': 'https://cdn.example.com/cover.jpg',
        'chapter_number': '10',
        'chapter_title': 'The Final Gate',
        'progress_percentage': 85.5,
        'last_read_at': 1710035000,
      });

      // Đóng DB v3
      await v3Db.close();

      // 3. Mở lại thông qua OfflineDatabase (kích hoạt upgrade lên schema mới nhất)
      final offlineDb = OfflineDatabase();
      final migratedDb = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      // 4. Invariant 1: Database Version phải được nâng lên phiên bản hiện hành (additive v5 progression)
      final currentVersion = await migratedDb.getVersion();
      expect(
        currentVersion,
        OfflineDatabase.databaseVersion,
        reason:
            'Database version must be upgraded to ${OfflineDatabase.databaseVersion} (additive v5 progression)',
      );

      // 5. Invariant 2: Toàn bộ dữ liệu của cả 6 bảng v3 còn nguyên vẹn 100%
      final chapters = await migratedDb.query('offline_chapters');
      expect(chapters.length, 1);
      expect(chapters.first['chapter_version_id'], 'v-chapter-1');
      expect(chapters.first['is_pinned'], 1);

      final tasks = await migratedDb.query('download_tasks');
      expect(tasks.length, 1);
      expect(tasks.first['task_id'], 'task-99');

      final tombstones = await migratedDb.query('offline_deletion_tombstones');
      expect(tombstones.length, 1);
      expect(tombstones.first['tombstone_id'], 'tombstone-77');

      final bookmarks = await migratedDb.query('local_library_bookmarks');
      expect(bookmarks.length, 1);
      expect(bookmarks.first['story_id'], 'story-omega');

      final progress = await migratedDb.query('local_reading_progress');
      expect(progress.length, 1);
      expect(progress.first['page_index'], 17);
      expect(progress.first['device_timestamp'], 1710035000);

      final history = await migratedDb.query('local_reading_history');
      expect(history.length, 1);
      expect(history.first['chapter_number'], '10');

      // 6. Invariant 3: Bảng guest_claim_recovery_journal được tạo với đúng 9 cột và ban đầu rỗng
      final initialJournal = await migratedDb.query('guest_claim_recovery_journal');
      expect(initialJournal, isEmpty);

      // 7. Invariant 4: Thử insert và query đủ 9 cột trên bảng mới
      await migratedDb.insert('guest_claim_recovery_journal', {
        'claim_id': 'claim-1234',
        'user_id': 'user-100',
        'guest_profile_id': 'guest-profile-1',
        'expected_state_fingerprint': 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        'conflict_decisions': '{"story-omega":"KEEP_CLOUD"}',
        'phase': 'prepared',
        'preview_data': '{"bookmarksToImport":1}',
        'created_at': 1710040000,
        'updated_at': 1710040000,
      });

      final journalRows = await migratedDb.query('guest_claim_recovery_journal');
      expect(journalRows.length, 1);
      final row = journalRows.first;
      expect(row['claim_id'], 'claim-1234');
      expect(row['user_id'], 'user-100');
      expect(row['guest_profile_id'], 'guest-profile-1');
      expect(row['expected_state_fingerprint'], 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
      expect(row['conflict_decisions'], '{"story-omega":"KEEP_CLOUD"}');
      expect(row['phase'], 'prepared');
      expect(row['preview_data'], '{"bookmarksToImport":1}');
      expect(row['created_at'], 1710040000);
      expect(row['updated_at'], 1710040000);

      await migratedDb.close();
    });
  });
}
