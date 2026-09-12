import { ParsedApiError } from '../api/translation';

export type SegmentCommitState =
  | 'COMMITTED'
  | 'REJECTED'
  | 'UNKNOWN';

export type WorkspaceSyncState =
  | 'SYNCED'
  | 'RECONCILIATION_REQUIRED'
  | 'STATE_CHANGED'
  | 'ACCESS_REVOKED';

export type SaveSegmentReason =
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'NETWORK'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'ACCESS_REVOKED'
  | 'PENDING_UNKNOWN_MUTATION'
  | 'INVALID_VERSION_ORDER'
  | 'SEGMENT_REMOVED';

export type DraftConflictKind =
  | 'VERSION_CONFLICT'
  | 'SEGMENT_REMOVED'
  | 'COMMIT_UNKNOWN_CONFLICT'
  | 'INVALID_VERSION_ORDER'
  | 'UNCOMMITTED_DRAFT';

export interface ConflictState {
  kind: DraftConflictKind;
  segmentId: string;
  currentVersion?: number;
  expectedVersion?: number;
  draftText?: string;
  draftVerification?: boolean;
  retryBlocked: boolean;
}

export type SaveSegmentOutcome =
  | 'SAVED_AND_SYNCED'
  | 'SAVED_SYNC_FAILED'
  | 'VERSION_CONFLICT'
  | 'STATE_CHANGED'
  | 'ACCESS_REVOKED'
  | 'FAILED_BEFORE_COMMIT'
  | 'PENDING_UNKNOWN_CONFLICT'
  | 'COMMIT_UNKNOWN'
  | 'RETRY_BLOCKED';

export interface SaveSegmentResult {
  commitState: SegmentCommitState;
  workspaceState: WorkspaceSyncState;
  success: boolean;
  outcome: SaveSegmentOutcome;
  reason?: SaveSegmentReason;
  backendCode?: string;
  conflict?: ConflictState;
  error?: ParsedApiError;
}

export interface PendingUnknownMutation {
  segmentId: string;
  operationId: number;
  attemptedText?: string;
  attemptedVerification?: boolean;
  expectedVersion: number;
}

export function buildSaveSegmentResult(
  commitState: SegmentCommitState,
  workspaceState: WorkspaceSyncState,
  options?: {
    reason?: SaveSegmentReason;
    backendCode?: string;
    conflict?: ConflictState;
    error?: ParsedApiError;
  },
): SaveSegmentResult {
  const success = commitState === 'COMMITTED' && workspaceState === 'SYNCED';
  let outcome: SaveSegmentOutcome;

  // Implementation Lock 1: commitState === 'UNKNOWN' takes precedence over workspaceState
  if (commitState === 'UNKNOWN') {
    outcome =
      options?.reason === 'PENDING_UNKNOWN_MUTATION'
        ? 'PENDING_UNKNOWN_CONFLICT'
        : 'COMMIT_UNKNOWN';
  } else if (workspaceState === 'ACCESS_REVOKED') {
    outcome = 'ACCESS_REVOKED';
  } else if (workspaceState === 'STATE_CHANGED') {
    outcome = 'STATE_CHANGED';
  } else if (commitState === 'COMMITTED') {
    outcome = workspaceState === 'SYNCED' ? 'SAVED_AND_SYNCED' : 'SAVED_SYNC_FAILED';
  } else if (commitState === 'REJECTED') {
    if (options?.reason === 'VERSION_CONFLICT') {
      outcome = 'VERSION_CONFLICT';
    } else if (options?.reason === 'PENDING_UNKNOWN_MUTATION') {
      outcome = 'PENDING_UNKNOWN_CONFLICT';
    } else if (
      options?.reason === 'SEGMENT_REMOVED' &&
      options?.conflict?.retryBlocked
    ) {
      outcome = 'RETRY_BLOCKED';
    } else {
      outcome = 'FAILED_BEFORE_COMMIT';
    }
  } else {
    outcome = 'FAILED_BEFORE_COMMIT';
  }

  return {
    commitState,
    workspaceState,
    success,
    outcome,
    reason: options?.reason,
    backendCode: options?.backendCode,
    conflict: options?.conflict,
    error: options?.error,
  };
}

