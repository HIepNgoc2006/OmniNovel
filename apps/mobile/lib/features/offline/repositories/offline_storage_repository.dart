import 'package:sqflite/sqflite.dart';
import '../../../core/storage/offline_database.dart';
import '../models/download_task.dart';
import '../models/offline_chapter.dart';
import '../models/offline_deletion_tombstone.dart';

/// Repository quản lý truy vấn SQLite cho các tác vụ tải, chương ngoại tuyến và tombstones.
/// Tất cả các thao tác (truy vấn, thêm mới, sửa đổi, xóa) bắt buộc phải scoped theo `userId`
/// để đảm bảo cô lập hoàn toàn giữa các người dùng trên cùng một thiết bị.
class OfflineStorageRepository {
  final OfflineDatabase _database;
  final String userId;

  OfflineStorageRepository({
    required OfflineDatabase database,
    required this.userId,
  }) : _database = database {
    if (userId.trim().isEmpty) {
      throw ArgumentError('userId không được rỗng hoặc chỉ chứa khoảng trắng');
    }
  }

  Database get _db => _database.database;

  /// Tạo instance repository bind với userId mới
  OfflineStorageRepository forUser(String newUserId) {
    return OfflineStorageRepository(
      database: _database,
      userId: newUserId,
    );
  }

  // ==========================================
  // DOWNLOAD TASKS OPERATIONS (USER-SCOPED)
  // ==========================================

  /// Thêm mới một tác vụ tải.
  /// Ràng buộc DB-level: `UNIQUE(user_id, chapter_version_id)` sẽ throw DatabaseException nếu trùng lặp.
  Future<void> insertTask(DownloadTask task) async {
    final scopedTask = task.userId == userId ? task : task.copyWith(userId: userId);
    await _db.insert(
      'download_tasks',
      scopedTask.toMap(),
      conflictAlgorithm: ConflictAlgorithm.abort,
    );
  }

  /// Lấy thông tin tác vụ theo taskId của user hiện tại.
  Future<DownloadTask?> getTaskById(String taskId) async {
    final results = await _db.query(
      'download_tasks',
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [taskId, userId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return DownloadTask.fromMap(results.first);
  }

  /// Lấy thông tin tác vụ theo chapterVersionId của user hiện tại.
  Future<DownloadTask?> getTaskByVersionId(String chapterVersionId) async {
    final results = await _db.query(
      'download_tasks',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return DownloadTask.fromMap(results.first);
  }

  /// Lấy danh sách toàn bộ tác vụ của user hiện tại.
  Future<List<DownloadTask>> getAllTasks() async {
    final results = await _db.query(
      'download_tasks',
      where: 'user_id = ?',
      whereArgs: [userId],
      orderBy: 'created_at DESC',
    );
    return results.map((m) => DownloadTask.fromMap(m)).toList();
  }

  /// Lấy danh sách tác vụ theo trạng thái của user hiện tại.
  Future<List<DownloadTask>> getTasksByStatus(DownloadTaskStatus status) async {
    final results = await _db.query(
      'download_tasks',
      where: 'status = ? AND user_id = ?',
      whereArgs: [status.value, userId],
      orderBy: 'created_at ASC',
    );
    return results.map((m) => DownloadTask.fromMap(m)).toList();
  }

  /// Cập nhật toàn bộ trường của tác vụ của user hiện tại.
  Future<void> updateTask(DownloadTask task) async {
    final scopedTask = task.userId == userId ? task : task.copyWith(userId: userId);
    await _db.update(
      'download_tasks',
      scopedTask.toMap(),
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [task.taskId, userId],
    );
  }

  /// Cập nhật tiến trình tải byte của tác vụ của user hiện tại.
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
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [taskId, userId],
    );
  }

  /// Cập nhật trạng thái tác vụ tải của user hiện tại.
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
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [taskId, userId],
    );
  }

  /// Cập nhật presigned URL mới cho tác vụ của user hiện tại.
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
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [taskId, userId],
    );
  }

  /// Xóa tác vụ tải khỏi hàng đợi của user hiện tại.
  Future<void> deleteTask(String taskId) async {
    await _db.delete(
      'download_tasks',
      where: 'task_id = ? AND user_id = ?',
      whereArgs: [taskId, userId],
    );
  }

  /// Xóa tác vụ theo version ID của user hiện tại.
  Future<void> deleteTaskByVersionId(String chapterVersionId) async {
    await _db.delete(
      'download_tasks',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  }

  /// Crash Recovery: Quét và chuyển toàn bộ task DOWNLOADING và VERIFYING sang PAUSED của user hiện tại.
  Future<int> resetUnfinishedTasksToPaused() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    return await _db.update(
      'download_tasks',
      {
        'status': DownloadTaskStatus.paused.value,
        'updated_at': now,
      },
      where: 'status IN (?, ?) AND user_id = ?',
      whereArgs: [
        DownloadTaskStatus.downloading.value,
        DownloadTaskStatus.verifying.value,
        userId,
      ],
    );
  }

  // ==========================================
  // OFFLINE CHAPTERS OPERATIONS (USER-SCOPED)
  // ==========================================

  /// Ghi nhận chương đã cài đặt thành công vào CSDL cho user hiện tại.
  Future<void> insertOfflineChapter(OfflineChapter chapter) async {
    final scopedChapter = chapter.userId == userId ? chapter : chapter.copyWith(userId: userId);
    await _db.insert(
      'offline_chapters',
      scopedChapter.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Ghi nhận chương đã cài đặt thành công và cập nhật task sang READY trong một SQLite Transaction nguyên tử.
  /// Đảm bảo tính toàn vẹn Invariant 5/7: không bao giờ tồn tại trạng thái nửa vời (row tồn tại nhưng task không READY).
  Future<void> commitInstalledChapterAndReady(
    OfflineChapter chapter,
    String taskId,
  ) async {
    final scopedChapter = chapter.userId == userId ? chapter : chapter.copyWith(userId: userId);
    await _db.transaction((txn) async {
      await txn.insert(
        'offline_chapters',
        scopedChapter.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      final now = DateTime.now().millisecondsSinceEpoch;
      await txn.update(
        'download_tasks',
        {
          'status': DownloadTaskStatus.ready.value,
          'error_message': null,
          'updated_at': now,
        },
        where: 'task_id = ? AND user_id = ?',
        whereArgs: [taskId, userId],
      );
    });
  }

  /// Lấy thông tin chương ngoại tuyến theo versionId của user hiện tại.
  Future<OfflineChapter?> getOfflineChapter(String chapterVersionId) async {
    final results = await _db.query(
      'offline_chapters',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return OfflineChapter.fromMap(results.first);
  }

  /// Lấy danh sách toàn bộ các chương đã cài đặt của một bộ truyện của user hiện tại.
  Future<List<OfflineChapter>> getOfflineChaptersByStory(String storyId) async {
    final results = await _db.query(
      'offline_chapters',
      where: 'story_id = ? AND user_id = ?',
      whereArgs: [storyId, userId],
      orderBy: 'installed_at ASC',
    );
    return results.map((m) => OfflineChapter.fromMap(m)).toList();
  }

  /// Lấy danh sách toàn bộ các chapterVersionId thuộc một bộ truyện
  /// (truy vấn kết hợp cả `offline_chapters` và `download_tasks` chưa finalize để hỗ trợ resume deletion sau crash).
  Future<List<String>> getAllChapterVersionIdsByStory(String storyId) async {
    final chapterResults = await _db.query(
      'offline_chapters',
      columns: ['chapter_version_id'],
      where: 'story_id = ? AND user_id = ?',
      whereArgs: [storyId, userId],
    );
    final taskResults = await _db.query(
      'download_tasks',
      columns: ['chapter_version_id'],
      where: 'story_id = ? AND user_id = ?',
      whereArgs: [storyId, userId],
    );

    final set = <String>{};
    for (final row in chapterResults) {
      final v = row['chapter_version_id'] as String?;
      if (v != null) set.add(v);
    }
    for (final row in taskResults) {
      final v = row['chapter_version_id'] as String?;
      if (v != null) set.add(v);
    }
    return set.toList();
  }

  /// Lấy toàn bộ các phiên bản đã tải của một chương truyện cụ thể của user hiện tại.
  Future<List<OfflineChapter>> getOfflineChaptersByChapterId(String chapterId) async {
    final results = await _db.query(
      'offline_chapters',
      where: 'chapter_id = ? AND user_id = ?',
      whereArgs: [chapterId, userId],
      orderBy: 'installed_at DESC',
    );
    return results.map((m) => OfflineChapter.fromMap(m)).toList();
  }

  /// Kiểm tra xem chapter version đã được cài đặt hợp lệ trên máy cho user hiện tại chưa.
  Future<bool> isChapterInstalled(String chapterVersionId) async {
    final count = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT COUNT(*) FROM offline_chapters WHERE chapter_version_id = ? AND user_id = ?',
      [chapterVersionId, userId],
    ));
    return (count ?? 0) > 0;
  }

  /// Cập nhật thời điểm đọc gần nhất để phục vụ LRU eviction.
  Future<void> updateLastReadAt(String chapterVersionId, int timestamp) async {
    await _db.update(
      'offline_chapters',
      {'last_read_at': timestamp},
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  }

  /// Đánh dấu hoặc hủy đánh dấu ghim chương (không bao giờ bị LRU tự động evict).
  Future<void> setChapterPinned(String chapterVersionId, bool isPinned) async {
    await _db.update(
      'offline_chapters',
      {'is_pinned': isPinned ? 1 : 0},
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  }

  /// Lấy danh sách toàn bộ các chương đã cài đặt ngoại tuyến của user hiện tại.
  Future<List<OfflineChapter>> getAllOfflineChapters() async {
    final results = await _db.query(
      'offline_chapters',
      where: 'user_id = ?',
      whereArgs: [userId],
      orderBy: 'installed_at ASC',
    );
    return results.map((m) => OfflineChapter.fromMap(m)).toList();
  }

  /// Xóa chương ngoại tuyến khỏi CSDL của user hiện tại.
  Future<void> deleteOfflineChapter(String chapterVersionId) async {
    await _db.delete(
      'offline_chapters',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  }

  /// Tính tổng dung lượng byte của các chương offline thuộc user hiện tại.
  Future<int> getTotalStorageBytes() async {
    final result = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT SUM(total_bytes) FROM offline_chapters WHERE user_id = ?',
      [userId],
    ));
    return result ?? 0;
  }

  // ==========================================
  // DELETION TOMBSTONES OPERATIONS (USER-SCOPED)
  // ==========================================

  /// Ghi tombstone vào bảng offline_deletion_tombstones (Bước 1 của giao thức xóa 3 bước).
  Future<void> insertTombstone(OfflineDeletionTombstone tombstone) async {
    final scoped = tombstone.userId == userId ? tombstone : tombstone.copyWith(userId: userId);
    await _db.insert(
      'offline_deletion_tombstones',
      scoped.toMap(),
      conflictAlgorithm: ConflictAlgorithm.abort,
    );
  }

  /// Lấy thông tin Deletion Tombstone của chapter version cho user hiện tại.
  Future<OfflineDeletionTombstone?> getTombstone(String chapterVersionId) async {
    final results = await _db.query(
      'offline_deletion_tombstones',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
      limit: 1,
    );
    if (results.isEmpty) return null;
    return OfflineDeletionTombstone.fromMap(results.first);
  }

  /// Xóa tombstone khỏi bảng offline_deletion_tombstones (Bước 3 finalize).
  Future<void> deleteTombstone(String chapterVersionId) async {
    await _db.delete(
      'offline_deletion_tombstones',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  }

  /// Lấy danh sách toàn bộ Deletion Tombstones của user hiện tại (phục vụ Startup Reconciliation).
  Future<List<OfflineDeletionTombstone>> getAllTombstones() async {
    final results = await _db.query(
      'offline_deletion_tombstones',
      where: 'user_id = ?',
      whereArgs: [userId],
      orderBy: 'created_at ASC',
    );
    return results.map((m) => OfflineDeletionTombstone.fromMap(m)).toList();
  }

  /// Alias tương thích cho [getAllTombstones].
  Future<List<OfflineDeletionTombstone>> getOfflineDeletionTombstones() => getAllTombstones();

  /// Bước 1 của Giao thức Xóa Tất định (Deterministic Deletion Protocol):
  /// Nguyên tử ghi nhận tombstone và xóa row offline_chapters trong cùng một SQLite transaction.
  /// Sử dụng ConflictAlgorithm.ignore để đảm bảo tính Idempotent khi chạy lại sau crash.
  Future<void> ensureDeletionRevoked(
    String chapterVersionId, {
    required String tombstoneId,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.transaction((txn) async {
      await txn.insert(
        'offline_deletion_tombstones',
        {
          'tombstone_id': tombstoneId,
          'user_id': userId,
          'chapter_version_id': chapterVersionId,
          'created_at': now,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      await txn.delete(
        'offline_chapters',
        where: 'chapter_version_id = ? AND user_id = ?',
        whereArgs: [chapterVersionId, userId],
      );
    });
  }

  /// Alias tương thích ngược cho [ensureDeletionRevoked].
  Future<void> atomicRevokeChapter(
    String chapterVersionId, {
    required String tombstoneId,
  }) => ensureDeletionRevoked(chapterVersionId, tombstoneId: tombstoneId);

  /// Bước 3 của Giao thức Xóa Tất định (Deterministic Deletion Protocol):
  /// Nguyên tử dọn dẹp tombstone và bản ghi download_tasks tương ứng sau khi filesystem đã được purge sạch.
  Future<void> atomicFinalizeChapterDeletion(String chapterVersionId) async {
    await _db.transaction((txn) async {
      await txn.delete(
        'offline_deletion_tombstones',
        where: 'chapter_version_id = ? AND user_id = ?',
        whereArgs: [chapterVersionId, userId],
      );
      await txn.delete(
        'download_tasks',
        where: 'chapter_version_id = ? AND user_id = ?',
        whereArgs: [chapterVersionId, userId],
      );
    });
  }

  /// Nguyên tử thu hồi quyền đọc của hàng loạt chương (Batch Revocation) với tính Idempotent.
  Future<void> ensureBatchDeletionRevoked(
    List<String> chapterVersionIds, {
    required String Function(String versionId) tombstoneIdGenerator,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.transaction((txn) async {
      for (final versionId in chapterVersionIds) {
        await txn.insert(
          'offline_deletion_tombstones',
          {
            'tombstone_id': tombstoneIdGenerator(versionId),
            'user_id': userId,
            'chapter_version_id': versionId,
            'created_at': now,
          },
          conflictAlgorithm: ConflictAlgorithm.ignore,
        );
        await txn.delete(
          'offline_chapters',
          where: 'chapter_version_id = ? AND user_id = ?',
          whereArgs: [versionId, userId],
        );
      }
    });
  }

  /// Alias tương thích ngược cho [ensureBatchDeletionRevoked].
  Future<void> atomicRevokeChapters(
    List<String> chapterVersionIds, {
    required String Function(String versionId) tombstoneIdGenerator,
  }) => ensureBatchDeletionRevoked(chapterVersionIds, tombstoneIdGenerator: tombstoneIdGenerator);

  /// Nguyên tử hoàn tất xóa sạch tombstones và tasks của danh sách chương (Batch Finalize).
  Future<void> atomicFinalizeChaptersDeletion(List<String> chapterVersionIds) async {
    await _db.transaction((txn) async {
      for (final versionId in chapterVersionIds) {
        await txn.delete(
          'offline_deletion_tombstones',
          where: 'chapter_version_id = ? AND user_id = ?',
          whereArgs: [versionId, userId],
        );
        await txn.delete(
          'download_tasks',
          where: 'chapter_version_id = ? AND user_id = ?',
          whereArgs: [versionId, userId],
        );
      }
    });
  }
}
