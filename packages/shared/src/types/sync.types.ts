import { ReadingMode } from '../index.js';

/**
 * Supported functional domains in OmniNovel Unified Sync Engine
 */
export enum SyncDomain {
  BOOKMARK = 'BOOKMARK',
  PROGRESS = 'PROGRESS',
  HISTORY = 'HISTORY',
  PREFERENCE = 'PREFERENCE',
  FOLLOW = 'FOLLOW',
}

/**
 * Mutation operations supported across all domains
 */
export enum SyncOperation {
  UPSERT = 'UPSERT',
  DELETE = 'DELETE',
}

/**
 * Durable execution status returned by the Server Sync Hub
 */
export type MutationExecutionStatus =
  | 'APPLIED'
  | 'DEDUPLICATED'
  | 'REJECTED_TOMBSTONE'
  | 'CONFLICT_MERGED'
  | 'REJECTED_STALE'
  | 'DOMAIN_NOT_SUPPORTED';

/**
 * Domain-specific payload for BOOKMARK UPSERT mutation
 */
export interface BookmarkMutationPayload {
  storyId: string;
}

/**
 * Domain-specific payload for PROGRESS UPSERT mutation
 */
export interface ProgressMutationPayload {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode: ReadingMode;
  /**
   * 1-based page index (pageIndex >= 1)
   */
  pageIndex: number;
  scrollPosition: number;
  progressPercentage: number;
  anchorBlockId?: string | null;
  textOffset?: number | null;
  forceRewind?: boolean;
  /**
   * Optional observed epoch for causal tombstone guard (< effectiveHistoryEpoch)
   */
  observedHistoryEpoch?: number;
}

/**
 * Domain-specific payload for HISTORY UPSERT mutation
 */
export interface HistoryMutationPayload {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  progressPercentage: number;
  /**
   * Required observed history epoch for Strict Equality guard (=== effectiveHistoryEpoch)
   */
  observedHistoryEpoch: number;
}

/**
 * Domain-specific payload for PREFERENCE UPSERT mutation
 */
export interface PreferenceMutationPayload {
  key: string;
  value: unknown;
}

/**
 * Canonical client mutation pushed to Core API Sync Hub
 */
export interface ClientMutation {
  /**
   * Local replica/device UUID v4
   */
  clientId: string;
  /**
   * Idempotency mutation UUID v4
   */
  mutationId: string;
  /**
   * Domain of the entity
   */
  domain: SyncDomain;
  /**
   * Target entity identifier
   */
  entityId: string;
  /**
   * Operation type
   */
  operation: SyncOperation;
  /**
   * Decimal string representation of client's observed server revision
   */
  baseServerRevision: string;
  /**
   * Domain payload conforming to domain schema
   */
  payload: Record<string, unknown>;
  /**
   * Optional client wall-clock timestamp (telemetry only)
   */
  clientCreatedAt?: string;
}

/**
 * Batch payload for POST /api/v1/sync/mutations/batch
 */
export interface PushMutationsBatchRequest {
  mutations: ClientMutation[];
}

/**
 * Durable receipt result for individual mutation
 */
export interface MutationResultItem {
  mutationId: string;
  status: MutationExecutionStatus;
  /**
   * Assigned server revision as decimal string, or null if rejected
   */
  assignedRevision: string | null;
  message?: string;
  reason?: string;
}

/**
 * Response for POST /api/v1/sync/mutations/batch
 */
export interface PushMutationsBatchResponse {
  processedCount: number;
  newServerRevision: string;
  results: MutationResultItem[];
}

/**
 * Single change record returned by GET /api/v1/sync/changes
 */
export interface SyncChangeItem {
  revision: string;
  domain: SyncDomain;
  entityId: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Response for GET /api/v1/sync/changes
 */
export interface SyncChangesResponse {
  currentServerRevision: string;
  minActiveRevision: string;
  nextRevision: string | null;
  hasMore: boolean;
  changes: SyncChangeItem[];
}

/**
 * Query parameters for GET /api/v1/sync/changes
 */
export interface SyncChangesQuery {
  after?: string;
  limit?: number;
}

/**
 * Bookmark entry in snapshot data
 */
export interface SnapshotBookmarkItem {
  storyId: string;
  createdAt: string;
}

/**
 * Chapter read-state record in snapshot data (maps to client local history)
 */
export interface SnapshotChapterReadStateItem {
  chapterId: string;
  storyId: string;
  chapterVersionId?: string | null;
  maxProgressPercentage: number;
  completedAt: string | null;
  lastReadAt: string;
  storyHistoryEpoch: number;
}

/**
 * User preference entry in snapshot data
 */
export interface SnapshotPreferenceItem {
  key: string;
  value: unknown;
  updatedAt: string;
}

/**
 * Consolidated snapshot domain data payload
 */
export interface SnapshotData {
  bookmarks: SnapshotBookmarkItem[];
  readingProgress: ProgressMutationPayload[];
  chapterReadStates: SnapshotChapterReadStateItem[];
  preferences: SnapshotPreferenceItem[];
}

/**
 * Response for GET /api/v1/sync/snapshot
 */
export interface SyncSnapshotResponse {
  snapshotRevision: string;
  minActiveRevision: string;
  hasMore: boolean;
  nextCursor: string | null;
  data: SnapshotData;
}

/**
 * Query parameters for GET /api/v1/sync/snapshot
 */
export interface SyncSnapshotQuery {
  cursor?: string;
  limit?: number;
}
