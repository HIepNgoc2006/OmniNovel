import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// Database Manager cho hạ tầng lưu trữ ngoại tuyến và Sync Foundation của OmniNovel Mobile.
/// Quản lý SQLite schema v1–v6 gồm các bảng offline, local library, guest claim journal,
/// sync storage và Guest lifecycle SSoT (`guest_quarantined_scopes`, `guest_purged_tombstones`).
class OfflineDatabase {
  static const String databaseName = 'omninovel_offline.db';
  static const int databaseVersion = 6;

  Database? _db;

  OfflineDatabase({Database? customDb}) : _db = customDb;

  /// Truy cập instance database đã khởi tạo.
  Database get database {
    final db = _db;
    if (db == null) {
      throw StateError(
        'OfflineDatabase chưa được khởi tạo. Hãy gọi initialize() trước.',
      );
    }
    return db;
  }

  bool get isInitialized => _db != null && _db!.isOpen;

  /// Khởi tạo database với đường dẫn tùy chọn hoặc mặc định.
  Future<Database> initialize({
    String? customPath,
    DatabaseFactory? databaseFactory,
    bool singleInstance = true,
  }) async {
    if (isInitialized) {
      return database;
    }

    final String dbPath;
    if (customPath != null) {
      dbPath = customPath;
    } else {
      final databasesPath = databaseFactory != null
          ? await databaseFactory.getDatabasesPath()
          : await getDatabasesPath();
      dbPath = p.join(databasesPath, databaseName);
    }

    if (databaseFactory != null) {
      _db = await databaseFactory.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: databaseVersion,
          onConfigure: _onConfigure,
          onCreate: _onCreate,
          onUpgrade: _onUpgrade,
          onDowngrade: _onDowngrade,
          singleInstance: singleInstance,
        ),
      );
    } else {
      _db = await openDatabase(
        dbPath,
        version: databaseVersion,
        onConfigure: _onConfigure,
        onCreate: _onCreate,
        onUpgrade: _onUpgrade,
        onDowngrade: _onDowngrade,
        singleInstance: singleInstance,
      );
    }

    return _db!;
  }

  Future<void> _onConfigure(Database db) async {
    // Kích hoạt foreign key constraints
    await db.execute('PRAGMA foreign_keys = ON;');
    // Thiết lập busy_timeout để hỗ trợ đa kết nối SQLite tranh chấp OCC an toàn (P0-M02)
    await db.rawQuery('PRAGMA busy_timeout = 5000;');
    // Chỉ bật WAL cho file database trên đĩa; bỏ qua :memory:
    final pathLower = db.path.toLowerCase();
    if (db.path.isNotEmpty && !pathLower.contains(':memory:')) {
      try {
        await db.rawQuery('PRAGMA journal_mode = WAL;');
      } catch (_) {
        // Fallback an toàn nếu nền tảng/driver không hỗ trợ WAL
      }
    }
  }

  Future<void> _onCreate(Database db, int version) async {
    await _createV2Tables(db);
    await _createV3LocalLibraryTables(db);
    await _createV4RecoveryJournalTable(db);
    await _createV5SyncTables(db);
    await _createV6LifecycleTables(db);
  }

  Future<void> _onUpgrade(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      // Migration v1 ➔ v2:
      // Invariant: Legacy v1 ownership = UNKNOWN -> fail-closed an toàn.
      // Tuyệt đối không gán về 'anon', không gán về current user.
      // Dữ liệu v1 không có owner phải bị loại bỏ khỏi inventory có thể đọc (không promote vào v2).
      // Xóa các bảng v1 unowned và tạo mới schema v2.
      await db.execute('DROP TABLE IF EXISTS offline_chapters;');
      await db.execute('DROP TABLE IF EXISTS download_tasks;');
      await _createV2Tables(db);
    }
    if (oldVersion < 3) {
      // Migration v2 ➔ v3:
      // Invariant: Tuyệt đối KHÔNG DROP hay recreate bất kỳ bảng v2 nào!
      // Toàn bộ dữ liệu offline_chapters, download_tasks, offline_deletion_tombstones giữ nguyên 100%.
      // Chỉ tạo thêm 3 bảng Local Library mới.
      await _createV3LocalLibraryTables(db);
    }
    if (oldVersion < 4) {
      // Migration v3 ➔ v4:
      // Invariant: Toàn bộ 6 bảng cũ (v2 + v3) giữ nguyên 100% dữ liệu.
      // Chỉ tạo thêm bảng guest_claim_recovery_journal (9 cột) cho crash recovery.
      await _createV4RecoveryJournalTable(db);
    }
    if (oldVersion < 5) {
      // Migration v4 ➔ v5:
      // Invariant: Toàn bộ 7 bảng cũ (v2 + v3 + v4) giữ nguyên 100% dữ liệu (additive).
      // Tạo thêm 7 bảng nền tảng Sync Storage Foundation & Local Preferences.
      await _createV5SyncTables(db);
    }
    if (oldVersion < 6) {
      // Migration v5 ➔ v6 (Stage 1B Controlled Unlock — ADR-07C4-001):
      // Invariant: Toàn bộ 14 bảng cũ (v2 + v3 + v4 + v5) giữ nguyên 100% dữ liệu (additive).
      // Chuyển Guest Quarantine SSoT sang SQLite và bổ sung terminal PURGED tombstones.
      await _createV6LifecycleTables(db);
    }
  }

  Future<void> _onDowngrade(Database db, int oldVersion, int newVersion) async {
    // Fail-closed: Tuyệt đối cấm onDatabaseDowngradeDelete hoặc âm thầm hạ version DB.
    throw StateError(
      'DATABASE_DOWNGRADE_PROHIBITED: Cannot downgrade OfflineDatabase from v$oldVersion to v$newVersion without risking sync/lifecycle integrity.',
    );
  }

  Future<void> _createV6LifecycleTables(Database db) async {
    // 1. SSoT Cách ly Guest đã Skip Claim (chặn purge vĩnh viễn bên trong SQLite engine)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS guest_quarantined_scopes (
        guest_profile_id TEXT PRIMARY KEY,
        quarantined_at_ms INTEGER NOT NULL,
        source_user_id TEXT,
        reason TEXT NOT NULL DEFAULT 'SKIP_CLAIM',
        CHECK (length(trim(guest_profile_id)) > 0)
      );
    ''');

    // 2. SSoT Tombstone Hủy Guest (chặn Claim & Quarantine sau Purge — Terminal Absorbing State)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS guest_purged_tombstones (
        guest_profile_id TEXT PRIMARY KEY,
        purged_at_ms INTEGER NOT NULL,
        purge_reason TEXT NOT NULL
          CHECK (purge_reason IN (
            'USER_CLEARED_GUEST_DATA',
            'VERIFIED_UNUSED_GUEST_EVICTION',
            'CLAIMED_AND_REBOUND'
          )),
        purged_by_user_id TEXT,
        CHECK (length(trim(guest_profile_id)) > 0)
      );
    ''');
  }

  Future<void> _createV5SyncTables(Database db) async {
    // 1. Sync Metadata & Baseline Lifecycle (fail-closed UNINITIALIZED)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_meta (
        owner_scope TEXT PRIMARY KEY,
        last_synced_server_revision TEXT NOT NULL DEFAULT '0',
        min_active_revision TEXT NOT NULL DEFAULT '0',
        last_sync_timestamp TEXT NOT NULL,
        effective_history_epochs_json TEXT NOT NULL DEFAULT '{}',
        sync_state TEXT NOT NULL DEFAULT 'IDLE',
        authoritative_baseline_status TEXT NOT NULL DEFAULT 'UNINITIALIZED'
          CHECK (authoritative_baseline_status IN ('UNINITIALIZED', 'BOOTSTRAPPING', 'READY')),
        last_error_message TEXT
      );
    ''');

    // 2. Durable Monotonic FIFO Sequence Allocation Table (P1-M03)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_mutation_sequences (
        owner_scope TEXT PRIMARY KEY,
        last_sequence_no INTEGER NOT NULL DEFAULT 0
      );
    ''');

    // 3. Account-Scoped Authoritative Shadow Replicas
    await db.execute('''
      CREATE TABLE IF NOT EXISTS sync_authoritative_replicas (
        owner_scope TEXT NOT NULL,
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        server_revision TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, domain, entity_key)
      );
    ''');

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_sync_replicas_scope_domain ON sync_authoritative_replicas(owner_scope, domain);',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_sync_replicas_scope_rev ON sync_authoritative_replicas(owner_scope, server_revision);',
    );

    // 4. Pending Mutations Queue (P1-M03 monotonic FIFO sequence_no)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS pending_mutations (
        owner_scope TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        base_server_revision TEXT NOT NULL,
        observed_history_epoch INTEGER,
        payload_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at_ms INTEGER,
        created_at_iso TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, mutation_id),
        UNIQUE (owner_scope, sequence_no)
      );
    ''');

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_pending_mutations_scope_fifo ON pending_mutations(owner_scope, sequence_no ASC);',
    );

    // 5. Quarantined Mutations Store (P1-M04 full-fidelity preservation)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS quarantined_mutations (
        owner_scope TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        base_server_revision TEXT NOT NULL,
        observed_history_epoch INTEGER,
        payload_json TEXT NOT NULL,
        original_sequence_no INTEGER,
        original_retry_count INTEGER NOT NULL DEFAULT 0,
        original_created_at_iso TEXT NOT NULL,
        original_created_at_ms INTEGER NOT NULL,
        rejection_reason TEXT NOT NULL,
        rejection_status TEXT NOT NULL DEFAULT 'MANUAL',
        rejected_at_iso TEXT NOT NULL,
        rejected_at_ms INTEGER NOT NULL,
        triage_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (triage_status IN ('PENDING', 'APPROVED', 'DISCARDED')),
        causal_evidence_json TEXT,
        PRIMARY KEY (owner_scope, mutation_id)
      );
    ''');

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_quarantined_mutations_scope_rejected ON quarantined_mutations(owner_scope, rejected_at_ms DESC);',
    );

    // 6. Snapshot Staging Store (P1-M04 snapshot session & cursor metadata)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS snapshot_staging_store (
        owner_scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        snapshot_revision TEXT NOT NULL,
        min_active_revision TEXT NOT NULL,
        cursor_token TEXT,
        page_index INTEGER NOT NULL DEFAULT 0,
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        staged_at_iso TEXT NOT NULL,
        staged_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, session_id, domain, entity_key)
      );
    ''');

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_snapshot_staging_scope_session ON snapshot_staging_store(owner_scope, session_id);',
    );

    // 7. Scoped Local Preferences
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_preferences (
        owner_scope TEXT NOT NULL,
        pref_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_scope, pref_key)
      );
    ''');
  }

  Future<void> _createV3LocalLibraryTables(Database db) async {
    // 1. Bảng quản lý Local Library Bookmarks (Guest & Account partitioned)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_library_bookmarks (
        owner_scope TEXT NOT NULL,
        story_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT,
        cover_url TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_scope, story_id)
      );
    ''');

    // 2. Bảng quản lý Local Reading Progress (Full canonical resume state)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_reading_progress (
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

    // 3. Bảng quản lý Local Reading History (Snapshot semantics: 1 row per chapter)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_reading_history (
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

    // Chỉ mục tối ưu truy vấn theo owner_scope
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_bookmarks_owner ON local_library_bookmarks(owner_scope);',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_progress_owner ON local_reading_progress(owner_scope);',
    );
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_local_history_owner_time ON local_reading_history(owner_scope, last_read_at DESC);',
    );
  }

  Future<void> _createV4RecoveryJournalTable(Database db) async {
    // Bảng quản lý Guest Claim Recovery Journal (Durable ACID Crash Recovery Ledger - 9 Cột)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS guest_claim_recovery_journal (
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

    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_guest_claim_journal_user ON guest_claim_recovery_journal(user_id);',
    );
  }

  Future<void> _createV2Tables(Database db) async {
    // 1. Bảng quản lý metadata các chương đã cài đặt thành công (Canonical Proof / SSoT)
    // Invariant: PRIMARY KEY (user_id, chapter_version_id), bổ sung is_pinned.
    // Bảng KHÔNG CÓ cột status. Row tồn tại <=> chapter sẵn sàng đọc offline.
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

    // 2. Bảng quản lý hàng đợi tải xuống
    // Invariant: UNIQUE(user_id, chapter_version_id) enforce DB-level single-flight per user.
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

    // 3. Bảng quản lý Deletion Tombstones (3-Step Deletion Protocol & Crash Recovery)
    // Invariant: UNIQUE(user_id, chapter_version_id) ngăn duplicate tombstones.
    await db.execute('''
      CREATE TABLE offline_deletion_tombstones (
        tombstone_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chapter_version_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, chapter_version_id)
      );
    ''');

    // Chỉ mục tối ưu truy vấn
    await db.execute(
      'CREATE INDEX idx_offline_chapters_user_story ON offline_chapters(user_id, story_id);',
    );
    await db.execute(
      'CREATE INDEX idx_offline_chapters_user_last_read ON offline_chapters(user_id, last_read_at);',
    );
    await db.execute(
      'CREATE INDEX idx_download_tasks_user_status ON download_tasks(user_id, status);',
    );
    await db.execute(
      'CREATE INDEX idx_tombstones_user_version ON offline_deletion_tombstones(user_id, chapter_version_id);',
    );
  }

  /// Đóng kết nối database.
  Future<void> close() async {
    if (_db != null && _db!.isOpen) {
      await _db!.close();
      _db = null;
    }
  }
}
