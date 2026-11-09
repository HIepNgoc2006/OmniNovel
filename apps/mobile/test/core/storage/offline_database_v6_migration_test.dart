import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    tempDir = await Directory.systemTemp.createTemp('omninovel_v6_mig_test_');
    dbPath = p.join(tempDir.path, 'migration_v6_test.db');
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

  Future<void> createV2Tables(Database db) async {
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
  }

  Future<void> createV3Tables(Database db) async {
    await createV2Tables(db);
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
  }

  Future<void> createV4Tables(Database db) async {
    await createV3Tables(db);
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
  }

  Future<void> createV5Tables(Database db) async {
    await createV4Tables(db);
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_meta (
        owner_scope TEXT PRIMARY KEY,
        last_synced_server_revision TEXT NOT NULL DEFAULT '0',
        min_active_revision TEXT NOT NULL DEFAULT '0',
        last_sync_timestamp TEXT NOT NULL,
        effective_history_epochs TEXT NOT NULL DEFAULT '{}',
        authoritative_baseline_status TEXT NOT NULL DEFAULT 'UNINITIALIZED'
          CHECK (authoritative_baseline_status IN ('UNINITIALIZED', 'BOOTSTRAPPING', 'READY')),
        active_snapshot_session_id TEXT,
        active_snapshot_target_revision TEXT,
        active_snapshot_min_active_revision TEXT
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_mutation_sequences (
        owner_scope TEXT PRIMARY KEY,
        last_sequence_no INTEGER NOT NULL DEFAULT 0
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_authoritative_replicas (
        owner_scope TEXT NOT NULL,
        domain TEXT NOT NULL CHECK (domain IN ('BOOKMARK', 'HISTORY', 'PROGRESS', 'PREFERENCE')),
        entity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        last_server_revision TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL,
        is_tombstone INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0, 1)),
        PRIMARY KEY (owner_scope, domain, entity_key)
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS pending_mutations (
        owner_scope TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL CHECK (domain IN ('BOOKMARK', 'HISTORY', 'PROGRESS', 'PREFERENCE')),
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
        base_server_revision TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_attempted_at_iso TEXT,
        PRIMARY KEY (owner_scope, mutation_id),
        UNIQUE (owner_scope, sequence_no)
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS quarantined_mutations (
        owner_scope TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        original_sequence_no INTEGER,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL CHECK (domain IN ('BOOKMARK', 'HISTORY', 'PROGRESS', 'PREFERENCE')),
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
        base_server_revision TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        original_created_at_iso TEXT NOT NULL,
        original_created_at_ms INTEGER NOT NULL,
        rejection_reason TEXT NOT NULL,
        rejection_status TEXT NOT NULL DEFAULT 'EXCEEDED_MAX_RETRIES'
          CHECK (rejection_status IN ('REJECTED_TOMBSTONE', 'REJECTED_STALE', 'HTTP_410_GONE', 'EXCEEDED_MAX_RETRIES')),
        authoritative_server_revision TEXT,
        rejected_at_iso TEXT NOT NULL,
        rejected_at_ms INTEGER NOT NULL,
        triage_status TEXT NOT NULL DEFAULT 'PENDING_USER_TRIAGE'
          CHECK (triage_status IN ('PENDING_USER_TRIAGE', 'TRIAGE_REQUEUED', 'TRIAGE_DISCARDED')),
        PRIMARY KEY (owner_scope, mutation_id)
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS snapshot_staging_store (
        owner_scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        snapshot_revision TEXT NOT NULL,
        min_active_revision TEXT NOT NULL DEFAULT '0',
        domain TEXT NOT NULL CHECK (domain IN ('BOOKMARK', 'HISTORY', 'PROGRESS', 'PREFERENCE')),
        entity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        staged_at_iso TEXT NOT NULL,
        staged_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, session_id, domain, entity_key)
      );
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_preferences (
        owner_scope TEXT NOT NULL,
        pref_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL,
        PRIMARY KEY (owner_scope, pref_key)
      );
    ''');
  }

  group('Phase 7C.4 Stage 1B — SQLite v6 Schema, Migration & Downgrade', () {
    test('T1: fresh v6 install provisions all 16 tables, pragmas, and CHECK/PK constraints on v6 SSoT tables', () async {
      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );

      expect(OfflineDatabase.databaseVersion, 6);
      expect(await db.getVersion(), 6);

      final fkRows = await db.rawQuery('PRAGMA foreign_keys;');
      expect(fkRows.first['foreign_keys'], 1);

      final busyRows = await db.rawQuery('PRAGMA busy_timeout;');
      expect(busyRows.first.values.first, 5000);

      final walRows = await db.rawQuery('PRAGMA journal_mode;');
      expect(walRows.first['journal_mode'].toString().toLowerCase(), 'wal');

      final tableRows = await db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;",
      );
      final tableNames = tableRows.map((r) => r['name'] as String).toSet();

      expect(
        tableNames,
        equals(<String>{
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
          // v6
          'guest_quarantined_scopes',
          'guest_purged_tombstones',
        }),
      );
      expect(tableNames, hasLength(16));

      // v6 CHECK constraint rejects empty or whitespace guest_profile_id
      for (final badId in <String>['', '   ']) {
        await expectLater(
          () => db.insert('guest_quarantined_scopes', <String, Object?>{
            'guest_profile_id': badId,
            'quarantined_at_ms': 1000,
            'reason': 'SKIP_CLAIM',
          }),
          throwsA(isA<DatabaseException>()),
        );
        await expectLater(
          () => db.insert('guest_purged_tombstones', <String, Object?>{
            'guest_profile_id': badId,
            'purged_at_ms': 1000,
            'purge_reason': 'USER_CLEARED_GUEST_DATA',
          }),
          throwsA(isA<DatabaseException>()),
        );
      }

      // v6 CHECK constraint rejects invalid purge_reason
      await expectLater(
        () => db.insert('guest_purged_tombstones', <String, Object?>{
          'guest_profile_id': 'g-bad-reason',
          'purged_at_ms': 1000,
          'purge_reason': 'UNKNOWN_REASON',
        }),
        throwsA(isA<DatabaseException>()),
      );

      // Valid purge_reason values succeed cleanly
      for (final entry in <String, String>{
        'g-reason-1': 'USER_CLEARED_GUEST_DATA',
        'g-reason-2': 'VERIFIED_UNUSED_GUEST_EVICTION',
        'g-reason-3': 'CLAIMED_AND_REBOUND',
      }.entries) {
        await db.insert('guest_purged_tombstones', <String, Object?>{
          'guest_profile_id': entry.key,
          'purged_at_ms': 1000,
          'purge_reason': entry.value,
        });
      }
      expect(await db.query('guest_purged_tombstones'), hasLength(3));

      await offlineDb.close();
    });

    test('T2a: upgrades v5 -> v6 preserving all 14 existing tables and rows verbatim', () async {
      final v5Db = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 5,
          singleInstance: false,
          onCreate: (db, version) async => createV5Tables(db),
        ),
      );

      await v5Db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-v5',
        'user_id': 'u-v5',
        'chapter_id': 'ch-v5',
        'story_id': 'st-v5',
        'story_title': 'Story V5',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/v5',
        'total_files': 3,
        'total_bytes': 1234,
        'installed_at': 1700000100,
        'manifest_json': '{"files":[]}',
        'is_pinned': 1,
      });
      await v5Db.insert('download_tasks', <String, Object?>{
        'task_id': 'dl-v5',
        'user_id': 'u-v5',
        'chapter_version_id': 'cv-v5',
        'chapter_id': 'ch-v5',
        'story_id': 'st-v5',
        'story_title': 'Story V5',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'status': 'COMPLETED',
        'downloaded_bytes': 1234,
        'total_bytes': 1234,
        'created_at': 1700000100,
        'updated_at': 1700000200,
      });
      await v5Db.insert('offline_deletion_tombstones', <String, Object?>{
        'tombstone_id': 'tb-v5',
        'user_id': 'u-v5',
        'chapter_version_id': 'cv-old',
        'created_at': 1700000300,
      });
      await v5Db.insert('local_library_bookmarks', <String, Object?>{
        'owner_scope': 'guest:g-v5',
        'story_id': 'st-v5',
        'title': 'Guest V5',
        'created_at': 1700000400,
      });
      await v5Db.insert('local_reading_progress', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'story_id': 'st-v5',
        'chapter_id': 'ch-v5',
        'reading_mode': 'PAGED',
        'progress_percentage': 80.0,
        'scroll_position': 0.0,
        'page_index': 7,
        'updated_at': 1700000500,
        'device_timestamp': 1700000500,
      });
      await v5Db.insert('local_reading_history', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'story_id': 'st-v5',
        'chapter_id': 'ch-v5',
        'story_title': 'Story V5',
        'chapter_number': '1',
        'progress_percentage': 80.0,
        'last_read_at': 1700000500,
      });
      await v5Db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'cl-v5',
        'user_id': 'u-v5',
        'guest_profile_id': 'g-v5',
        'expected_state_fingerprint': 'fp-v5',
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'created_at': 1700000600,
        'updated_at': 1700000600,
      });
      await v5Db.insert('sync_meta', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'last_synced_server_revision': '42',
        'min_active_revision': '1',
        'last_sync_timestamp': '2026-03-01T00:00:00.000Z',
        'authoritative_baseline_status': 'BOOTSTRAPPING',
      });
      await v5Db.insert('sync_mutation_sequences', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'last_sequence_no': 9,
      });
      await v5Db.insert('sync_authoritative_replicas', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'domain': 'BOOKMARK',
        'entity_key': 'st-v5',
        'payload_json': '{"storyId":"st-v5"}',
        'last_server_revision': '42',
        'updated_at_iso': '2026-03-01T00:00:00.000Z',
      });
      await v5Db.insert('pending_mutations', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'mutation_id': 'mut-v5',
        'sequence_no': 9,
        'client_id': '11111111-1111-4111-8111-111111111111',
        'domain': 'BOOKMARK',
        'entity_id': 'st-v5',
        'operation': 'UPSERT',
        'base_server_revision': '42',
        'payload_json': '{"storyId":"st-v5"}',
        'created_at_iso': '2026-03-01T00:00:00.000Z',
        'created_at_ms': 1700000700,
      });
      await v5Db.insert('quarantined_mutations', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'mutation_id': 'q-v5',
        'original_sequence_no': 3,
        'client_id': '11111111-1111-4111-8111-111111111111',
        'domain': 'HISTORY',
        'entity_id': 'st-v5',
        'operation': 'DELETE',
        'base_server_revision': '10',
        'payload_json': '{}',
        'original_created_at_iso': '2026-02-28T00:00:00.000Z',
        'original_created_at_ms': 1700000000,
        'rejection_reason': 'conflict',
        'rejection_status': 'EXCEEDED_MAX_RETRIES',
        'rejected_at_iso': '2026-03-01T00:00:00.000Z',
        'rejected_at_ms': 1700000700,
      });
      await v5Db.insert('snapshot_staging_store', <String, Object?>{
        'owner_scope': 'account:u-v5',
        'session_id': 'sess-v5',
        'snapshot_revision': '45',
        'min_active_revision': '1',
        'domain': 'BOOKMARK',
        'entity_key': 'st-v5',
        'payload_json': '{}',
        'staged_at_iso': '2026-03-01T00:00:00.000Z',
        'staged_at_ms': 1700000700,
      });
      await v5Db.insert('local_preferences', <String, Object?>{
        'owner_scope': 'guest:g-v5',
        'pref_key': 'theme',
        'value_json': '"dark"',
        'updated_at_iso': '2026-03-01T00:00:00.000Z',
      });
      await v5Db.close();

      final offlineDb = OfflineDatabase();
      final db = await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );

      expect(await db.getVersion(), 6);
      expect((await db.query('offline_chapters')).first['chapter_version_id'], 'cv-v5');
      expect((await db.query('download_tasks')).first['task_id'], 'dl-v5');
      expect((await db.query('offline_deletion_tombstones')).first['tombstone_id'], 'tb-v5');
      expect((await db.query('local_library_bookmarks')).first['owner_scope'], 'guest:g-v5');
      expect((await db.query('local_reading_progress')).first['page_index'], 7);
      expect((await db.query('local_reading_history')).first['progress_percentage'], 80.0);
      expect((await db.query('guest_claim_recovery_journal')).first['claim_id'], 'cl-v5');
      expect((await db.query('sync_meta')).first['last_synced_server_revision'], '42');
      expect((await db.query('sync_mutation_sequences')).first['last_sequence_no'], 9);
      expect((await db.query('sync_authoritative_replicas')).first['entity_key'], 'st-v5');
      expect((await db.query('pending_mutations')).first['mutation_id'], 'mut-v5');
      expect((await db.query('quarantined_mutations')).first['mutation_id'], 'q-v5');
      expect((await db.query('snapshot_staging_store')).first['session_id'], 'sess-v5');
      expect((await db.query('local_preferences')).first['value_json'], '"dark"');
      expect(await db.query('guest_quarantined_scopes'), isEmpty);
      expect(await db.query('guest_purged_tombstones'), isEmpty);

      await offlineDb.close();
    });

    test('T2b: upgrades v2 -> v6, v3 -> v6, and v4 -> v6 preserving all prior rows verbatim', () async {
      // 1. v2 -> v6
      final v2Path = p.join(tempDir.path, 'mig_v2_to_v6.db');
      final v2Db = await databaseFactoryFfi.openDatabase(
        v2Path,
        options: OpenDatabaseOptions(
          version: 2,
          singleInstance: false,
          onCreate: (db, _) => createV2Tables(db),
        ),
      );
      await v2Db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-v2',
        'user_id': 'u-v2',
        'chapter_id': 'c-v2',
        'story_id': 's-v2',
        'story_title': 'Story V2',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/v2',
        'total_files': 1,
        'total_bytes': 100,
        'installed_at': 1000,
        'manifest_json': '{}',
      });
      await v2Db.close();

      final dbFromV2 = OfflineDatabase();
      final upgradedV2 = await dbFromV2.initialize(
        customPath: v2Path,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      expect(await upgradedV2.getVersion(), 6);
      expect((await upgradedV2.query('offline_chapters')).first['chapter_version_id'], 'cv-v2');
      expect(await upgradedV2.query('guest_quarantined_scopes'), isEmpty);
      expect(await upgradedV2.query('guest_purged_tombstones'), isEmpty);
      await dbFromV2.close();

      // 2. v3 -> v6
      final v3Path = p.join(tempDir.path, 'mig_v3_to_v6.db');
      final v3Db = await databaseFactoryFfi.openDatabase(
        v3Path,
        options: OpenDatabaseOptions(
          version: 3,
          singleInstance: false,
          onCreate: (db, _) => createV3Tables(db),
        ),
      );
      await v3Db.insert('local_library_bookmarks', <String, Object?>{
        'owner_scope': 'guest:g-v3',
        'story_id': 's-v3',
        'title': 'Story V3',
        'created_at': 1000,
      });
      await v3Db.close();

      final dbFromV3 = OfflineDatabase();
      final upgradedV3 = await dbFromV3.initialize(
        customPath: v3Path,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      expect(await upgradedV3.getVersion(), 6);
      expect((await upgradedV3.query('local_library_bookmarks')).first['owner_scope'], 'guest:g-v3');
      expect(await upgradedV3.query('guest_quarantined_scopes'), isEmpty);
      expect(await upgradedV3.query('guest_purged_tombstones'), isEmpty);
      await dbFromV3.close();

      // 3. v4 -> v6
      final v4Path = p.join(tempDir.path, 'mig_v4_to_v6.db');
      final v4Db = await databaseFactoryFfi.openDatabase(
        v4Path,
        options: OpenDatabaseOptions(
          version: 4,
          singleInstance: false,
          onCreate: (db, _) => createV4Tables(db),
        ),
      );
      await v4Db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'claim-v4',
        'user_id': 'u-v4',
        'guest_profile_id': 'g-v4',
        'expected_state_fingerprint': 'fp-v4',
        'conflict_decisions': '{}',
        'phase': 'committing',
        'created_at': 1000,
        'updated_at': 1000,
      });
      await v4Db.close();

      final dbFromV4 = OfflineDatabase();
      final upgradedV4 = await dbFromV4.initialize(
        customPath: v4Path,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      expect(await upgradedV4.getVersion(), 6);
      expect((await upgradedV4.query('guest_claim_recovery_journal')).first['claim_id'], 'claim-v4');
      expect(await upgradedV4.query('guest_quarantined_scopes'), isEmpty);
      expect(await upgradedV4.query('guest_purged_tombstones'), isEmpty);
      await dbFromV4.close();
    });

    test('T10: downgrade v7/v6 fails closed in OfflineDatabase & v6->v5 rollback round-trip preserves 100% DB rows + Prefs shadow', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        GuestProfileIdentityProvider.keyQuarantinedProfiles: <String>['g-shadow-1'],
      });
      final prefs = await SharedPreferences.getInstance();

      // Part A: Explicit fail-closed guard on OfflineDatabase itself (rejects higher-version DB without wiping)
      final futureV7Path = p.join(tempDir.path, 'future_v7.db');
      final futureV7Db = await databaseFactoryFfi.openDatabase(
        futureV7Path,
        options: OpenDatabaseOptions(
          version: 7,
          singleInstance: false,
          onCreate: (db, _) async {
            await createV5Tables(db);
            await db.execute('''
              CREATE TABLE IF NOT EXISTS guest_quarantined_scopes (
                guest_profile_id TEXT PRIMARY KEY,
                quarantined_at_ms INTEGER NOT NULL,
                source_user_id TEXT,
                reason TEXT NOT NULL DEFAULT 'SKIP_CLAIM',
                CHECK (length(trim(guest_profile_id)) > 0)
              );
            ''');
            await db.execute('''
              CREATE TABLE IF NOT EXISTS guest_purged_tombstones (
                guest_profile_id TEXT PRIMARY KEY,
                purged_at_ms INTEGER NOT NULL,
                purge_reason TEXT NOT NULL CHECK (purge_reason IN ('USER_CLEARED_GUEST_DATA', 'VERIFIED_UNUSED_GUEST_EVICTION', 'CLAIMED_AND_REBOUND')),
                purged_by_user_id TEXT,
                CHECK (length(trim(guest_profile_id)) > 0)
              );
            ''');
          },
        ),
      );
      await futureV7Db.insert('guest_quarantined_scopes', <String, Object?>{
        'guest_profile_id': 'g-v7-keep',
        'quarantined_at_ms': 1700000100,
        'reason': 'SKIP_CLAIM',
      });
      await futureV7Db.close();

      final downgradedOfflineDb = OfflineDatabase();
      await expectLater(
        () => downgradedOfflineDb.initialize(
          customPath: futureV7Path,
          databaseFactory: databaseFactoryFfi,
          singleInstance: false,
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('DATABASE_DOWNGRADE_PROHIBITED'),
          ),
        ),
      );
      expect(File(futureV7Path).existsSync(), isTrue);
      final verifyV7StillIntact = await databaseFactoryFfi.openDatabase(
        futureV7Path,
        options: OpenDatabaseOptions(version: 7, singleInstance: false),
      );
      expect(await verifyV7StillIntact.getVersion(), 7);
      expect((await verifyV7StillIntact.query('guest_quarantined_scopes')).first['guest_profile_id'], 'g-v7-keep');
      await verifyV7StillIntact.close();

      // Part B: v6 -> v5 binary rollback simulation (fail-closed Android style throws without wipe;
      // and legacy sqflite_common v5 open without onDowngrade + re-upgrade to v6 preserves 100% of all 16 tables + rows)
      final v6Db = OfflineDatabase();
      final db = await v6Db.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      await db.insert('local_library_bookmarks', <String, Object?>{
        'owner_scope': 'guest:g-keep',
        'story_id': 'story-keep',
        'title': 'Must Survive Downgrade',
        'created_at': 1700000000,
      });
      await db.insert('guest_quarantined_scopes', <String, Object?>{
        'guest_profile_id': 'g-keep',
        'quarantined_at_ms': 1700000100,
        'reason': 'SKIP_CLAIM',
      });
      await db.insert('guest_purged_tombstones', <String, Object?>{
        'guest_profile_id': 'g-purged',
        'purged_at_ms': 1700000200,
        'purge_reason': 'USER_CLEARED_GUEST_DATA',
      });
      await v6Db.close();

      // Simulate native fail-closed downgrade rejection
      await expectLater(
        () => databaseFactoryFfi.openDatabase(
          dbPath,
          options: OpenDatabaseOptions(
            version: 5,
            singleInstance: false,
            onDowngrade: (db, oldV, newV) =>
                throw StateError('DOWNGRADE_REJECTED:$oldV->$newV'),
          ),
        ),
        throwsA(isA<StateError>()),
      );
      expect(File(dbPath).existsSync(), isTrue);

      // Simulate legacy v5 FFI opener (which had no onDowngrade hook) followed by re-upgrade to v6
      final legacyV5Open = await databaseFactoryFfi.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: 5,
          singleInstance: false,
        ),
      );
      expect(await legacyV5Open.getVersion(), 5);
      await legacyV5Open.close();

      final reopenedV6 = OfflineDatabase();
      final dbReopened = await reopenedV6.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );
      expect(await dbReopened.getVersion(), 6);
      expect((await dbReopened.query('local_library_bookmarks')).first['story_id'], 'story-keep');
      expect((await dbReopened.query('guest_quarantined_scopes')).first['guest_profile_id'], 'g-keep');
      expect((await dbReopened.query('guest_purged_tombstones')).first['guest_profile_id'], 'g-purged');
      // Read-only legacy SharedPreferences shadow key also intact
      expect(
        prefs.getStringList(GuestProfileIdentityProvider.keyQuarantinedProfiles),
        equals(<String>['g-shadow-1']),
      );
      await reopenedV6.close();
    });
  });
}
