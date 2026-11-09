import 'dart:math' as math;

import 'package:sqflite/sqflite.dart';

import '../../storage/local_library_models.dart';
import '../../storage/offline_database.dart';
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
/// - Cô lập tuyệt đối theo `owner_scope` và triple-barrier `checkAdmission()` (`P0-M02`).
///
/// Stage 1 boundary: KHÔNG gọi mạng `/sync/*`, KHÔNG chạy Background SyncWorker,
/// và KHÔNG tự cấp trạng thái `READY`.
class SyncStorageDal {
  final OfflineDatabase? _offlineDatabase;
  final Database? _customDb;

  SyncStorageDal({
    OfflineDatabase? offlineDatabase,
    Database? customDb,
  })  : _offlineDatabase = offlineDatabase,
        _customDb = customDb {
    if (_offlineDatabase == null && _customDb == null) {
      throw ArgumentError(
        'Phải cung cấp ít nhất offlineDatabase hoặc customDb cho SyncStorageDal.',
      );
    }
  }

  Database get _db => _customDb ?? _offlineDatabase!.database;

  /// Thực thi write operation trong native SQLite transaction với 3 hàng rào `checkAdmission`:
  /// - Barrier 1: trước khi lấy handle DB và trước khi mở SQLite transaction.
  /// - Barrier 2: ngay đầu thân SQLite transaction (sau khi giành khóa ghi).
  /// - Barrier 3: ngay trước khi thoát callback để commit transaction (`P0-M02`).
  Future<T> _runWriteTransaction<T>(
    Future<T> Function(Transaction txn) action, {
    void Function()? checkAdmission,
  }) async {
    checkAdmission?.call();
    final db = _db;
    checkAdmission?.call();
    return db.transaction<T>((txn) async {
      checkAdmission?.call();
      final result = await action(txn);
      checkAdmission?.call();
      return result;
    });
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

  void _validatePendingMutationFields(PendingMutationRecord mutation) {
    assertValidScope(mutation.ownerScope);
    if (mutation.mutationId.trim().isEmpty) {
      throw ArgumentError('mutationId must be a non-empty string.');
    }
    if (mutation.clientId.trim().isEmpty) {
      throw ArgumentError('clientId must be a non-empty string.');
    }
    if (mutation.entityId.trim().isEmpty) {
      throw ArgumentError('entityId must be a non-empty string.');
    }
    if (!isValidRevisionString(mutation.baseServerRevision)) {
      throw ArgumentError(
        'Invalid baseServerRevision "${mutation.baseServerRevision}". Expected canonical 64-bit BIGINT decimal string.',
      );
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
  Future<PendingMutationRecord> recordReadingSessionWithMutation({
    required LocalReadingProgress progress,
    required LocalReadingHistory history,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(progress.ownerScope);
    assertValidScope(history.ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
            (existingHistoryRows.first['progress_percentage'] as num).toDouble();
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
    }, checkAdmission: checkAdmission);
  }

  /// Lưu bookmark cục bộ (`local_library_bookmarks`) và enqueue `BOOKMARK UPSERT` nguyên tử.
  Future<PendingMutationRecord> putBookmarkWithMutation({
    required LocalBookmark bookmark,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(bookmark.ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Xóa bookmark cục bộ và enqueue `BOOKMARK DELETE` nguyên tử.
  Future<PendingMutationRecord> deleteBookmarkWithMutation({
    required String ownerScope,
    required String storyId,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Lưu preference theo scope (`local_preferences`) và enqueue `PREFERENCE UPSERT` nguyên tử.
  Future<PendingMutationRecord> putPreferenceWithMutation({
    required LocalPreferenceRecord preference,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(preference.ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Xóa lịch sử + tiến độ cục bộ của 1 truyện (bảo toàn bookmark) và enqueue `HISTORY DELETE` nguyên tử.
  Future<PendingMutationRecord> deleteStoryHistoryWithMutation({
    required String ownerScope,
    required String storyId,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Xóa toàn bộ lịch sử + tiến độ cục bộ của scope (bảo toàn bookmark)
  /// và enqueue Global `HISTORY DELETE` (`all` hoặc sentinel UUID) nguyên tử.
  Future<PendingMutationRecord> clearAllHistoryWithMutation({
    required String ownerScope,
    required PendingMutationRecord mutation,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

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

    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  // ==================== PENDING MUTATIONS QUEUE (P1-M03) ====================

  /// Đưa mutation mới vào hàng đợi `pending_mutations` với `sequence_no` tăng đơn điệu bền vững.
  Future<PendingMutationRecord> enqueuePendingMutation(
    PendingMutationRecord mutation, {
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    _validatePendingMutationFields(mutation);
    return _runWriteTransaction<PendingMutationRecord>((txn) async {
      final persisted = await _insertPendingMutationInTxn(txn, mutation);
      if (onBeforeCommitHook != null) {
        await onBeforeCommitHook(txn);
      }
      return persisted;
    }, checkAdmission: checkAdmission);
  }

  Future<PendingMutationRecord?> getPendingMutation(
    String ownerScope,
    String mutationId,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
      'pending_mutations',
      where: 'owner_scope = ? AND mutation_id = ?',
      whereArgs: <Object?>[ownerScope, mutationId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return PendingMutationRecord.fromMap(rows.first);
  }

  /// Lấy danh sách pending mutations của [ownerScope] đúng thứ tự FIFO theo `sequence_no ASC`.
  Future<List<PendingMutationRecord>> getPendingMutations(
    String ownerScope, {
    int limit = 100,
  }) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
      await txn.delete(
        'pending_mutations',
        where: 'owner_scope = ? AND mutation_id = ?',
        whereArgs: <Object?>[ownerScope, mutationId],
      );
    }, checkAdmission: checkAdmission);
  }

  Future<void> deletePendingMutationsBatch(
    String ownerScope,
    List<String> mutationIds, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    if (mutationIds.isEmpty) {
      checkAdmission?.call();
      return;
    }
    await _runWriteTransaction<void>((txn) async {
      final placeholders = List<String>.filled(mutationIds.length, '?').join(',');
      await txn.delete(
        'pending_mutations',
        where: 'owner_scope = ? AND mutation_id IN ($placeholders)',
        whereArgs: <Object?>[ownerScope, ...mutationIds],
      );
    }, checkAdmission: checkAdmission);
  }

  /// Nguyên tử hóa xử lý lỗi tạm thời: tăng `retry_count` + tính backoff hoặc chuyển sang
  /// `quarantined_mutations` trong cùng một SQLite transaction (`P1-M04`).
  Future<TransientFailureResult> recordTransientFailureAtomic({
    required String ownerScope,
    required String mutationId,
    required RecordTransientFailureOptions options,
  }) async {
    assertValidScope(ownerScope);
    return _runWriteTransaction<TransientFailureResult>((txn) async {
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
        final rawDelay =
            options.initialBackoffMs *
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
    }, checkAdmission: options.checkAdmission);
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
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    return _runWriteTransaction<QuarantinedMutationRecord?>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Ghi bản ghi vào `quarantined_mutations` và xóa khỏi `pending_mutations` nếu còn tồn tại.
  Future<void> quarantineMutation(
    QuarantinedMutationRecord record, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(record.ownerScope);
    await _runWriteTransaction<void>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  Future<QuarantinedMutationRecord?> getQuarantinedMutation(
    String ownerScope,
    String mutationId,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
      await txn.delete(
        'quarantined_mutations',
        where: 'owner_scope = ? AND mutation_id = ?',
        whereArgs: <Object?>[ownerScope, mutationId],
      );
    }, checkAdmission: checkAdmission);
  }

  /// Đưa mutation từ `quarantined_mutations` trở lại `pending_mutations` với `retry_count = 0`.
  ///
  /// - Cấm tuyệt đối `REJECTED_TOMBSTONE` (chống phục sinh dữ liệu).
  /// - Khóa `REJECTED_STALE` và `HTTP_410_GONE` ở Stage 1 cho tới Stage 3 Causal Triage Engine.
  Future<PendingMutationRecord> requeueQuarantinedMutation({
    required String ownerScope,
    required String mutationId,
    CausalTriageProof? triageProof,
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    return _runWriteTransaction<PendingMutationRecord>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  /// Anti-Tombstone Resurrection: xóa đồng thời bản sao cục bộ/shadow và pending mutation
  /// trong một SQLite transaction duy nhất.
  Future<void> evictReplicaAndRemovePending({
    required String ownerScope,
    required SyncDomain domain,
    required String entityId,
    required String mutationId,
    Map<String, Object?>? payload,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
      switch (domain) {
        case SyncDomain.bookmark:
          await txn.delete(
            'local_library_bookmarks',
            where: 'owner_scope = ? AND story_id = ?',
            whereArgs: <Object?>[ownerScope, entityId],
          );
          await txn.delete(
            'sync_authoritative_replicas',
            where: "owner_scope = ? AND domain = 'BOOKMARK' AND entity_key = ?",
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
            where: "owner_scope = ? AND domain = 'PROGRESS' AND entity_key = ?",
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
    }, checkAdmission: checkAdmission);
  }

  // ==================== LOCAL PREFERENCES ====================

  Future<void> putPreference(
    LocalPreferenceRecord preference, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(preference.ownerScope);
    await _runWriteTransaction<void>((txn) async {
      await txn.insert(
        'local_preferences',
        preference.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }, checkAdmission: checkAdmission);
  }

  Future<LocalPreferenceRecord?> getPreference(
    String ownerScope,
    String prefKey,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
      'local_preferences',
      where: 'owner_scope = ? AND pref_key = ?',
      whereArgs: <Object?>[ownerScope, prefKey],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return LocalPreferenceRecord.fromMap(rows.first);
  }

  Future<List<LocalPreferenceRecord>> getAllPreferences(
    String ownerScope,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
      'local_preferences',
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
      orderBy: 'pref_key ASC',
    );
    return rows.map(LocalPreferenceRecord.fromMap).toList();
  }

  Future<void> deletePreference(
    String ownerScope,
    String prefKey, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
      await txn.delete(
        'local_preferences',
        where: 'owner_scope = ? AND pref_key = ?',
        whereArgs: <Object?>[ownerScope, prefKey],
      );
    }, checkAdmission: checkAdmission);
  }

  // ==================== SYNC META & FAIL-CLOSED BASELINE LIFECYCLE ====================

  Future<SyncMeta?> getSyncMeta(String ownerScope) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    void Function()? checkAdmission,
  }) async {
    assertValidScope(meta.ownerScope);
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

    await _runWriteTransaction<void>((txn) async {
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
        if (meta.lastSyncedServerRevision != existing!.lastSyncedServerRevision) {
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
    }, checkAdmission: checkAdmission);
  }

  Future<AuthoritativeBaselineStatus> getAuthoritativeBaselineStatus(
    String ownerScope,
  ) async {
    assertValidScope(ownerScope);
    final meta = await getSyncMeta(ownerScope);
    return meta?.authoritativeBaselineStatus ??
        AuthoritativeBaselineStatus.uninitialized;
  }

  /// Thiết lập trạng thái baseline (`UNINITIALIZED` hoặc `BOOTSTRAPPING`).
  /// CẤM TUYỆT ĐỐI truyền [AuthoritativeBaselineStatus.ready] ở Stage 1.
  Future<void> setAuthoritativeBaselineStatus(
    String ownerScope,
    AuthoritativeBaselineStatus status, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    if (status == AuthoritativeBaselineStatus.ready) {
      throw const ReadyStatusTransitionForbiddenError(
        'Transition to READY baseline status is forbidden in Stage 1. Direct transition via setAuthoritativeBaselineStatus is locked.',
      );
    }

    await _runWriteTransaction<void>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  Future<bool> isAuthoritativeReady(String ownerScope) async {
    final status = await getAuthoritativeBaselineStatus(ownerScope);
    return status == AuthoritativeBaselineStatus.ready;
  }

  /// Crash recovery: khi khởi động lại sau crash giữa chừng quá trình bootstrap,
  /// đưa scope đang ở `BOOTSTRAPPING` quay về fail-closed `UNINITIALIZED`.
  /// Giữ nguyên `lastSyncedServerRevision`, `minActiveRevision` và `effectiveHistoryEpochs`.
  Future<bool> recoverInterruptedBootstrapToUninitialized(
    String ownerScope, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    return _runWriteTransaction<bool>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  // ==================== AUTHORITATIVE SHADOW READS & DELTA INGESTION ====================

  Future<AuthoritativeShadowRecord?> getAuthoritativeShadow(
    String ownerScope,
    SyncDomain domain,
    String entityKey,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
  /// - `P0-M02`: Native SQLite transaction + OCC checkpoint verification trên DB + 3-barrier admission.
  /// - Bảo toàn nguyên trạng `authoritativeBaselineStatus` (không tự cấp `READY`).
  Future<ApplyAuthoritativeDeltaResult> applyAuthoritativeDeltaPage({
    required String ownerScope,
    required SyncChangesPage page,
    required String? expectedCheckpoint,
    void Function()? checkAdmission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertValidScope(ownerScope);

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

    // 5. P0-M01: Item-level validation
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

    // 6. P0-M02: Atomic SQLite transaction with native OCC & 3-barrier checkAdmission
    return _runWriteTransaction<ApplyAuthoritativeDeltaResult>((txn) async {
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
                  where: "owner_scope = ? AND domain IN ('HISTORY', 'PROGRESS')",
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
              await _deleteShadow(txn, ownerScope, SyncDomain.follow, entityKey);
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
    }, checkAdmission: checkAdmission);
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
  /// trong cùng `(ownerScope, sessionId)` mang cùng một `snapshotRevision` đơn nhất.
  Future<void> stageSnapshotItems(
    List<SnapshotStagingItem> items, {
    void Function()? checkAdmission,
  }) async {
    checkAdmission?.call();
    if (items.isEmpty) return;

    final sessionRevisions = <String, String>{};
    for (final item in items) {
      assertValidScope(item.ownerScope);
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

    await _runWriteTransaction<void>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  Future<List<SnapshotStagingItem>> getSnapshotStagingItems(
    String ownerScope,
    String sessionId,
  ) async {
    assertValidScope(ownerScope);
    final rows = await _db.query(
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
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
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
    }, checkAdmission: checkAdmission);
  }

  // ==================== SCOPE PURGE (STORAGE ISOLATION) ====================

  /// Dọn sạch toàn bộ dữ liệu Sync + Local Library của [ownerScope] trong 1 transaction.
  ///
  /// TUYỆT ĐỐI bảo toàn:
  /// - `offline_chapters`, `download_tasks`, `offline_deletion_tombstones`
  /// - `guest_claim_recovery_journal`
  /// - Mọi scope khác (`guest:*` hoặc `account:*`).
  Future<void> purgeScope(
    String ownerScope, {
    void Function()? checkAdmission,
  }) async {
    assertValidScope(ownerScope);
    await _runWriteTransaction<void>((txn) async {
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
    }, checkAdmission: checkAdmission);
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
