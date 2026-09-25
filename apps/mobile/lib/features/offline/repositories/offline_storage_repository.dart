import 'package:sqflite/sqflite.dart';
import '../../../core/storage/offline_database.dart';
import '../models/download_task.dart';
import '../models/offline_chapter.dart';

/// Repository quản lý truy vấn SQLite cho các tác vụ tải và chương ngoại tuyến.
class OfflineStorageRepository {
  final OfflineDatabase _database;

  OfflineStorageRepository({required OfflineDatabase database})
      : _database = database;

  Database get _db => _database.database;

  // ==========================================
  // DOWNLOAD TASKS OPERATIONS
  // ==========================================

  /// Thêm mới một tác vụ tải.
  /// Ràng buộc DB-level: `UNIQUE(chapter_version_id)` sẽ throw DatabaseException nếu trùng lặp.
  Future<void> insertTask(DownloadTask task) async {
    await _db.insert(
      'download_tasks',
      task.toMap(),
      conflictAlgorithm: ConflictAlgorithm.abort,
    );
  }

  /// Lấy thông tin tác vụ theo taskId.
  Future<DownloadTask?> getTaskById(String taskId) async {
    final results = await _db.query(
      'download_tasks',
      where: 'task_id = ?',
      whereArgs: [taskId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return DownloadTask.fromMap(results.first);
  }

  /// Lấy thông tin tác vụ theo chapterVersionId.
  Future<DownloadTask?> getTaskByVersionId(String chapterVersionId) async {
    final results = await _db.query(
      'download_tasks',
      where: 'chapter_version_id = ?',
      whereArgs: [chapterVersionId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return DownloadTask.fromMap(results.first);
  }

  /// Lấy danh sách toàn bộ tác vụ.
  Future<List<DownloadTask>> getAllTasks() async {
    final results = await _db.query(
      'download_tasks',
      orderBy: 'created_at DESC',
    );
    return results.map((m) => DownloadTask.fromMap(m)).toList();
  }

  /// Lấy danh sách tác vụ theo trạng thái.
  Future<List<DownloadTask>> getTasksByStatus(DownloadTaskStatus status) async {
    final results = await _db.query(
      'download_tasks',
      where: 'status = ?',
      whereArgs: [status.value],
      orderBy: 'created_at ASC',
    );
    return results.map((m) => DownloadTask.fromMap(m)).toList();
  }

  /// Cập nhật toàn bộ trường của tác vụ.
  Future<void> updateTask(DownloadTask task) async {
    await _db.update(
      'download_tasks',
      task.toMap(),
      where: 'task_id = ?',
      whereArgs: [task.taskId],
    );
  }

  /// Cập nhật tiến trình tải byte của tác vụ.
  Future<void> updateTaskProgress(
    String taskId, {
    required int downloadedBytes,
    required int totalBytes,
    required double progressFraction,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.update(
      'download_tasks',
      {
        'downloaded_bytes': downloadedBytes,
        'total_bytes': totalBytes,
        'progress_fraction': progressFraction,
        'updated_at': now,
      },
      where: 'task_id = ?',
      whereArgs: [taskId],
    );
  }

  /// Cập nhật trạng thái tác vụ tải.
  Future<void> updateTaskStatus(
    String taskId,
    DownloadTaskStatus status, {
    String? errorMessage,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final Map<String, dynamic> values = {
      'status': status.value,
      'updated_at': now,
    };
    if (errorMessage != null) {
      values['error_message'] = errorMessage;
    }
    await _db.update(
      'download_tasks',
      values,
      where: 'task_id = ?',
      whereArgs: [taskId],
    );
  }

  /// Cập nhật presigned URL mới cho tác vụ.
  Future<void> updateTaskUrl(
    String taskId, {
    required String downloadUrl,
    String? sha256Hash,
    int? totalBytes,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final Map<String, dynamic> values = {
      'download_url': downloadUrl,
      'updated_at': now,
    };
    if (sha256Hash != null) {
      values['sha256_hash'] = sha256Hash;
    }
    if (totalBytes != null && totalBytes > 0) {
      values['total_bytes'] = totalBytes;
    }
    await _db.update(
      'download_tasks',
      values,
      where: 'task_id = ?',
      whereArgs: [taskId],
    );
  }

  /// Xóa tác vụ tải khỏi hàng đợi.
  Future<void> deleteTask(String taskId) async {
    await _db.delete(
      'download_tasks',
      where: 'task_id = ?',
      whereArgs: [taskId],
    );
  }

  /// Xóa tác vụ theo version ID.
  Future<void> deleteTaskByVersionId(String chapterVersionId) async {
    await _db.delete(
      'download_tasks',
      where: 'chapter_version_id = ?',
      whereArgs: [chapterVersionId],
    );
  }

  /// Crash Recovery: Quét và chuyển toàn bộ task DOWNLOADING và VERIFYING sang PAUSED.
  Future<int> resetUnfinishedTasksToPaused() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    return await _db.update(
      'download_tasks',
      {
        'status': DownloadTaskStatus.paused.value,
        'updated_at': now,
      },
      where: 'status IN (?, ?)',
      whereArgs: [
        DownloadTaskStatus.downloading.value,
        DownloadTaskStatus.verifying.value,
      ],
    );
  }

  // ==========================================
  // OFFLINE CHAPTERS OPERATIONS
  // ==========================================

  /// Ghi nhận chương đã cài đặt thành công vào CSDL.
  Future<void> insertOfflineChapter(OfflineChapter chapter) async {
    await _db.insert(
      'offline_chapters',
      chapter.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Lấy thông tin chương ngoại tuyến theo versionId.
  Future<OfflineChapter?> getOfflineChapter(String chapterVersionId) async {
    final results = await _db.query(
      'offline_chapters',
      where: 'chapter_version_id = ?',
      whereArgs: [chapterVersionId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return OfflineChapter.fromMap(results.first);
  }

  /// Lấy danh sách toàn bộ các chương đã cài đặt của một bộ truyện.
  Future<List<OfflineChapter>> getOfflineChaptersByStory(String storyId) async {
    final results = await _db.query(
      'offline_chapters',
      where: 'story_id = ?',
      whereArgs: [storyId],
      orderBy: 'installed_at ASC',
    );
    return results.map((m) => OfflineChapter.fromMap(m)).toList();
  }

  /// Kiểm tra xem chapter version đã được cài đặt hợp lệ trên máy chưa.
  Future<bool> isChapterInstalled(String chapterVersionId) async {
    final count = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT COUNT(*) FROM offline_chapters WHERE chapter_version_id = ?',
      [chapterVersionId],
    ));
    return (count ?? 0) > 0;
  }

  /// Cập nhật thời điểm đọc gần nhất để phục vụ LRU eviction.
  Future<void> updateLastReadAt(String chapterVersionId, int timestamp) async {
    await _db.update(
      'offline_chapters',
      {'last_read_at': timestamp},
      where: 'chapter_version_id = ?',
      whereArgs: [chapterVersionId],
    );
  }

  /// Lấy danh sách toàn bộ các chương đã cài đặt ngoại tuyến (phục vụ Reconciliation & Storage Management).
  Future<List<OfflineChapter>> getAllOfflineChapters() async {
    final results = await _db.query(
      'offline_chapters',
      orderBy: 'installed_at ASC',
    );
    return results.map((m) => OfflineChapter.fromMap(m)).toList();
  }

  /// Xóa chương ngoại tuyến khỏi CSDL.
  Future<void> deleteOfflineChapter(String chapterVersionId) async {
    await _db.delete(
      'offline_chapters',
      where: 'chapter_version_id = ?',
      whereArgs: [chapterVersionId],
    );
  }
}

