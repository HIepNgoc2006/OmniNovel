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
  | 'PENDING_UNKNOWN_MUTATION'
  | 'INVALID_VERSION_ORDER'
  | 'SEGMENT_REMOVED';

export type DraftConflictKind =
  | 'VERSION_CONFLICT'
  | 'SEGMENT_REMOVED'
  | 'COMMIT_UNKNOWN_CONFLICT'
  | 'INVALID_VERSION_ORDER';

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
  | 'RETRY_BLOCKED';

export interface SaveSegmentResult {
  success: boolean;
  outcome: SaveSegmentOutcome;
  commitState: SegmentCommitState;
  workspaceState: WorkspaceSyncState;
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
