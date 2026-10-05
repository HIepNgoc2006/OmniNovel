import 'dart:math' as math;
import 'package:sqflite/sqflite.dart';
import 'local_library_models.dart';
import 'offline_database.dart';

/// Data Access Object (DAO) cho các bảng Local Library (v3) trong SQLite.
///
/// Invariant 1 (Strict Layering): DAO KHÔNG BIẾT authentication/coordinator.
/// Tất cả các thao tác nhận `ownerScope` rõ ràng từ caller.
class LocalLibraryDao {
  final OfflineDatabase? _offlineDatabase;
  final Database? _customDb;

  LocalLibraryDao({
    OfflineDatabase? offlineDatabase,
    Database? customDb,
  })  : _offlineDatabase = offlineDatabase,
        _customDb = customDb {
    if (_offlineDatabase == null && _customDb == null) {
      throw ArgumentError(
        'Phải cung cấp ít nhất offlineDatabase hoặc customDb cho LocalLibraryDao.',
      );
    }
  }

  Database get _db => _customDb ?? _offlineDatabase!.database;

  // ==================== BOOKMARKS ====================

  /// Lưu hoặc cập nhật một dấu trang cục bộ.
  Future<void> saveBookmark(LocalBookmark bookmark) async {
    await _db.insert(
      'local_library_bookmarks',
      bookmark.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Lấy thông tin một dấu trang cụ thể.
  Future<LocalBookmark?> getBookmark({
    required String ownerScope,
    required String storyId,
  }) async {
    final rows = await _db.query(
      'local_library_bookmarks',
      where: 'owner_scope = ? AND story_id = ?',
      whereArgs: [ownerScope, storyId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalBookmark.fromMap(rows.first);
  }

  /// Kiểm tra truyện đã được đánh dấu trang chưa.
  Future<bool> isBookmarked({
    required String ownerScope,
    required String storyId,
  }) async {
    final rows = await _db.query(
      'local_library_bookmarks',
      columns: ['story_id'],
      where: 'owner_scope = ? AND story_id = ?',
      whereArgs: [ownerScope, storyId],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  /// Lấy toàn bộ danh sách dấu trang của một scope (sắp xếp mới nhất trước).
  Future<List<LocalBookmark>> getBookmarks({
    required String ownerScope,
  }) async {
    final rows = await _db.query(
      'local_library_bookmarks',
      where: 'owner_scope = ?',
      whereArgs: [ownerScope],
      orderBy: 'created_at DESC',
    );
    return rows.map((r) => LocalBookmark.fromMap(r)).toList();
  }

  /// Xóa một dấu trang theo ownerScope và storyId.
  Future<void> deleteBookmark({
    required String ownerScope,
    required String storyId,
  }) async {
    await _db.delete(
      'local_library_bookmarks',
      where: 'owner_scope = ? AND story_id = ?',
      whereArgs: [ownerScope, storyId],
    );
  }

  // ==================== READING PROGRESS ====================

  /// Lưu tiến độ đọc hiện tại (ghi đè vị trí canonical).
  Future<void> saveProgress(LocalReadingProgress progress) async {
    await _db.insert(
      'local_reading_progress',
      progress.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Lấy tiến độ đọc hiện tại của một truyện.
  Future<LocalReadingProgress?> getProgress({
    required String ownerScope,
    required String storyId,
  }) async {
    final rows = await _db.query(
      'local_reading_progress',
      where: 'owner_scope = ? AND story_id = ?',
      whereArgs: [ownerScope, storyId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalReadingProgress.fromMap(rows.first);
  }

  // ==================== READING HISTORY ====================

  /// Lưu lịch sử đọc của một chương.
  /// Invariant 5: Monotonic MAX — nếu đã từng đọc với tiến độ cao hơn thì giữ nguyên tiến độ cao nhất.
  Future<void> saveHistory(LocalReadingHistory history) async {
    final existing = await getHistoryItem(
      ownerScope: history.ownerScope,
      storyId: history.storyId,
      chapterId: history.chapterId,
    );

    final double effectiveProgress = existing != null
        ? math.max(existing.progressPercentage, history.progressPercentage)
        : history.progressPercentage;

    final effectiveHistory = history.copyWith(
      progressPercentage: effectiveProgress,
    );

    await _db.insert(
      'local_reading_history',
      effectiveHistory.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Lấy bản ghi lịch sử đọc của một chương cụ thể.
  Future<LocalReadingHistory?> getHistoryItem({
    required String ownerScope,
    required String storyId,
    required String chapterId,
  }) async {
    final rows = await _db.query(
      'local_reading_history',
      where: 'owner_scope = ? AND story_id = ? AND chapter_id = ?',
      whereArgs: [ownerScope, storyId, chapterId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalReadingHistory.fromMap(rows.first);
  }

  /// Lấy danh sách toàn bộ lịch sử đọc của một scope (sắp xếp theo thời gian đọc giảm dần).
  Future<List<LocalReadingHistory>> getHistory({
    required String ownerScope,
  }) async {
    final rows = await _db.query(
      'local_reading_history',
      where: 'owner_scope = ?',
      whereArgs: [ownerScope],
      orderBy: 'last_read_at DESC',
    );
    return rows.map((r) => LocalReadingHistory.fromMap(r)).toList();
  }

  /// Xóa đồng thời cả tiến độ đọc (local_reading_progress) và lịch sử đọc (local_reading_history) của một truyện.
  /// Invariant: Bookmark (local_library_bookmarks) tuyệt đối không bị ảnh hưởng.
  Future<void> deleteStoryReadingState({
    required String ownerScope,
    required String storyId,
  }) async {
    await _db.transaction((txn) async {
      await txn.delete(
        'local_reading_progress',
        where: 'owner_scope = ? AND story_id = ?',
        whereArgs: [ownerScope, storyId],
      );
      await txn.delete(
        'local_reading_history',
        where: 'owner_scope = ? AND story_id = ?',
        whereArgs: [ownerScope, storyId],
      );
    });
  }

  /// Xóa đồng thời cả tiến độ đọc và lịch sử đọc của tất cả truyện thuộc ownerScope.
  /// Invariant: Bookmark (local_library_bookmarks) tuyệt đối không bị ảnh hưởng.
  Future<void> clearAllReadingState({
    required String ownerScope,
  }) async {
    await _db.transaction((txn) async {
      await txn.delete(
        'local_reading_progress',
        where: 'owner_scope = ?',
        whereArgs: [ownerScope],
      );
      await txn.delete(
        'local_reading_history',
        where: 'owner_scope = ?',
        whereArgs: [ownerScope],
      );
    });
  }

  /// Xóa lịch sử đọc của một truyện (xóa đồng bộ progress + history).
  Future<void> deleteStoryHistory({
    required String ownerScope,
    required String storyId,
  }) =>
      deleteStoryReadingState(ownerScope: ownerScope, storyId: storyId);

  /// Xóa toàn bộ lịch sử đọc của một scope (xóa đồng bộ progress + history).
  Future<void> clearAllHistory({
    required String ownerScope,
  }) =>
      clearAllReadingState(ownerScope: ownerScope);

  /// Lấy danh sách ID các chương đã đọc đạt ngưỡng threshold (mặc định 80%).
  Future<List<String>> getReadChapterIds({
    required String ownerScope,
    required String storyId,
    double threshold = 80.0,
  }) async {
    final rows = await _db.query(
      'local_reading_history',
      columns: ['chapter_id'],
      where: 'owner_scope = ? AND story_id = ? AND progress_percentage >= ?',
      whereArgs: [ownerScope, storyId, threshold],
    );
    return rows.map((r) => r['chapter_id'] as String).toList();
  }

  // ==================== ATOMIC SESSION TRANSACTION ====================

  /// Invariant 4: Atomic Reading Transaction.
  /// Lưu đồng thời cả `local_reading_progress` và `local_reading_history` trong cùng một SQLite Transaction.
  /// Invariant 5: Giữ Monotonic MAX cho tiến độ trong lịch sử.
  /// Nếu một trong hai thao tác lỗi (hoặc [onBeforeCommitHook] throw), toàn bộ transaction sẽ rollback.
  Future<void> recordReadingSession({
    required LocalReadingProgress progress,
    required LocalReadingHistory history,
    Future<void> Function()? onBeforeCommitHook,
  }) async {
    await _db.transaction((txn) async {
      // 1. Lưu tiến độ đọc hiện tại
      await txn.insert(
        'local_reading_progress',
        progress.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

      // 2. Kiểm tra tiến độ lịch sử cũ để giữ Monotonic MAX
      final existingRows = await txn.query(
        'local_reading_history',
        where: 'owner_scope = ? AND story_id = ? AND chapter_id = ?',
        whereArgs: [history.ownerScope, history.storyId, history.chapterId],
      );

      double maxProgress = history.progressPercentage;
      if (existingRows.isNotEmpty) {
        final prevProgress =
            (existingRows.first['progress_percentage'] as num).toDouble();
        if (prevProgress > maxProgress) {
          maxProgress = prevProgress;
        }
      }

      final effectiveHistory = history.copyWith(
        progressPercentage: maxProgress,
      );

      // 3. Lưu lịch sử đọc
      await txn.insert(
        'local_reading_history',
        effectiveHistory.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

      // 4. Hook kiểm thử rollback atomic
      if (onBeforeCommitHook != null) {
        await onBeforeCommitHook();
      }
    });
  }
}
