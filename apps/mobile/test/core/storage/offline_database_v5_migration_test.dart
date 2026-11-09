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
    tempDir = await Directory.systemTemp.createTemp('omninovel_v5_mig_test_');
    dbPath = p.join(tempDir.path, 'migration_v5_test.db');
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

  group('Phase 7C.4 Stage 1 — SQLite v5 Migration & Additive Schema', () {
    test('fresh v5 install provisions all 14 tables, indexes, pragmas, and SQLite CHECK/UNIQUE constraints', () async {
      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      expect(await db.getVersion(), OfflineDatabase.databaseVersion);
      expect(OfflineDatabase.databaseVersion, 5);

      // Verify pragmas on file-backed DB
      final fkRows = await db.rawQuery('PRAGMA foreign_keys;');
      expect(fkRows.first['foreign_keys'], 1);

      final busyRows = await db.rawQuery('PRAGMA busy_timeout;');
      expect(busyRows.first.values.first, 5000);

      final walRows = await db.rawQuery('PRAGMA journal_mode;');
      expect(walRows.first['journal_mode'].toString().toLowerCase(), 'wal');

      // Verify all 14 tables exist
      final tableRows = await db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;",
      );
      final tableNames = tableRows.map((r) => r['name'] as String).toSet();

      expect(
        tableNames,
        containsAll(<String>{
          // v2
          'offline_chapters',
          'download_tasks',
          'offline_deletion_tombstones',
          // v3
          'local_library_bookmarks',
          'local_reading_progress',
          'local_reading_history',
          // v4
          'guest_claim_recovery_journal',
          // v5
          'sync_meta',
          'sync_mutation_sequences',
          'sync_authoritative_replicas',
          'pending_mutations',
          'quarantined_mutations',
          'snapshot_staging_store',
          'local_preferences',
        }),
      );

      // Verify v5 indexes exist
      final indexRows = await db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%';",
      );
      final indexNames = indexRows.map((r) => r['name'] as String).toSet();
      expect(
        indexNames,
        containsAll(<String>{
          'idx_sync_replicas_scope_domain',
          'idx_sync_replicas_scope_rev',
          'idx_pending_mutations_scope_fifo',
          'idx_quarantined_mutations_scope_rejected',
          'idx_snapshot_staging_scope_session',
        }),
      );

      // Verify CHECK constraint on sync_meta.authoritative_baseline_status
      await expectLater(
        () => db.insert('sync_meta', <String, Object?>{
          'owner_scope': 'account:u1',
          'last_sync_timestamp': '2026-01-01T00:00:00.000Z',
          'authoritative_baseline_status': 'INVALID_STATUS',
        }),
        throwsA(isA<DatabaseException>()),
      );

      // Verify CHECK constraint on quarantined_mutations.triage_status
      await expectLater(
        () => db.insert('quarantined_mutations', <String, Object?>{
          'owner_scope': 'account:u1',
          'mutation_id': 'mut-1',
          'client_id': 'cli-1',
          'domain': 'BOOKMARK',
          'entity_id': 'story-1',
          'operation': 'UPSERT',
          'base_server_revision': '0',
          'payload_json': '{}',
          'original_created_at_iso': '2026-01-01T00:00:00.000Z',
          'original_created_at_ms': 1000,
          'rejection_reason': 'test',
          'rejected_at_iso': '2026-01-01T00:00:01.000Z',
          'rejected_at_ms': 2000,
          'triage_status': 'BOGUS_TRIAGE',
        }),
        throwsA(isA<DatabaseException>()),
      );

      // Verify UNIQUE(owner_scope, sequence_no) on pending_mutations
      await db.insert('pending_mutations', <String, Object?>{
        'owner_scope': 'account:u1',
        'mutation_id': 'mut-seq-1',
        'sequence_no': 1,
        'client_id': 'cli-1',
        'domain': 'BOOKMARK',
        'entity_id': 'story-1',
        'operation': 'UPSERT',
        'base_server_revision': '0',
        'payload_json': '{}',
        'created_at_iso': '2026-01-01T00:00:00.000Z',
        'created_at_ms': 1000,
      });

      await expectLater(
        () => db.insert('pending_mutations', <String, Object?>{
          'owner_scope': 'account:u1',
          'mutation_id': 'mut-seq-2',
          'sequence_no': 1, // Duplicate sequence_no for same owner_scope!
          'client_id': 'cli-1',
          'domain': 'BOOKMARK',
          'entity_id': 'story-2',
          'operation': 'UPSERT',
          'base_server_revision': '0',
          'payload_json': '{}',
          'created_at_iso': '2026-01-01T00:00:00.000Z',
          'created_at_ms': 1001,
        }),
        throwsA(isA<DatabaseException>()),
      );

      await offlineDb.close();
    });

    test('safely initializes in :memory: without throwing WAL pragma errors', () async {
      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: inMemoryDatabasePath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );

      expect(await db.getVersion(), 5);
      final rows = await db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta';",
      );
      expect(rows, hasLength(1));

      await offlineDb.close();
    });

    test('upgrades v4 -> v5 preserving 100% of all 7 prior tables row-for-row', () async {
      final v4Db = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 4,
          onCreate: (db, version) async {
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
            await db.execute('''
              CREATE TABLE guest_claim_recovery_journal (
                claim_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                guest_profile_id TEXT NOT NULL,
                expected_state_fingerprint TEXT NOT NULL,
                conflict_decisions TEXT NOT NULL,
                phase TEXT NOT NULL,
                preview_data TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
              );
            ''');
          },
        ),
      );

      await v4Db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-1',
        'user_id': 'user-42',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Omniscient Reader',
        'chapter_number': '10',
        'media_format': 'NOVEL',
        'installed_dir': '/offline/user-42/cv-1',
        'total_files': 3,
        'total_bytes': 4096,
        'installed_at': 1700000100,
        'manifest_json': '{"v":1}',
        'is_pinned': 1,
      });

      await v4Db.insert('download_tasks', <String, Object?>{
        'task_id': 'dt-1',
        'user_id': 'user-42',
        'chapter_version_id': 'cv-2',
        'chapter_id': 'c-2',
        'story_id': 's-1',
        'story_title': 'Omniscient Reader',
        'chapter_number': '11',
        'media_format': 'NOVEL',
        'status': 'PAUSED',
        'created_at': 1700000200,
        'updated_at': 1700000250,
      });

      await v4Db.insert('offline_deletion_tombstones', <String, Object?>{
        'tombstone_id': 'tb-1',
        'user_id': 'user-42',
        'chapter_version_id': 'cv-0',
        'created_at': 1700000050,
      });

      await v4Db.insert('local_library_bookmarks', <String, Object?>{
        'owner_scope': 'guest:g-42',
        'story_id': 's-1',
        'title': 'Omniscient Reader',
        'slug': 'orv',
        'cover_url': 'https://cdn.example/orv.webp',
        'created_at': 1700000300,
      });

      await v4Db.insert('local_reading_progress', <String, Object?>{
        'owner_scope': 'guest:g-42',
        'story_id': 's-1',
        'chapter_id': 'c-10',
        'chapter_version_id': 'cv-10',
        'reading_mode': 'MANGA_PAGED',
        'progress_percentage': 62.5,
        'scroll_position': 0.0,
        'page_index': 12,
        'anchor_block_id': 'p_4',
        'text_offset': 88,
        'updated_at': 1700000400,
        'device_timestamp': 1700000450,
      });

      await v4Db.insert('local_reading_history', <String, Object?>{
        'owner_scope': 'guest:g-42',
        'story_id': 's-1',
        'chapter_id': 'c-10',
        'chapter_version_id': 'cv-10',
        'story_title': 'Omniscient Reader',
        'story_slug': 'orv',
        'story_cover_url': 'https://cdn.example/orv.webp',
        'chapter_number': '10',
        'chapter_title': 'Prologue',
        'progress_percentage': 90.0,
        'last_read_at': 1700000400,
      });

      await v4Db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'claim-v4-1',
        'user_id': 'user-42',
        'guest_profile_id': 'g-42',
        'expected_state_fingerprint': 'fp-hash-v4',
        'conflict_decisions': '{"s-1":"USE_GUEST"}',
        'phase': 'committedServer',
        'preview_data': '{"count":1}',
        'created_at': 1700000500,
        'updated_at': 1700000600,
      });

      await v4Db.close();

      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      expect(await db.getVersion(), 5);

      // Assert 100% row-for-row preservation of all 7 prior tables
      final chapters = await db.query('offline_chapters');
      expect(chapters, hasLength(1));
      expect(chapters.first['chapter_version_id'], 'cv-1');
      expect(chapters.first['is_pinned'], 1);

      final tasks = await db.query('download_tasks');
      expect(tasks, hasLength(1));
      expect(tasks.first['status'], 'PAUSED');

      final tombstones = await db.query('offline_deletion_tombstones');
      expect(tombstones, hasLength(1));
      expect(tombstones.first['tombstone_id'], 'tb-1');

      final bookmarks = await db.query('local_library_bookmarks');
      expect(bookmarks, hasLength(1));
      expect(bookmarks.first['owner_scope'], 'guest:g-42');
      expect(bookmarks.first['title'], 'Omniscient Reader');

      final progress = await db.query('local_reading_progress');
      expect(progress, hasLength(1));
      expect(progress.first['reading_mode'], 'MANGA_PAGED');
      expect(progress.first['page_index'], 12);
      expect(progress.first['anchor_block_id'], 'p_4');
      expect(progress.first['text_offset'], 88);

      final history = await db.query('local_reading_history');
      expect(history, hasLength(1));
      expect(history.first['progress_percentage'], 90.0);

      final journal = await db.query('guest_claim_recovery_journal');
      expect(journal, hasLength(1));
      expect(journal.first['claim_id'], 'claim-v4-1');
      expect(journal.first['phase'], 'committedServer');

      // Assert new v5 tables exist and operate normally
      expect(await db.query('sync_meta'), isEmpty);
      expect(await db.query('sync_mutation_sequences'), isEmpty);
      expect(await db.query('sync_authoritative_replicas'), isEmpty);
      expect(await db.query('pending_mutations'), isEmpty);
      expect(await db.query('quarantined_mutations'), isEmpty);
      expect(await db.query('snapshot_staging_store'), isEmpty);
      expect(await db.query('local_preferences'), isEmpty);

      await offlineDb.close();
    });

    test('upgrades directly v3 -> v5 preserving 6 prior tables while adding recovery journal and v5 sync tables', () async {
      final v3Db = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 3,
          onCreate: (db, version) async {
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

      await v3Db.insert('local_library_bookmarks', <String, Object?>{
        'owner_scope': 'guest:v3-preserve',
        'story_id': 'story-v3',
        'title': 'V3 Story',
        'created_at': 1700000000,
      });
      await v3Db.close();

      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      expect(await db.getVersion(), 5);
      final bm = await db.query('local_library_bookmarks');
      expect(bm, hasLength(1));
      expect(bm.first['story_id'], 'story-v3');
      expect(await db.query('guest_claim_recovery_journal'), isEmpty);
      expect(await db.query('sync_meta'), isEmpty);

      await offlineDb.close();
    });
  });
}
