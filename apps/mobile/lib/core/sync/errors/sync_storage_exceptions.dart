// Exceptions dùng cho tầng Mobile Sync Storage Foundation (Phase 7C.4 Stage 1).

/// Ném khi `ownerScope` rỗng, sai định dạng, hoặc không thuộc `guest:<id>` / `account:<id>`.
class InvalidSyncScopeException implements Exception {
  final String? scope;
  final String message;

  InvalidSyncScopeException(this.scope, [String? detail])
      : message = detail ??
            'Invalid ownerScope "$scope". Expected non-empty "guest:<id>" or "account:<id>".';

  @override
  String toString() => 'InvalidSyncScopeException: $message';
}

/// Ném khi vi phạm quy tắc fail-closed Baseline Lifecycle (cấm nâng cấp lên `READY` trái phép
/// hoặc tự ý sửa checkpoint/epochs của scope đang ở `READY` qua `putSyncMeta`).
class ReadyStatusTransitionForbiddenError implements Exception {
  final String message;

  const ReadyStatusTransitionForbiddenError([
    this.message =
        'Transition to READY baseline status is forbidden without atomic baseline proof verification.',
  ]);

  @override
  String toString() => 'ReadyStatusTransitionForbiddenError: $message';
}

/// Ném khi kiểm tra Optimistic Concurrency Control (OCC) bên trong native SQLite transaction
/// phát hiện `expectedCheckpoint` không khớp với `last_synced_server_revision`.
class CheckpointConflictError implements Exception {
  final String message;

  const CheckpointConflictError([
    this.message = 'Optimistic concurrency check failed: checkpoint mismatch.',
  ]);

  @override
  String toString() => 'CheckpointConflictError: $message';
}

/// Ném khi payload delta/cursor/revision/domain/operation vi phạm giao thức Sync hoặc bị lỗi.
class InvalidDeltaPayloadError implements Exception {
  final String message;

  const InvalidDeltaPayloadError([
    this.message = 'Authoritative delta page payload is invalid or malformed.',
  ]);

  @override
  String toString() => 'InvalidDeltaPayloadError: $message';
}

/// Ném khi `HISTORY DELETE` epoch không tăng đơn điệu nghiêm ngặt so với `effectiveEpoch`.
class NonMonotonicHistoryEpochError extends InvalidDeltaPayloadError {
  const NonMonotonicHistoryEpochError([
    super.message =
        'NON_MONOTONIC_HISTORY_EPOCH: Incoming HISTORY DELETE epoch must be strictly greater than effective epoch.',
  ]);

  @override
  String toString() => 'NonMonotonicHistoryEpochError: $message';
}

/// Ném bởi hàng rào `SyncWriteAdmission` (`P0-M06`) khi scope, auth, hoặc `transitionGeneration` mất hiệu lực.
class SyncAdmissionRejectedError implements Exception {
  final String message;

  const SyncAdmissionRejectedError([
    this.message = 'SYNC_ADMISSION_REJECTED: Scope or generation is no longer active.',
  ]);

  @override
  String toString() => 'SyncAdmissionRejectedError: $message';
}

/// Ném khi cố gắng requeue mutation bị cấm (ví dụ `REJECTED_TOMBSTONE`, `REJECTED_STALE`, `HTTP_410_GONE`).
class RequeueProhibitedError implements Exception {
  final String message;

  const RequeueProhibitedError([
    this.message = 'REQUEUE_PROHIBITED: Mutation cannot be requeued.',
  ]);

  @override
  String toString() => 'RequeueProhibitedError: $message';
}

/// Ném khi chèn trùng `(owner_scope, mutation_id)` vào `pending_mutations` (kích hoạt rollback SQLite).
class DuplicateMutationException implements Exception {
  final String message;
  final Object? cause;

  const DuplicateMutationException(this.message, [this.cause]);

  @override
  String toString() => 'DuplicateMutationException: $message';
}

/// Ném khi dữ liệu staged snapshot vi phạm nhất quán `snapshotRevision` trong cùng `(ownerScope, sessionId)`.
class SnapshotStagingConflictError implements Exception {
  final String message;

  const SnapshotStagingConflictError([
    this.message = 'SNAPSHOT_STAGING_CONFLICT: Staging metadata is inconsistent.',
  ]);

  @override
  String toString() => 'SnapshotStagingConflictError: $message';
}

/// Ném khi `readingMode` không thuộc tập canonical (`WEBTOON`, `PAGED`, `NOVEL`)
/// hoặc legacy `MANGA_PAGED` (`P1-M07` fail-closed).
class InvalidSyncReadingModeException implements Exception {
  final String? readingMode;
  final String message;

  InvalidSyncReadingModeException(this.readingMode, [String? detail])
      : message = detail ??
            'INVALID_SYNC_READING_MODE: Unsupported readingMode "$readingMode". Strictly requires "WEBTOON", "PAGED", "NOVEL" (or legacy "MANGA_PAGED").';

  @override
  String toString() => 'InvalidSyncReadingModeException: $message';
}

/// Ném khi `clientId` thiếu, không đúng chuẩn RFC4122 UUIDv4, hoặc trùng lặp với
/// `userId` / `guestProfileId` / JWT `sessionId` (`P1-M08`).
class InvalidClientIdentityException implements Exception {
  final String? clientId;
  final String message;

  InvalidClientIdentityException(this.clientId, [String? detail])
      : message = detail ??
            'INVALID_CLIENT_IDENTITY: Invalid or collided clientId "$clientId". Expected a durable RFC4122 UUIDv4 distinct from userId, guestProfileId, and sessionId.';

  @override
  String toString() => 'InvalidClientIdentityException: $message';
}

/// Ném khi thao tác purge scope vi phạm rào chắn lifecycle (`P0-M05`), ví dụ
/// cố xóa Guest partition đang có `guest_claim_recovery_journal` hoặc đang bị cách ly.
class PurgeProhibitedError implements Exception {
  final String message;

  const PurgeProhibitedError([
    this.message = 'PURGE_PROHIBITED: Scope purge is forbidden in the current lifecycle state.',
  ]);

  @override
  String toString() => 'PurgeProhibitedError: $message';
}
