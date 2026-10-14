import 'dart:math' as math;
import 'package:sqflite/sqflite.dart';
import '../claim/models/guest_claim_models.dart';
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

  // ==================== GUEST CLAIM REBIND & RECONCILIATION ====================

  /// Kiểm tra xem partition của `ownerScope` có bất kỳ dữ liệu nào không (bookmarks, progress, history).
  /// Fail-closed: ném lỗi nếu truy vấn database thất bại.
  Future<bool> hasGuestData(String ownerScope) async {
    final bookmarksCount = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT COUNT(*) FROM local_library_bookmarks WHERE owner_scope = ?',
      [ownerScope],
    )) ?? 0;
    if (bookmarksCount > 0) return true;

    final progressCount = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT COUNT(*) FROM local_reading_progress WHERE owner_scope = ?',
      [ownerScope],
    )) ?? 0;
    if (progressCount > 0) return true;

    final historyCount = Sqflite.firstIntValue(await _db.rawQuery(
      'SELECT COUNT(*) FROM local_reading_history WHERE owner_scope = ?',
      [ownerScope],
    )) ?? 0;
    return historyCount > 0;
  }

  /// Trích xuất tập hợp distinct story_id từ cả 3 bảng của `ownerScope`.
  Future<Set<String>> getClaimedStoryIds(String ownerScope) async {
    final storyIds = <String>{};

    final bmRows = await _db.rawQuery(
      'SELECT DISTINCT story_id FROM local_library_bookmarks WHERE owner_scope = ?',
      [ownerScope],
    );
    for (final row in bmRows) {
      final id = row['story_id'] as String?;
      if (id != null && id.isNotEmpty) storyIds.add(id);
    }

    final progRows = await _db.rawQuery(
      'SELECT DISTINCT story_id FROM local_reading_progress WHERE owner_scope = ?',
      [ownerScope],
    );
    for (final row in progRows) {
      final id = row['story_id'] as String?;
      if (id != null && id.isNotEmpty) storyIds.add(id);
    }

    final histRows = await _db.rawQuery(
      'SELECT DISTINCT story_id FROM local_reading_history WHERE owner_scope = ?',
      [ownerScope],
    );
    for (final row in histRows) {
      final id = row['story_id'] as String?;
      if (id != null && id.isNotEmpty) storyIds.add(id);
    }

    return storyIds;
  }

  /// Rebind dữ liệu từ `sourceScope` sang `targetScope` và áp dụng Authoritative Finalization Snapshot.
  ///
  /// Thực thi toàn bộ trong một Transaction nguyên tử:
  /// 1. Bookmarks: Additive merge (INSERT OR IGNORE) vào targetScope, không bị lọc bởi tombstone.
  /// 2. Authoritative Snapshot Reconciliation:
  ///    - Nếu `finalization != null`:
  ///      * Lọc bỏ truyện trong `finalization.tombstonedStoryIds` (anti-resurrection).
  ///      * Ghép và validate metadata lịch sử từ bản ghi nguồn/đích trước khi cập nhật.
  ///      * Ghi đè authoritative progress (12 cột đầy đủ) và chapter read state vào targetScope.
  ///    - Nếu `finalization == null`:
  ///      * Fallback an toàn không phá hủy dữ liệu (non-destructive): merge bookmarks, nhưng bảo toàn
  ///        reading progress/history của khách và giữ journal record nếu có reading state chưa reconcile.
  /// 3. Purge dữ liệu sourceScope và xóa bản ghi `guest_claim_recovery_journal` tương ứng.
  /// 4. Atomic Rollback: Nếu bất kỳ bước nào lỗi (hoặc [onBeforeCommitHook] throw), toàn bộ transaction rollback.
  Future<void> rebindScope({
    required String sourceScope,
    required String targetScope,
    required String claimId,
    GuestClaimFinalizationData? finalization,
    Future<void> Function()? onBeforeCommitHook,
  }) async {
    await _db.transaction((txn) async {
      // 1. Bookmarks Additive Merge (INSERT OR IGNORE vào targetScope)
      final sourceBookmarks = await txn.query(
        'local_library_bookmarks',
        where: 'owner_scope = ?',
        whereArgs: [sourceScope],
      );

      for (final bmRow in sourceBookmarks) {
        final targetBm = Map<String, dynamic>.from(bmRow);
        targetBm['owner_scope'] = targetScope;
        await txn.insert(
          'local_library_bookmarks',
          targetBm,
          conflictAlgorithm: ConflictAlgorithm.ignore,
        );
      }

      // 2. Kiểm tra xem sourceScope có reading progress / history không
      final sourceProgressCount = Sqflite.firstIntValue(await txn.rawQuery(
            'SELECT COUNT(*) FROM local_reading_progress WHERE owner_scope = ?',
            [sourceScope],
          )) ??
          0;
      final sourceHistoryCount = Sqflite.firstIntValue(await txn.rawQuery(
            'SELECT COUNT(*) FROM local_reading_history WHERE owner_scope = ?',
            [sourceScope],
          )) ??
          0;
      final hasSourceReadingState =
          sourceProgressCount > 0 || sourceHistoryCount > 0;

      if (finalization == null) {
        // Invariant 2: Non-destructive Legacy Fallback
        // Chỉ xóa bookmarks của sourceScope. Nếu có reading state, bảo toàn 100% partition và journal.
        await txn.delete(
          'local_library_bookmarks',
          where: 'owner_scope = ?',
          whereArgs: [sourceScope],
        );

        if (!hasSourceReadingState) {
          // Không có reading state -> an toàn xóa journal record
          await _deleteJournalRecord(txn, claimId, targetScope);
        }

        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook();
        }
        return;
      }

      // 3. Authoritative Reconciliation (Phương án A)
      final tombstonedSet = finalization.tombstonedStoryIds.toSet();

      // Invariant 3: Pre-validate và thu thập metadata lịch sử trước khi cập nhật
      // Thu thập metadata từ cả sourceScope và targetScope
      final existingHistoryRows = await txn.query(
        'local_reading_history',
        where: 'owner_scope = ? OR owner_scope = ?',
        whereArgs: [sourceScope, targetScope],
      );

      // Map (storyId, chapterId) -> row
      final exactHistoryMap = <String, Map<String, dynamic>>{};
      // Map storyId -> row (dùng để fallback metadata truyện khi chapter mới)
      final storyMetadataMap = <String, Map<String, dynamic>>{};

      for (final row in existingHistoryRows) {
        final sId = row['story_id'] as String;
        final cId = row['chapter_id'] as String;
        exactHistoryMap['$sId:$cId'] = row;
        storyMetadataMap.putIfAbsent(sId, () => row);
      }

      // 3.1 Reconcile Reading History (Authoritative)
      for (final readState in finalization.finalizedChapterReadStates) {
        if (tombstonedSet.contains(readState.storyId)) {
          continue; // Anti-resurrection: loại trừ truyện bị tombstone
        }

        final exactMeta = exactHistoryMap['${readState.storyId}:${readState.chapterId}'];
        final storyMeta = storyMetadataMap[readState.storyId];

        final storyTitle = (exactMeta?['story_title'] ?? storyMeta?['story_title']) as String?;
        final chapterNumber = (exactMeta?['chapter_number'] ?? storyMeta?['chapter_number']) as String?;

        if (storyTitle == null || chapterNumber == null) {
          throw StateError(
            'Missing required metadata for story ${readState.storyId}, chapter ${readState.chapterId}',
          );
        }

        final storySlug = (exactMeta?['story_slug'] ?? storyMeta?['story_slug']) as String?;
        final storyCoverUrl = (exactMeta?['story_cover_url'] ?? storyMeta?['story_cover_url']) as String?;
        final chapterTitle = exactMeta?['chapter_title'] as String?;

        DateTime lastReadAt;
        try {
          lastReadAt = DateTime.parse(readState.lastReadAt).toUtc();
        } catch (_) {
          lastReadAt = DateTime.now().toUtc();
        }

        final historyItem = LocalReadingHistory(
          ownerScope: targetScope,
          storyId: readState.storyId,
          chapterId: readState.chapterId,
          chapterVersionId: readState.chapterVersionId,
          storyTitle: storyTitle,
          storySlug: storySlug,
          storyCoverUrl: storyCoverUrl,
          chapterNumber: chapterNumber,
          chapterTitle: chapterTitle,
          progressPercentage: readState.progressPercentage,
          lastReadAt: lastReadAt,
        );

        await txn.insert(
          'local_reading_history',
          historyItem.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }

      // 3.2 Reconcile Reading Progress (Authoritative - Đầy đủ 12 cột NOT NULL)
      for (final prog in finalization.finalizedProgress) {
        if (tombstonedSet.contains(prog.storyId)) {
          continue; // Anti-resurrection
        }

        DateTime updatedAt;
        try {
          updatedAt = DateTime.parse(prog.updatedAt).toUtc();
        } catch (_) {
          updatedAt = DateTime.now().toUtc();
        }

        final deviceTimestamp = prog.deviceTimestamp != null
            ? DateTime.fromMillisecondsSinceEpoch(prog.deviceTimestamp!, isUtc: true)
            : updatedAt;

        final targetProg = LocalReadingProgress(
          ownerScope: targetScope,
          storyId: prog.storyId,
          chapterId: prog.chapterId,
          chapterVersionId: prog.chapterVersionId,
          readingMode: prog.readingMode.value,
          progressPercentage: prog.progressPercentage,
          scrollPosition: prog.scrollPosition,
          pageIndex: prog.pageIndex >= 1 ? prog.pageIndex : 1,
          anchorBlockId: prog.anchorBlockId,
          textOffset: prog.textOffset,
          updatedAt: updatedAt,
          deviceTimestamp: deviceTimestamp,
        );

        await txn.insert(
          'local_reading_progress',
          targetProg.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }

      // 4. Purge Partition Khách (sourceScope)
      await txn.delete(
        'local_library_bookmarks',
        where: 'owner_scope = ?',
        whereArgs: [sourceScope],
      );
      await txn.delete(
        'local_reading_progress',
        where: 'owner_scope = ?',
        whereArgs: [sourceScope],
      );
      await txn.delete(
        'local_reading_history',
        where: 'owner_scope = ?',
        whereArgs: [sourceScope],
      );

      // 5. Xóa Checkpoint Recovery Journal cho claimId với bảo vệ quyền sở hữu
      await _deleteJournalRecord(txn, claimId, targetScope);

      // 6. Hook kiểm thử rollback atomic
      if (onBeforeCommitHook != null) {
        await onBeforeCommitHook();
      }
    });
  }

  /// Helper xóa bản ghi trong recovery journal với kiểm tra an toàn quyền sở hữu claimId & userId
  Future<void> _deleteJournalRecord(
    DatabaseExecutor txn,
    String claimId,
    String targetScope,
  ) async {
    final expectedUserId = targetScope.startsWith('account:')
        ? targetScope.substring('account:'.length)
        : targetScope;

    final journalRows = await txn.query(
      'guest_claim_recovery_journal',
      where: 'claim_id = ?',
      whereArgs: [claimId],
      limit: 1,
    );

    if (journalRows.isNotEmpty) {
      final journalUserId = journalRows.first['user_id'] as String?;
      if (journalUserId != null &&
          journalUserId.isNotEmpty &&
          journalUserId != expectedUserId) {
        throw StateError(
          'Security guard: Recovery journal $claimId belongs to user $journalUserId, cannot be deleted by $expectedUserId',
        );
      }
    }

    await txn.delete(
      'guest_claim_recovery_journal',
      where: 'claim_id = ?',
      whereArgs: [claimId],
    );
  }
}
