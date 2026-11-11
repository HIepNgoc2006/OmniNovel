import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';
import '../authority/sync_write_admission.dart';
import '../errors/sync_storage_exceptions.dart';
import '../models/sync_models.dart';
import '../storage/sync_storage_dal.dart';
import '../utils/canonical_entity_key.dart';
import 'mock_sync_transport.dart';
import 'offline_reconciler_state.dart';

/// Kết quả của một chu kỳ đồng bộ ngoại tuyến Stage 2A (Reconciler Cycle Result).
@immutable
class ReconcilerCycleResult {
  final String ownerScope;
  final int mutationsPushed;
  final int mutationsQuarantined;
  final int deltasApplied;
  final OfflineReconcilerState finalState;
  final String? errorMessage;
  final bool requiresSnapshotResync;

  const ReconcilerCycleResult({
    required this.ownerScope,
    this.mutationsPushed = 0,
    this.mutationsQuarantined = 0,
    this.deltasApplied = 0,
    required this.finalState,
    this.errorMessage,
    this.requiresSnapshotResync = false,
  });
}

/// Offline Sync Reconciler điều phối chu trình đồng bộ ngoại tuyến với Mock Transport.
/// Đáp ứng các tiêu chí Stage 2A:
/// - Chạy mock transport và deterministic tests.
/// - Không gọi endpoint HTTP thật.
/// - Không bật Background SyncWorker.
/// - Không tự ý nâng baseline lên READY.
class OfflineSyncReconciler {
  final SyncStorageDal _dal;
  final MockSyncTransport _transport;
  final OfflineReconcilerStateMachine _stateMachine;
  final Future<void> Function(Transaction txn)? onBeforeSettlementCommitHook;

  OfflineSyncReconciler({
    required SyncStorageDal dal,
    required MockSyncTransport transport,
    required String ownerScope,
    this.onBeforeSettlementCommitHook,
  })  : _dal = dal,
        _transport = transport,
        _stateMachine = OfflineReconcilerStateMachine(ownerScope: ownerScope);

  OfflineReconcilerStateMachine get stateMachine => _stateMachine;
  OfflineReconcilerState get currentState => _stateMachine.currentState;

  /// Thực thi 1 chu kỳ Reconciler đơn lẻ có kiểm soát và kiểm định thẩm quyền fail-closed.
  Future<ReconcilerCycleResult> reconcileOnce({
    required String ownerScope,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);

    // 1. ADMISSION_CHECK
    try {
      admission.assertAdmitted(ownerScope);
      _stateMachine.transitionTo(
        OfflineReconcilerState.admissionCheck,
        reason: 'Verifying active account admission capability',
      );
    } catch (e) {
      _stateMachine.transitionTo(
        OfflineReconcilerState.authorityRevoked,
        reason: 'Account admission check rejected: $e',
      );
      return ReconcilerCycleResult(
        ownerScope: ownerScope,
        finalState: OfflineReconcilerState.authorityRevoked,
        errorMessage: e.toString(),
      );
    }

    // 2. Kiểm tra hàng đợi Pending Mutations
    final pendingList = await _dal.getPendingMutations(ownerScope);
    var pushedCount = 0;
    var quarantinedCount = 0;

    if (pendingList.isNotEmpty) {
      // 3. PREPARING_BATCH
      _stateMachine.transitionTo(
        OfflineReconcilerState.preparingBatch,
        reason: 'Found ${pendingList.length} pending mutations, packing batch',
      );

      final batchWires = pendingList.map(ClientMutationWire.fromPendingRecord).toList();

      // 4. MOCK_PUSHING
      _stateMachine.transitionTo(
        OfflineReconcilerState.mockPushing,
        reason: 'Dispatching ${batchWires.length} mutations via Mock Transport',
      );

      try {
        final pushResponse = await _transport.pushMutationsBatch(
          ownerScope: ownerScope,
          mutations: batchWires,
        );

        // Hàng rào kiểm tra quyền sở hữu và phiên đăng nhập ngay sau await mạng (trước khi vào SQLite)
        admission.assertAdmitted(ownerScope);

        // Atomic settlement: xác thực toàn vẹn biên nhận + thực thi giao dịch SQLite đơn nhất
        final settlement = await _dal.settleBatchReceiptsAtomic(
          ownerScope: ownerScope,
          sentMutations: batchWires,
          response: pushResponse,
          admission: admission,
          onBeforeCommitHook: onBeforeSettlementCommitHook,
        );

        pushedCount = settlement.settledCount;
        quarantinedCount = settlement.quarantinedCount;

        if (quarantinedCount > 0) {
          _stateMachine.transitionTo(
            OfflineReconcilerState.quarantined,
            reason: '$quarantinedCount mutations moved to quarantine store',
          );
        }
      } on ReceiptValidationException catch (e) {
        // Vi phạm tính toàn vẹn receipt -> Giữ nguyên pending mutations, lui về RETRY_BACKOFF
        _stateMachine.transitionTo(
          OfflineReconcilerState.retryBackoff,
          reason: 'Receipt validation failed: ${e.message}',
        );
        return ReconcilerCycleResult(
          ownerScope: ownerScope,
          mutationsPushed: 0,
          mutationsQuarantined: 0,
          finalState: OfflineReconcilerState.retryBackoff,
          errorMessage: 'Receipt validation failed: ${e.message}',
        );
      } on SyncAdmissionRejectedError catch (e) {
        // Thu hồi quyền / logout / account switch mid-flight
        _stateMachine.transitionTo(
          OfflineReconcilerState.authorityRevoked,
          reason: 'Authority revoked during reconciliation: ${e.message}',
        );
        return ReconcilerCycleResult(
          ownerScope: ownerScope,
          mutationsPushed: 0,
          mutationsQuarantined: 0,
          finalState: OfflineReconcilerState.authorityRevoked,
          errorMessage: e.message,
        );
      } on MockNetworkException catch (e) {
        // Lỗi mạng tạm thời -> Ghi nhận transient failure và chuyển sang RETRY_BACKOFF
        for (final m in pendingList) {
          await _dal.recordTransientFailureAtomic(
            ownerScope: ownerScope,
            mutationId: m.mutationId,
            options: RecordTransientFailureOptions(
              maxRetries: 5,
              initialBackoffMs: 1000,
              maxBackoffMs: 30000,
              backoffFactor: 2.0,
              failureReason: e.message,
            ),
            admission: admission,
          );
        }

        _stateMachine.transitionTo(
          OfflineReconcilerState.retryBackoff,
          reason: 'Network transient failure: ${e.message}',
        );

        return ReconcilerCycleResult(
          ownerScope: ownerScope,
          mutationsPushed: 0,
          mutationsQuarantined: 0,
          finalState: OfflineReconcilerState.retryBackoff,
          errorMessage: e.message,
        );
      } on MockHttpException catch (e) {
        if (e.statusCode == 409) {
          // Xung đột checkpoint OCC -> Giữ nguyên pending mutations, chuyển sang RETRY_BACKOFF
          _stateMachine.transitionTo(
            OfflineReconcilerState.retryBackoff,
            reason: 'HTTP 409 Checkpoint conflict detected',
          );
          return ReconcilerCycleResult(
            ownerScope: ownerScope,
            mutationsPushed: 0,
            mutationsQuarantined: 0,
            finalState: OfflineReconcilerState.retryBackoff,
            errorMessage: e.message,
          );
        } else if (e.statusCode == 410) {
          // HTTP 410 Gone -> Cần snapshot bootstrap resync
          _stateMachine.transitionTo(
            OfflineReconcilerState.retryBackoff,
            reason: 'HTTP 410 Compaction gap, full snapshot resync required',
          );
          return ReconcilerCycleResult(
            ownerScope: ownerScope,
            mutationsPushed: 0,
            mutationsQuarantined: 0,
            finalState: OfflineReconcilerState.retryBackoff,
            errorMessage: e.message,
            requiresSnapshotResync: true,
          );
        } else {
          _stateMachine.transitionTo(
            OfflineReconcilerState.retryBackoff,
            reason: 'HTTP error ${e.statusCode}: ${e.message}',
          );
          return ReconcilerCycleResult(
            ownerScope: ownerScope,
            finalState: OfflineReconcilerState.retryBackoff,
            errorMessage: e.message,
          );
        }
      } on Exception catch (e) {
        // Bất kỳ ngoại lệ nào khác (ví dụ: DB failure, injected exception trong transaction)
        _stateMachine.transitionTo(
          OfflineReconcilerState.retryBackoff,
          reason: 'Settlement failure: $e',
        );
        return ReconcilerCycleResult(
          ownerScope: ownerScope,
          mutationsPushed: 0,
          mutationsQuarantined: 0,
          finalState: OfflineReconcilerState.retryBackoff,
          errorMessage: e.toString(),
        );
      }
    }

    // 5. APPLYING_MOCK_DELTA
    _stateMachine.transitionTo(
      OfflineReconcilerState.applyingMockDelta,
      reason: 'Fetching changes from Mock Transport',
    );

    var deltasApplied = 0;
    try {
      final syncMeta = await _dal.getSyncMeta(ownerScope);
      final currentRev = syncMeta?.lastSyncedServerRevision ?? '0';

      final changesPage = await _transport.getChanges(
        ownerScope: ownerScope,
        afterRevision: currentRev,
      );

      // Hàng rào kiểm tra quyền sở hữu ngay sau await mạng (trước khi vào SQLite)
      admission.assertAdmitted(ownerScope);

      if (changesPage.changes.isNotEmpty) {
        final result = await _dal.applyAuthoritativeDeltaPage(
          ownerScope: ownerScope,
          page: changesPage,
          expectedCheckpoint: currentRev,
          admission: admission,
        );
        deltasApplied = result.appliedCount;
      }

      // Đảm bảo không bao giờ tự ý nâng baseline lên READY
      final updatedMeta = await _dal.getSyncMeta(ownerScope);
      _stateMachine.assertBaselineReadyTransitionForbidden(
        updatedMeta?.authoritativeBaselineStatus ?? AuthoritativeBaselineStatus.uninitialized,
      );

      _stateMachine.transitionTo(
        OfflineReconcilerState.idle,
        reason: 'Sync cycle completed successfully with mock transport',
      );

      return ReconcilerCycleResult(
        ownerScope: ownerScope,
        mutationsPushed: pushedCount,
        mutationsQuarantined: quarantinedCount,
        deltasApplied: deltasApplied,
        finalState: OfflineReconcilerState.idle,
      );
    } on SyncAdmissionRejectedError catch (e) {
      _stateMachine.transitionTo(
        OfflineReconcilerState.authorityRevoked,
        reason: 'Authority revoked during delta pull: ${e.message}',
      );
      return ReconcilerCycleResult(
        ownerScope: ownerScope,
        mutationsPushed: pushedCount,
        mutationsQuarantined: quarantinedCount,
        deltasApplied: 0,
        finalState: OfflineReconcilerState.authorityRevoked,
        errorMessage: e.message,
      );
    } on MockNetworkException catch (e) {
      _stateMachine.transitionTo(
        OfflineReconcilerState.retryBackoff,
        reason: 'Failed to fetch delta changes: ${e.message}',
      );
      return ReconcilerCycleResult(
        ownerScope: ownerScope,
        mutationsPushed: pushedCount,
        mutationsQuarantined: quarantinedCount,
        deltasApplied: 0,
        finalState: OfflineReconcilerState.retryBackoff,
        errorMessage: e.message,
      );
    }
  }

  /// Staging snapshot các phân vùng 6 domains với kiểm định tính toàn vẹn (Task D).
  Future<int> stageSnapshotSession({
    required String ownerScope,
    required String sessionId,
    required List<SyncSnapshotResponseWire> pages,
    required AccountWriteAdmission admission,
  }) async {
    assertAccountScope(ownerScope);
    admission.assertAdmitted(ownerScope);

    var totalItemsStaged = 0;

    for (final page in pages) {
      admission.assertAdmitted(ownerScope);
      if (page.items.isNotEmpty) {
        await _dal.stageSnapshotItems(
          ownerScope: ownerScope,
          items: page.items,
          admission: admission,
        );
        totalItemsStaged += page.items.length;
      }
    }

    return totalItemsStaged;
  }

  /// Cam kết phiên snapshot dở dang vào SQLite một cách nguyên tử và an toàn (ADR-SYNC-07C-v2.2).
  Future<CommitSnapshotResult> commitSnapshotSession({
    required String ownerScope,
    required String sessionId,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    admission.assertAdmitted(ownerScope);

    final result = await _dal.commitAuthoritativeSnapshot(
      ownerScope: ownerScope,
      sessionId: sessionId,
      admission: admission,
      onBeforeCommitHook: onBeforeCommitHook,
    );

    // Khóa bất biến Stage 2A: cấm tuyệt đối tự ý chuyển baseline sang READY
    final meta = await _dal.getSyncMeta(ownerScope);
    _stateMachine.assertBaselineReadyTransitionForbidden(
      meta?.authoritativeBaselineStatus ??
          AuthoritativeBaselineStatus.uninitialized,
    );

    return result;
  }

  /// Chu trình Snapshot Bootstrap toàn diện 6 domains (ADR-SYNC-07C-v2.2):
  /// Staging phân trang + Cam kết SQLite nguyên tử + Bảo toàn pending mutations.
  Future<CommitSnapshotResult> bootstrapFromSnapshot({
    required String ownerScope,
    required String sessionId,
    required List<SyncSnapshotResponseWire> pages,
    required AccountWriteAdmission admission,
    Future<void> Function(Transaction txn)? onBeforeCommitHook,
  }) async {
    assertAccountScope(ownerScope);
    admission.assertAdmitted(ownerScope);

    _stateMachine.transitionTo(
      OfflineReconcilerState.admissionCheck,
      reason: 'Validating admission for snapshot bootstrap',
    );

    await stageSnapshotSession(
      ownerScope: ownerScope,
      sessionId: sessionId,
      pages: pages,
      admission: admission,
    );

    // Kiểm tra admission sau khi staging hoàn tất (ngay trước khi commit)
    admission.assertAdmitted(ownerScope);

    final result = await commitSnapshotSession(
      ownerScope: ownerScope,
      sessionId: sessionId,
      admission: admission,
      onBeforeCommitHook: onBeforeCommitHook,
    );

    _stateMachine.transitionTo(
      OfflineReconcilerState.idle,
      reason: 'Snapshot bootstrap completed successfully',
    );

    return result;
  }
}
