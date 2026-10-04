import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// Database Manager cho hạ tầng lưu trữ ngoại tuyến của OmniNovel Mobile.
/// Quản lý SQLite schema v1 gồm bảng `download_tasks` và `offline_chapters`.
class OfflineDatabase {
  static const String databaseName = 'omninovel_offline.db';
  static const int databaseVersion = 3;

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
        ),
      );
    } else {
      _db = await openDatabase(
        dbPath,
        version: databaseVersion,
        onConfigure: _onConfigure,
        onCreate: _onCreate,
        onUpgrade: _onUpgrade,
      );
    }

    return _db!;
  }

  Future<void> _onConfigure(Database db) async {
    // Kích hoạt foreign key constraints
    await db.execute('PRAGMA foreign_keys = ON;');
  }

  Future<void> _onCreate(Database db, int version) async {
    await _createV2Tables(db);
    await _createV3LocalLibraryTables(db);
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
