import 'package:flutter/foundation.dart';
import '../errors/sync_storage_exceptions.dart';
import '../models/sync_models.dart';

/// 9 Trạng thái cốt lõi của Offline Reconciler State Machine (Mobile Phase 7C.4 Stage 2A).
enum OfflineReconcilerState {
  idle('IDLE'),
  waitingForNetwork('WAITING_FOR_NETWORK'),
  preparingBatch('PREPARING_BATCH'),
  admissionCheck('ADMISSION_CHECK'),
  mockPushing('MOCK_PUSHING'),
  applyingMockDelta('APPLYING_MOCK_DELTA'),
  retryBackoff('RETRY_BACKOFF'),
  quarantined('QUARANTINED'),
  authorityRevoked('AUTHORITY_REVOKED');

  final String wireValue;
  const OfflineReconcilerState(this.wireValue);

  static OfflineReconcilerState fromWire(String? value) {
    for (final state in OfflineReconcilerState.values) {
      if (state.wireValue == value) return state;
    }
    return OfflineReconcilerState.idle;
  }
}

/// Ngoại lệ ném ra khi cố gắng thực hiện chuyển đổi trạng thái không hợp lệ.
class IllegalStateTransitionException implements Exception {
  final OfflineReconcilerState fromState;
  final OfflineReconcilerState toState;
  final String? reason;

  const IllegalStateTransitionException({
    required this.fromState,
    required this.toState,
    this.reason,
  });

  @override
  String toString() =>
      'IllegalStateTransitionException: Cannot transition from ${fromState.wireValue} to ${toState.wireValue}'
      '${reason != null ? " ($reason)" : ""}.';
}

/// Bản ghi lưu lại lịch sử chuyển dịch trạng thái của Reconciler (phục vụ audit & debugging).
@immutable
class ReconcilerStateTransition {
  final String ownerScope;
  final OfflineReconcilerState fromState;
  final OfflineReconcilerState toState;
  final String reason;
  final DateTime timestamp;

  const ReconcilerStateTransition({
    required this.ownerScope,
    required this.fromState,
    required this.toState,
    required this.reason,
    required this.timestamp,
  });

  Map<String, Object?> toMap() => {
        'owner_scope': ownerScope,
        'from_state': fromState.wireValue,
        'to_state': toState.wireValue,
        'reason': reason,
        'timestamp': timestamp.toIso8601String(),
      };
}

/// Bộ điều phối State Machine cho Offline Reconciler (Stage 2A Mock Harness).
class OfflineReconcilerStateMachine {
  final String ownerScope;
  OfflineReconcilerState _currentState;
  final List<ReconcilerStateTransition> _history = [];

  OfflineReconcilerStateMachine({
    required this.ownerScope,
    OfflineReconcilerState initialState = OfflineReconcilerState.idle,
  }) : _currentState = initialState;

  OfflineReconcilerState get currentState => _currentState;

  List<ReconcilerStateTransition> get history => List.unmodifiable(_history);

  /// Kiểm tra xem quá trình chuyển trạng thái từ [from] sang [to] có hợp lệ hay không.
  static bool isValidTransition(
    OfflineReconcilerState from,
    OfflineReconcilerState to,
  ) {
    if (from == to) return true; // Idempotent no-op

    // Chuyển sang AUTHORITY_REVOKED luôn hợp lệ từ bất kỳ trạng thái nào
    if (to == OfflineReconcilerState.authorityRevoked) return true;

    switch (from) {
      case OfflineReconcilerState.idle:
        return to == OfflineReconcilerState.waitingForNetwork ||
            to == OfflineReconcilerState.admissionCheck;

      case OfflineReconcilerState.waitingForNetwork:
        return to == OfflineReconcilerState.admissionCheck ||
            to == OfflineReconcilerState.idle;

      case OfflineReconcilerState.admissionCheck:
        return to == OfflineReconcilerState.preparingBatch ||
            to == OfflineReconcilerState.applyingMockDelta ||
            to == OfflineReconcilerState.waitingForNetwork ||
            to == OfflineReconcilerState.idle;

      case OfflineReconcilerState.preparingBatch:
        return to == OfflineReconcilerState.mockPushing ||
            to == OfflineReconcilerState.idle;

      case OfflineReconcilerState.mockPushing:
        return to == OfflineReconcilerState.applyingMockDelta ||
            to == OfflineReconcilerState.retryBackoff ||
            to == OfflineReconcilerState.quarantined ||
            to == OfflineReconcilerState.idle;

      case OfflineReconcilerState.applyingMockDelta:
        return to == OfflineReconcilerState.idle ||
            to == OfflineReconcilerState.retryBackoff ||
            to == OfflineReconcilerState.quarantined;

      case OfflineReconcilerState.retryBackoff:
        return to == OfflineReconcilerState.waitingForNetwork ||
            to == OfflineReconcilerState.admissionCheck ||
            to == OfflineReconcilerState.idle;

      case OfflineReconcilerState.quarantined:
        return to == OfflineReconcilerState.idle ||
            to == OfflineReconcilerState.applyingMockDelta ||
            to == OfflineReconcilerState.admissionCheck;

      case OfflineReconcilerState.authorityRevoked:
        // Sau khi bị revoke, chỉ có thể quay lại IDLE khi tái xác thực phiên mới
        return to == OfflineReconcilerState.idle;
    }
  }

  /// Thực hiện chuyển trạng thái với kiểm định fail-closed.
  void transitionTo(
    OfflineReconcilerState nextState, {
    required String reason,
  }) {
    if (!isValidTransition(_currentState, nextState)) {
      throw IllegalStateTransitionException(
        fromState: _currentState,
        toState: nextState,
        reason: reason,
      );
    }

    final transition = ReconcilerStateTransition(
      ownerScope: ownerScope,
      fromState: _currentState,
      toState: nextState,
      reason: reason,
      timestamp: DateTime.now().toUtc(),
    );

    _history.add(transition);
    _currentState = nextState;
  }

  /// Bảo đảm bất biến: Cấm tuyệt đối việc tự động thăng cấp trạng thái baseline sang READY
  /// ở Stage 2A khi chưa có sự cho phép của Hội đồng Gate Review.
  void assertBaselineReadyTransitionForbidden(
    AuthoritativeBaselineStatus targetStatus,
  ) {
    if (targetStatus == AuthoritativeBaselineStatus.ready) {
      throw const ReadyStatusTransitionForbiddenError(
        'STAGE_2A_LOCK: Reconciler state machine is strictly forbidden from elevating baseline to READY. Production network sync and READY status are locked.',
      );
    }
  }
}
