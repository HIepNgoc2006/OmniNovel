import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// Database Manager cho hạ tầng lưu trữ ngoại tuyến của OmniNovel Mobile.
/// Quản lý SQLite schema v1 gồm bảng `download_tasks` và `offline_chapters`.
class OfflineDatabase {
  static const String databaseName = 'omninovel_offline.db';
  static const int databaseVersion = 1;

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
        ),
      );
    } else {
      _db = await openDatabase(
        dbPath,
        version: databaseVersion,
        onConfigure: _onConfigure,
        onCreate: _onCreate,
      );
    }

    return _db!;
  }

  Future<void> _onConfigure(Database db) async {
    // Kích hoạt foreign key constraints
    await db.execute('PRAGMA foreign_keys = ON;');
  }

  Future<void> _onCreate(Database db, int version) async {
    // 1. Bảng quản lý metadata các chương đã cài đặt thành công (Canonical Proof)
    // Lưu ý P0.6: Bảng này KHÔNG CÓ cột status. Row tồn tại <=> chapter sẵn sàng đọc offline.
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

    // 2. Bảng quản lý hàng đợi tải xuống
    // Lưu ý P0.3: UNIQUE(chapter_version_id) enforce DB-level single-flight.
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

    // Chỉ mục tối ưu truy vấn
    await db.execute(
      'CREATE INDEX idx_offline_chapters_story ON offline_chapters(story_id);',
    );
    await db.execute(
      'CREATE INDEX idx_offline_chapters_last_read ON offline_chapters(last_read_at);',
    );
    await db.execute(
      'CREATE INDEX idx_download_tasks_status ON download_tasks(status);',
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
