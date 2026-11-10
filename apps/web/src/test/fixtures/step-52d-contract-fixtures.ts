import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  ClientMutation,
  MutationResultItem,
  SyncChangesResponse,
  SyncChangeItem,
  ProgressMutationPayload,
} from '@omninovel/shared';
import { GLOBAL_HISTORY_SENTINEL } from '../../lib/storage/indexed-db-client';

/**
 * Step 5.2d Canonical Wire Transport & Protocol Constants
 * (ADR-SYNC-07C-v2.2 & Patch Set A Conformance)
 */
export const WIRE_GLOBAL_HISTORY_ENTITY_ID = GLOBAL_HISTORY_SENTINEL; // '00000000-0000-0000-0000-000000000000'
export const LEGACY_GLOBAL_HISTORY_ENTITY_ID = 'all';

export const SYNC_CHANGES_ENDPOINT = '/api/v1/sync/changes';
export const SYNC_SNAPSHOT_ENDPOINT = '/api/v1/sync/snapshot';
export const SYNC_MUTATIONS_BATCH_ENDPOINT = '/api/v1/sync/mutations/batch';

/**
 * Task A1: Mutation Batch Wire Payload
 * Note: Does NOT assume server-side batch-level 'Idempotency-Key' header.
 * Relies on (clientId, mutationId, payloadHash) as durable idempotency key.
 */
export interface WireMutationBatchRequest {
  mutations: ClientMutation[];
}

export interface WireMutationBatchResponse {
  results: MutationResultItem[];
}

/**
 * Task A2 / Task E: GlobalExceptionFilter Canonical Error Envelopes
 * In production NestJS GlobalExceptionFilter, responses are structured as:
 * {
 *   error: {
 *     code: string;
 *     message: string;
 *     requestId: string;
 *     timestamp: string;
 *     meta?: Record<string, any>;
 *     details?: Array<{ field: string; issue: string }>;
 *   }
 * }
 * Note: GlobalExceptionFilter only allows allowlisted fields in error.meta.
 * In present production, minActiveRevision and currentServerRevision are NOT yet allowlisted,
 * so present production returns only code, message, requestId, timestamp.
 * Proposed B1/B2 contracts introduce metadata under error.meta.
 */
export interface ProductionGlobalErrorEnvelope<TMeta = Record<string, unknown>> {
  error: {
    code: string;
    message: string;
    requestId: string;
    timestamp: string;
    meta?: TMeta;
    details?: Array<{ field: string; issue: string }>;
  };
}

/**
 * Present Production HTTP 410 Error (Filtered by GlobalExceptionFilter)
 */
export interface ProductionSyncRevisionExpiredBody {
  error: {
    code: 'SYNC_REVISION_EXPIRED';
    message: string;
    requestId: string;
    timestamp: string;
  };
}

/**
 * Proposed B1 HTTP 410 Error (Allowlisting minActiveRevision & currentServerRevision under error.meta)
 */
export interface ProposedB1SyncRevisionExpiredBody {
  error: {
    code: 'SYNC_REVISION_EXPIRED';
    message: string;
    requestId: string;
    timestamp: string;
    meta?: {
      minActiveRevision?: string;
      currentServerRevision?: string;
    };
  };
}

export interface WireHttpResponse<TBody> {
  httpStatus: number;
  body: TBody;
}

export type WireSyncRevisionExpiredResponse =
  | WireHttpResponse<ProductionSyncRevisionExpiredBody>
  | WireHttpResponse<ProposedB1SyncRevisionExpiredBody>;

export function createProduction410Response(params?: {
  message?: string;
  requestId?: string;
}): WireHttpResponse<ProductionSyncRevisionExpiredBody> {
  return {
    httpStatus: 410,
    body: {
      error: {
        code: 'SYNC_REVISION_EXPIRED',
        message: params?.message ?? 'Client revision is expired and has been pruned by GC; full snapshot resync required',
        requestId: params?.requestId ?? `req-prod-410-${Math.random().toString(36).substring(2, 8)}`,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

export function createProposedB1410Response(params: {
  minActiveRevision: string;
  currentServerRevision: string;
  message?: string;
  requestId?: string;
}): WireHttpResponse<ProposedB1SyncRevisionExpiredBody> {
  return {
    httpStatus: 410,
    body: {
      error: {
        code: 'SYNC_REVISION_EXPIRED',
        message: params.message ?? `Client revision is expired (minActiveRevision: ${params.minActiveRevision}); full snapshot resync required`,
        requestId: params.requestId ?? `req-b1-410-${Math.random().toString(36).substring(2, 8)}`,
        timestamp: new Date().toISOString(),
        meta: {
          minActiveRevision: params.minActiveRevision,
          currentServerRevision: params.currentServerRevision,
        },
      },
    },
  };
}

/**
 * Task C: Six-Domain Snapshot Contract Types
 * (Mirroring ADR-SYNC-07C-v2.2 §2.1 & §2.4 / PR #213 Patch Set A)
 */
export interface SnapshotHistoryEpochItem {
  storyId: string;
  epoch: number;
}

export type SyncTombstoneDomain = 'BOOKMARK' | 'PROGRESS' | 'HISTORY' | 'PREFERENCE';

export interface SnapshotTombstoneItem {
  domain: SyncTombstoneDomain;
  entityId: string;
  deletedAtRevision: string;
}

export interface SixDomainSnapshotData {
  bookmarks: Array<{ storyId: string; createdAt: string }>;
  readingProgress: ProgressMutationPayload[];
  chapterReadStates: Array<{
    chapterId: string;
    storyId: string;
    chapterVersionId?: string | null;
    maxProgressPercentage: number;
    completedAt: string | null;
    lastReadAt: string;
    storyHistoryEpoch: number;
  }>;
  preferences: Array<{ key: string; value: unknown; updatedAt: string }>;
  historyEpochs: SnapshotHistoryEpochItem[];
  tombstones: SnapshotTombstoneItem[];
}

export interface SixDomainSyncSnapshotResponse {
  snapshotRevision: string;
  minActiveRevision: string;
  hasMore: boolean;
  nextCursor: string | null;
  globalHistoryEpoch: number;
  data: SixDomainSnapshotData;
}

/**
 * Task C / Task E: HTTP 409 Snapshot Invalidated Error Payloads
 */
export interface ProductionSnapshotInvalidatedBody {
  error: {
    code: 'SNAPSHOT_INVALIDATED';
    message: string;
    requestId: string;
    timestamp: string;
  };
}

export interface ProposedB2SnapshotInvalidatedBody {
  error: {
    code: 'SNAPSHOT_INVALIDATED';
    message: string;
    requestId: string;
    timestamp: string;
    meta?: {
      reason?: 'CURSOR_WATERMARK_UPGRADE_REQUIRED' | 'CONCURRENT_GC_MIN_ACTIVE_ADVANCED';
      currentServerRevision?: string;
      minActiveRevision?: string;
      cursorRevision?: string;
    };
  };
}

export type WireSnapshotInvalidatedResponse =
  | WireHttpResponse<ProductionSnapshotInvalidatedBody>
  | WireHttpResponse<ProposedB2SnapshotInvalidatedBody>;

export function createProduction409Response(params?: {
  message?: string;
  requestId?: string;
}): WireHttpResponse<ProductionSnapshotInvalidatedBody> {
  return {
    httpStatus: 409,
    body: {
      error: {
        code: 'SNAPSHOT_INVALIDATED',
        message: params?.message ?? 'Snapshot invalidated; client must clear snapshot staging store and restart from page 1',
        requestId: params?.requestId ?? `req-prod-409-${Math.random().toString(36).substring(2, 8)}`,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

export function createProposedB2409Response(params: {
  reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED' | 'CONCURRENT_GC_MIN_ACTIVE_ADVANCED';
  currentServerRevision: string;
  minActiveRevision: string;
  cursorRevision: string;
  message?: string;
  requestId?: string;
}): WireHttpResponse<ProposedB2SnapshotInvalidatedBody> {
  return {
    httpStatus: 409,
    body: {
      error: {
        code: 'SNAPSHOT_INVALIDATED',
        message: params.message ?? `Snapshot invalidated: current server revision (${params.currentServerRevision}) != cursor revision (${params.cursorRevision})`,
        requestId: params.requestId ?? `req-b2-409-${Math.random().toString(36).substring(2, 8)}`,
        timestamp: new Date().toISOString(),
        meta: {
          reason: params.reason,
          currentServerRevision: params.currentServerRevision,
          minActiveRevision: params.minActiveRevision,
          cursorRevision: params.cursorRevision,
        },
      },
    },
  };
}

/**
 * Fixture Factory for Six-Domain Paginated Snapshot (ADR-SYNC-07C-v2.2 §2.4 REG-17)
 */
export function createSixDomainSnapshotPagesFixture(params?: {
  snapshotRevision?: string;
  minActiveRevision?: string;
}): SixDomainSyncSnapshotResponse[] {
  const srev = params?.snapshotRevision ?? '15';
  const mrev = params?.minActiveRevision ?? '1';

  // Page 1: 2 Bookmarks, limit=2 -> nextCursor points to PREFERENCE
  const page1: SixDomainSyncSnapshotResponse = {
    snapshotRevision: srev,
    minActiveRevision: mrev,
    hasMore: true,
    nextCursor: `cur_hmac_v1_${Buffer.from(JSON.stringify({ domain: 'PREFERENCE', key: '', srev, mrev })).toString('base64url')}`,
    globalHistoryEpoch: 3,
    data: {
      bookmarks: [
        { storyId: 'story-alpha', createdAt: '2026-11-09T08:00:00.000Z' },
        { storyId: 'story-beta', createdAt: '2026-11-09T08:01:00.000Z' },
      ],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [],
      historyEpochs: [],
      tombstones: [],
    },
  };

  // Page 2: 1 Preference, limit=2 -> nextCursor points to HISTORY_TOMBSTONE
  const page2: SixDomainSyncSnapshotResponse = {
    snapshotRevision: srev,
    minActiveRevision: mrev,
    hasMore: true,
    nextCursor: `cur_hmac_v1_${Buffer.from(JSON.stringify({ domain: 'HISTORY_TOMBSTONE', key: '', srev, mrev })).toString('base64url')}`,
    globalHistoryEpoch: 3,
    data: {
      bookmarks: [],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [
        { key: 'theme:colon', value: 'dark', updatedAt: '2026-11-09T08:02:00.000Z' },
      ],
      historyEpochs: [],
      tombstones: [],
    },
  };

  // Page 3: 3 History Epochs (per-story, sentinel excluded), globalHistoryEpoch = 3
  const page3: SixDomainSyncSnapshotResponse = {
    snapshotRevision: srev,
    minActiveRevision: mrev,
    hasMore: true,
    nextCursor: `cur_hmac_v1_${Buffer.from(JSON.stringify({ domain: 'SYNC_TOMBSTONE', key: '', srev, mrev })).toString('base64url')}`,
    globalHistoryEpoch: 3,
    data: {
      bookmarks: [],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [],
      historyEpochs: [
        { storyId: 'story-1', epoch: 1 },
        { storyId: 'story-2', epoch: 2 },
        { storyId: 'story-3', epoch: 4 },
      ],
      tombstones: [],
    },
  };

  // Page 4: 2 Tombstones (split across boundary)
  const page4: SixDomainSyncSnapshotResponse = {
    snapshotRevision: srev,
    minActiveRevision: mrev,
    hasMore: true,
    nextCursor: `cur_hmac_v1_${Buffer.from(JSON.stringify({ domain: 'SYNC_TOMBSTONE', key: '["PREFERENCE","pref:a:b"]', srev, mrev })).toString('base64url')}`,
    globalHistoryEpoch: 3,
    data: {
      bookmarks: [],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [],
      historyEpochs: [],
      tombstones: [
        { domain: 'HISTORY', entityId: 'story-deleted', deletedAtRevision: '11' },
        { domain: 'PREFERENCE', entityId: 'pref:a:b', deletedAtRevision: '12' },
      ],
    },
  };

  // Page 5: 1 Final Tombstone -> hasMore: false, nextCursor: null
  const page5: SixDomainSyncSnapshotResponse = {
    snapshotRevision: srev,
    minActiveRevision: mrev,
    hasMore: false,
    nextCursor: null,
    globalHistoryEpoch: 3,
    data: {
      bookmarks: [],
      readingProgress: [],
      chapterReadStates: [],
      preferences: [],
      historyEpochs: [],
      tombstones: [
        { domain: 'PREFERENCE', entityId: 'pref:a:c', deletedAtRevision: '13' },
      ],
    },
  };

  return [page1, page2, page3, page4, page5];
}

/**
 * Fixture Factory for Delta Changes Pages
 */
export function createDeltaChangesPageFixture(params: {
  currentServerRevision: string;
  minActiveRevision: string;
  nextRevision: string | null;
  hasMore: boolean;
  changes: SyncChangeItem[];
}): SyncChangesResponse {
  return {
    currentServerRevision: params.currentServerRevision,
    minActiveRevision: params.minActiveRevision,
    nextRevision: params.nextRevision,
    hasMore: params.hasMore,
    changes: params.changes,
  };
}
