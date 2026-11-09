import 'dart:math' as math;

import 'package:sqflite/sqflite.dart';

import '../../identity/guest_profile_identity_provider.dart';
import '../../storage/local_library_models.dart';
import '../../storage/offline_database.dart';
import '../authority/sync_write_admission.dart';
import '../errors/sync_storage_exceptions.dart';
import '../models/sync_models.dart';
import '../utils/canonical_entity_key.dart';
import '../utils/revision_bigint.dart';

/// Mobile Authoritative Sync Storage DAL (Phase 7C.4 Stage 1 — SQLite v5).
///
/// Chịu trách nhiệm quản trị bền vững:
/// - Authoritative shadow replicas (`sync_authoritative_replicas`) + OCC checkpoint (`sync_meta`).
/// - Pending mutations FIFO bền vững qua `sync_mutation_sequences` (`P1-M03`).
/// - Atomic Local Write + Enqueue cho reading progress, history, bookmarks, preferences.
/// - Quarantine full-fidelity & requeue guards (`P1-M04`).
/// - Snapshot staging session/revision consistency (`P1-M04`).
/// - Fail-closed Baseline Lifecycle (`UNINITIALIZED -> BOOTSTRAPPING -> [READY bị khóa ở Stage 1]`).
/// - Cưỡng chế ranh giới thẩm quyền `account:*` vs Guest-local (`P0-M05`), bắt buộc
///   capability admission 4 hàng rào (`P0-M06`), reading mode fail-closed (`P1-M07`),
///   và `clientId` UUIDv4 tách biệt (`P1-M08`).
///
/// Stage 1 boundary: KHÔNG gọi mạng `/sync/*`, KHÔNG chạy Background SyncWorker,
/// và KHÔNG tự cấp trạng thái `READY`.
class SyncStorageDal {
  /// Ngân sách retry mặc định khi tranh chấp `BEGIN IMMEDIATE` gặp `SQLITE_BUSY` (khớp `PRAGMA busy_timeout = 5000`).
  static const Duration defaultBusyRetryTimeout = Duration(milliseconds: 5000);

  final OfflineDatabase? _offlineDatabase;
  final Database? _customDb;
  final Future<Database> Function()? _asyncDbProvider;
  final Duration _busyRetryTimeout;

  SyncStorageDal({
    OfflineDatabase? offlineDatabase,
    Database? customDb,
    Future<Database> Function()? asyncDatabaseProvider,
    Duration busyRetryTimeout = defaultBusyRetryTimeout,
  })  : _offlineDatabase = offlineDatabase,
        _customDb = customDb,
        _asyncDbProvider = asyncDatabaseProvider,
        _busyRetryTimeout = busyRetryTimeout {
    if (_offlineDatabase == null &&
        _customDb == null &&
        _asyncDbProvider == null) {
      throw ArgumentError(
        'Phải cung cấp ít nhất offlineDatabase, customDb hoặc asyncDatabaseProvider cho SyncStorageDal.',
      );
    }
    if (_busyRetryTimeout.isNegative) {
      throw ArgumentError.value(
        busyRetryTimeout,
        'busyRetryTimeout',
        'busyRetryTimeout must be non-negative.',
      );
    }
  }

  Future<Database> _acquireDatabase() async {
    final asyncProvider = _asyncDbProvider;
    if (asyncProvider != null) {
      return await asyncProvider();
    }
    return _customDb ?? _offlineDatabase!.database;
  }

  static bool _isSqliteBusyException(DatabaseException error) {
    final code = error.getResultCode();
    if (code != null) {
      // Primary SQLITE_BUSY = 5; các extended code (261, 517, 773) có 8 bit thấp == 5.
      // Phân biệt rành mạch với SQLITE_LOCKED (6, intra-connection table lock) và lỗi constraint.
      return (code & 0xFF) == 5;
    }
    final normalized = error.toString().toLowerCase();
    if (normalized.contains('database table is locked')) {
      return false;
    }
    return normalized.contains('database is locked') ||
        normalized.contains('sqlite_busy');
  }

  /// Thực thi write operation trong native SQLite transaction với 4 hàng rào
  /// [SyncWriteAdmission] bắt buộc (`P0-M02` + `P0-M06`) và cơ chế async retry có giới hạn
  /// khi `BEGIN IMMEDIATE` gặp `SQLITE_BUSY`.
  ///
  /// Bốn hàng rào admission:
  /// 1. Trước khi chạm / mở DB handle (và trước mỗi lần thử lại sau `SQLITE_BUSY`).
  /// 2. Ngay sau khi acquire DB handle xong (bao gồm sau mọi `await` bất đồng bộ).
  /// 3. Ngay khi bước vào native SQLite transaction (`BEGIN IMMEDIATE`).
  /// 4. Ngay trước khi transaction kết thúc để commit (sau SQLite writes + hooks).
  Future<T> _runWriteTransaction<T>({
    required String targetScope,
    required SyncWriteAdmission admission,
    required Future<T> Function(Transaction txn) action,
  }) async {
    final stopwatch = Stopwatch()..start();
    var attempt = 0;

    while (true) {
      // Barrier 1: Trước khi chạm DB hoặc bắt đầu retry attempt mới
      admission.assertAdmitted(targetScope);
      final db = await _acquireDatabase();
      // Barrier 2: Ngay sau khi acquire DB (bắt kịp revocation trong lúc await DB)
      admission.assertAdmitted(targetScope);

      var enteredAction = false;
      try {
        return await db.transaction<T>((txn) async {
          enteredAction = true;
          // Barrier 3: Ngay khi đã nắm native SQLite transaction lock
          admission.assertAdmitted(targetScope);
          final result = await action(txn);
          // Barrier 4: Ngay trước khi commit (sau toàn bộ ghi và onBeforeCommitHook)
          admission.assertAdmitted(targetScope);
          return result;
        });
      } on DatabaseException catch (e) {
        if (enteredAction || !_isSqliteBusyException(e)) {
          rethrow;
        }
        final remaining = _busyRetryTimeout - stopwatch.elapsed;
        if (remaining <= Duration.zero) {
          rethrow;
        }
        attempt++;
        final baseMs = math.min(50, 10 * (1 << math.min(attempt - 1, 3)));
        final delayMs = math.min(baseMs, remaining.inMilliseconds);
        await Future<void>.delayed(
          Duration(milliseconds: delayMs > 0 ? delayMs : 1),
        );
      }
    }
  }

  Future<int> _allocateNextSequenceNo(
    Transaction txn,
    String ownerScope,
  ) async {
    await txn.rawInsert(
      'INSERT OR IGNORE INTO sync_mutation_sequences (owner_scope, last_sequence_no) VALUES (?, 0)',
      <Object?>[ownerScope],
    );
    await txn.rawUpdate(
      'UPDATE sync_mutation_sequences SET last_sequence_no = last_sequence_no + 1 WHERE owner_scope = ?',
      <Object?>[ownerScope],
    );
    final rows = await txn.query(
      'sync_mutation_sequences',
      columns: <String>['last_sequence_no'],
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      limit: 1,
    );
    if (rows.isEmpty) {
      throw StateError(
        'Failed to allocate FIFO sequence_no for scope "$ownerScope".',
      );
    }
    return (rows.first['last_sequence_no'] as num).toInt();
  }

  Future<void> _ensureMinimumSequenceNo(
    Transaction txn,
    String ownerScope,
    int minSeqNo,
  ) async {
    await txn.rawInsert(
      'INSERT OR IGNORE INTO sync_mutation_sequences (owner_scope, last_sequence_no) VALUES (?, 0)',
      <Object?>[ownerScope],
    );
    await txn.rawUpdate(
      'UPDATE sync_mutation_sequences SET last_sequence_no = MAX(last_sequence_no, ?) WHERE owner_scope = ?',
      <Object?>[minSeqNo, ownerScope],
    );
  }

  void _validateClientIdForAccountScope(String ownerScope, String clientId) {
    assertAccountScope(ownerScope);
    if (!isValidUuidV4(clientId)) {
      throw InvalidClientIdentityException(
        clientId,
        'INVALID_CLIENT_IDENTITY: clientId "$clientId" must be a valid RFC4122 UUIDv4.',
      );
    }
    final accountUserId = ownerScope.substring('account:'.length).trim();
    if (clientId.trim().toLowerCase() == accountUserId.toLowerCase()) {
      throw InvalidClientIdentityException(
        clientId,
        'CLIENT_ID_IDENTITY_COLLISION: clientId "$clientId" must not match account userId "$accountUserId".',
      );
    }
  }

  void _validatePendingMutationFields(PendingMutationRecord mutation) {
    assertAccountScope(mutation.ownerScope);
    if (mutation.mutationId.trim().isEmpty) {
      throw ArgumentError('mutationId must be a non-empty string.');
    }
    _validateClientIdForAccountScope(mutation.ownerScope, mutation.clientId);
    if (mutation.entityId.trim().isEmpty) {
      throw ArgumentError('entityId must be a non-empty string.');
    }
    if (!isValidRevisionString(mutation.baseServerRevision)) {
      throw ArgumentError(
        'Invalid baseServerRevision "${mutation.baseServerRevision}". Expected canonical 64-bit BIGINT decimal string.',
      );
    }
    if (mutation.domain == SyncDomain.progress &&
        mutation.operation == SyncOperation.upsert &&
        mutation.payload.containsKey('readingMode')) {
      final rawMode = mutation.payload['readingMode'];
      normalizeSyncReadingMode(rawMode is String ? rawMode : null);
    }
  }

  Future<PendingMutationRecord> _insertPendingMutationInTxn(
    Transaction txn,
    PendingMutationRecord mutation, {
    bool preserveSequenceIfAvailable = false,
  }) async {
    _validatePendingMutationFields(mutation);

    int assignedSeqNo;
    if (preserveSequenceIfAvailable && mutation.sequenceNo > 0) {
      final collisionRows = await txn.query(
        'pending_mutations',
        columns: <String>['mutation_id'],
        where: 'owner_scope = ? AND sequence_no = ?',
        whereArgs: <Object?>[mutation.ownerScope, mutation.sequenceNo],
        limit: 1,
      );
      if (collisionRows.isEmpty) {
        assignedSeqNo = mutation.sequenceNo;
        await _ensureMinimumSequenceNo(
          txn,
          mutation.ownerScope,
          assignedSeqNo,
        );
      } else {
        assignedSeqNo = await _allocateNextSequenceNo(txn, mutation.ownerScope);
      }
    } else {
      assignedSeqNo = await _allocateNextSequenceNo(txn, mutation.ownerScope);
    }

    final persisted = mutation.copyWith(sequenceNo: assignedSeqNo);
    try {
      await txn.insert(
        'pending_mutations',
        persisted.toMap(),
        conflictAlgorithm: ConflictAlgorithm.abort,
      );
    } on DatabaseException catch (e) {
      if (e.isUniqueConstraintError()) {
        throw DuplicateMutationException(
          'DUPLICATE_MUTATION: Pending mutation "${mutation.mutationId}" already exists for scope "${mutation.ownerScope}".',
          e,
        );
      }
      rethrow;
    }

    return persisted;
  }

  // ==================== ATOMIC LOCAL WRITE + PENDING ENQUEUE ====================

  /// Ghi đồng thời `local_reading_progress` + Monotonic MAX `local_reading_history`
  /// + enqueue mutation vào `pending_mutations` (`P1-M03`) trong một SQLite transaction duy nhất.
  ///
  /// Yêu cầu nghiêm ngặt `account:<userId>` (`P0-M05`), [AccountWriteAdmission] bắt buộc (`P0-M06`),
  /// `readingMode` fail-closed (`P1-M07`), và `clientId` UUIDv4 tách biệt (`P1-M08`).
  Future<PendingMutationRecord> recordReadingSessionWithMutation({
    required LocalReadingProgress progress,
    required LocalReadingHistory history,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(progress.ownerScope);
    assertAccountScope(history.ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (progress.ownerScope != mutation.ownerScope ||
        history.ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: progress (${progress.ownerScope}) / history (${history.ownerScope}) != mutation (${mutation.ownerScope}).',
      );
    }
    if (mutation.domain != SyncDomain.progress &&
        mutation.domain != SyncDomain.history) {
      throw ArgumentError(
        'Domain mismatch: expected PROGRESS or HISTORY, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.upsert) {
      throw ArgumentError(
        'Operation mismatch: expected UPSERT, got ${mutation.operation.wireValue}.',
      );
    }
    if (mutation.domain == SyncDomain.progress &&
        mutation.entityId != progress.storyId) {
      throw ArgumentError(
        'EntityId mismatch: expected "${progress.storyId}", got "${mutation.entityId}".',
      );
    }
    normalizeSyncReadingMode(progress.readingMode);
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: mutation.ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.insert(
          'local_reading_progress',
          progress.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );

        final existingHistoryRows = await txn.query(
          'local_reading_history',
          columns: <String>['progress_percentage'],
          where: 'owner_scope = ? AND story_id = ? AND chapter_id = ?',
          whereArgs: <Object?>[
            history.ownerScope,
            history.storyId,
            history.chapterId,
          ],
          limit: 1,
        );

        var effectiveProgress = history.progressPercentage;
        if (existingHistoryRows.isNotEmpty) {
          final prevProgress =
              (existingHistoryRows.first['progress_percentage'] as num)
                  .toDouble();
          if (prevProgress > effectiveProgress) {
            effectiveProgress = prevProgress;
          }
        }

        final effectiveHistory =
            history.copyWith(progressPercentage: effectiveProgress);
        await txn.insert(
          'local_reading_history',
          effectiveHistory.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );

        final persisted = await _insertPendingMutationInTxn(txn, mutation);

        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  /// Lưu bookmark cục bộ (`local_library_bookmarks`) và enqueue `BOOKMARK UPSERT` nguyên tử.
  Future<PendingMutationRecord> putBookmarkWithMutation({
    required LocalBookmark bookmark,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(bookmark.ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (bookmark.ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: bookmark (${bookmark.ownerScope}) != mutation (${mutation.ownerScope}).',
      );
    }
    if (mutation.domain != SyncDomain.bookmark) {
      throw ArgumentError(
        'Domain mismatch: expected BOOKMARK, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.upsert) {
      throw ArgumentError(
        'Operation mismatch: expected UPSERT, got ${mutation.operation.wireValue}.',
      );
    }
    if (mutation.entityId != bookmark.storyId) {
      throw ArgumentError(
        'EntityId mismatch: expected "${bookmark.storyId}", got "${mutation.entityId}".',
      );
    }
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: mutation.ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.insert(
          'local_library_bookmarks',
          bookmark.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  /// Xóa bookmark cục bộ và enqueue `BOOKMARK DELETE` nguyên tử.
  Future<PendingMutationRecord> deleteBookmarkWithMutation({
    required String ownerScope,
    required String storyId,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: "$ownerScope" != "${mutation.ownerScope}".',
      );
    }
    if (mutation.domain != SyncDomain.bookmark) {
      throw ArgumentError(
        'Domain mismatch: expected BOOKMARK, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.delete) {
      throw ArgumentError(
        'Operation mismatch: expected DELETE, got ${mutation.operation.wireValue}.',
      );
    }
    if (mutation.entityId != storyId) {
      throw ArgumentError(
        'EntityId mismatch: expected "$storyId", got "${mutation.entityId}".',
      );
    }
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'local_library_bookmarks',
          where: 'owner_scope = ? AND story_id = ?',
          whereArgs: <Object?>[ownerScope, storyId],
        );
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  /// Lưu preference theo Account scope (`local_preferences`) và enqueue `PREFERENCE UPSERT` nguyên tử.
  Future<PendingMutationRecord> putPreferenceWithMutation({
    required LocalPreferenceRecord preference,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(preference.ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (preference.ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: preference (${preference.ownerScope}) != mutation (${mutation.ownerScope}).',
      );
    }
    if (mutation.domain != SyncDomain.preference) {
      throw ArgumentError(
        'Domain mismatch: expected PREFERENCE, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.upsert) {
      throw ArgumentError(
        'Operation mismatch: expected UPSERT, got ${mutation.operation.wireValue}.',
      );
    }
    if (mutation.entityId != preference.prefKey) {
      throw ArgumentError(
        'EntityId mismatch: expected "${preference.prefKey}", got "${mutation.entityId}".',
      );
    }
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: preference.ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.insert(
          'local_preferences',
          preference.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  /// Xóa lịch sử + tiến độ cục bộ của 1 truyện (bảo toàn bookmark) và enqueue `HISTORY DELETE` nguyên tử.
  Future<PendingMutationRecord> deleteStoryHistoryWithMutation({
    required String ownerScope,
    required String storyId,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: "$ownerScope" != "${mutation.ownerScope}".',
      );
    }
    if (mutation.domain != SyncDomain.history) {
      throw ArgumentError(
        'Domain mismatch: expected HISTORY, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.delete) {
      throw ArgumentError(
        'Operation mismatch: expected DELETE, got ${mutation.operation.wireValue}.',
      );
    }
    if (mutation.entityId != storyId) {
      throw ArgumentError(
        'EntityId mismatch: expected "$storyId", got "${mutation.entityId}".',
      );
    }
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'local_reading_history',
          where: 'owner_scope = ? AND story_id = ?',
          whereArgs: <Object?>[ownerScope, storyId],
        );
        await txn.delete(
          'local_reading_progress',
          where: 'owner_scope = ? AND story_id = ?',
          whereArgs: <Object?>[ownerScope, storyId],
        );
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  /// Xóa toàn bộ lịch sử + tiến độ cục bộ của scope (bảo toàn bookmark)
  /// và enqueue Global `HISTORY DELETE` (`all` hoặc sentinel UUID) nguyên tử.
  Future<PendingMutationRecord> clearAllHistoryWithMutation({
    required String ownerScope,
    required PendingMutationRecord mutation,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    assertAccountScope(mutation.ownerScope);

    if (ownerScope != mutation.ownerScope) {
      throw ArgumentError(
        'Scope mismatch: "$ownerScope" != "${mutation.ownerScope}".',
      );
    }
    if (mutation.domain != SyncDomain.history) {
      throw ArgumentError(
        'Domain mismatch: expected HISTORY, got ${mutation.domain.wireValue}.',
      );
    }
    if (mutation.operation != SyncOperation.delete) {
      throw ArgumentError(
        'Operation mismatch: expected DELETE, got ${mutation.operation.wireValue}.',
      );
    }
    if (!isGlobalHistoryTarget(mutation.entityId)) {
      throw ArgumentError(
        'EntityId mismatch for clearAllHistory: expected "$kGlobalHistoryAlias" or "$kGlobalHistorySentinelUuid", got "${mutation.entityId}".',
      );
    }
    _validatePendingMutationFields(mutation);

    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'local_reading_history',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
        );
        await txn.delete(
          'local_reading_progress',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
        );
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  // ==================== PENDING MUTATIONS QUEUE (P1-M03) ====================

  /// Đưa mutation mới vào hàng đợi `pending_mutations` với `sequence_no` tăng đơn điệu bền vững.
  Future<PendingMutationRecord> enqueuePendingMutation(
    PendingMutationRecord mutation, {
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    _validatePendingMutationFields(mutation);
    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: mutation.ownerScope,
      admission: admission,
      action: (txn) async {
        final persisted = await _insertPendingMutationInTxn(txn, mutation);
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
        return persisted;
      },
    );
  }

  Future<PendingMutationRecord?> getPendingMutation(
    String ownerScope,
    String mutationId,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'pending_mutations',
      where: 'owner_scope = ? AND mutation_id = ?',
      whereArgs: <Object?>[ownerScope, mutationId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return PendingMutationRecord.fromMap(rows.first);
  }

  /// Lấy danh sách pending mutations của Account [ownerScope] đúng thứ tự FIFO theo `sequence_no ASC`.
  Future<List<PendingMutationRecord>> getPendingMutations(
    String ownerScope, {
    int limit = 100,
  }) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'pending_mutations',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      orderBy: 'sequence_no ASC',
      limit: limit,
    );
    return rows.map(PendingMutationRecord.fromMap).toList();
  }

  Future<void> deletePendingMutation(
    String ownerScope,
    String mutationId, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
        );
      },
    );
  }

  Future<void> deletePendingMutationsBatch(
    String ownerScope,
    List<String> mutationIds, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    if (mutationIds.isEmpty) {
      admission.assertAdmitted(ownerScope);
      return;
    }
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final placeholders =
            List<String>.filled(mutationIds.length, '?').join(',');
        await txn.delete(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id IN ($placeholders)',
          whereArgs: <Object?>[ownerScope, ...mutationIds],
        );
      },
    );
  }

  /// Nguyên tử hóa xử lý lỗi tạm thời: tăng `retry_count` + tính backoff hoặc chuyển sang
  /// `quarantined_mutations` trong cùng một SQLite transaction (`P1-M04`).
  Future<TransientFailureResult> recordTransientFailureAtomic({
    required String ownerScope,
    required String mutationId,
    required RecordTransientFailureOptions options,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    return _runWriteTransaction<TransientFailureResult>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
          limit: 1,
        );

        if (rows.isEmpty) {
          if (options.onBeforeCommitHook != null) {
            await options.onBeforeCommitHook!(txn);
          }
          return const TransientFailureResult(
            outcome: TransientFailureOutcome.notFound,
          );
        }

        final item = PendingMutationRecord.fromMap(rows.first);
        final newRetryCount = item.retryCount + 1;
        final now = DateTime.now().toUtc();
        final nowIso = now.toIso8601String();
        final nowMs = now.millisecondsSinceEpoch;

        if (newRetryCount >= options.maxRetries) {
          await txn.delete(
            'pending_mutations',
            where: 'owner_scope = ? AND mutation_id = ?',
            whereArgs: <Object?>[ownerScope, mutationId],
          );

          final quarantined = QuarantinedMutationRecord(
            ownerScope: item.ownerScope,
            mutationId: item.mutationId,
            clientId: item.clientId,
            domain: item.domain,
            entityId: item.entityId,
            operation: item.operation,
            baseServerRevision: item.baseServerRevision,
            observedHistoryEpoch: item.observedHistoryEpoch,
            payload: item.payload,
            originalSequenceNo: item.sequenceNo,
            originalRetryCount: item.retryCount,
            originalCreatedAtIso: item.createdAtIso,
            originalCreatedAtMs: item.createdAtMs,
            rejectionReason: 'EXCEEDED_MAX_RETRIES: ${options.failureReason}',
            rejectionStatus: 'EXCEEDED_MAX_RETRIES',
            rejectedAtIso: nowIso,
            rejectedAtMs: nowMs,
            triageStatus: QuarantineTriageStatus.pending,
            causalEvidence: null,
          );

          await txn.insert(
            'quarantined_mutations',
            quarantined.toMap(),
            conflictAlgorithm: ConflictAlgorithm.replace,
          );

          if (options.onBeforeCommitHook != null) {
            await options.onBeforeCommitHook!(txn);
          }

          return TransientFailureResult(
            outcome: TransientFailureOutcome.quarantined,
            retryCount: newRetryCount,
            quarantinedMutation: quarantined,
          );
        } else {
          final rawDelay = options.initialBackoffMs *
              math.pow(options.backoffFactor, newRetryCount - 1);
          final delayMs = math.max(
            0,
            math.min(options.maxBackoffMs, rawDelay.round()),
          );
          final nextRetryAtMs = nowMs + delayMs;

          await txn.update(
            'pending_mutations',
            <String, Object?>{
              'retry_count': newRetryCount,
              'next_retry_at_ms': nextRetryAtMs,
            },
            where: 'owner_scope = ? AND mutation_id = ?',
            whereArgs: <Object?>[ownerScope, mutationId],
          );

          if (options.onBeforeCommitHook != null) {
            await options.onBeforeCommitHook!(txn);
          }

          return TransientFailureResult(
            outcome: TransientFailureOutcome.retryScheduled,
            retryCount: newRetryCount,
            nextRetryAtMs: nextRetryAtMs,
          );
        }
      },
    );
  }

  // ==================== QUARANTINED MUTATIONS (P1-M04) ====================

  /// Chuyển 1 mutation từ `pending_mutations` sang `quarantined_mutations` theo composite key,
  /// bảo toàn 100% metadata nguyên bản (`P1-M04`).
  Future<QuarantinedMutationRecord?> quarantinePendingMutationByKey({
    required String ownerScope,
    required String mutationId,
    required String reason,
    String status = 'MANUAL',
    CausalTriageProof? causalEvidence,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    return _runWriteTransaction<QuarantinedMutationRecord?>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
          limit: 1,
        );
        if (rows.isEmpty) return null;

        final target = PendingMutationRecord.fromMap(rows.first);
        await txn.delete(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
        );

        final now = DateTime.now().toUtc();
        final quarantined = QuarantinedMutationRecord(
          ownerScope: target.ownerScope,
          mutationId: target.mutationId,
          clientId: target.clientId,
          domain: target.domain,
          entityId: target.entityId,
          operation: target.operation,
          baseServerRevision: target.baseServerRevision,
          observedHistoryEpoch: target.observedHistoryEpoch,
          payload: target.payload,
          originalSequenceNo: target.sequenceNo,
          originalRetryCount: target.retryCount,
          originalCreatedAtIso: target.createdAtIso,
          originalCreatedAtMs: target.createdAtMs,
          rejectionReason: reason,
          rejectionStatus: status,
          rejectedAtIso: now.toIso8601String(),
          rejectedAtMs: now.millisecondsSinceEpoch,
          triageStatus: QuarantineTriageStatus.pending,
          causalEvidence: causalEvidence,
        );

        await txn.insert(
          'quarantined_mutations',
          quarantined.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        return quarantined;
      },
    );
  }

  /// Ghi bản ghi vào `quarantined_mutations` và xóa khỏi `pending_mutations` nếu còn tồn tại.
  Future<void> quarantineMutation(
    QuarantinedMutationRecord record, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(record.ownerScope);
    if (record.mutationId.trim().isEmpty) {
      throw ArgumentError('mutationId must be a non-empty string.');
    }
    _validateClientIdForAccountScope(record.ownerScope, record.clientId);
    if (!isValidRevisionString(record.baseServerRevision)) {
      throw ArgumentError(
        'Invalid baseServerRevision "${record.baseServerRevision}". Expected canonical 64-bit BIGINT decimal string.',
      );
    }

    await _runWriteTransaction<void>(
      targetScope: record.ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[record.ownerScope, record.mutationId],
        );
        await txn.insert(
          'quarantined_mutations',
          record.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      },
    );
  }

  Future<QuarantinedMutationRecord?> getQuarantinedMutation(
    String ownerScope,
    String mutationId,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'quarantined_mutations',
      where: 'owner_scope = ? AND mutation_id = ?',
      whereArgs: <Object?>[ownerScope, mutationId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return QuarantinedMutationRecord.fromMap(rows.first);
  }

  Future<List<QuarantinedMutationRecord>> getQuarantinedMutations(
    String ownerScope,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'quarantined_mutations',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      orderBy: 'rejected_at_ms DESC, mutation_id ASC',
    );
    return rows.map(QuarantinedMutationRecord.fromMap).toList();
  }

  Future<void> deleteQuarantinedMutation(
    String ownerScope,
    String mutationId, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'quarantined_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
        );
      },
    );
  }

  /// Đưa mutation từ `quarantined_mutations` trở lại `pending_mutations` với `retry_count = 0`.
  ///
  /// - Cấm tuyệt đối `REJECTED_TOMBSTONE` (chống phục sinh dữ liệu).
  /// - Khóa `REJECTED_STALE` và `HTTP_410_GONE` ở Stage 1 cho tới Stage 3 Causal Triage Engine.
  Future<PendingMutationRecord> requeueQuarantinedMutation({
    required String ownerScope,
    required String mutationId,
    CausalTriageProof? triageProof,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    return _runWriteTransaction<PendingMutationRecord>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'quarantined_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
          limit: 1,
        );
        if (rows.isEmpty) {
          throw StateError(
            'Quarantined mutation [$ownerScope, $mutationId] not found.',
          );
        }

        final q = QuarantinedMutationRecord.fromMap(rows.first);

        if (q.rejectionStatus == 'REJECTED_TOMBSTONE') {
          throw const RequeueProhibitedError(
            'REQUEUE_PROHIBITED: Cannot requeue REJECTED_TOMBSTONE mutation. Entity has authoritative tombstone on server.',
          );
        }

        if (q.rejectionStatus == 'REJECTED_STALE' ||
            q.rejectionStatus == 'HTTP_410_GONE') {
          throw const RequeueProhibitedError(
            'REQUEUE_PROHIBITED: Requeuing REJECTED_STALE or HTTP_410_GONE mutations is locked until Stage 3 Causal Triage Engine is implemented.',
          );
        }

        await txn.delete(
          'quarantined_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
        );

        final restored = PendingMutationRecord(
          ownerScope: q.ownerScope,
          mutationId: q.mutationId,
          sequenceNo: q.originalSequenceNo ?? 0,
          clientId: q.clientId,
          domain: q.domain,
          entityId: q.entityId,
          operation: q.operation,
          baseServerRevision: q.baseServerRevision,
          observedHistoryEpoch: q.observedHistoryEpoch,
          payload: q.payload,
          retryCount: 0,
          nextRetryAtMs: null,
          createdAtIso: q.originalCreatedAtIso,
          createdAtMs: q.originalCreatedAtMs,
        );

        return _insertPendingMutationInTxn(
          txn,
          restored,
          preserveSequenceIfAvailable: true,
        );
      },
    );
  }

  /// Anti-Tombstone Resurrection: xóa đồng thời bản sao cục bộ/shadow và pending mutation
  /// trong một SQLite transaction duy nhất.
  Future<void> evictReplicaAndRemovePending({
    required String ownerScope,
    required SyncDomain domain,
    required String entityId,
    required String mutationId,
    Map<String, Object?>? payload,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        switch (domain) {
          case SyncDomain.bookmark:
            await txn.delete(
              'local_library_bookmarks',
              where: 'owner_scope = ? AND story_id = ?',
              whereArgs: <Object?>[ownerScope, entityId],
            );
            await txn.delete(
              'sync_authoritative_replicas',
              where:
                  "owner_scope = ? AND domain = 'BOOKMARK' AND entity_key = ?",
              whereArgs: <Object?>[ownerScope, entityId],
            );
            break;

          case SyncDomain.progress:
            await txn.delete(
              'local_reading_progress',
              where: 'owner_scope = ? AND story_id = ?',
              whereArgs: <Object?>[ownerScope, entityId],
            );
            await txn.delete(
              'sync_authoritative_replicas',
              where:
                  "owner_scope = ? AND domain = 'PROGRESS' AND entity_key = ?",
              whereArgs: <Object?>[ownerScope, entityId],
            );
            break;

          case SyncDomain.history:
            if (isGlobalHistoryTarget(entityId)) {
              await txn.delete(
                'local_reading_history',
                where: 'owner_scope = ?',
                whereArgs: <Object?>[ownerScope],
              );
              await txn.delete(
                'local_reading_progress',
                where: 'owner_scope = ?',
                whereArgs: <Object?>[ownerScope],
              );
              await txn.delete(
                'sync_authoritative_replicas',
                where: "owner_scope = ? AND domain IN ('HISTORY', 'PROGRESS')",
                whereArgs: <Object?>[ownerScope],
              );
            } else {
              final payloadStoryId = _nonEmptyString(payload?['storyId']);
              final payloadChapterId = _nonEmptyString(payload?['chapterId']);
              final colonIdx = entityId.indexOf(':');

              if (payloadStoryId != null && payloadChapterId != null) {
                await txn.delete(
                  'local_reading_history',
                  where: 'owner_scope = ? AND story_id = ? AND chapter_id = ?',
                  whereArgs: <Object?>[
                    ownerScope,
                    payloadStoryId,
                    payloadChapterId,
                  ],
                );
                await txn.delete(
                  'sync_authoritative_replicas',
                  where:
                      "owner_scope = ? AND domain = 'HISTORY' AND entity_key = ?",
                  whereArgs: <Object?>[
                    ownerScope,
                    canonicalHistoryEntityKey(payloadStoryId, payloadChapterId),
                  ],
                );
              } else if (colonIdx > 0 && colonIdx < entityId.length - 1) {
                final sId = entityId.substring(0, colonIdx);
                final cId = entityId.substring(colonIdx + 1);
                await txn.delete(
                  'local_reading_history',
                  where: 'owner_scope = ? AND story_id = ? AND chapter_id = ?',
                  whereArgs: <Object?>[ownerScope, sId, cId],
                );
                await txn.delete(
                  'sync_authoritative_replicas',
                  where:
                      "owner_scope = ? AND domain = 'HISTORY' AND entity_key = ?",
                  whereArgs: <Object?>[ownerScope, entityId],
                );
              } else {
                await txn.delete(
                  'local_reading_history',
                  where: 'owner_scope = ? AND story_id = ?',
                  whereArgs: <Object?>[ownerScope, entityId],
                );
                await txn.delete(
                  'local_reading_progress',
                  where: 'owner_scope = ? AND story_id = ?',
                  whereArgs: <Object?>[ownerScope, entityId],
                );
                final escapedPrefix = '${escapeSqlLikePattern(entityId)}:%';
                await txn.delete(
                  'sync_authoritative_replicas',
                  where:
                      r"owner_scope = ? AND domain = 'HISTORY' AND (entity_key = ? OR entity_key LIKE ? ESCAPE '\')",
                  whereArgs: <Object?>[ownerScope, entityId, escapedPrefix],
                );
                await txn.delete(
                  'sync_authoritative_replicas',
                  where:
                      "owner_scope = ? AND domain = 'PROGRESS' AND entity_key = ?",
                  whereArgs: <Object?>[ownerScope, entityId],
                );
              }
            }
            break;

          case SyncDomain.preference:
            final prefKey = _nonEmptyString(payload?['key']) ?? entityId;
            await txn.delete(
              'local_preferences',
              where: 'owner_scope = ? AND pref_key = ?',
              whereArgs: <Object?>[ownerScope, prefKey],
            );
            await txn.delete(
              'sync_authoritative_replicas',
              where:
                  "owner_scope = ? AND domain = 'PREFERENCE' AND entity_key = ?",
              whereArgs: <Object?>[ownerScope, prefKey],
            );
            break;

          case SyncDomain.follow:
            await txn.delete(
              'sync_authoritative_replicas',
              where: "owner_scope = ? AND domain = 'FOLLOW' AND entity_key = ?",
              whereArgs: <Object?>[ownerScope, entityId],
            );
            break;
        }

        await txn.delete(
          'pending_mutations',
          where: 'owner_scope = ? AND mutation_id = ?',
          whereArgs: <Object?>[ownerScope, mutationId],
        );

        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      },
    );
  }

  // ==================== SCOPED PREFERENCES (P0-M05 EXPLICIT SPLIT) ====================

  /// Lưu tùy chọn cục bộ cho Guest (`guest:<guestProfileId>`) — KHÔNG enqueue sync mutation.
  Future<void> putGuestLocalPreference(
    LocalPreferenceRecord preference, {
    required GuestLocalWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertGuestScope(preference.ownerScope);
    await _runWriteTransaction<void>(
      targetScope: preference.ownerScope,
      admission: admission,
      action: (txn) async {
        await txn.insert(
          'local_preferences',
          preference.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      },
    );
  }

  /// Đọc tùy chọn cục bộ của Guest (`guest:<guestProfileId>`).
  Future<LocalPreferenceRecord?> getGuestLocalPreference(
    String guestScope,
    String prefKey,
  ) async {
    assertGuestScope(guestScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'local_preferences',
      where: 'owner_scope = ? AND pref_key = ?',
      whereArgs: <Object?>[guestScope, prefKey],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalPreferenceRecord.fromMap(rows.first);
  }

  /// Đọc toàn bộ tùy chọn cục bộ của Guest (`guest:<guestProfileId>`).
  Future<List<LocalPreferenceRecord>> getAllGuestLocalPreferences(
    String guestScope,
  ) async {
    assertGuestScope(guestScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'local_preferences',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[guestScope],
      orderBy: 'pref_key ASC',
    );
    return rows.map(LocalPreferenceRecord.fromMap).toList();
  }

  /// Xóa tùy chọn cục bộ của Guest (`guest:<guestProfileId>`).
  Future<void> deleteGuestLocalPreference(
    String guestScope,
    String prefKey, {
    required GuestLocalWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertGuestScope(guestScope);
    await _runWriteTransaction<void>(
      targetScope: guestScope,
      admission: admission,
      action: (txn) async {
        await txn.delete(
          'local_preferences',
          where: 'owner_scope = ? AND pref_key = ?',
          whereArgs: <Object?>[guestScope, prefKey],
        );
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      },
    );
  }

  /// Đọc tùy chọn cục bộ của Account (`account:<userId>`).
  /// Việc ghi preference đồng bộ của Account đi qua [putPreferenceWithMutation].
  Future<LocalPreferenceRecord?> getAccountLocalPreference(
    String ownerScope,
    String prefKey,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'local_preferences',
      where: 'owner_scope = ? AND pref_key = ?',
      whereArgs: <Object?>[ownerScope, prefKey],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalPreferenceRecord.fromMap(rows.first);
  }

  /// Đọc toàn bộ tùy chọn cục bộ của Account (`account:<userId>`).
  Future<List<LocalPreferenceRecord>> getAllAccountLocalPreferences(
    String ownerScope,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'local_preferences',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      orderBy: 'pref_key ASC',
    );
    return rows.map(LocalPreferenceRecord.fromMap).toList();
  }

  // ==================== SYNC META & FAIL-CLOSED BASELINE LIFECYCLE ====================

  Future<SyncMeta?> getSyncMeta(String ownerScope) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'sync_meta',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return SyncMeta.fromMap(rows.first);
  }

  /// Lưu metadata đồng bộ theo scope với cơ chế bảo vệ kép fail-closed:
  /// 1. Cấm nâng cấp scope chưa verified lên `READY`.
  /// 2. Khi scope đang ở `READY`, cấm sửa `lastSyncedServerRevision`, `minActiveRevision`
  ///    hoặc `effectiveHistoryEpochs` qua `putSyncMeta` (chỉ được sửa qua `applyAuthoritativeDeltaPage`).
  Future<void> putSyncMeta(
    SyncMeta meta, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(meta.ownerScope);
    if (!isValidRevisionString(meta.lastSyncedServerRevision)) {
      throw ArgumentError(
        'Invalid lastSyncedServerRevision: "${meta.lastSyncedServerRevision}".',
      );
    }
    if (!isValidRevisionString(meta.minActiveRevision)) {
      throw ArgumentError(
        'Invalid minActiveRevision: "${meta.minActiveRevision}".',
      );
    }

    await _runWriteTransaction<void>(
      targetScope: meta.ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'sync_meta',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[meta.ownerScope],
          limit: 1,
        );
        final existing = rows.isEmpty ? null : SyncMeta.fromMap(rows.first);

        if (meta.authoritativeBaselineStatus ==
                AuthoritativeBaselineStatus.ready &&
            existing?.authoritativeBaselineStatus !=
                AuthoritativeBaselineStatus.ready) {
          throw const ReadyStatusTransitionForbiddenError(
            'Cannot transition baseline status to READY via putSyncMeta without atomic baseline proof verification.',
          );
        }

        if (existing?.authoritativeBaselineStatus ==
            AuthoritativeBaselineStatus.ready) {
          if (meta.lastSyncedServerRevision !=
              existing!.lastSyncedServerRevision) {
            throw ReadyStatusTransitionForbiddenError(
              'CHECKPOINT_MUTATION_FORBIDDEN: Mutating lastSyncedServerRevision on a READY scope via putSyncMeta is forbidden (attempted "${existing.lastSyncedServerRevision}" -> "${meta.lastSyncedServerRevision}").',
            );
          }
          if (meta.minActiveRevision != existing.minActiveRevision) {
            throw ReadyStatusTransitionForbiddenError(
              'CHECKPOINT_MUTATION_FORBIDDEN: Mutating minActiveRevision on a READY scope via putSyncMeta is forbidden (attempted "${existing.minActiveRevision}" -> "${meta.minActiveRevision}").',
            );
          }
          if (!areEpochMapsEqual(
            meta.effectiveHistoryEpochs,
            existing.effectiveHistoryEpochs,
          )) {
            throw const ReadyStatusTransitionForbiddenError(
              'CHECKPOINT_MUTATION_FORBIDDEN: Mutating effectiveHistoryEpochs on a READY scope via putSyncMeta is forbidden.',
            );
          }
        }

        await txn.insert(
          'sync_meta',
          meta.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      },
    );
  }

  Future<AuthoritativeBaselineStatus> getAuthoritativeBaselineStatus(
    String ownerScope,
  ) async {
    assertAccountScope(ownerScope);
    final meta = await getSyncMeta(ownerScope);
    return meta?.authoritativeBaselineStatus ??
        AuthoritativeBaselineStatus.uninitialized;
  }

  /// Thiết lập trạng thái baseline (`UNINITIALIZED` hoặc `BOOTSTRAPPING`).
  /// CẤM TUYỆT ĐỐI truyền [AuthoritativeBaselineStatus.ready] ở Stage 1.
  Future<void> setAuthoritativeBaselineStatus(
    String ownerScope,
    AuthoritativeBaselineStatus status, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    if (status == AuthoritativeBaselineStatus.ready) {
      throw const ReadyStatusTransitionForbiddenError(
        'Transition to READY baseline status is forbidden in Stage 1. Direct transition via setAuthoritativeBaselineStatus is locked.',
      );
    }

    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'sync_meta',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
          limit: 1,
        );
        final existing = rows.isEmpty ? null : SyncMeta.fromMap(rows.first);
        final updated = existing != null
            ? existing.copyWith(authoritativeBaselineStatus: status)
            : SyncMeta(
                ownerScope: ownerScope,
                lastSyncedServerRevision: '0',
                minActiveRevision: '0',
                lastSyncTimestamp:
                    DateTime.fromMillisecondsSinceEpoch(0, isUtc: true)
                        .toIso8601String(),
                effectiveHistoryEpochs: const <String, int>{},
                syncState: SyncExecutionState.idle,
                authoritativeBaselineStatus: status,
              );
        await txn.insert(
          'sync_meta',
          updated.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      },
    );
  }

  Future<bool> isAuthoritativeReady(String ownerScope) async {
    assertAccountScope(ownerScope);
    final status = await getAuthoritativeBaselineStatus(ownerScope);
    return status == AuthoritativeBaselineStatus.ready;
  }

  /// Crash recovery: khi khởi động lại sau crash giữa chừng quá trình bootstrap,
  /// đưa scope đang ở `BOOTSTRAPPING` quay về fail-closed `UNINITIALIZED`.
  /// Giữ nguyên `lastSyncedServerRevision`, `minActiveRevision` và `effectiveHistoryEpochs`.
  Future<bool> recoverInterruptedBootstrapToUninitialized(
    String ownerScope, {
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    return _runWriteTransaction<bool>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final rows = await txn.query(
          'sync_meta',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
          limit: 1,
        );
        if (rows.isEmpty) return false;

        final existing = SyncMeta.fromMap(rows.first);
        if (existing.authoritativeBaselineStatus !=
            AuthoritativeBaselineStatus.bootstrapping) {
          return false;
        }

        await txn.update(
          'sync_meta',
          <String, Object?>{
            'authoritative_baseline_status':
                AuthoritativeBaselineStatus.uninitialized.wireValue,
            'sync_state': SyncExecutionState.idle.wireValue,
          },
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
        );
        return true;
      },
    );
  }

  // ==================== AUTHORITATIVE SHADOW READS & DELTA INGESTION ====================

  Future<AuthoritativeShadowRecord?> getAuthoritativeShadow(
    String ownerScope,
    SyncDomain domain,
    String entityKey,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'sync_authoritative_replicas',
      where: 'owner_scope = ? AND domain = ? AND entity_key = ?',
      whereArgs: <Object?>[ownerScope, domain.wireValue, entityKey],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return AuthoritativeShadowRecord.fromMap(rows.first);
  }

  Future<List<AuthoritativeShadowRecord>> getAuthoritativeShadowsByDomain(
    String ownerScope,
    SyncDomain domain,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'sync_authoritative_replicas',
      where: 'owner_scope = ? AND domain = ?',
      whereArgs: <Object?>[ownerScope, domain.wireValue],
      orderBy: 'entity_key ASC',
    );
    return rows.map(AuthoritativeShadowRecord.fromMap).toList();
  }

  Future<List<AuthoritativeShadowRecord>> getAllAuthoritativeShadows(
    String ownerScope,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'sync_authoritative_replicas',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      orderBy: 'domain ASC, entity_key ASC',
    );
    return rows.map(AuthoritativeShadowRecord.fromMap).toList();
  }

  /// Nạp một trang Authoritative Delta (`GET /api/v1/sync/changes`) vào Shadow Store
  /// + cập nhật `sync_meta` checkpoint & `effectiveHistoryEpochs` nguyên tử trong SQLite.
  ///
  /// Tuân thủ đầy đủ điều kiện Gate Review:
  /// - `P0-M01`: Cursor/pagination integrity, compacted retention gap, causal revision bounds.
  /// - `P0-M02`: Native SQLite transaction + OCC checkpoint verification trên DB.
  /// - `P0-M05` & `P0-M06`: Chỉ nhận `account:*` + bắt buộc [AccountWriteAdmission] 4 hàng rào.
  /// - `P1-M07`: Kiểm định fail-closed `readingMode` nếu delta `PROGRESS` mang trường này.
  /// - Bảo toàn nguyên trạng `authoritativeBaselineStatus` (không tự cấp `READY`).
  Future<ApplyAuthoritativeDeltaResult> applyAuthoritativeDeltaPage({
    required String ownerScope,
    required SyncChangesPage page,
    required String? expectedCheckpoint,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    admission.assertAdmitted(ownerScope);

    // 1. P0-M01: Validate mandatory OCC checkpoint & page metadata fail-closed
    if (!isValidRevisionString(expectedCheckpoint)) {
      throw InvalidDeltaPayloadError(
        'MANDATORY_OCC_CHECKPOINT_REQUIRED: expectedCheckpoint is mandatory and must be a valid canonical 64-bit BIGINT decimal string, got: "$expectedCheckpoint".',
      );
    }
    final validExpected = expectedCheckpoint!;

    if (!isValidRevisionString(page.currentServerRevision)) {
      throw InvalidDeltaPayloadError(
        'Invalid currentServerRevision: "${page.currentServerRevision}" must be a canonical 64-bit BIGINT decimal string.',
      );
    }

    if (!isValidRevisionString(page.minActiveRevision)) {
      throw InvalidDeltaPayloadError(
        'Invalid minActiveRevision: "${page.minActiveRevision}" must be a canonical 64-bit BIGINT decimal string.',
      );
    }

    // 2. P0-M01: Delta Pagination Cursor Integrity
    if (page.hasMore) {
      if (page.changes.isEmpty) {
        throw const InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: hasMore is true, but changes array is empty.',
        );
      }
      if (!isValidRevisionString(page.nextRevision)) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: hasMore is true, but nextRevision "${page.nextRevision}" is null or not a valid decimal string.',
        );
      }
      final lastChange = page.changes.last;
      if (!isValidRevisionString(lastChange.revision)) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: Last change in page has invalid revision "${lastChange.revision}".',
        );
      }
      if (page.nextRevision != lastChange.revision) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: nextRevision "${page.nextRevision}" does not match last change revision "${lastChange.revision}" when hasMore is true.',
        );
      }
    } else {
      if (page.nextRevision != null) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: hasMore is false, but nextRevision is not null (got: "${page.nextRevision}"). Core API contract requires nextRevision to be null when hasMore is false.',
        );
      }
    }

    final expCkptBigInt = parseRevisionBigInt(validExpected);
    final minActiveBigInt = parseRevisionBigInt(page.minActiveRevision);

    // 3. P0-M01: Compaction Retention Gap Guard
    if (validExpected != '0' && expCkptBigInt < minActiveBigInt) {
      throw InvalidDeltaPayloadError(
        'COMPACTED_RETENTION_GAP: Client checkpoint "$validExpected" is older than server minActiveRevision "${page.minActiveRevision}". Full snapshot resync required.',
      );
    }

    // 4. P0-M01: Determine target checkpoint & server boundary checks
    final targetCheckpoint =
        page.hasMore ? page.nextRevision! : page.currentServerRevision;
    final targetCkptBigInt = parseRevisionBigInt(targetCheckpoint);
    final currentServerBigInt = parseRevisionBigInt(page.currentServerRevision);

    if (targetCkptBigInt > currentServerBigInt) {
      throw InvalidDeltaPayloadError(
        'INCONSISTENT_DELTA_PAGE: targetCheckpoint "$targetCheckpoint" exceeds currentServerRevision "${page.currentServerRevision}".',
      );
    }
    if (targetCkptBigInt < expCkptBigInt) {
      throw InvalidDeltaPayloadError(
        'REGRESSIVE_CHECKPOINT: Target checkpoint "$targetCheckpoint" is less than expected checkpoint "$validExpected".',
      );
    }

    // 5. P0-M01 & P1-M07: Item-level validation
    BigInt? prevRev;
    for (var i = 0; i < page.changes.length; i++) {
      final change = page.changes[i];
      if (!isValidRevisionString(change.revision)) {
        throw InvalidDeltaPayloadError(
          'Delta change at index $i has invalid revision: "${change.revision}". Must be a canonical decimal string.',
        );
      }

      final revBigInt = parseRevisionBigInt(change.revision);
      if (revBigInt <= expCkptBigInt) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: Delta change at index $i has revision "${change.revision}" <= expectedCheckpoint "$validExpected".',
        );
      }
      if (revBigInt > targetCkptBigInt) {
        throw InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: Delta change at index $i has revision "${change.revision}" > targetCheckpoint "$targetCheckpoint".',
        );
      }
      if (prevRev != null && revBigInt < prevRev) {
        throw InvalidDeltaPayloadError(
          'Delta change at index $i has regressive revision: "${change.revision}" < "$prevRev". Changes must be in non-decreasing revision order.',
        );
      }
      prevRev = revBigInt;

      final parsedDomain = SyncDomain.tryFromWire(change.domain);
      if (parsedDomain == null) {
        throw InvalidDeltaPayloadError(
          'Delta change at index $i has unsupported domain: "${change.domain}".',
        );
      }

      final parsedOp = SyncOperation.tryFromWire(change.operation);
      if (parsedOp == null) {
        throw InvalidDeltaPayloadError(
          'Delta change at index $i has unsupported operation: "${change.operation}".',
        );
      }

      if (change.entityId.trim().isEmpty) {
        throw InvalidDeltaPayloadError(
          'Delta change at index $i has missing or empty entityId.',
        );
      }

      if (parsedDomain == SyncDomain.progress &&
          parsedOp == SyncOperation.upsert &&
          change.payload.containsKey('readingMode')) {
        final rawMode = change.payload['readingMode'];
        normalizeSyncReadingMode(rawMode is String ? rawMode : null);
      }

      if (parsedDomain == SyncDomain.history &&
          parsedOp == SyncOperation.delete) {
        final rawEpoch = change.payload['epoch'];
        if (rawEpoch is! int || rawEpoch <= 0) {
          throw InvalidDeltaPayloadError(
            'MISSING_HISTORY_DELETE_EPOCH: HISTORY DELETE at index $i must contain a valid positive integer epoch in payload, got: $rawEpoch.',
          );
        }
      }
    }

    // 6. P0-M02 + P0-M06: Atomic SQLite transaction with native OCC & 4-barrier admission
    return _runWriteTransaction<ApplyAuthoritativeDeltaResult>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        final metaRows = await txn.query(
          'sync_meta',
          where: 'owner_scope = ?',
          whereArgs: <Object?>[ownerScope],
          limit: 1,
        );
        final existingMeta =
            metaRows.isEmpty ? null : SyncMeta.fromMap(metaRows.first);
        final currentCheckpoint = existingMeta?.lastSyncedServerRevision ?? '0';

        if (validExpected != currentCheckpoint) {
          throw CheckpointConflictError(
            'OCC_CHECKPOINT_MISMATCH: Expected checkpoint "$validExpected", but current checkpoint is "$currentCheckpoint".',
          );
        }

        if (targetCkptBigInt < parseRevisionBigInt(currentCheckpoint)) {
          throw InvalidDeltaPayloadError(
            'REGRESSIVE_CHECKPOINT: Target checkpoint "$targetCheckpoint" is less than current checkpoint "$currentCheckpoint".',
          );
        }

        final effectiveEpochs = Map<String, int>.from(
          existingMeta?.effectiveHistoryEpochs ?? const <String, int>{},
        );
        final now = DateTime.now().toUtc();
        final nowMs = now.millisecondsSinceEpoch;

        for (final change in page.changes) {
          final domain = SyncDomain.fromWire(change.domain);
          final op = SyncOperation.fromWire(change.operation);
          final payload = change.payload;

          switch (domain) {
            case SyncDomain.bookmark:
              final entityKey = canonicalBookmarkEntityKey(
                _nonEmptyString(payload['storyId']) ?? change.entityId,
              );
              if (op == SyncOperation.upsert) {
                await _upsertShadow(
                  txn,
                  AuthoritativeShadowRecord(
                    ownerScope: ownerScope,
                    domain: SyncDomain.bookmark,
                    entityKey: entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload: payload,
                    isDeleted: false,
                    updatedAtMs: nowMs,
                  ),
                );
              } else {
                await _deleteShadow(
                  txn,
                  ownerScope,
                  SyncDomain.bookmark,
                  entityKey,
                );
              }
              break;

            case SyncDomain.progress:
              final entityKey = canonicalProgressEntityKey(
                _nonEmptyString(payload['storyId']) ?? change.entityId,
              );
              if (op == SyncOperation.upsert) {
                final epoch = _extractInt(payload['observedHistoryEpoch']) ??
                    _extractInt(payload['epoch']) ??
                    0;
                await _upsertShadow(
                  txn,
                  AuthoritativeShadowRecord(
                    ownerScope: ownerScope,
                    domain: SyncDomain.progress,
                    entityKey: entityKey,
                    serverRevision: change.revision,
                    epoch: epoch,
                    payload: payload,
                    isDeleted: false,
                    updatedAtMs: nowMs,
                  ),
                );
              } else {
                await _deleteShadow(
                  txn,
                  ownerScope,
                  SyncDomain.progress,
                  entityKey,
                );
              }
              break;

            case SyncDomain.preference:
              final entityKey = canonicalPreferenceEntityKey(
                _nonEmptyString(payload['key']) ?? change.entityId,
              );
              if (op == SyncOperation.upsert) {
                await _upsertShadow(
                  txn,
                  AuthoritativeShadowRecord(
                    ownerScope: ownerScope,
                    domain: SyncDomain.preference,
                    entityKey: entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload: payload,
                    isDeleted: false,
                    updatedAtMs: nowMs,
                  ),
                );
              } else {
                await _deleteShadow(
                  txn,
                  ownerScope,
                  SyncDomain.preference,
                  entityKey,
                );
              }
              break;

            case SyncDomain.history:
              if (op == SyncOperation.upsert) {
                final colonIdx = change.entityId.indexOf(':');
                final fallbackStoryId = colonIdx >= 0
                    ? change.entityId.substring(0, colonIdx)
                    : change.entityId;
                final fallbackChapterId = colonIdx >= 0
                    ? change.entityId.substring(colonIdx + 1)
                    : '';
                final storyId =
                    _nonEmptyString(payload['storyId']) ?? fallbackStoryId;
                final chapterId =
                    _nonEmptyString(payload['chapterId']) ?? fallbackChapterId;
                final entityKey = canonicalHistoryEntityKey(storyId, chapterId);
                final epoch = _extractInt(payload['observedHistoryEpoch']) ??
                    _extractInt(payload['epoch']) ??
                    0;
                await _upsertShadow(
                  txn,
                  AuthoritativeShadowRecord(
                    ownerScope: ownerScope,
                    domain: SyncDomain.history,
                    entityKey: entityKey,
                    serverRevision: change.revision,
                    epoch: epoch,
                    payload: payload,
                    isDeleted: false,
                    updatedAtMs: nowMs,
                  ),
                );
              } else {
                final newEpoch = payload['epoch'] as int;
                if (isGlobalHistoryTarget(change.entityId)) {
                  final currentGlobalEpoch =
                      effectiveEpochs[kGlobalHistorySentinelUuid] ?? 0;
                  if (newEpoch <= currentGlobalEpoch) {
                    throw NonMonotonicHistoryEpochError(
                      'NON_MONOTONIC_HISTORY_EPOCH: Incoming global HISTORY DELETE epoch ($newEpoch) must be strictly greater than current global epoch ($currentGlobalEpoch).',
                    );
                  }
                  effectiveEpochs[kGlobalHistorySentinelUuid] = newEpoch;

                  await txn.delete(
                    'sync_authoritative_replicas',
                    where:
                        "owner_scope = ? AND domain IN ('HISTORY', 'PROGRESS')",
                    whereArgs: <Object?>[ownerScope],
                  );
                } else {
                  final storyId =
                      _nonEmptyString(payload['storyId']) ?? change.entityId;
                  final currentEffective =
                      getEffectiveHistoryEpoch(effectiveEpochs, storyId);
                  if (newEpoch <= currentEffective) {
                    throw NonMonotonicHistoryEpochError(
                      'NON_MONOTONIC_HISTORY_EPOCH: Incoming story HISTORY DELETE epoch ($newEpoch) for story "$storyId" must be strictly greater than current effective epoch ($currentEffective).',
                    );
                  }
                  effectiveEpochs[storyId] = newEpoch;

                  final escapedPrefix = '${escapeSqlLikePattern(storyId)}:%';
                  await txn.delete(
                    'sync_authoritative_replicas',
                    where:
                        r"owner_scope = ? AND domain = 'HISTORY' AND (entity_key = ? OR entity_key LIKE ? ESCAPE '\')",
                    whereArgs: <Object?>[ownerScope, storyId, escapedPrefix],
                  );
                  await txn.delete(
                    'sync_authoritative_replicas',
                    where:
                        "owner_scope = ? AND domain = 'PROGRESS' AND entity_key = ?",
                    whereArgs: <Object?>[ownerScope, storyId],
                  );
                }
              }
              break;

            case SyncDomain.follow:
              final entityKey = change.entityId;
              if (op == SyncOperation.upsert) {
                await _upsertShadow(
                  txn,
                  AuthoritativeShadowRecord(
                    ownerScope: ownerScope,
                    domain: SyncDomain.follow,
                    entityKey: entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload: payload,
                    isDeleted: false,
                    updatedAtMs: nowMs,
                  ),
                );
              } else {
                await _deleteShadow(
                  txn,
                  ownerScope,
                  SyncDomain.follow,
                  entityKey,
                );
              }
              break;
          }
        }

        // INVARIANT: Stage 1 Delta Ingestion NEVER grants READY baseline status!
        final preservedStatus = existingMeta?.authoritativeBaselineStatus ??
            AuthoritativeBaselineStatus.uninitialized;
        final immutableEpochs = Map<String, int>.unmodifiable(effectiveEpochs);

        final updatedMeta = SyncMeta(
          ownerScope: ownerScope,
          lastSyncedServerRevision: targetCheckpoint,
          minActiveRevision: page.minActiveRevision,
          lastSyncTimestamp: now.toIso8601String(),
          effectiveHistoryEpochs: immutableEpochs,
          syncState: SyncExecutionState.idle,
          authoritativeBaselineStatus: preservedStatus,
          lastErrorMessage: null,
        );

        await txn.insert(
          'sync_meta',
          updatedMeta.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );

        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }

        return ApplyAuthoritativeDeltaResult(
          appliedCount: page.changes.length,
          newCheckpoint: targetCheckpoint,
          hasMore: page.hasMore,
          effectiveEpochs: immutableEpochs,
        );
      },
    );
  }

  Future<void> _upsertShadow(
    Transaction txn,
    AuthoritativeShadowRecord record,
  ) async {
    await txn.insert(
      'sync_authoritative_replicas',
      record.toMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> _deleteShadow(
    Transaction txn,
    String ownerScope,
    SyncDomain domain,
    String entityKey,
  ) async {
    await txn.delete(
      'sync_authoritative_replicas',
      where: 'owner_scope = ? AND domain = ? AND entity_key = ?',
      whereArgs: <Object?>[ownerScope, domain.wireValue, entityKey],
    );
  }

  // ==================== SNAPSHOT STAGING STORE (P1-M04) ====================

  /// Đưa các item của trang snapshot vào `snapshot_staging_store`, bảo đảm mọi item
  /// đều thuộc [ownerScope] (`account:*`) và cùng `(ownerScope, sessionId)` mang cùng
  /// một `snapshotRevision` đơn nhất.
  Future<void> stageSnapshotItems({
    required String ownerScope,
    required List<SnapshotStagingItem> items,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    admission.assertAdmitted(ownerScope);
    if (items.isEmpty) return;

    final sessionRevisions = <String, String>{};
    for (final item in items) {
      assertAccountScope(item.ownerScope);
      if (item.ownerScope != ownerScope) {
        throw SnapshotStagingConflictError(
          'SNAPSHOT_SCOPE_MISMATCH: Snapshot item scope "${item.ownerScope}" does not match target ownerScope "$ownerScope".',
        );
      }
      if (item.sessionId.trim().isEmpty) {
        throw const SnapshotStagingConflictError(
          'Snapshot staging sessionId must be non-empty.',
        );
      }
      if (!isValidRevisionString(item.snapshotRevision)) {
        throw SnapshotStagingConflictError(
          'Invalid snapshotRevision "${item.snapshotRevision}".',
        );
      }
      if (!isValidRevisionString(item.minActiveRevision)) {
        throw SnapshotStagingConflictError(
          'Invalid minActiveRevision "${item.minActiveRevision}".',
        );
      }
      if (item.domain == SyncDomain.progress &&
          item.payload.containsKey('readingMode')) {
        final rawMode = item.payload['readingMode'];
        normalizeSyncReadingMode(rawMode is String ? rawMode : null);
      }
      final compositeSession = '${item.ownerScope}\u0000${item.sessionId}';
      final expectedRev = sessionRevisions[compositeSession];
      if (expectedRev == null) {
        sessionRevisions[compositeSession] = item.snapshotRevision;
      } else if (expectedRev != item.snapshotRevision) {
        throw SnapshotStagingConflictError(
          'SNAPSHOT_REVISION_MISMATCH: Batch contains conflicting snapshotRevision values ("$expectedRev" vs "${item.snapshotRevision}") for session "${item.sessionId}".',
        );
      }
    }

    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        for (final entry in sessionRevisions.entries) {
          final sep = entry.key.indexOf('\u0000');
          final scope = entry.key.substring(0, sep);
          final sessionId = entry.key.substring(sep + 1);
          final existingRows = await txn.rawQuery(
            'SELECT DISTINCT snapshot_revision FROM snapshot_staging_store WHERE owner_scope = ? AND session_id = ? LIMIT 1',
            <Object?>[scope, sessionId],
          );
          if (existingRows.isNotEmpty) {
            final existingRev = existingRows.first['snapshot_revision'] as String;
            if (existingRev != entry.value) {
              throw SnapshotStagingConflictError(
                'SNAPSHOT_REVISION_MISMATCH: Existing session "$sessionId" is pinned to snapshotRevision "$existingRev", cannot stage items at "${entry.value}". Clear staging session before restarting.',
              );
            }
          }
        }

        for (final item in items) {
          await txn.insert(
            'snapshot_staging_store',
            item.toMap(),
            conflictAlgorithm: ConflictAlgorithm.replace,
          );
        }
      },
    );
  }

  Future<List<SnapshotStagingItem>> getSnapshotStagingItems(
    String ownerScope,
    String sessionId,
  ) async {
    assertAccountScope(ownerScope);
    final db = await _acquireDatabase();
    final rows = await db.query(
      'snapshot_staging_store',
      where: 'owner_scope = ? AND session_id = ?',
      whereArgs: <Object?>[ownerScope, sessionId],
      orderBy: 'page_index ASC, domain ASC, entity_key ASC',
    );
    return rows.map(SnapshotStagingItem.fromMap).toList();
  }

  Future<void> clearSnapshotStaging(
    String ownerScope, {
    String? sessionId,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        if (sessionId != null) {
          await txn.delete(
            'snapshot_staging_store',
            where: 'owner_scope = ? AND session_id = ?',
            whereArgs: <Object?>[ownerScope, sessionId],
          );
        } else {
          await txn.delete(
            'snapshot_staging_store',
            where: 'owner_scope = ?',
            whereArgs: <Object?>[ownerScope],
          );
        }
      },
    );
  }

  // ==================== LIFECYCLE-PROTECTED SCOPE PURGE (P0-M05) ====================

  /// Dọn sạch toàn bộ dữ liệu Sync + Local Library cache của Account [ownerScope]
  /// theo [reason] hợp lệ (`AccountPurgeReason`), trong 1 SQLite transaction với 4 hàng rào [admission].
  ///
  /// TUYỆT ĐỐI bảo toàn:
  /// - `offline_chapters`, `download_tasks`, `offline_deletion_tombstones`
  /// - `guest_claim_recovery_journal`
  /// - Mọi scope khác (`guest:*` hoặc `account:*`).
  Future<void> purgeAccountScope({
    required String ownerScope,
    required AccountPurgeReason reason,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    await _runWriteTransaction<void>(
      targetScope: ownerScope,
      admission: admission,
      action: (txn) async {
        const scopedTables = <String>[
          'sync_meta',
          'sync_mutation_sequences',
          'sync_authoritative_replicas',
          'pending_mutations',
          'quarantined_mutations',
          'snapshot_staging_store',
          'local_preferences',
          'local_library_bookmarks',
          'local_reading_progress',
          'local_reading_history',
        ];
        for (final table in scopedTables) {
          await txn.delete(
            table,
            where: 'owner_scope = ?',
            whereArgs: <Object?>[ownerScope],
          );
        }
        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      },
    );
  }

  /// Dọn dữ liệu cục bộ của Guest [guestScope] (`guest:<guestProfileId>`) theo
  /// [reason] lifecycle hợp lệ (`GuestLifecyclePurgeReason`).
  ///
  /// Bảo vệ fail-closed `P0-M05`:
  /// - Cấm tuyệt đối xóa nếu `guestProfileId` đang có bản ghi trong `guest_claim_recovery_journal`
  ///   (dù ở pha `prepared`, `committing`, hay `committedServer`).
  /// - Cấm tuyệt đối xóa nếu `guestProfileId` nằm trong danh sách cách ly của [guestProfileProvider]
  ///   (`listQuarantinedGuestScopes()`).
  /// - Chỉ xóa trong 4 bảng cục bộ (`local_preferences`, `local_library_bookmarks`,
  ///   `local_reading_progress`, `local_reading_history`); bảo toàn 100% `offline_*`,
  ///   `guest_claim_recovery_journal`, và mọi scope khác.
  Future<void> purgeGuestLocalScope({
    required String guestScope,
    required GuestLifecyclePurgeReason reason,
    required GuestLocalWriteAdmission admission,
    required GuestProfileIdentityProvider guestProfileProvider,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertGuestScope(guestScope);
    admission.assertAdmitted(guestScope);

    final guestProfileId = guestScope.substring('guest:'.length);
    final preQuarantined = await guestProfileProvider.listQuarantinedGuestScopes();
    if (preQuarantined.contains(guestProfileId)) {
      throw PurgeProhibitedError(
        'PURGE_PROHIBITED: Guest scope "$guestScope" is quarantined and cannot be purged.',
      );
    }

    await _runWriteTransaction<void>(
      targetScope: guestScope,
      admission: admission,
      action: (txn) async {
        final quarantined =
            await guestProfileProvider.listQuarantinedGuestScopes();
        if (quarantined.contains(guestProfileId)) {
          throw PurgeProhibitedError(
            'PURGE_PROHIBITED: Guest scope "$guestScope" is quarantined and cannot be purged.',
          );
        }

        final journalRows = await txn.query(
          'guest_claim_recovery_journal',
          columns: const <String>['claim_id', 'phase'],
          where: 'guest_profile_id = ?',
          whereArgs: <Object?>[guestProfileId],
          limit: 1,
        );
        if (journalRows.isNotEmpty) {
          throw PurgeProhibitedError(
            'PURGE_PROHIBITED: Guest scope "$guestScope" has active/recoverable entries in guest_claim_recovery_journal (phase=${journalRows.first['phase']}).',
          );
        }

        const guestLocalTables = <String>[
          'local_preferences',
          'local_library_bookmarks',
          'local_reading_progress',
          'local_reading_history',
        ];
        for (final table in guestLocalTables) {
          await txn.delete(
            table,
            where: 'owner_scope = ?',
            whereArgs: <Object?>[guestScope],
          );
        }

        if (onBeforeCommitHook != null) {
          await onBeforeCommitHook(txn);
        }
      },
    );
  }

  // ==================== PRIVATE HELPERS ====================

  static String? _nonEmptyString(Object? value) {
    if (value is String && value.isNotEmpty) {
      return value;
    }
    return null;
  }

  static int? _extractInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return null;
  }
}
