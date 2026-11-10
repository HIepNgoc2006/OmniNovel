import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/reconciler/offline_reconciler_state.dart';

void main() {
  group('Phase 7C.4 Stage 2A — Task A: Offline Reconciler State Machine', () {
    const ownerScope = 'account:user-stage2a-001';

    test('verifies all 9 core states and their wire values', () {
      final expectedStates = {
        OfflineReconcilerState.idle: 'IDLE',
        OfflineReconcilerState.waitingForNetwork: 'WAITING_FOR_NETWORK',
        OfflineReconcilerState.preparingBatch: 'PREPARING_BATCH',
        OfflineReconcilerState.admissionCheck: 'ADMISSION_CHECK',
        OfflineReconcilerState.mockPushing: 'MOCK_PUSHING',
        OfflineReconcilerState.applyingMockDelta: 'APPLYING_MOCK_DELTA',
        OfflineReconcilerState.retryBackoff: 'RETRY_BACKOFF',
        OfflineReconcilerState.quarantined: 'QUARANTINED',
        OfflineReconcilerState.authorityRevoked: 'AUTHORITY_REVOKED',
      };

      expect(OfflineReconcilerState.values.length, 9);
      for (final entry in expectedStates.entries) {
        expect(entry.key.wireValue, entry.value);
        expect(OfflineReconcilerState.fromWire(entry.value), entry.key);
      }
      expect(OfflineReconcilerState.fromWire('UNKNOWN_XYZ'), OfflineReconcilerState.idle);
    });

    test('initial state defaults to IDLE and transitions sequentially through normal push-delta flow', () {
      final machine = OfflineReconcilerStateMachine(ownerScope: ownerScope);
      expect(machine.currentState, OfflineReconcilerState.idle);
      expect(machine.history, isEmpty);

      // IDLE -> ADMISSION_CHECK
      machine.transitionTo(
        OfflineReconcilerState.admissionCheck,
        reason: 'Checking token validity',
      );
      expect(machine.currentState, OfflineReconcilerState.admissionCheck);

      // ADMISSION_CHECK -> PREPARING_BATCH
      machine.transitionTo(
        OfflineReconcilerState.preparingBatch,
        reason: 'Packing mutations',
      );
      expect(machine.currentState, OfflineReconcilerState.preparingBatch);

      // PREPARING_BATCH -> MOCK_PUSHING
      machine.transitionTo(
        OfflineReconcilerState.mockPushing,
        reason: 'Dispatching to mock transport',
      );
      expect(machine.currentState, OfflineReconcilerState.mockPushing);

      // MOCK_PUSHING -> APPLYING_MOCK_DELTA
      machine.transitionTo(
        OfflineReconcilerState.applyingMockDelta,
        reason: 'Push succeeded, now pulling delta',
      );
      expect(machine.currentState, OfflineReconcilerState.applyingMockDelta);

      // APPLYING_MOCK_DELTA -> IDLE
      machine.transitionTo(
        OfflineReconcilerState.idle,
        reason: 'Delta applied, cycle complete',
      );
      expect(machine.currentState, OfflineReconcilerState.idle);

      expect(machine.history.length, 5);
      expect(machine.history.last.toState, OfflineReconcilerState.idle);
      expect(machine.history.last.reason, 'Delta applied, cycle complete');
      expect(machine.history.last.ownerScope, ownerScope);
    });

    test('handles WAITING_FOR_NETWORK and RETRY_BACKOFF branch', () {
      final machine = OfflineReconcilerStateMachine(ownerScope: ownerScope);

      // IDLE -> WAITING_FOR_NETWORK
      machine.transitionTo(
        OfflineReconcilerState.waitingForNetwork,
        reason: 'Connectivity lost',
      );
      expect(machine.currentState, OfflineReconcilerState.waitingForNetwork);

      // WAITING_FOR_NETWORK -> ADMISSION_CHECK
      machine.transitionTo(
        OfflineReconcilerState.admissionCheck,
        reason: 'Network restored',
      );
      expect(machine.currentState, OfflineReconcilerState.admissionCheck);

      // ADMISSION_CHECK -> PREPARING_BATCH -> MOCK_PUSHING
      machine.transitionTo(OfflineReconcilerState.preparingBatch, reason: 'Batch');
      machine.transitionTo(OfflineReconcilerState.mockPushing, reason: 'Push');

      // MOCK_PUSHING -> RETRY_BACKOFF (lỗi tạm thời)
      machine.transitionTo(
        OfflineReconcilerState.retryBackoff,
        reason: 'Socket timeout, scheduling backoff',
      );
      expect(machine.currentState, OfflineReconcilerState.retryBackoff);

      // RETRY_BACKOFF -> IDLE
      machine.transitionTo(
        OfflineReconcilerState.idle,
        reason: 'Backoff expired, standing down',
      );
      expect(machine.currentState, OfflineReconcilerState.idle);
    });

    test('handles QUARANTINED transition when server permanently rejects mutations', () {
      final machine = OfflineReconcilerStateMachine(ownerScope: ownerScope);
      machine.transitionTo(OfflineReconcilerState.admissionCheck, reason: 'Check');
      machine.transitionTo(OfflineReconcilerState.preparingBatch, reason: 'Prep');
      machine.transitionTo(OfflineReconcilerState.mockPushing, reason: 'Push');

      // MOCK_PUSHING -> QUARANTINED
      machine.transitionTo(
        OfflineReconcilerState.quarantined,
        reason: 'REJECTED_TOMBSTONE receipt received',
      );
      expect(machine.currentState, OfflineReconcilerState.quarantined);

      // QUARANTINED -> IDLE
      machine.transitionTo(
        OfflineReconcilerState.idle,
        reason: 'Quarantine triage recorded, returning to idle',
      );
      expect(machine.currentState, OfflineReconcilerState.idle);
    });

    test('handles AUTHORITY_REVOKED from ANY active state and permits transition ONLY to IDLE', () {
      final testStates = [
        OfflineReconcilerState.idle,
        OfflineReconcilerState.waitingForNetwork,
        OfflineReconcilerState.admissionCheck,
        OfflineReconcilerState.preparingBatch,
        OfflineReconcilerState.mockPushing,
        OfflineReconcilerState.applyingMockDelta,
        OfflineReconcilerState.retryBackoff,
        OfflineReconcilerState.quarantined,
      ];

      for (final state in testStates) {
        final machine = OfflineReconcilerStateMachine(
          ownerScope: ownerScope,
          initialState: state,
        );

        // Chuyển sang AUTHORITY_REVOKED từ bất kỳ trạng thái nào
        machine.transitionTo(
          OfflineReconcilerState.authorityRevoked,
          reason: 'Token expired or user logged out',
        );
        expect(machine.currentState, OfflineReconcilerState.authorityRevoked);

        // Từ AUTHORITY_REVOKED cấm chuyển sang MOCK_PUSHING, PREPARING_BATCH...
        expect(
          () => machine.transitionTo(
            OfflineReconcilerState.mockPushing,
            reason: 'Illegal push without auth',
          ),
          throwsA(isA<IllegalStateTransitionException>()),
        );

        // Chỉ có thể quay lại IDLE khi tái xác thực phiên
        machine.transitionTo(
          OfflineReconcilerState.idle,
          reason: 'Re-authenticated with fresh session',
        );
        expect(machine.currentState, OfflineReconcilerState.idle);
      }
    });

    test('rejects illegal state jumps with IllegalStateTransitionException', () {
      final machine = OfflineReconcilerStateMachine(ownerScope: ownerScope);

      // IDLE -> MOCK_PUSHING (không thể push khi chưa qua admission check hoặc prepare)
      expect(
        () => machine.transitionTo(
          OfflineReconcilerState.mockPushing,
          reason: 'Premature push',
        ),
        throwsA(isA<IllegalStateTransitionException>()),
      );

      // IDLE -> QUARANTINED
      expect(
        () => machine.transitionTo(
          OfflineReconcilerState.quarantined,
          reason: 'Illegal quarantine from idle',
        ),
        throwsA(isA<IllegalStateTransitionException>()),
      );
    });

    test('STRICT SAFETY: assertBaselineReadyTransitionForbidden locks READY elevation in Stage 2A', () {
      final machine = OfflineReconcilerStateMachine(ownerScope: ownerScope);

      // UNINITIALIZED và BOOTSTRAPPING được phép
      expect(
        () => machine.assertBaselineReadyTransitionForbidden(
          AuthoritativeBaselineStatus.uninitialized,
        ),
        returnsNormally,
      );

      expect(
        () => machine.assertBaselineReadyTransitionForbidden(
          AuthoritativeBaselineStatus.bootstrapping,
        ),
        returnsNormally,
      );

      // READY bị CHẶN TUYỆT ĐỐI với ReadyStatusTransitionForbiddenError
      expect(
        () => machine.assertBaselineReadyTransitionForbidden(
          AuthoritativeBaselineStatus.ready,
        ),
        throwsA(isA<ReadyStatusTransitionForbiddenError>()),
      );
    });
  });
}
