import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/sync_models.dart';

/// Các ngoại lệ mô phỏng mạng và HTTP trong Mock Transport Harness.
abstract class MockTransportException implements Exception {
  final String message;
  const MockTransportException(this.message);

  @override
  String toString() => '$runtimeType: $message';
}

/// Ngoại lệ mô phỏng lỗi kết nối mạng (SocketException, TimeoutException, Offline).
class MockNetworkException extends MockTransportException {
  const MockNetworkException([super.message = 'TRANSIENT_NETWORK_FAILURE']);
}

/// Ngoại lệ mô phỏng lỗi HTTP từ Core API Sync Hub.
class MockHttpException extends MockTransportException {
  final int statusCode;
  final String? errorBody;

  const MockHttpException({
    required this.statusCode,
    required String message,
    this.errorBody,
  }) : super(message);

  @override
  String toString() =>
      'MockHttpException(HTTP $statusCode): $message${errorBody != null ? " ($errorBody)" : ""}';
}

/// Wire DTO cho Client Mutation khi đẩy lên Server.
@immutable
class ClientMutationWire {
  final String clientId;
  final String mutationId;
  final String domain;
  final String entityId;
  final String operation;
  final String baseServerRevision;
  final Map<String, Object?> payload;
  final String? clientCreatedAt;

  const ClientMutationWire({
    required this.clientId,
    required this.mutationId,
    required this.domain,
    required this.entityId,
    required this.operation,
    required this.baseServerRevision,
    required this.payload,
    this.clientCreatedAt,
  });

  factory ClientMutationWire.fromPendingRecord(PendingMutationRecord record) {
    return ClientMutationWire(
      clientId: record.clientId,
      mutationId: record.mutationId,
      domain: record.domain.wireValue,
      entityId: record.entityId,
      operation: record.operation.wireValue,
      baseServerRevision: record.baseServerRevision,
      payload: record.payload,
      clientCreatedAt: record.createdAtIso,
    );
  }

  Map<String, Object?> toMap() => {
        'clientId': clientId,
        'mutationId': mutationId,
        'domain': domain,
        'entityId': entityId,
        'operation': operation,
        'baseServerRevision': baseServerRevision,
        'payload': payload,
        if (clientCreatedAt != null) 'clientCreatedAt': clientCreatedAt,
      };
}

/// Kết quả biên nhận (receipt) từng mutation trả về từ Server Mock.
@immutable
class MutationResultItemWire {
  final String mutationId;
  final String status; // 'APPLIED' | 'DEDUPLICATED' | 'REJECTED_TOMBSTONE' | 'CONFLICT_MERGED' | 'REJECTED_STALE' | 'DOMAIN_NOT_SUPPORTED'
  final String? assignedRevision;
  final String? message;
  final String? reason;

  const MutationResultItemWire({
    required this.mutationId,
    required this.status,
    this.assignedRevision,
    this.message,
    this.reason,
  });
}

/// Phản hồi của lệnh đẩy batch mutation lên server.
@immutable
class PushMutationsBatchResponseWire {
  final int processedCount;
  final String newServerRevision;
  final List<MutationResultItemWire> results;

  const PushMutationsBatchResponseWire({
    required this.processedCount,
    required this.newServerRevision,
    required this.results,
  });
}

/// Phản hồi snapshot 6 domains mô phỏng Core API.
@immutable
class SyncSnapshotResponseWire {
  final String snapshotRevision;
  final String minActiveRevision;
  final int globalHistoryEpoch;
  final bool hasMore;
  final String? nextCursor;
  final List<SnapshotStagingItem> items;

  const SyncSnapshotResponseWire({
    required this.snapshotRevision,
    required this.minActiveRevision,
    this.globalHistoryEpoch = 0,
    required this.hasMore,
    this.nextCursor,
    required this.items,
  });
}

/// Interface trừu tượng cho Mock Sync Transport (chặn hoàn toàn network calls thật).
abstract class MockSyncTransport {
  Future<PushMutationsBatchResponseWire> pushMutationsBatch({
    required String ownerScope,
    required List<ClientMutationWire> mutations,
  });

  Future<SyncChangesPage> getChanges({
    required String ownerScope,
    required String afterRevision,
    int? limit,
  });

  Future<SyncSnapshotResponseWire> getSnapshot({
    required String ownerScope,
    String? cursor,
    int? limit,
  });
}

/// Triển khai Configurable Mock Sync Transport hỗ trợ Fault Injection toàn diện.
class ConfigurableMockSyncTransport implements MockSyncTransport {
  bool isOnline = true;
  bool shouldFailTransiently = false;
  int transientFailureCount = 0;
  int _transientFailuresEncountered = 0;

  bool shouldReturn409 = false;
  bool shouldReturn410 = false;
  bool shouldReturnInvalidCheckpoint = false;
  bool shouldReturnStaleRevision = false;
  String? staleRevisionOverride;

  bool shouldInterruptSnapshotMidway = false;
  int? partialPageSize;

  /// Hook gọi ngay trước khi thực thi operation (cho phép test logout/account switch mid-operation).
  Future<void> Function(String operation, String ownerScope)? onOperationStart;

  /// Handlers tùy biến cho từng endpoint (nếu cần kịch bản chuyên biệt).
  Future<PushMutationsBatchResponseWire> Function(
    String ownerScope,
    List<ClientMutationWire> mutations,
  )? customPushHandler;

  Future<SyncChangesPage> Function(
    String ownerScope,
    String afterRevision,
    int? limit,
  )? customChangesHandler;

  Future<SyncSnapshotResponseWire> Function(
    String ownerScope,
    String? cursor,
    int? limit,
  )? customSnapshotHandler;

  int pushCallCount = 0;
  int getChangesCallCount = 0;
  int getSnapshotCallCount = 0;

  void resetStats() {
    pushCallCount = 0;
    getChangesCallCount = 0;
    getSnapshotCallCount = 0;
    _transientFailuresEncountered = 0;
  }

  void _checkPreconditions(String operation, String ownerScope) {
    if (!isOnline) {
      throw const MockNetworkException('DEVICE_OFFLINE: Network connection unavailable.');
    }

    if (shouldFailTransiently) {
      if (transientFailureCount <= 0 ||
          _transientFailuresEncountered < transientFailureCount) {
        _transientFailuresEncountered++;
        throw const MockNetworkException('TRANSIENT_NETWORK_TIMEOUT: Socket closed remotely.');
      }
    }

    if (shouldReturn409) {
      throw const MockHttpException(
        statusCode: 409,
        message: 'CHECKPOINT_CONFLICT: Expected checkpoint mismatch on server.',
        errorBody: '{"error": "CHECKPOINT_CONFLICT"}',
      );
    }

    if (shouldReturn410) {
      throw const MockHttpException(
        statusCode: 410,
        message: 'COMPACTION_GAP_REVISION_PURGED: Server revision compacted, full resync required.',
        errorBody: '{"error": "COMPACTION_GAP"}',
      );
    }

    if (shouldReturnInvalidCheckpoint) {
      throw const MockHttpException(
        statusCode: 400,
        message: 'MANDATORY_OCC_CHECKPOINT_REQUIRED: Invalid checkpoint format.',
        errorBody: '{"error": "INVALID_CHECKPOINT"}',
      );
    }
  }

  @override
  Future<PushMutationsBatchResponseWire> pushMutationsBatch({
    required String ownerScope,
    required List<ClientMutationWire> mutations,
  }) async {
    pushCallCount++;
    if (onOperationStart != null) {
      await onOperationStart!('pushMutationsBatch', ownerScope);
    }
    _checkPreconditions('pushMutationsBatch', ownerScope);

    if (customPushHandler != null) {
      return customPushHandler!(ownerScope, mutations);
    }

    // Default mock response: tất cả mutation được APPLIED
    var currentServerRev = BigInt.parse('100');
    final results = <MutationResultItemWire>[];

    for (final m in mutations) {
      currentServerRev += BigInt.one;
      results.add(
        MutationResultItemWire(
          mutationId: m.mutationId,
          status: 'APPLIED',
          assignedRevision: currentServerRev.toString(),
        ),
      );
    }

    return PushMutationsBatchResponseWire(
      processedCount: mutations.length,
      newServerRevision: currentServerRev.toString(),
      results: results,
    );
  }

  @override
  Future<SyncChangesPage> getChanges({
    required String ownerScope,
    required String afterRevision,
    int? limit,
  }) async {
    getChangesCallCount++;
    if (onOperationStart != null) {
      await onOperationStart!('getChanges', ownerScope);
    }
    _checkPreconditions('getChanges', ownerScope);

    if (customChangesHandler != null) {
      return customChangesHandler!(ownerScope, afterRevision, limit);
    }

    final afterRevBigInt = BigInt.tryParse(afterRevision) ?? BigInt.zero;
    final currentServerRev = shouldReturnStaleRevision
        ? (staleRevisionOverride ?? (afterRevBigInt > BigInt.zero ? (afterRevBigInt - BigInt.one).toString() : '0'))
        : (afterRevBigInt + BigInt.from(10)).toString();

    return SyncChangesPage(
      currentServerRevision: currentServerRev,
      minActiveRevision: '0',
      hasMore: false,
      nextRevision: null,
      changes: const [],
    );
  }

  @override
  Future<SyncSnapshotResponseWire> getSnapshot({
    required String ownerScope,
    String? cursor,
    int? limit,
  }) async {
    getSnapshotCallCount++;
    if (onOperationStart != null) {
      await onOperationStart!('getSnapshot', ownerScope);
    }
    _checkPreconditions('getSnapshot', ownerScope);

    if (shouldInterruptSnapshotMidway) {
      throw const MockNetworkException('SNAPSHOT_INTERRUPTED_MIDWAY: Connection reset by peer.');
    }

    if (customSnapshotHandler != null) {
      return customSnapshotHandler!(ownerScope, cursor, limit);
    }

    return const SyncSnapshotResponseWire(
      snapshotRevision: '500',
      minActiveRevision: '100',
      globalHistoryEpoch: 1,
      hasMore: false,
      nextCursor: null,
      items: [],
    );
  }
}
