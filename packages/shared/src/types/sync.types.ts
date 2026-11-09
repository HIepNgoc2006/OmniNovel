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
 * Sentinel UUID used in reading_history_tombstones for global history clears.
 * Hoisted to `SyncSnapshotResponse.globalHistoryEpoch` and excluded from `historyEpochs[]`.
 */
export const GLOBAL_HISTORY_EPOCH_SENTINEL =
  '00000000-0000-0000-0000-000000000000' as const;

/**
 * Canonical ordered partition domains traversed by six-domain snapshot keyset pagination.
 */
export const SNAPSHOT_PARTITION_DOMAINS = [
  'BOOKMARK',
  'PROGRESS',
  'CHAPTER_READ_STATE',
  'PREFERENCE',
  'HISTORY_TOMBSTONE',
  'SYNC_TOMBSTONE',
] as const;

export type SnapshotPartitionDomain =
  (typeof SNAPSHOT_PARTITION_DOMAINS)[number];

/**
 * Sync domains that emit durable tombstones in `sync_tombstones` (`FOLLOW` excluded in Phase 7C).
 */
export type SyncTombstoneDomain =
  | SyncDomain.BOOKMARK
  | SyncDomain.PROGRESS
  | SyncDomain.HISTORY
  | SyncDomain.PREFERENCE;

export const SYNC_TOMBSTONE_DOMAINS: readonly SyncTombstoneDomain[] = [
  SyncDomain.BOOKMARK,
  SyncDomain.PROGRESS,
  SyncDomain.HISTORY,
  SyncDomain.PREFERENCE,
] as const;

/**
 * Per-story history epoch item in six-domain snapshot data (sentinel excluded).
 */
export interface SnapshotHistoryEpochItem {
  storyId: string;
  epoch: number;
}

/**
 * Active sync tombstone entry in six-domain snapshot data (`deletedAtRevision >= minActiveRevision`).
 */
export interface SnapshotTombstoneItem {
  domain: SyncTombstoneDomain;
  entityId: string;
  deletedAtRevision: string;
}

/**
 * Consolidated snapshot domain data payload.
 * `historyEpochs` and `tombstones` are optional for backward compatibility with 4-domain consumers.
 */
export interface SnapshotData {
  bookmarks: SnapshotBookmarkItem[];
  readingProgress: ProgressMutationPayload[];
  chapterReadStates: SnapshotChapterReadStateItem[];
  preferences: SnapshotPreferenceItem[];
  historyEpochs?: SnapshotHistoryEpochItem[];
  tombstones?: SnapshotTombstoneItem[];
}

/**
 * Strict six-domain snapshot payload containing required epoch & tombstone partitions.
 */
export interface SixDomainSnapshotData extends SnapshotData {
  historyEpochs: SnapshotHistoryEpochItem[];
  tombstones: SnapshotTombstoneItem[];
}

/**
 * Response for GET /api/v1/sync/snapshot.
 * `globalHistoryEpoch` is optional for backward compatibility with 4-domain consumers.
 */
export interface SyncSnapshotResponse {
  snapshotRevision: string;
  minActiveRevision: string;
  globalHistoryEpoch?: number;
  hasMore: boolean;
  nextCursor: string | null;
  data: SnapshotData;
}

/**
 * Strict six-domain response for GET /api/v1/sync/snapshot.
 */
export interface SixDomainSyncSnapshotResponse extends SyncSnapshotResponse {
  globalHistoryEpoch: number;
  data: SixDomainSnapshotData;
}

/**
 * Query parameters for GET /api/v1/sync/snapshot
 */
export interface SyncSnapshotQuery {
  cursor?: string;
  limit?: number;
}

const MAX_POSTGRES_BIGINT = 9223372036854775807n;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidUnsignedBigIntRevision(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= MAX_POSTGRES_BIGINT;
  } catch {
    return false;
  }
}

/**
 * Type guard validating whether a domain supports canonical sync tombstones.
 */
export function isValidTombstoneDomain(
  domain: unknown,
): domain is SyncTombstoneDomain {
  return (
    domain === SyncDomain.BOOKMARK ||
    domain === SyncDomain.PROGRESS ||
    domain === SyncDomain.HISTORY ||
    domain === SyncDomain.PREFERENCE
  );
}

/**
 * Type guard validating strict six-domain `SnapshotData` structural and causal invariants.
 */
export function isSixDomainSnapshotData(
  data: unknown,
): data is SixDomainSnapshotData {
  if (!isRecordObject(data)) {
    return false;
  }
  if (
    !Array.isArray(data.bookmarks) ||
    !Array.isArray(data.readingProgress) ||
    !Array.isArray(data.chapterReadStates) ||
    !Array.isArray(data.preferences) ||
    !Array.isArray(data.historyEpochs) ||
    !Array.isArray(data.tombstones)
  ) {
    return false;
  }
  for (const item of data.historyEpochs) {
    if (!isRecordObject(item)) {
      return false;
    }
    if (
      typeof item.storyId !== 'string' ||
      item.storyId.trim().length === 0 ||
      item.storyId !== item.storyId.trim() ||
      item.storyId === GLOBAL_HISTORY_EPOCH_SENTINEL ||
      !isNonNegativeSafeInteger(item.epoch)
    ) {
      return false;
    }
  }
  for (const item of data.tombstones) {
    if (!isRecordObject(item)) {
      return false;
    }
    if (!isValidTombstoneDomain(item.domain)) {
      return false;
    }
    if (
      typeof item.entityId !== 'string' ||
      item.entityId.trim().length === 0 ||
      item.entityId !== item.entityId.trim()
    ) {
      return false;
    }
    if (item.domain === SyncDomain.HISTORY && item.entityId === 'all') {
      return false;
    }
    if (!isValidUnsignedBigIntRevision(item.deletedAtRevision)) {
      return false;
    }
  }
  return true;
}

/**
 * Type guard validating a full six-domain `SyncSnapshotResponse` envelope and revision invariants.
 */
export function isSixDomainSyncSnapshotResponse(
  response: unknown,
): response is SixDomainSyncSnapshotResponse {
  if (!isRecordObject(response)) {
    return false;
  }
  if (
    !isValidUnsignedBigIntRevision(response.snapshotRevision) ||
    !isValidUnsignedBigIntRevision(response.minActiveRevision)
  ) {
    return false;
  }
  const snapshotRevBigInt = BigInt(response.snapshotRevision);
  const minActiveRevBigInt = BigInt(response.minActiveRevision);
  if (minActiveRevBigInt > snapshotRevBigInt) {
    return false;
  }
  if (typeof response.hasMore !== 'boolean') {
    return false;
  }
  if (response.hasMore) {
    if (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0) {
      return false;
    }
  } else if (response.nextCursor !== null) {
    return false;
  }
  if (!isNonNegativeSafeInteger(response.globalHistoryEpoch)) {
    return false;
  }
  if (!isSixDomainSnapshotData(response.data)) {
    return false;
  }
  for (const item of response.data.tombstones) {
    const tombstoneRevBigInt = BigInt(item.deletedAtRevision);
    if (tombstoneRevBigInt < minActiveRevBigInt || tombstoneRevBigInt > snapshotRevBigInt) {
      return false;
    }
  }
  return true;
}
