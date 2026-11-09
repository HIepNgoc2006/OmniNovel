import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';

/// Các miền đồng bộ được hỗ trợ bởi OmniNovel Unified Sync Engine.
enum SyncDomain {
  bookmark('BOOKMARK'),
  progress('PROGRESS'),
  history('HISTORY'),
  preference('PREFERENCE'),
  follow('FOLLOW');

  final String wireValue;
  const SyncDomain(this.wireValue);

  static SyncDomain? tryFromWire(String? value) {
    for (final domain in SyncDomain.values) {
      if (domain.wireValue == value) return domain;
    }
    return null;
  }

  static SyncDomain fromWire(String value) {
    final parsed = tryFromWire(value);
    if (parsed == null) {
      throw ArgumentError('Unsupported SyncDomain wire value: "$value".');
    }
    return parsed;
  }
}

/// Các thao tác mutation được hỗ trợ trong giao thức đồng bộ.
enum SyncOperation {
  upsert('UPSERT'),
  delete('DELETE');

  final String wireValue;
  const SyncOperation(this.wireValue);

  static SyncOperation? tryFromWire(String? value) {
    for (final op in SyncOperation.values) {
      if (op.wireValue == value) return op;
    }
    return null;
  }

  static SyncOperation fromWire(String value) {
    final parsed = tryFromWire(value);
    if (parsed == null) {
      throw ArgumentError('Unsupported SyncOperation wire value: "$value".');
    }
    return parsed;
  }
}

/// Trạng thái vòng đời baseline cho Authoritative Shadow Replica (fail-closed mặc định).
enum AuthoritativeBaselineStatus {
  uninitialized('UNINITIALIZED'),
  bootstrapping('BOOTSTRAPPING'),
  ready('READY');

  final String wireValue;
  const AuthoritativeBaselineStatus(this.wireValue);

  static AuthoritativeBaselineStatus fromWire(String? value) {
    for (final status in AuthoritativeBaselineStatus.values) {
      if (status.wireValue == value) return status;
    }
    return AuthoritativeBaselineStatus.uninitialized;
  }
}

/// Trạng thái thực thi đồng bộ hiện tại của scope.
enum SyncExecutionState {
  idle('IDLE'),
  pulling('PULLING'),
  pushing('PUSHING'),
  reconciling410('RECONCILING_410'),
  error('ERROR');

  final String wireValue;
  const SyncExecutionState(this.wireValue);

  static SyncExecutionState fromWire(String? value) {
    for (final state in SyncExecutionState.values) {
      if (state.wireValue == value) return state;
    }
    return SyncExecutionState.idle;
  }
}

/// Trạng thái xử lý cách ly (triage) cho quarantined mutation.
enum QuarantineTriageStatus {
  pending('PENDING'),
  approved('APPROVED'),
  discarded('DISCARDED');

  final String wireValue;
  const QuarantineTriageStatus(this.wireValue);

  static QuarantineTriageStatus fromWire(String? value) {
    for (final status in QuarantineTriageStatus.values) {
      if (status.wireValue == value) return status;
    }
    return QuarantineTriageStatus.pending;
  }
}

/// Kết quả nguyên tử khi xử lý lỗi tạm thời trên pending mutation.
enum TransientFailureOutcome {
  retryScheduled,
  quarantined,
  notFound,
}

Map<String, Object?> _decodeJsonObject(String? raw, {bool allowNull = false}) {
  if (raw == null || raw.isEmpty) {
    if (allowNull) return const <String, Object?>{};
    return const <String, Object?>{};
  }
  final decoded = jsonDecode(raw);
  if (decoded is Map) {
    return Map<String, Object?>.from(decoded);
  }
  throw FormatException('Expected JSON object, got ${decoded.runtimeType}.');
}

Map<String, int> _decodeEpochMap(String? raw) {
  if (raw == null || raw.isEmpty) return <String, int>{};
  final decoded = jsonDecode(raw);
  if (decoded is! Map) {
    throw FormatException(
      'Expected JSON object for effective_history_epochs_json, got ${decoded.runtimeType}.',
    );
  }
  final result = <String, int>{};
  decoded.forEach((key, value) {
    if (key is String && value is num) {
      result[key] = value.toInt();
    }
  });
  return result;
}

/// Metadata đồng bộ theo scope trong bảng SQLite `sync_meta`.
@immutable
class SyncMeta {
  final String ownerScope;
  final String lastSyncedServerRevision;
  final String minActiveRevision;
  final String lastSyncTimestamp;
  final Map<String, int> effectiveHistoryEpochs;
  final SyncExecutionState syncState;
  final AuthoritativeBaselineStatus authoritativeBaselineStatus;
  final String? lastErrorMessage;

  const SyncMeta({
    required this.ownerScope,
    this.lastSyncedServerRevision = '0',
    this.minActiveRevision = '0',
    required this.lastSyncTimestamp,
    this.effectiveHistoryEpochs = const <String, int>{},
    this.syncState = SyncExecutionState.idle,
    this.authoritativeBaselineStatus =
        AuthoritativeBaselineStatus.uninitialized,
    this.lastErrorMessage,
  });

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'last_synced_server_revision': lastSyncedServerRevision,
        'min_active_revision': minActiveRevision,
        'last_sync_timestamp': lastSyncTimestamp,
        'effective_history_epochs_json': jsonEncode(effectiveHistoryEpochs),
        'sync_state': syncState.wireValue,
        'authoritative_baseline_status': authoritativeBaselineStatus.wireValue,
        'last_error_message': lastErrorMessage,
      };

  factory SyncMeta.fromMap(Map<String, Object?> map) {
    return SyncMeta(
      ownerScope: map['owner_scope'] as String,
      lastSyncedServerRevision:
          (map['last_synced_server_revision'] as String?) ?? '0',
      minActiveRevision: (map['min_active_revision'] as String?) ?? '0',
      lastSyncTimestamp: (map['last_sync_timestamp'] as String?) ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true).toIso8601String(),
      effectiveHistoryEpochs: _decodeEpochMap(
        map['effective_history_epochs_json'] as String?,
      ),
      syncState: SyncExecutionState.fromWire(map['sync_state'] as String?),
      authoritativeBaselineStatus: AuthoritativeBaselineStatus.fromWire(
        map['authoritative_baseline_status'] as String?,
      ),
      lastErrorMessage: map['last_error_message'] as String?,
    );
  }

  SyncMeta copyWith({
    String? ownerScope,
    String? lastSyncedServerRevision,
    String? minActiveRevision,
    String? lastSyncTimestamp,
    Map<String, int>? effectiveHistoryEpochs,
    SyncExecutionState? syncState,
    AuthoritativeBaselineStatus? authoritativeBaselineStatus,
    String? lastErrorMessage,
    bool clearLastErrorMessage = false,
  }) {
    return SyncMeta(
      ownerScope: ownerScope ?? this.ownerScope,
      lastSyncedServerRevision:
          lastSyncedServerRevision ?? this.lastSyncedServerRevision,
      minActiveRevision: minActiveRevision ?? this.minActiveRevision,
      lastSyncTimestamp: lastSyncTimestamp ?? this.lastSyncTimestamp,
      effectiveHistoryEpochs:
          effectiveHistoryEpochs ?? this.effectiveHistoryEpochs,
      syncState: syncState ?? this.syncState,
      authoritativeBaselineStatus:
          authoritativeBaselineStatus ?? this.authoritativeBaselineStatus,
      lastErrorMessage: clearLastErrorMessage
          ? null
          : (lastErrorMessage ?? this.lastErrorMessage),
    );
  }
}

/// Bản ghi bản sao có thẩm quyền (Authoritative Shadow Replica) trong `sync_authoritative_replicas`.
@immutable
class AuthoritativeShadowRecord {
  final String ownerScope;
  final SyncDomain domain;
  final String entityKey;
  final String serverRevision;
  final int epoch;
  final Map<String, Object?>? payload;
  final bool isDeleted;
  final int updatedAtMs;

  const AuthoritativeShadowRecord({
    required this.ownerScope,
    required this.domain,
    required this.entityKey,
    required this.serverRevision,
    this.epoch = 0,
    this.payload,
    this.isDeleted = false,
    required this.updatedAtMs,
  });

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'domain': domain.wireValue,
        'entity_key': entityKey,
        'server_revision': serverRevision,
        'epoch': epoch,
        'payload_json': payload == null ? null : jsonEncode(payload),
        'is_deleted': isDeleted ? 1 : 0,
        'updated_at': updatedAtMs,
      };

  factory AuthoritativeShadowRecord.fromMap(Map<String, Object?> map) {
    final rawPayload = map['payload_json'] as String?;
    return AuthoritativeShadowRecord(
      ownerScope: map['owner_scope'] as String,
      domain: SyncDomain.fromWire(map['domain'] as String),
      entityKey: map['entity_key'] as String,
      serverRevision: map['server_revision'] as String,
      epoch: (map['epoch'] as num?)?.toInt() ?? 0,
      payload: rawPayload == null ? null : _decodeJsonObject(rawPayload),
      isDeleted: ((map['is_deleted'] as num?)?.toInt() ?? 0) != 0,
      updatedAtMs: (map['updated_at'] as num).toInt(),
    );
  }
}

/// Mutation cục bộ chờ đẩy lên server trong bảng `pending_mutations` (`P1-M03` durable FIFO).
@immutable
class PendingMutationRecord {
  final String ownerScope;
  final String mutationId;

  /// Số thứ tự đơn điệu do SQLite cấp bền vững qua `sync_mutation_sequences` khi enqueue.
  /// Có thể đặt `0` trước khi lưu xuống DB.
  final int sequenceNo;
  final String clientId;
  final SyncDomain domain;
  final String entityId;
  final SyncOperation operation;
  final String baseServerRevision;
  final int? observedHistoryEpoch;
  final Map<String, Object?> payload;
  final int retryCount;
  final int? nextRetryAtMs;
  final String createdAtIso;
  final int createdAtMs;

  const PendingMutationRecord({
    required this.ownerScope,
    required this.mutationId,
    this.sequenceNo = 0,
    required this.clientId,
    required this.domain,
    required this.entityId,
    required this.operation,
    required this.baseServerRevision,
    this.observedHistoryEpoch,
    required this.payload,
    this.retryCount = 0,
    this.nextRetryAtMs,
    required this.createdAtIso,
    required this.createdAtMs,
  });

  /// Factory tiện ích khởi tạo mutation với timestamp chuẩn hóa ISO-8601 + ms.
  factory PendingMutationRecord.create({
    required String ownerScope,
    required String mutationId,
    required String clientId,
    required SyncDomain domain,
    required String entityId,
    required SyncOperation operation,
    required String baseServerRevision,
    int? observedHistoryEpoch,
    required Map<String, Object?> payload,
    DateTime? createdAt,
  }) {
    final ts = (createdAt ?? DateTime.now()).toUtc();
    return PendingMutationRecord(
      ownerScope: ownerScope,
      mutationId: mutationId,
      sequenceNo: 0,
      clientId: clientId,
      domain: domain,
      entityId: entityId,
      operation: operation,
      baseServerRevision: baseServerRevision,
      observedHistoryEpoch: observedHistoryEpoch,
      payload: payload,
      retryCount: 0,
      nextRetryAtMs: null,
      createdAtIso: ts.toIso8601String(),
      createdAtMs: ts.millisecondsSinceEpoch,
    );
  }

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'mutation_id': mutationId,
        'sequence_no': sequenceNo,
        'client_id': clientId,
        'domain': domain.wireValue,
        'entity_id': entityId,
        'operation': operation.wireValue,
        'base_server_revision': baseServerRevision,
        'observed_history_epoch': observedHistoryEpoch,
        'payload_json': jsonEncode(payload),
        'retry_count': retryCount,
        'next_retry_at_ms': nextRetryAtMs,
        'created_at_iso': createdAtIso,
        'created_at_ms': createdAtMs,
      };

  factory PendingMutationRecord.fromMap(Map<String, Object?> map) {
    return PendingMutationRecord(
      ownerScope: map['owner_scope'] as String,
      mutationId: map['mutation_id'] as String,
      sequenceNo: (map['sequence_no'] as num).toInt(),
      clientId: map['client_id'] as String,
      domain: SyncDomain.fromWire(map['domain'] as String),
      entityId: map['entity_id'] as String,
      operation: SyncOperation.fromWire(map['operation'] as String),
      baseServerRevision: map['base_server_revision'] as String,
      observedHistoryEpoch: (map['observed_history_epoch'] as num?)?.toInt(),
      payload: _decodeJsonObject(map['payload_json'] as String?),
      retryCount: (map['retry_count'] as num?)?.toInt() ?? 0,
      nextRetryAtMs: (map['next_retry_at_ms'] as num?)?.toInt(),
      createdAtIso: map['created_at_iso'] as String,
      createdAtMs: (map['created_at_ms'] as num).toInt(),
    );
  }

  PendingMutationRecord copyWith({
    String? ownerScope,
    String? mutationId,
    int? sequenceNo,
    String? clientId,
    SyncDomain? domain,
    String? entityId,
    SyncOperation? operation,
    String? baseServerRevision,
    int? observedHistoryEpoch,
    Map<String, Object?>? payload,
    int? retryCount,
    int? nextRetryAtMs,
    bool clearNextRetryAtMs = false,
    String? createdAtIso,
    int? createdAtMs,
  }) {
    return PendingMutationRecord(
      ownerScope: ownerScope ?? this.ownerScope,
      mutationId: mutationId ?? this.mutationId,
      sequenceNo: sequenceNo ?? this.sequenceNo,
      clientId: clientId ?? this.clientId,
      domain: domain ?? this.domain,
      entityId: entityId ?? this.entityId,
      operation: operation ?? this.operation,
      baseServerRevision: baseServerRevision ?? this.baseServerRevision,
      observedHistoryEpoch: observedHistoryEpoch ?? this.observedHistoryEpoch,
      payload: payload ?? this.payload,
      retryCount: retryCount ?? this.retryCount,
      nextRetryAtMs:
          clearNextRetryAtMs ? null : (nextRetryAtMs ?? this.nextRetryAtMs),
      createdAtIso: createdAtIso ?? this.createdAtIso,
      createdAtMs: createdAtMs ?? this.createdAtMs,
    );
  }
}

/// Bằng chứng causal triage gắn kèm mutation bị cách ly (`P1-M04`).
@immutable
class CausalTriageProof {
  final int? observedEpoch;
  final String? validatedRevision;
  final bool triageApproved;
  final String? triageReason;
  final Map<String, Object?>? evidence;

  const CausalTriageProof({
    this.observedEpoch,
    this.validatedRevision,
    required this.triageApproved,
    this.triageReason,
    this.evidence,
  });

  Map<String, Object?> toJsonMap() => <String, Object?>{
        if (observedEpoch != null) 'observedEpoch': observedEpoch,
        if (validatedRevision != null) 'validatedRevision': validatedRevision,
        'triageApproved': triageApproved,
        if (triageReason != null) 'triageReason': triageReason,
        if (evidence != null) 'evidence': evidence,
      };

  factory CausalTriageProof.fromJsonMap(Map<String, Object?> map) {
    final rawEvidence = map['evidence'];
    return CausalTriageProof(
      observedEpoch: (map['observedEpoch'] as num?)?.toInt(),
      validatedRevision: map['validatedRevision'] as String?,
      triageApproved: map['triageApproved'] as bool? ?? false,
      triageReason: map['triageReason'] as String?,
      evidence:
          rawEvidence is Map ? Map<String, Object?>.from(rawEvidence) : null,
    );
  }
}

/// Bản ghi mutation cách ly bảo toàn toàn bộ metadata gốc (`P1-M04`) trong `quarantined_mutations`.
@immutable
class QuarantinedMutationRecord {
  final String ownerScope;
  final String mutationId;
  final String clientId;
  final SyncDomain domain;
  final String entityId;
  final SyncOperation operation;
  final String baseServerRevision;
  final int? observedHistoryEpoch;
  final Map<String, Object?> payload;
  final int? originalSequenceNo;
  final int originalRetryCount;
  final String originalCreatedAtIso;
  final int originalCreatedAtMs;
  final String rejectionReason;
  final String rejectionStatus;
  final String rejectedAtIso;
  final int rejectedAtMs;
  final QuarantineTriageStatus triageStatus;
  final CausalTriageProof? causalEvidence;

  const QuarantinedMutationRecord({
    required this.ownerScope,
    required this.mutationId,
    required this.clientId,
    required this.domain,
    required this.entityId,
    required this.operation,
    required this.baseServerRevision,
    this.observedHistoryEpoch,
    required this.payload,
    this.originalSequenceNo,
    this.originalRetryCount = 0,
    required this.originalCreatedAtIso,
    required this.originalCreatedAtMs,
    required this.rejectionReason,
    this.rejectionStatus = 'MANUAL',
    required this.rejectedAtIso,
    required this.rejectedAtMs,
    this.triageStatus = QuarantineTriageStatus.pending,
    this.causalEvidence,
  });

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'mutation_id': mutationId,
        'client_id': clientId,
        'domain': domain.wireValue,
        'entity_id': entityId,
        'operation': operation.wireValue,
        'base_server_revision': baseServerRevision,
        'observed_history_epoch': observedHistoryEpoch,
        'payload_json': jsonEncode(payload),
        'original_sequence_no': originalSequenceNo,
        'original_retry_count': originalRetryCount,
        'original_created_at_iso': originalCreatedAtIso,
        'original_created_at_ms': originalCreatedAtMs,
        'rejection_reason': rejectionReason,
        'rejection_status': rejectionStatus,
        'rejected_at_iso': rejectedAtIso,
        'rejected_at_ms': rejectedAtMs,
        'triage_status': triageStatus.wireValue,
        'causal_evidence_json': causalEvidence == null
            ? null
            : jsonEncode(causalEvidence!.toJsonMap()),
      };

  factory QuarantinedMutationRecord.fromMap(Map<String, Object?> map) {
    final rawEvidence = map['causal_evidence_json'] as String?;
    return QuarantinedMutationRecord(
      ownerScope: map['owner_scope'] as String,
      mutationId: map['mutation_id'] as String,
      clientId: map['client_id'] as String,
      domain: SyncDomain.fromWire(map['domain'] as String),
      entityId: map['entity_id'] as String,
      operation: SyncOperation.fromWire(map['operation'] as String),
      baseServerRevision: map['base_server_revision'] as String,
      observedHistoryEpoch: (map['observed_history_epoch'] as num?)?.toInt(),
      payload: _decodeJsonObject(map['payload_json'] as String?),
      originalSequenceNo: (map['original_sequence_no'] as num?)?.toInt(),
      originalRetryCount: (map['original_retry_count'] as num?)?.toInt() ?? 0,
      originalCreatedAtIso: map['original_created_at_iso'] as String,
      originalCreatedAtMs: (map['original_created_at_ms'] as num).toInt(),
      rejectionReason: map['rejection_reason'] as String,
      rejectionStatus: (map['rejection_status'] as String?) ?? 'MANUAL',
      rejectedAtIso: map['rejected_at_iso'] as String,
      rejectedAtMs: (map['rejected_at_ms'] as num).toInt(),
      triageStatus: QuarantineTriageStatus.fromWire(
        map['triage_status'] as String?,
      ),
      causalEvidence: rawEvidence == null
          ? null
          : CausalTriageProof.fromJsonMap(_decodeJsonObject(rawEvidence)),
    );
  }
}

/// Bản ghi staged snapshot page kèm metadata phiên/revision/cursor (`P1-M04`).
@immutable
class SnapshotStagingItem {
  final String ownerScope;
  final String sessionId;
  final String snapshotRevision;
  final String minActiveRevision;
  final String? cursorToken;
  final int pageIndex;
  final SyncDomain domain;
  final String entityKey;
  final Map<String, Object?> payload;
  final String stagedAtIso;
  final int stagedAtMs;

  const SnapshotStagingItem({
    required this.ownerScope,
    required this.sessionId,
    required this.snapshotRevision,
    required this.minActiveRevision,
    this.cursorToken,
    this.pageIndex = 0,
    required this.domain,
    required this.entityKey,
    required this.payload,
    required this.stagedAtIso,
    required this.stagedAtMs,
  });

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'session_id': sessionId,
        'snapshot_revision': snapshotRevision,
        'min_active_revision': minActiveRevision,
        'cursor_token': cursorToken,
        'page_index': pageIndex,
        'domain': domain.wireValue,
        'entity_key': entityKey,
        'payload_json': jsonEncode(payload),
        'staged_at_iso': stagedAtIso,
        'staged_at_ms': stagedAtMs,
      };

  factory SnapshotStagingItem.fromMap(Map<String, Object?> map) {
    return SnapshotStagingItem(
      ownerScope: map['owner_scope'] as String,
      sessionId: map['session_id'] as String,
      snapshotRevision: map['snapshot_revision'] as String,
      minActiveRevision: map['min_active_revision'] as String,
      cursorToken: map['cursor_token'] as String?,
      pageIndex: (map['page_index'] as num?)?.toInt() ?? 0,
      domain: SyncDomain.fromWire(map['domain'] as String),
      entityKey: map['entity_key'] as String,
      payload: _decodeJsonObject(map['payload_json'] as String?),
      stagedAtIso: map['staged_at_iso'] as String,
      stagedAtMs: (map['staged_at_ms'] as num).toInt(),
    );
  }
}

/// Bản ghi tùy chọn người dùng cục bộ theo scope trong bảng `local_preferences`.
@immutable
class LocalPreferenceRecord {
  final String ownerScope;
  final String prefKey;
  final Object? value;
  final String updatedAt;

  const LocalPreferenceRecord({
    required this.ownerScope,
    required this.prefKey,
    required this.value,
    required this.updatedAt,
  });

  Map<String, Object?> toMap() => <String, Object?>{
        'owner_scope': ownerScope,
        'pref_key': prefKey,
        'value_json': jsonEncode(value),
        'updated_at': updatedAt,
      };

  factory LocalPreferenceRecord.fromMap(Map<String, Object?> map) {
    return LocalPreferenceRecord(
      ownerScope: map['owner_scope'] as String,
      prefKey: map['pref_key'] as String,
      value: jsonDecode(map['value_json'] as String),
      updatedAt: map['updated_at'] as String,
    );
  }
}

/// Phần tử delta từ Core API (`GET /api/v1/sync/changes`).
/// Sử dụng `String` thô cho [domain] và [operation] để bảo đảm kiểm định fail-closed
/// tại runtime khi nhận wire payload không hợp lệ.
@immutable
class SyncChangeItem {
  final String revision;
  final String domain;
  final String entityId;
  final String operation;
  final Map<String, Object?> payload;
  final String? createdAt;

  const SyncChangeItem({
    required this.revision,
    required this.domain,
    required this.entityId,
    required this.operation,
    this.payload = const <String, Object?>{},
    this.createdAt,
  });

  factory SyncChangeItem.typed({
    required String revision,
    required SyncDomain domain,
    required String entityId,
    required SyncOperation operation,
    Map<String, Object?> payload = const <String, Object?>{},
    String? createdAt,
  }) {
    return SyncChangeItem(
      revision: revision,
      domain: domain.wireValue,
      entityId: entityId,
      operation: operation.wireValue,
      payload: payload,
      createdAt: createdAt,
    );
  }
}

/// Trang phản hồi chuẩn hóa của `GET /api/v1/sync/changes`.
@immutable
class SyncChangesPage {
  final String currentServerRevision;
  final String minActiveRevision;
  final String? nextRevision;
  final bool hasMore;
  final List<SyncChangeItem> changes;

  const SyncChangesPage({
    required this.currentServerRevision,
    required this.minActiveRevision,
    required this.nextRevision,
    required this.hasMore,
    required this.changes,
  });
}

/// Kết quả nạp một trang delta vào SQLite (`applyAuthoritativeDeltaPage`).
@immutable
class ApplyAuthoritativeDeltaResult {
  final int appliedCount;
  final String newCheckpoint;
  final bool hasMore;
  final Map<String, int> effectiveEpochs;

  const ApplyAuthoritativeDeltaResult({
    required this.appliedCount,
    required this.newCheckpoint,
    required this.hasMore,
    required this.effectiveEpochs,
  });
}

/// Lý do lifecycle hợp lệ khi dọn sạch dữ liệu đồng bộ của Account scope (`P0-M05`).
enum AccountPurgeReason {
  /// Dọn bộ đệm tài khoản khi đăng xuất hoặc thu hồi phiên trên thiết bị.
  signOutReset,

  /// Đặt lại trạng thái đồng bộ tài khoản trước full resync.
  fullResyncReset,

  /// Xóa vĩnh viễn tài khoản theo yêu cầu người dùng.
  accountDeleted,
}

/// Lý do lifecycle hợp lệ khi dọn dữ liệu cục bộ của Guest scope (`P0-M05`).
/// Chỉ được phép thực thi khi Guest không nằm trong danh sách cách ly và không có Claim journal.
enum GuestLifecyclePurgeReason {
  /// Người dùng chủ động xóa thư viện / lịch sử đọc cục bộ ở chế độ Guest.
  userClearedGuestData,

  /// Thu hồi dữ liệu Guest cũ sau khi đã xác minh không còn Claim journal hay quarantine.
  verifiedUnusedGuestEviction,
}

/// Tùy chọn cấu hình cho `recordTransientFailureAtomic`.
class RecordTransientFailureOptions {
  final int maxRetries;
  final int initialBackoffMs;
  final int maxBackoffMs;
  final double backoffFactor;
  final String failureReason;
  final Future<void> Function(Transaction txn)? onBeforeCommitHook;

  const RecordTransientFailureOptions({
    required this.maxRetries,
    required this.initialBackoffMs,
    required this.maxBackoffMs,
    required this.backoffFactor,
    required this.failureReason,
    this.onBeforeCommitHook,
  });
}

/// Kết quả của `recordTransientFailureAtomic`.
@immutable
class TransientFailureResult {
  final TransientFailureOutcome outcome;
  final int? retryCount;
  final int? nextRetryAtMs;
  final QuarantinedMutationRecord? quarantinedMutation;

  const TransientFailureResult({
    required this.outcome,
    this.retryCount,
    this.nextRetryAtMs,
    this.quarantinedMutation,
  });
}
