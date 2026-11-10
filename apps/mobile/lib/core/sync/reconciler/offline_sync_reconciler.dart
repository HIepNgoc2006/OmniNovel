import 'package:flutter/foundation.dart';
import '../authority/sync_write_admission.dart';
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

  OfflineSyncReconciler({
    required SyncStorageDal dal,
    required MockSyncTransport transport,
    required String ownerScope,
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

        // Xử lý receipts
        for (final item in pushResponse.results) {
          if (item.status == 'APPLIED' || item.status == 'DEDUPLICATED') {
            await _dal.deletePendingMutation(
              ownerScope,
              item.mutationId,
              admission: admission,
            );
            pushedCount++;
          } else {
            // Rejection vĩnh viễn (TOMBSTONE / STALE / DOMAIN_NOT_SUPPORTED) -> Cách ly
            await _dal.quarantinePendingMutationByKey(
              ownerScope: ownerScope,
              mutationId: item.mutationId,
              reason: item.reason ?? item.message ?? item.status,
              status: item.status,
              admission: admission,
            );
            quarantinedCount++;
          }
        }

        if (quarantinedCount > 0) {
          _stateMachine.transitionTo(
            OfflineReconcilerState.quarantined,
            reason: '$quarantinedCount mutations moved to quarantine store',
          );
        }
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
}
