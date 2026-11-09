import {
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
  ConflictResolution,
  SyncDomain,
  SyncOperation,
  MutationExecutionStatus,
  SyncChangeItem,
  SyncChangesResponse,
} from '@omninovel/shared';

export const DB_NAME = 'omninovel_local_v2';
export const DB_VERSION = 5;

export const STORE_BOOKMARKS = 'bookmarks';
export const STORE_PROGRESS = 'progress';
export const STORE_HISTORY = 'history';
export const STORE_PREFERENCES = 'preferences';
export const STORE_SYNC_META = 'sync_meta';
export const STORE_PENDING_MUTATIONS = 'pending_mutations';
export const STORE_QUARANTINED_MUTATIONS = 'quarantined_mutations';
export const STORE_SNAPSHOT_STAGING = 'snapshot_staging_store';
export const STORE_AUTHORITATIVE_REPLICAS = 'sync_authoritative_replicas'; // Phase 5.2a
export const STORE_TOMBSTONES = 'sync_tombstones'; // Phase 5.2b P1-01

export const ALL_OBJECT_STORES = [
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  STORE_SNAPSHOT_STAGING,
  STORE_AUTHORITATIVE_REPLICAS,
  STORE_TOMBSTONES,
] as const;

export interface LocalPreference {
  ownerScope: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export type AuthoritativeBaselineStatus = 'UNINITIALIZED' | 'BOOTSTRAPPING' | 'READY';

export interface AuthoritativeShadowRecord {
  ownerScope: string;
  domain: SyncDomain;
  entityKey: string;
  serverRevision: string;
  epoch: number;
  payload: Record<string, any> | null;
  isDeleted: boolean;
  updatedAt: number;
}

export interface AuthoritativeTombstoneRecord {
  ownerScope: string;
  domain: SyncDomain;
  entityKey: string;
  deletedAtRevision: string;
  epoch?: number;
  updatedAt: number;
}

export interface GcTombstonesOptions {
  maxEvictableRevision?: string;
  checkAdmission?: () => void;
  _testHookBeforeComplete?: (tx: IDBTransaction) => void;
}

export interface GcTombstonesResult {
  scannedCount: number;
  deletedCount: number;
  retainedCount: number;
  safeGcFloor: string;
}

export interface QuarantineStaleByWatermarkOptions {
  excludeMutationIds?: Iterable<string>;
  checkAdmission?: () => void;
  _testHookBeforeComplete?: (tx: IDBTransaction) => void;
}

export interface QuarantineStaleByWatermarkResult {
  minActiveRevision: string;
  scannedCount: number;
  quarantinedCount: number;
  quarantinedMutations: LocalQuarantinedMutation[];
}

export interface LocalSyncMeta {
  ownerScope: string;
  lastSyncedServerRevision: string;
  minActiveRevision: string;
  lastSyncTimestamp: string;
  effectiveHistoryEpochs: Record<string, number>;
  syncState: 'IDLE' | 'PULLING' | 'PUSHING' | 'RECONCILING_410' | 'ERROR';
  lastErrorMessage?: string | null;
  authoritativeBaselineStatus?: AuthoritativeBaselineStatus; // Phase 5.2a
}

export type QuarantineRejectionStatus =
  | MutationExecutionStatus
  | 'EXCEEDED_MAX_RETRIES'
  | 'MANUAL'
  | 'HTTP_410_GONE'
  | string;

export type QuarantineTriageStatus = 'PENDING' | 'APPROVED' | 'DISCARDED';

export interface CausalTriageProof {
  observedEpoch?: number;
  validatedRevision?: string;
  triageApproved: boolean;
  triageReason?: string;
  evidence?: Record<string, unknown>;
}

export interface LocalPendingMutation {
  ownerScope: string;
  mutationId: string;
  clientId: string;
  domain: SyncDomain;
  entityId: string;
  operation: SyncOperation;
  baseServerRevision: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount?: number;
  nextRetryAt?: number;
}

export interface LocalQuarantinedMutation {
  ownerScope: string;
  mutationId: string;
  clientId: string;
  domain: SyncDomain;
  entityId: string;
  operation: SyncOperation;
  baseServerRevision: string;
  payload: Record<string, unknown>;
  rejectionReason: string;
  rejectionStatus?: QuarantineRejectionStatus;
  rejectedAt: string;
  triageStatus?: QuarantineTriageStatus;
  causalEvidence?: CausalTriageProof;
  originalCreatedAt?: string;
}

export type TransientFailureOutcome = 'RETRY_SCHEDULED' | 'QUARANTINED' | 'NOT_FOUND';

export interface TransientFailureResult {
  outcome: TransientFailureOutcome;
  retryCount?: number;
  nextRetryAt?: number;
  quarantinedMutation?: LocalQuarantinedMutation;
}

export interface RecordTransientFailureOptions {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffFactor: number;
  failureReason: string;
  checkAdmission?: () => void;
  _testHookBeforeComplete?: (tx: IDBTransaction) => void;
}

export interface LocalSnapshotStagingItem {
  ownerScope: string;
  sessionId: string;
  domain: SyncDomain;
  entityKey: string;
  payload: Record<string, unknown>;
  stagedAt: string;
}

export class IndexedDbUnavailableError extends Error {
  constructor(message: string = 'IndexedDB is not available or disabled.') {
    super(message);
    this.name = 'IndexedDbUnavailableError';
  }
}

export class QuotaExceededStorageError extends Error {
  constructor(message: string = 'IndexedDB storage quota exceeded.') {
    super(message);
    this.name = 'QuotaExceededStorageError';
  }
}

export class ReadyStatusTransitionForbiddenError extends Error {
  constructor(
    message: string = 'Transition to READY baseline status is forbidden without atomic baseline proof verification. Direct transition via setAuthoritativeBaselineStatus or unverified putSyncMeta is locked.'
  ) {
    super(message);
    this.name = 'ReadyStatusTransitionForbiddenError';
  }
}

export class CheckpointConflictError extends Error {
  constructor(message: string = 'Optimistic concurrency check failed: checkpoint mismatch.') {
    super(message);
    this.name = 'CheckpointConflictError';
  }
}

export class InvalidDeltaPayloadError extends Error {
  constructor(message: string = 'Authoritative delta page payload is invalid or malformed.') {
    super(message);
    this.name = 'InvalidDeltaPayloadError';
  }
}

export interface ApplyAuthoritativeDeltaPageOptions {
  ownerScope: string;
  page: SyncChangesResponse;
  expectedCheckpoint: string;
  checkAdmission?: () => void;
  _testHookBeforeComplete?: (tx: IDBTransaction) => void;
}

export interface ApplyAuthoritativeDeltaResult {
  appliedCount: number;
  newCheckpoint: string;
  hasMore: boolean;
  effectiveEpochs: Record<string, number>;
}

export const GLOBAL_HISTORY_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function isValidRevisionString(val: unknown): val is string {
  return typeof val === 'string' && /^\d+$/.test(val);
}

function maxRevisionString(a: string | undefined | null, b: string | undefined | null): string | null {
  const validA = isValidRevisionString(a);
  const validB = isValidRevisionString(b);
  if (validA && validB) {
    return BigInt(a) >= BigInt(b) ? a : b;
  }
  if (validA) return a;
  if (validB) return b;
  return null;
}

export function areEpochMapsEqual(
  a?: Record<string, number>,
  b?: Record<string, number>,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export class InvalidGuestScopeException extends Error {
  constructor(scope: string | null | undefined) {
    super(
      `Invalid scope for Guest repository: "${scope}". Guest operations strictly require scope matching "guest:<guestProfileId>".`
    );
    this.name = 'InvalidGuestScopeException';
  }
}

export function assertGuestScope(scope: string | null | undefined): asserts scope is string {
  if (!scope || typeof scope !== 'string' || !scope.startsWith('guest:') || scope.slice(6).trim() === '') {
    throw new InvalidGuestScopeException(scope);
  }
}

export function assertValidScope(scope: string | null | undefined): asserts scope is string {
  if (!scope || typeof scope !== 'string' || !scope.trim()) {
    throw new Error('ownerScope must be a non-empty string.');
  }
}

export class IndexedDbClient {
  private dbInstance: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  /**
   * Retrieves active IDBDatabase connection or opens a new one.
   * Fails closed during SSR (window undefined).
   */
  async getDatabase(): Promise<IDBDatabase> {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
      throw new IndexedDbUnavailableError('IndexedDB is client-only and cannot be executed during SSR.');
    }

    if (this.dbInstance) {
      return this.dbInstance;
    }

    if (this.openPromise) {
      return this.openPromise;
    }

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
          const db = request.result;

          // 1. Bookmarks Store: Composite key [ownerScope, storyId]
          if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
            db.createObjectStore(STORE_BOOKMARKS, {
              keyPath: ['ownerScope', 'storyId'],
            });
          }

          // 2. Reading Progress Store: Composite key [ownerScope, storyId]
          if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
            db.createObjectStore(STORE_PROGRESS, {
              keyPath: ['ownerScope', 'storyId'],
            });
          }

          // 3. Reading History Store: Composite key [ownerScope, storyId, chapterId]
          if (!db.objectStoreNames.contains(STORE_HISTORY)) {
            const historyStore = db.createObjectStore(STORE_HISTORY, {
              keyPath: ['ownerScope', 'storyId', 'chapterId'],
            });
            historyStore.createIndex('by_owner_time', ['ownerScope', 'lastReadAt'], {
              unique: false,
            });
          }

          // 4. Preferences Store: Composite key [ownerScope, key] (Phase 7C.3)
          if (!db.objectStoreNames.contains(STORE_PREFERENCES)) {
            db.createObjectStore(STORE_PREFERENCES, {
              keyPath: ['ownerScope', 'key'],
            });
          }

          // 5. Sync Metadata Store: KeyPath ownerScope (Phase 7C.3)
          if (!db.objectStoreNames.contains(STORE_SYNC_META)) {
            db.createObjectStore(STORE_SYNC_META, {
              keyPath: 'ownerScope',
            });
          }

          // 6. Pending Mutations Queue: Composite key [ownerScope, mutationId] (Phase 7C.3)
          if (!db.objectStoreNames.contains(STORE_PENDING_MUTATIONS)) {
            const pendingStore = db.createObjectStore(STORE_PENDING_MUTATIONS, {
              keyPath: ['ownerScope', 'mutationId'],
            });
            pendingStore.createIndex('by_scope_created', ['ownerScope', 'createdAt'], {
              unique: false,
            });
          }

          // 7. Quarantined Mutations Store: Composite key [ownerScope, mutationId] (Phase 7C.3)
          if (!db.objectStoreNames.contains(STORE_QUARANTINED_MUTATIONS)) {
            const quarantinedStore = db.createObjectStore(STORE_QUARANTINED_MUTATIONS, {
              keyPath: ['ownerScope', 'mutationId'],
            });
            quarantinedStore.createIndex('by_scope_rejected', ['ownerScope', 'rejectedAt'], {
              unique: false,
            });
          }

          // 8. Snapshot Staging Store: Composite key [ownerScope, sessionId, domain, entityKey] (Phase 7C.3)
          if (!db.objectStoreNames.contains(STORE_SNAPSHOT_STAGING)) {
            const stagingStore = db.createObjectStore(STORE_SNAPSHOT_STAGING, {
              keyPath: ['ownerScope', 'sessionId', 'domain', 'entityKey'],
            });
            stagingStore.createIndex('by_scope_session', ['ownerScope', 'sessionId'], {
              unique: false,
            });
          }

          // 9. Authoritative Shadow Replicas Store: Composite key [ownerScope, domain, entityKey] (Phase 5.2a)
          if (!db.objectStoreNames.contains(STORE_AUTHORITATIVE_REPLICAS)) {
            const shadowStore = db.createObjectStore(STORE_AUTHORITATIVE_REPLICAS, {
              keyPath: ['ownerScope', 'domain', 'entityKey'],
            });
            shadowStore.createIndex('by_scope_domain', ['ownerScope', 'domain'], {
              unique: false,
            });
            shadowStore.createIndex('by_scope_revision', ['ownerScope', 'serverRevision'], {
              unique: false,
            });
          }

          // 10. Durable Authoritative Tombstones Store: Composite key [ownerScope, domain, entityKey] (Phase 5.2b P1-01)
          // Note: No lexicographic range index on deletedAtRevision string; comparisons strictly use BigInt in memory.
          if (!db.objectStoreNames.contains(STORE_TOMBSTONES)) {
            const tombstoneStore = db.createObjectStore(STORE_TOMBSTONES, {
              keyPath: ['ownerScope', 'domain', 'entityKey'],
            });
            tombstoneStore.createIndex('by_scope_domain', ['ownerScope', 'domain'], {
              unique: false,
            });
          }

          // Fail-closed baseline reset on upgrade from any pre-v5 schema (< 5):
          // Historical non-epoch tombstones were not persisted independently prior to v5,
          // so all upgraded scopes must reset authoritativeBaselineStatus to 'UNINITIALIZED'
          // while preserving lastSyncedServerRevision, minActiveRevision, effectiveHistoryEpochs, etc.
          const isUpgradeFromPreV5 = event.oldVersion > 0 && event.oldVersion < 5;
          if (db.objectStoreNames.contains(STORE_SYNC_META) && request.transaction) {
            const metaStore = request.transaction.objectStore(STORE_SYNC_META);
            const cursorReq = metaStore.openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor) {
                const meta = cursor.value as LocalSyncMeta;
                if (isUpgradeFromPreV5 || !meta.authoritativeBaselineStatus) {
                  meta.authoritativeBaselineStatus = 'UNINITIALIZED';
                  cursor.update(meta);
                }
                cursor.continue();
              }
            };
          }
        };

        request.onsuccess = () => {
          this.dbInstance = request.result;
          this.dbInstance.onversionchange = () => {
            this.close();
          };
          resolve(this.dbInstance);
        };

        request.onerror = () => {
          this.openPromise = null;
          const err = request.error;
          if (err && err.name === 'QuotaExceededError') {
            reject(new QuotaExceededStorageError());
          } else {
            reject(new IndexedDbUnavailableError(err ? err.message : 'Failed to open IndexedDB.'));
          }
        };

        request.onblocked = () => {
          this.openPromise = null;
          reject(new IndexedDbUnavailableError('IndexedDB open blocked by another open connection.'));
        };
      } catch (err: any) {
        this.openPromise = null;
        if (err instanceof IndexedDbUnavailableError || err instanceof QuotaExceededStorageError) {
          reject(err);
        } else {
          reject(new IndexedDbUnavailableError(err instanceof Error ? err.message : String(err)));
        }
      }
    });

    return this.openPromise;
  }

  close(): void {
    if (this.dbInstance) {
      this.dbInstance.close();
      this.dbInstance = null;
    }
    this.openPromise = null;
  }

  /**
   * Atomic Transaction: records reading progress and history in a single readwrite transaction.
   * Guarantees rollback if either operation fails or quota is exceeded.
   * Monotonicity Invariant: history.progressPercentage = MAX(oldProgress, newProgress).
   */
  async recordReadingSession(
    progress: LocalReadingProgress,
    history: LocalReadingHistory
  ): Promise<void> {
    assertValidScope(progress.ownerScope);
    assertValidScope(history.ownerScope);
    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_PROGRESS, STORE_HISTORY], 'readwrite');
      const progressStore = tx.objectStore(STORE_PROGRESS);
      const historyStore = tx.objectStore(STORE_HISTORY);

      tx.onerror = () => {
        const error = tx.error;
        if (error && (error.name === 'QuotaExceededError' || error.name === 'QuotaExceeded')) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction failed.'));
        }
      };

      tx.onabort = () => {
        const error = tx.error;
        if (error && (error.name === 'QuotaExceededError' || error.name === 'QuotaExceeded')) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction aborted.'));
        }
      };

      tx.oncomplete = () => {
        resolve();
      };

      try {
        const historyKey = [history.ownerScope, history.storyId, history.chapterId];
        const getRequest = historyStore.get(historyKey);

        getRequest.onsuccess = () => {
          try {
            const existingHistory = getRequest.result as LocalReadingHistory | undefined;
            const mergedPercentage = Math.max(
              existingHistory?.progressPercentage || 0,
              history.progressPercentage
            );

            const finalHistory: LocalReadingHistory = {
              ...history,
              progressPercentage: mergedPercentage,
            };

            progressStore.put(progress);
            historyStore.put(finalHistory);
          } catch (err: any) {
            try {
              tx.abort();
            } catch (_) {}
            if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
              reject(new QuotaExceededStorageError());
            } else {
              reject(err);
            }
          }
        };

        getRequest.onerror = () => {
          try {
            tx.abort();
          } catch (_) {}
          reject(getRequest.error || new Error('Failed to read existing history.'));
        };
      } catch (err: any) {
        try {
          tx.abort();
        } catch (_) {}
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  // ==================== ATOMIC LOCAL WRITE + PENDING ENQUEUE PRIMITIVES (Phase 7C.3) ====================

  /**
   * Atomic Primitive: Records reading session and enqueues progress mutation in the same IDB transaction.
   * Guarantees rollback if either operation fails or quota is exceeded.
   * Enforces mutation immutability via add() — duplicate mutationId triggers ConstraintError and aborts transaction.
   */
  async recordReadingSessionWithMutation(
    progress: LocalReadingProgress,
    history: LocalReadingHistory,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(progress.ownerScope);
    assertValidScope(history.ownerScope);
    assertValidScope(mutation.ownerScope);

    if (progress.ownerScope !== mutation.ownerScope || history.ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: progress/history (${progress.ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.PROGRESS && mutation.domain !== SyncDomain.HISTORY) {
      throw new Error(`Domain mismatch: mutation domain must be PROGRESS or HISTORY, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.UPSERT) {
      throw new Error(`Operation mismatch: reading session mutation must be UPSERT, got ${mutation.operation}`);
    }

    if (mutation.entityId !== progress.storyId) {
      throw new Error(`EntityId mismatch: expected "${progress.storyId}", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_PROGRESS, STORE_HISTORY, STORE_PENDING_MUTATIONS], 'readwrite');
      const progressStore = tx.objectStore(STORE_PROGRESS);
      const historyStore = tx.objectStore(STORE_HISTORY);
      const mutationStore = tx.objectStore(STORE_PENDING_MUTATIONS);

      tx.onerror = () => {
        const error = tx.error;
        if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction failed.'));
        }
      };

      tx.onabort = () => {
        const error = tx.error;
        if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction aborted.'));
        }
      };

      tx.oncomplete = () => {
        resolve();
      };

      try {
        const historyKey = [history.ownerScope, history.storyId, history.chapterId];
        const getRequest = historyStore.get(historyKey);

        getRequest.onsuccess = () => {
          try {
            const existingHistory = getRequest.result as LocalReadingHistory | undefined;
            const mergedPercentage = Math.max(
              existingHistory?.progressPercentage || 0,
              history.progressPercentage
            );

            const finalHistory: LocalReadingHistory = {
              ...history,
              progressPercentage: mergedPercentage,
            };

            progressStore.put(progress);
            historyStore.put(finalHistory);
            mutationStore.add(mutation);
          } catch (err: any) {
            try {
              tx.abort();
            } catch (_) {}
            if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
              reject(new QuotaExceededStorageError());
            } else {
              reject(err);
            }
          }
        };

        getRequest.onerror = () => {
          try {
            tx.abort();
          } catch (_) {}
          reject(getRequest.error || new Error('Failed to read existing history.'));
        };
      } catch (err: any) {
        try {
          tx.abort();
        } catch (_) {}
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  /**
   * Atomic Primitive: Persists bookmark and enqueues BOOKMARK UPSERT mutation in the same IDB transaction.
   * Enforces mutation immutability via add() — duplicate mutationId triggers ConstraintError and aborts transaction.
   */
  async putBookmarkWithMutation(
    bookmark: LocalBookmark,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(bookmark.ownerScope);
    assertValidScope(mutation.ownerScope);

    if (bookmark.ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: bookmark (${bookmark.ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.BOOKMARK) {
      throw new Error(`Domain mismatch: expected BOOKMARK, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.UPSERT) {
      throw new Error(`Operation mismatch: expected UPSERT, got ${mutation.operation}`);
    }

    if (mutation.entityId !== bookmark.storyId) {
      throw new Error(`EntityId mismatch: expected "${bookmark.storyId}", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_BOOKMARKS, STORE_PENDING_MUTATIONS], 'readwrite');
        tx.objectStore(STORE_BOOKMARKS).put(bookmark);
        tx.objectStore(STORE_PENDING_MUTATIONS).add(mutation);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction failed.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  /**
   * Atomic Primitive: Deletes bookmark and enqueues BOOKMARK DELETE mutation in the same IDB transaction.
   * Enforces mutation immutability via add().
   */
  async deleteBookmarkWithMutation(
    ownerScope: string,
    storyId: string,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

    if (ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: ownerScope (${ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.BOOKMARK) {
      throw new Error(`Domain mismatch: expected BOOKMARK, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.DELETE) {
      throw new Error(`Operation mismatch: expected DELETE, got ${mutation.operation}`);
    }

    if (mutation.entityId !== storyId) {
      throw new Error(`EntityId mismatch: expected "${storyId}", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_BOOKMARKS, STORE_PENDING_MUTATIONS], 'readwrite');
        tx.objectStore(STORE_BOOKMARKS).delete([ownerScope, storyId]);
        tx.objectStore(STORE_PENDING_MUTATIONS).add(mutation);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction failed.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  /**
   * Atomic Primitive: Persists preference and enqueues PREFERENCE UPSERT mutation in the same IDB transaction.
   * Enforces mutation immutability via add().
   */
  async putPreferenceWithMutation(
    preference: LocalPreference,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(preference.ownerScope);
    assertValidScope(mutation.ownerScope);

    if (preference.ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: preference (${preference.ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.PREFERENCE) {
      throw new Error(`Domain mismatch: expected PREFERENCE, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.UPSERT) {
      throw new Error(`Operation mismatch: expected UPSERT, got ${mutation.operation}`);
    }

    if (mutation.entityId !== preference.key) {
      throw new Error(`EntityId mismatch: expected "${preference.key}", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_PREFERENCES, STORE_PENDING_MUTATIONS], 'readwrite');
        tx.objectStore(STORE_PREFERENCES).put(preference);
        tx.objectStore(STORE_PENDING_MUTATIONS).add(mutation);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction failed.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  /**
   * Atomic Primitive: Deletes single story history and enqueues HISTORY DELETE mutation in the same IDB transaction.
   * Enforces mutation immutability via add().
   */
  async deleteStoryHistoryWithMutation(
    ownerScope: string,
    storyId: string,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

    if (ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: ownerScope (${ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.HISTORY) {
      throw new Error(`Domain mismatch: expected HISTORY, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.DELETE) {
      throw new Error(`Operation mismatch: expected DELETE, got ${mutation.operation}`);
    }

    if (mutation.entityId !== storyId) {
      throw new Error(`EntityId mismatch: expected "${storyId}", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_HISTORY, STORE_PROGRESS, STORE_PENDING_MUTATIONS], 'readwrite');

        const histStore = tx.objectStore(STORE_HISTORY);
        const range = IDBKeyRange.bound([ownerScope, storyId, ''], [ownerScope, storyId, '\uffff']);
        const req = histStore.openCursor(range);

        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        const progStore = tx.objectStore(STORE_PROGRESS);
        progStore.delete([ownerScope, storyId]);

        const mutStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        mutStore.add(mutation);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction failed.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  /**
   * Atomic Primitive: Clears all history for ownerScope and enqueues global HISTORY DELETE mutation in the same IDB transaction.
   * Enforces mutation immutability via add().
   */
  async clearAllHistoryWithMutation(
    ownerScope: string,
    mutation: LocalPendingMutation
  ): Promise<void> {
    assertValidScope(ownerScope);
    assertValidScope(mutation.ownerScope);

    if (ownerScope !== mutation.ownerScope) {
      throw new Error(`Scope mismatch: ownerScope (${ownerScope}) does not match mutation (${mutation.ownerScope})`);
    }

    if (mutation.domain !== SyncDomain.HISTORY) {
      throw new Error(`Domain mismatch: expected HISTORY, got ${mutation.domain}`);
    }

    if (mutation.operation !== SyncOperation.DELETE) {
      throw new Error(`Operation mismatch: expected DELETE, got ${mutation.operation}`);
    }

    if (mutation.entityId !== 'all' && mutation.entityId !== '00000000-0000-0000-0000-000000000000') {
      throw new Error(`EntityId mismatch for clearAllHistory: expected "all" or sentinel UUID "00000000-0000-0000-0000-000000000000", got "${mutation.entityId}"`);
    }

    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_HISTORY, STORE_PROGRESS, STORE_PENDING_MUTATIONS], 'readwrite');

        const histStore = tx.objectStore(STORE_HISTORY);
        const histRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const histReq = histStore.openCursor(histRange);

        histReq.onsuccess = () => {
          const cursor = histReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        const progStore = tx.objectStore(STORE_PROGRESS);
        const progRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const progReq = progStore.openCursor(progRange);

        progReq.onsuccess = () => {
          const cursor = progReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        const mutStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        mutStore.add(mutation);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction failed.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  // ==================== BOOKMARKS SCOPE-BOUND OPERATIONS ====================

  async putBookmark(bookmark: LocalBookmark): Promise<void> {
    assertValidScope(bookmark.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
        tx.objectStore(STORE_BOOKMARKS).put(bookmark);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error);
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  async getBookmark(ownerScope: string, storyId: string): Promise<LocalBookmark | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKMARKS).get([ownerScope, storyId]);
      req.onsuccess = () => resolve((req.result as LocalBookmark) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBookmark(ownerScope: string, storyId: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
      tx.objectStore(STORE_BOOKMARKS).delete([ownerScope, storyId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getBookmarks(ownerScope: string): Promise<LocalBookmark[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
      const store = tx.objectStore(STORE_BOOKMARKS);
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = store.openCursor(range);
      const results: LocalBookmark[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const item = cursor.value as LocalBookmark;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ==================== READING PROGRESS SCOPE-BOUND OPERATIONS ====================

  async getProgress(ownerScope: string, storyId: string): Promise<LocalReadingProgress | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROGRESS, 'readonly');
      const req = tx.objectStore(STORE_PROGRESS).get([ownerScope, storyId]);
      req.onsuccess = () => resolve((req.result as LocalReadingProgress) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putProgress(progress: LocalReadingProgress): Promise<void> {
    assertValidScope(progress.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PROGRESS, 'readwrite');
        tx.objectStore(STORE_PROGRESS).put(progress);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error);
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  async deleteProgress(ownerScope: string, storyId: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROGRESS, 'readwrite');
      tx.objectStore(STORE_PROGRESS).delete([ownerScope, storyId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== READING HISTORY SCOPE-BOUND OPERATIONS ====================

  async getHistory(ownerScope: string): Promise<LocalReadingHistory[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY, 'readonly');
      const store = tx.objectStore(STORE_HISTORY);
      const index = store.index('by_owner_time');
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = index.openCursor(range, 'prev');
      const results: LocalReadingHistory[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const item = cursor.value as LocalReadingHistory;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async deleteStoryHistory(ownerScope: string, storyId: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_HISTORY, STORE_PROGRESS], 'readwrite');

      const histStore = tx.objectStore(STORE_HISTORY);
      const range = IDBKeyRange.bound([ownerScope, storyId, ''], [ownerScope, storyId, '\uffff']);
      const req = histStore.openCursor(range);

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      const progStore = tx.objectStore(STORE_PROGRESS);
      progStore.delete([ownerScope, storyId]);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteHistoryItem(ownerScope: string, storyId: string, chapterId: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY, 'readwrite');
      tx.objectStore(STORE_HISTORY).delete([ownerScope, storyId, chapterId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAllHistory(ownerScope: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_HISTORY, STORE_PROGRESS], 'readwrite');

      const histStore = tx.objectStore(STORE_HISTORY);
      const histRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const histReq = histStore.openCursor(histRange);

      histReq.onsuccess = () => {
        const cursor = histReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      const progStore = tx.objectStore(STORE_PROGRESS);
      const progRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const progReq = progStore.openCursor(progRange);

      progReq.onsuccess = () => {
        const cursor = progReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllProgress(ownerScope: string): Promise<LocalReadingProgress[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROGRESS, 'readonly');
      const store = tx.objectStore(STORE_PROGRESS);
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = store.openCursor(range);
      const results: LocalReadingProgress[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const item = cursor.value as LocalReadingProgress;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ==================== PREFERENCES SCOPE-BOUND OPERATIONS (Phase 7C.3) ====================

  async getPreference(ownerScope: string, key: string): Promise<LocalPreference | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PREFERENCES, 'readonly');
      const req = tx.objectStore(STORE_PREFERENCES).get([ownerScope, key]);
      req.onsuccess = () => resolve((req.result as LocalPreference) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putPreference(preference: LocalPreference): Promise<void> {
    assertValidScope(preference.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PREFERENCES, 'readwrite');
        tx.objectStore(STORE_PREFERENCES).put(preference);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getAllPreferences(ownerScope: string): Promise<LocalPreference[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PREFERENCES, 'readonly');
      const store = tx.objectStore(STORE_PREFERENCES);
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = store.openCursor(range);
      const results: LocalPreference[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const item = cursor.value as LocalPreference;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async deletePreference(ownerScope: string, key: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PREFERENCES, 'readwrite');
      tx.objectStore(STORE_PREFERENCES).delete([ownerScope, key]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== SYNC METADATA SCOPE-BOUND OPERATIONS (Phase 7C.3) ====================

  async getSyncMeta(ownerScope: string): Promise<LocalSyncMeta | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SYNC_META, 'readonly');
      const req = tx.objectStore(STORE_SYNC_META).get(ownerScope);
      req.onsuccess = () => {
        const meta = req.result as LocalSyncMeta | undefined;
        if (!meta) {
          resolve(null);
          return;
        }
        resolve({
          ...meta,
          authoritativeBaselineStatus: meta.authoritativeBaselineStatus || 'UNINITIALIZED',
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async putSyncMeta(meta: LocalSyncMeta): Promise<void> {
    assertValidScope(meta.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_SYNC_META, 'readwrite');
        const store = tx.objectStore(STORE_SYNC_META);
        const getReq = store.get(meta.ownerScope);
        getReq.onsuccess = () => {
          try {
            const existing = getReq.result as LocalSyncMeta | undefined;
            const targetStatus =
              meta.authoritativeBaselineStatus ??
              existing?.authoritativeBaselineStatus ??
              'UNINITIALIZED';

            // Invariant 1: Cannot elevate an unverified scope to READY via putSyncMeta
            if (targetStatus === 'READY' && existing?.authoritativeBaselineStatus !== 'READY') {
              throw new ReadyStatusTransitionForbiddenError(
                'Cannot transition baseline status to READY via putSyncMeta without atomic baseline proof verification.'
              );
            }

            // Invariant 2: Checkpoint, Epoch & MinActiveRevision Immutability on READY scopes via putSyncMeta:
            // If a scope is already READY, lastSyncedServerRevision, minActiveRevision, and effectiveHistoryEpochs
            // cannot be mutated via benign putSyncMeta(). Mutating checkpoints or epochs on a READY
            // scope belongs strictly to atomic delta ingestion (applyAuthoritativeDeltaPage in Step 5.2b).
            if (existing?.authoritativeBaselineStatus === 'READY') {
              if (
                meta.lastSyncedServerRevision !== undefined &&
                meta.lastSyncedServerRevision !== existing.lastSyncedServerRevision
              ) {
                throw new ReadyStatusTransitionForbiddenError(
                  `CHECKPOINT_MUTATION_FORBIDDEN: Mutating lastSyncedServerRevision on a READY scope via putSyncMeta is forbidden (attempted to change from "${existing.lastSyncedServerRevision}" to "${meta.lastSyncedServerRevision}"). Checkpoint updates require atomic delta ingestion.`
                );
              }
              if (
                meta.minActiveRevision !== undefined &&
                meta.minActiveRevision !== existing.minActiveRevision
              ) {
                throw new ReadyStatusTransitionForbiddenError(
                  `CHECKPOINT_MUTATION_FORBIDDEN: Mutating minActiveRevision on a READY scope via putSyncMeta is forbidden (attempted to change from "${existing.minActiveRevision}" to "${meta.minActiveRevision}"). Synchronization metadata updates require atomic delta ingestion.`
                );
              }
              if (
                meta.effectiveHistoryEpochs !== undefined &&
                !areEpochMapsEqual(meta.effectiveHistoryEpochs, existing.effectiveHistoryEpochs)
              ) {
                throw new ReadyStatusTransitionForbiddenError(
                  'CHECKPOINT_MUTATION_FORBIDDEN: Mutating effectiveHistoryEpochs on a READY scope via putSyncMeta is forbidden. Epoch updates require atomic delta ingestion.'
                );
              }
            }

            const normalized: LocalSyncMeta = {
              ...meta,
              authoritativeBaselineStatus: targetStatus,
            };
            store.put(normalized);
          } catch (err) {
            try {
              tx.abort();
            } catch (_) {}
            reject(err);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('putSyncMeta transaction aborted.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==================== AUTHORITATIVE SHADOW & BASELINE LIFECYCLE (Phase 5.2a) ====================

  async getAuthoritativeBaselineStatus(ownerScope: string): Promise<AuthoritativeBaselineStatus> {
    assertValidScope(ownerScope);
    const meta = await this.getSyncMeta(ownerScope);
    return meta?.authoritativeBaselineStatus || 'UNINITIALIZED';
  }

  /**
   * Sets local baseline status.
   * STRICT INVARIANT: Direct transition to 'READY' is forbidden in Step 5.2a; callers can only set
   * 'UNINITIALIZED' or 'BOOTSTRAPPING'. Transition to 'READY' is deferred to Step 6 verified bootstrap finalization.
   */
  async setAuthoritativeBaselineStatus(
    ownerScope: string,
    status: AuthoritativeBaselineStatus,
  ): Promise<void> {
    assertValidScope(ownerScope);
    if (status === 'READY') {
      throw new ReadyStatusTransitionForbiddenError(
        'Transition to READY baseline status is forbidden in Step 5.2a. Direct transition via setAuthoritativeBaselineStatus is locked.'
      );
    }
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_SYNC_META, 'readwrite');
        const store = tx.objectStore(STORE_SYNC_META);
        const getReq = store.get(ownerScope);
        getReq.onsuccess = () => {
          const existing = getReq.result as LocalSyncMeta | undefined;
          const updated: LocalSyncMeta = existing
            ? { ...existing, authoritativeBaselineStatus: status }
            : {
                ownerScope,
                lastSyncedServerRevision: '0',
                minActiveRevision: '0',
                lastSyncTimestamp: new Date(0).toISOString(),
                effectiveHistoryEpochs: {},
                syncState: 'IDLE',
                authoritativeBaselineStatus: status,
              };
          store.put(updated);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('setAuthoritativeBaselineStatus transaction aborted.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async isAuthoritativeReady(ownerScope: string): Promise<boolean> {
    const status = await this.getAuthoritativeBaselineStatus(ownerScope);
    return status === 'READY';
  }

  async getAuthoritativeShadow(
    ownerScope: string,
    domain: SyncDomain,
    entityKey: string,
  ): Promise<AuthoritativeShadowRecord | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_AUTHORITATIVE_REPLICAS, 'readonly');
        const req = tx.objectStore(STORE_AUTHORITATIVE_REPLICAS).get([ownerScope, domain, entityKey]);
        req.onsuccess = () => resolve((req.result as AuthoritativeShadowRecord) || null);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Internal/Test-Only Primitive: Direct authoritative shadow write.
   * WARNING: Production Delta Pull (Step 5.2b) MUST NOT call this directly.
   * Production delta ingestion must use `applyAuthoritativeDeltaPage` to enforce
   * atomic shadow writes, tombstone cascades, causal projection, and OCC server revision updates.
   */
  async putAuthoritativeShadow(record: AuthoritativeShadowRecord): Promise<void> {
    assertValidScope(record.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_AUTHORITATIVE_REPLICAS, 'readwrite');
        tx.objectStore(STORE_AUTHORITATIVE_REPLICAS).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getAuthoritativeShadowsByDomain(
    ownerScope: string,
    domain: SyncDomain,
  ): Promise<AuthoritativeShadowRecord[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_AUTHORITATIVE_REPLICAS, 'readonly');
        const store = tx.objectStore(STORE_AUTHORITATIVE_REPLICAS);
        const index = store.index('by_scope_domain');
        const req = index.getAll(IDBKeyRange.only([ownerScope, domain]));
        req.onsuccess = () => resolve((req.result as AuthoritativeShadowRecord[]) || []);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async deleteAuthoritativeShadow(
    ownerScope: string,
    domain: SyncDomain,
    entityKey: string,
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_AUTHORITATIVE_REPLICAS, 'readwrite');
        tx.objectStore(STORE_AUTHORITATIVE_REPLICAS).delete([ownerScope, domain, entityKey]);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==================== DURABLE TOMBSTONE REPOSITORY & BOUNDED GC (P1-01) ====================

  async getAuthoritativeTombstone(
    ownerScope: string,
    domain: SyncDomain,
    entityKey: string,
  ): Promise<AuthoritativeTombstoneRecord | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_TOMBSTONES, 'readonly');
        const req = tx.objectStore(STORE_TOMBSTONES).get([ownerScope, domain, entityKey]);
        req.onsuccess = () => resolve((req.result as AuthoritativeTombstoneRecord) || null);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getAuthoritativeTombstonesByDomain(
    ownerScope: string,
    domain: SyncDomain,
  ): Promise<AuthoritativeTombstoneRecord[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_TOMBSTONES, 'readonly');
        const store = tx.objectStore(STORE_TOMBSTONES);
        const index = store.index('by_scope_domain');
        const req = index.getAll(IDBKeyRange.only([ownerScope, domain]));
        req.onsuccess = () => resolve((req.result as AuthoritativeTombstoneRecord[]) || []);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getAllAuthoritativeTombstones(ownerScope: string): Promise<AuthoritativeTombstoneRecord[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_TOMBSTONES, 'readonly');
        const store = tx.objectStore(STORE_TOMBSTONES);
        const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const req = store.openCursor(range);
        const results: AuthoritativeTombstoneRecord[] = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const rec = cursor.value as AuthoritativeTombstoneRecord;
            if (rec && rec.ownerScope === ownerScope) {
              results.push(rec);
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Internal/Test-Only Primitive: Persists a tombstone record with BigInt monotonicity.
   * Never downgrades an existing tombstone with a strictly greater deletedAtRevision.
   */
  async putAuthoritativeTombstone(record: AuthoritativeTombstoneRecord): Promise<void> {
    assertValidScope(record.ownerScope);
    if (!isValidRevisionString(record.deletedAtRevision)) {
      throw new InvalidDeltaPayloadError(
        `Invalid tombstone deletedAtRevision: "${record.deletedAtRevision}" must be a decimal string.`
      );
    }

    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      let isSettled = false;
      const fail = (err: unknown) => {
        if (!isSettled) {
          isSettled = true;
          try {
            tx.abort();
          } catch (_) {}
          reject(err);
        }
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE_TOMBSTONES, 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }

      tx.oncomplete = () => {
        if (!isSettled) {
          isSettled = true;
          resolve();
        }
      };
      tx.onerror = () => fail(tx.error || new Error('Transaction error in putAuthoritativeTombstone.'));
      tx.onabort = () => fail(tx.error || new Error('Transaction aborted in putAuthoritativeTombstone.'));

      try {
        const store = tx.objectStore(STORE_TOMBSTONES);
        const getReq = store.get([record.ownerScope, record.domain, record.entityKey]);
        getReq.onerror = () => fail(getReq.error || new Error('Failed to read tombstone in putAuthoritativeTombstone.'));
        getReq.onsuccess = () => {
          try {
            const existing = getReq.result as AuthoritativeTombstoneRecord | undefined;
            if (existing) {
              if (!isValidRevisionString(existing.deletedAtRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Corrupt existing tombstone deletedAtRevision: "${existing.deletedAtRevision}".`
                  )
                );
                return;
              }
              if (BigInt(existing.deletedAtRevision) > BigInt(record.deletedAtRevision)) {
                return; // Monotonic guard: preserve higher existing revision
              }
            }
            store.put(record);
          } catch (err) {
            fail(err);
          }
        };
      } catch (err) {
        fail(err);
      }
    });
  }

  /**
   * Bounded Atomic Tombstone Garbage Collection (P1-01):
   * Locks [STORE_TOMBSTONES, STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS, STORE_SYNC_META]
   * in a single IDB readwrite transaction and fails closed on any invalid decimal revision.
   *
   * safeGcFloor = min(
   *   syncedRev,
   *   minActiveRevision,
   *   min(non-discarded queue baseServerRevisions) ?? syncedRev,
   *   options.maxEvictableRevision ?? syncedRev
   * )
   *
   * Deletes tombstone iff BigInt(deletedAtRevision) <= safeGcFloor.
   */
  async gcAuthoritativeTombstones(
    ownerScope: string,
    options?: GcTombstonesOptions,
  ): Promise<GcTombstonesResult> {
    assertValidScope(ownerScope);

    if (
      options?.maxEvictableRevision !== undefined &&
      !isValidRevisionString(options.maxEvictableRevision)
    ) {
      throw new InvalidDeltaPayloadError(
        `Invalid maxEvictableRevision in GC: "${options.maxEvictableRevision}" must be a decimal string.`
      );
    }

    options?.checkAdmission?.();
    const db = await this.getDatabase();
    options?.checkAdmission?.();

    return new Promise<GcTombstonesResult>((resolve, reject) => {
      let isSettled = false;
      const fail = (err: unknown) => {
        if (!isSettled) {
          isSettled = true;
          try {
            tx.abort();
          } catch (_) {}
          reject(err);
        }
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(
          [
            STORE_TOMBSTONES,
            STORE_PENDING_MUTATIONS,
            STORE_QUARANTINED_MUTATIONS,
            STORE_SYNC_META,
          ],
          'readwrite',
        );
      } catch (err) {
        reject(err);
        return;
      }

      let result: GcTombstonesResult | null = null;
      tx.onerror = () => fail(tx.error || new Error('Transaction error in gcAuthoritativeTombstones.'));
      tx.onabort = () => fail(tx.error || new Error('Transaction aborted in gcAuthoritativeTombstones.'));
      tx.oncomplete = () => {
        if (!isSettled && result) {
          isSettled = true;
          resolve(result);
        }
      };

      try {
        const tombstoneStore = tx.objectStore(STORE_TOMBSTONES);
        const pendingStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        const quarantinedStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);
        const metaStore = tx.objectStore(STORE_SYNC_META);

        let remaining = 4;
        let syncMeta: LocalSyncMeta | null = null;
        const pendingItems: LocalPendingMutation[] = [];
        const quarantinedItems: LocalQuarantinedMutation[] = [];
        const tombstoneItems: AuthoritativeTombstoneRecord[] = [];

        const scanScopeStore = <T extends { ownerScope: string }>(
          store: IDBObjectStore,
          target: T[],
          label: string,
        ) => {
          const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
          const req = store.openCursor(range);
          req.onerror = () => fail(req.error || new Error(`Failed scanning ${label} in tombstone GC.`));
          req.onsuccess = () => {
            try {
              const cursor = req.result;
              if (cursor) {
                const item = cursor.value as T;
                if (item && item.ownerScope === ownerScope) {
                  target.push(item);
                }
                cursor.continue();
              } else {
                onSubTaskComplete();
              }
            } catch (err) {
              fail(err);
            }
          };
        };

        const evaluateAndPrune = () => {
          try {
            options?.checkAdmission?.();

            let syncedRev = 0n;
            let minActiveRev = 0n;

            if (syncMeta) {
              if (!isValidRevisionString(syncMeta.lastSyncedServerRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid lastSyncedServerRevision during tombstone GC: "${syncMeta.lastSyncedServerRevision}".`
                  )
                );
                return;
              }
              syncedRev = BigInt(syncMeta.lastSyncedServerRevision);

              if (syncMeta.minActiveRevision !== undefined && syncMeta.minActiveRevision !== null) {
                if (!isValidRevisionString(syncMeta.minActiveRevision)) {
                  fail(
                    new InvalidDeltaPayloadError(
                      `Invalid minActiveRevision during tombstone GC: "${syncMeta.minActiveRevision}".`
                    )
                  );
                  return;
                }
                minActiveRev = BigInt(syncMeta.minActiveRevision);
              }
            }

            const floorCandidates: bigint[] = [syncedRev, minActiveRev];

            if (options?.maxEvictableRevision !== undefined) {
              if (!isValidRevisionString(options.maxEvictableRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid maxEvictableRevision during tombstone GC: "${options.maxEvictableRevision}".`
                  )
                );
                return;
              }
              floorCandidates.push(BigInt(options.maxEvictableRevision));
            }

            for (const pending of pendingItems) {
              if (!isValidRevisionString(pending.baseServerRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid pending baseServerRevision during tombstone GC: "${pending.baseServerRevision}" (mutationId="${pending.mutationId}").`
                  )
                );
                return;
              }
              floorCandidates.push(BigInt(pending.baseServerRevision));
            }

            for (const q of quarantinedItems) {
              if (!isValidRevisionString(q.baseServerRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid quarantined baseServerRevision during tombstone GC: "${q.baseServerRevision}" (mutationId="${q.mutationId}").`
                  )
                );
                return;
              }
              if (q.triageStatus !== 'DISCARDED') {
                floorCandidates.push(BigInt(q.baseServerRevision));
              }
            }

            // Fail-closed validation of all tombstone revisions before issuing any delete
            for (const tomb of tombstoneItems) {
              if (!isValidRevisionString(tomb.deletedAtRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid tombstone deletedAtRevision during GC: "${tomb.deletedAtRevision}" (${tomb.domain}:${tomb.entityKey}).`
                  )
                );
                return;
              }
            }

            let safeGcFloor = floorCandidates[0];
            for (let i = 1; i < floorCandidates.length; i++) {
              if (floorCandidates[i] < safeGcFloor) {
                safeGcFloor = floorCandidates[i];
              }
            }

            let deletedCount = 0;
            let retainedCount = 0;
            for (const tomb of tombstoneItems) {
              if (BigInt(tomb.deletedAtRevision) <= safeGcFloor) {
                tombstoneStore.delete([ownerScope, tomb.domain, tomb.entityKey]);
                deletedCount += 1;
              } else {
                retainedCount += 1;
              }
            }

            result = {
              scannedCount: tombstoneItems.length,
              deletedCount,
              retainedCount,
              safeGcFloor: safeGcFloor.toString(),
            };

            if (options?._testHookBeforeComplete) {
              options._testHookBeforeComplete(tx);
            }
          } catch (err) {
            fail(err);
          }
        };

        const onSubTaskComplete = () => {
          if (isSettled) return;
          remaining -= 1;
          if (remaining === 0) {
            evaluateAndPrune();
          }
        };

        const metaReq = metaStore.get(ownerScope);
        metaReq.onerror = () => fail(metaReq.error || new Error('Failed loading sync_meta in tombstone GC.'));
        metaReq.onsuccess = () => {
          syncMeta = (metaReq.result as LocalSyncMeta | undefined) ?? null;
          onSubTaskComplete();
        };

        scanScopeStore<LocalPendingMutation>(pendingStore, pendingItems, STORE_PENDING_MUTATIONS);
        scanScopeStore<LocalQuarantinedMutation>(quarantinedStore, quarantinedItems, STORE_QUARANTINED_MUTATIONS);
        scanScopeStore<AuthoritativeTombstoneRecord>(tombstoneStore, tombstoneItems, STORE_TOMBSTONES);
      } catch (err) {
        fail(err);
      }
    });
  }

  /**
   * Atomic Primitive: Ingests an authoritative delta changes page into local storage.
   * Uses a SINGLE IDB readwrite transaction over [STORE_AUTHORITATIVE_REPLICAS, STORE_TOMBSTONES, STORE_SYNC_META].
   * Enforces:
   * 1. Checkpoint OCC guard (expectedCheckpoint validation against current lastSyncedServerRevision).
   * 2. Decimal BigInt validation & monotonic revision progression.
   * 3. Durable independent STORE_TOMBSTONES persistence with BigInt monotonicity and delete lineage preservation.
   * 4. Story-wide and Global HISTORY DELETE cascading to shadow records BEFORE surviving in-page upserts (FIFO-safe).
   * 5. Temporary client compatibility epoch inference ONLY for epoch-less PROGRESS UPSERT payloads
   *    (does NOT establish independent server causality; explicit numeric epochs are preserved fail-closed).
   * 6. Epoch map progression in the same transaction.
   * 7. Fail-closed on malformed revisions, missing HISTORY DELETE epochs, or unsupported operations.
   * NOTE: Step 5.2b / P1-01 DOES NOT grant READY baseline status.
   */
  async applyAuthoritativeDeltaPage(
    options: ApplyAuthoritativeDeltaPageOptions
  ): Promise<ApplyAuthoritativeDeltaResult> {
    const { ownerScope, page, expectedCheckpoint, checkAdmission, _testHookBeforeComplete } = options;
    assertValidScope(ownerScope);

    // 1. Pre-transaction validation of mandatory OCC checkpoint
    if (
      expectedCheckpoint === undefined ||
      expectedCheckpoint === null ||
      typeof expectedCheckpoint !== 'string' ||
      !isValidRevisionString(expectedCheckpoint)
    ) {
      throw new InvalidDeltaPayloadError(
        `MANDATORY_OCC_CHECKPOINT_REQUIRED: expectedCheckpoint is mandatory and must be a valid decimal string, got: ${JSON.stringify(expectedCheckpoint)}`
      );
    }

    // 2. Pre-transaction validation of page structure and metadata
    if (!page || typeof page !== 'object' || !Array.isArray(page.changes)) {
      throw new InvalidDeltaPayloadError('Invalid delta page: changes array is required.');
    }

    if (typeof page.currentServerRevision !== 'string' || !isValidRevisionString(page.currentServerRevision)) {
      throw new InvalidDeltaPayloadError(
        `Invalid currentServerRevision: "${page.currentServerRevision}" must be a decimal string.`
      );
    }

    if (typeof page.minActiveRevision !== 'string' || !isValidRevisionString(page.minActiveRevision)) {
      throw new InvalidDeltaPayloadError(
        `Invalid minActiveRevision: "${page.minActiveRevision}" must be a decimal string.`
      );
    }

    if (typeof page.hasMore !== 'boolean') {
      throw new InvalidDeltaPayloadError(
        `Invalid delta page: hasMore must be a boolean, got ${typeof page.hasMore}.`
      );
    }

    // P0-03 Delta Pagination Cursor Integrity:
    // Core API getChanges() contract:
    // - If hasMore === true: changes must not be empty, nextRevision must be a valid decimal string,
    //   and nextRevision must strictly equal the revision of the last change in the page.
    // - If hasMore === false: nextRevision must be null.
    if (page.hasMore) {
      if (page.changes.length === 0) {
        throw new InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: hasMore is true, but changes array is empty.'
        );
      }
      if (page.nextRevision === null || page.nextRevision === undefined || !isValidRevisionString(page.nextRevision)) {
        throw new InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: hasMore is true, but nextRevision is null, undefined, or not a valid decimal string.'
        );
      }
      const lastChange = page.changes[page.changes.length - 1];
      if (!lastChange || !isValidRevisionString(lastChange.revision)) {
        throw new InvalidDeltaPayloadError(
          'INCONSISTENT_DELTA_PAGE: Last change in page is invalid or missing revision.'
        );
      }
      if (page.nextRevision !== lastChange.revision) {
        throw new InvalidDeltaPayloadError(
          `INCONSISTENT_DELTA_PAGE: nextRevision "${page.nextRevision}" does not match last change revision "${lastChange.revision}" when hasMore is true.`
        );
      }
    } else {
      if (page.nextRevision !== null) {
        throw new InvalidDeltaPayloadError(
          `INCONSISTENT_DELTA_PAGE: hasMore is false, but nextRevision is not null (got: ${JSON.stringify(page.nextRevision)}). Core API contract requires nextRevision to be null when hasMore is false.`
        );
      }
    }

    // 3. Compaction Retention Gap Guard:
    // If client has an established checkpoint (> '0') that has fallen behind server minActiveRevision,
    // the history was pruned on server and delta sync cannot bridge this gap. Must trigger snapshot resync.
    if (expectedCheckpoint !== '0' && BigInt(expectedCheckpoint) < BigInt(page.minActiveRevision)) {
      throw new InvalidDeltaPayloadError(
        `COMPACTED_RETENTION_GAP: Client checkpoint "${expectedCheckpoint}" is older than server minActiveRevision "${page.minActiveRevision}". History has been pruned; delta sync cannot bridge this gap. Full resync required.`
      );
    }

    // 4. Determine target checkpoint and enforce server boundary
    const targetCheckpoint: string = page.hasMore
      ? (page.nextRevision as string)
      : page.currentServerRevision;

    const expCkptBigInt = BigInt(expectedCheckpoint);
    const targetCkptBigInt = BigInt(targetCheckpoint);
    const currentServerRevBigInt = BigInt(page.currentServerRevision);

    if (targetCkptBigInt > currentServerRevBigInt) {
      throw new InvalidDeltaPayloadError(
        `INCONSISTENT_DELTA_PAGE: targetCheckpoint "${targetCheckpoint}" exceeds currentServerRevision "${page.currentServerRevision}".`
      );
    }

    if (targetCkptBigInt < expCkptBigInt) {
      throw new InvalidDeltaPayloadError(
        `REGRESSIVE_CHECKPOINT: Target checkpoint "${targetCheckpoint}" is less than expected checkpoint "${expectedCheckpoint}".`
      );
    }

    // 5. Validate each change item
    let prevRev: bigint | null = null;
    let hasAnyDeletes = false;
    for (let i = 0; i < page.changes.length; i++) {
      const change = page.changes[i];
      if (!change || typeof change !== 'object') {
        throw new InvalidDeltaPayloadError(`Delta change at index ${i} is invalid.`);
      }

      if (!isValidRevisionString(change.revision)) {
        throw new InvalidDeltaPayloadError(
          `Delta change at index ${i} has invalid revision: "${change.revision}". Must be a decimal string.`
        );
      }

      const revBigInt = BigInt(change.revision);

      // Boundary: changes must be strictly after expectedCheckpoint
      if (revBigInt <= expCkptBigInt) {
        throw new InvalidDeltaPayloadError(
          `INCONSISTENT_DELTA_PAGE: Delta change at index ${i} has revision "${change.revision}" <= expectedCheckpoint "${expectedCheckpoint}". Delta page cannot contain changes already synced.`
        );
      }

      // Boundary: changes must not exceed targetCheckpoint
      if (revBigInt > targetCkptBigInt) {
        throw new InvalidDeltaPayloadError(
          `INCONSISTENT_DELTA_PAGE: Delta change at index ${i} has revision "${change.revision}" > targetCheckpoint "${targetCheckpoint}".`
        );
      }

      // Ordering: changes within page must be in non-decreasing revision order
      if (prevRev !== null && revBigInt < prevRev) {
        throw new InvalidDeltaPayloadError(
          `Delta changes at index ${i} has regressive revision: "${change.revision}" < "${prevRev.toString()}". Changes must be in non-decreasing revision order.`
        );
      }
      prevRev = revBigInt;

      // Validate domain
      if (
        change.domain !== SyncDomain.BOOKMARK &&
        change.domain !== SyncDomain.PROGRESS &&
        change.domain !== SyncDomain.HISTORY &&
        change.domain !== SyncDomain.PREFERENCE &&
        change.domain !== SyncDomain.FOLLOW
      ) {
        throw new InvalidDeltaPayloadError(
          `Delta change at index ${i} has unsupported domain: "${change.domain}".`
        );
      }

      // Validate operation
      if (
        change.operation !== SyncOperation.UPSERT &&
        change.operation !== SyncOperation.DELETE
      ) {
        throw new InvalidDeltaPayloadError(
          `Delta change at index ${i} has unsupported operation: "${change.operation}".`
        );
      }

      if (change.operation === SyncOperation.DELETE) {
        hasAnyDeletes = true;
      }

      if (!change.entityId || typeof change.entityId !== 'string' || !change.entityId.trim()) {
        throw new InvalidDeltaPayloadError(
          `Delta change at index ${i} has missing or empty entityId.`
        );
      }

      // Invariant: HISTORY DELETE must contain a valid positive integer epoch in payload
      if (change.domain === SyncDomain.HISTORY && change.operation === SyncOperation.DELETE) {
        const epoch = change.payload?.epoch;
        if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch <= 0) {
          throw new InvalidDeltaPayloadError(
            `MISSING_HISTORY_DELETE_EPOCH: HISTORY DELETE at index ${i} must contain a valid positive integer epoch in payload, got: ${JSON.stringify(epoch)}`
          );
        }
      }
    }

    // 2. Pre-transaction admission check
    if (checkAdmission) {
      checkAdmission();
    }

    const db = await this.getDatabase();

    // Re-verify admission after async DB acquisition
    if (checkAdmission) {
      checkAdmission();
    }

    return new Promise<ApplyAuthoritativeDeltaResult>((resolve, reject) => {
      let isSettled = false;
      const fail = (err: any) => {
        if (!isSettled) {
          isSettled = true;
          try {
            tx.abort();
          } catch (_) {}
          reject(err);
        }
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(
          [STORE_AUTHORITATIVE_REPLICAS, STORE_TOMBSTONES, STORE_SYNC_META],
          'readwrite',
        );
      } catch (err) {
        reject(err);
        return;
      }

      tx.onerror = () => fail(tx.error || new Error('Transaction error in applyAuthoritativeDeltaPage.'));
      tx.onabort = () => fail(tx.error || new Error('Transaction aborted in applyAuthoritativeDeltaPage.'));

      let result: ApplyAuthoritativeDeltaResult | null = null;
      tx.oncomplete = () => {
        if (!isSettled && result) {
          isSettled = true;
          resolve(result);
        }
      };

      try {
        const shadowStore = tx.objectStore(STORE_AUTHORITATIVE_REPLICAS);
        const tombstoneStore = tx.objectStore(STORE_TOMBSTONES);
        const metaStore = tx.objectStore(STORE_SYNC_META);

        const executeDeltaWithTombstones = (
          existingMeta: LocalSyncMeta | undefined,
          existingTombstones: Map<string, AuthoritativeTombstoneRecord>,
        ) => {
          try {
            const effectiveEpochs: Record<string, number> = {
              ...(existingMeta?.effectiveHistoryEpochs || {}),
            };

            // Phase A: Chronological in-memory planner over page.changes
            // Tracks active upserts vs deletes, monotonic tombstones (preserving delete lineage across
            // DELETE@80 -> UPSERT@85), epoch transitions, and deferred cascade scopes.
            const pendingUpserts = new Map<string, AuthoritativeShadowRecord>();
            const directShadowDeletes = new Map<string, { domain: SyncDomain; entityKey: string }>();
            const pendingTombstones = new Map<string, AuthoritativeTombstoneRecord>();
            let runGlobalCascade = false;
            const storyCascadeIds = new Set<string>();

            const recordPendingTombstone = (
              domain: SyncDomain,
              entityKey: string,
              revision: string,
              epoch?: number,
            ) => {
              const composite = `${domain}::${entityKey}`;
              const prevRecord = pendingTombstones.get(composite) ?? existingTombstones.get(composite);
              if (prevRecord) {
                if (!isValidRevisionString(prevRecord.deletedAtRevision)) {
                  throw new InvalidDeltaPayloadError(
                    `Corrupt existing tombstone deletedAtRevision: "${prevRecord.deletedAtRevision}" (${domain}:${entityKey}).`
                  );
                }
                if (BigInt(prevRecord.deletedAtRevision) > BigInt(revision)) {
                  return;
                }
              }
              const prevRev = prevRecord?.deletedAtRevision;
              const finalRev = maxRevisionString(prevRev, revision) ?? revision;
              const mergedEpoch = epoch !== undefined ? epoch : prevRecord?.epoch;
              pendingTombstones.set(composite, {
                ownerScope,
                domain,
                entityKey,
                deletedAtRevision: finalRev,
                ...(mergedEpoch !== undefined ? { epoch: mergedEpoch } : {}),
                updatedAt: Date.now(),
              });
            };

            for (let i = 0; i < page.changes.length; i++) {
              const change = page.changes[i];
              const domain = change.domain;
              const op = change.operation;
              const payload = (change.payload || {}) as Record<string, any>;

              if (domain === SyncDomain.BOOKMARK) {
                const entityKey = String(payload.storyId || change.entityId);
                const composite = `${SyncDomain.BOOKMARK}::${entityKey}`;
                if (op === SyncOperation.UPSERT) {
                  directShadowDeletes.delete(composite);
                  pendingUpserts.set(composite, {
                    ownerScope,
                    domain: SyncDomain.BOOKMARK,
                    entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload,
                    isDeleted: false,
                    updatedAt: Date.now(),
                  });
                } else {
                  pendingUpserts.delete(composite);
                  directShadowDeletes.set(composite, { domain: SyncDomain.BOOKMARK, entityKey });
                  recordPendingTombstone(SyncDomain.BOOKMARK, entityKey, change.revision);
                }
              } else if (domain === SyncDomain.PROGRESS) {
                const entityKey = String(payload.storyId || change.entityId);
                const composite = `${SyncDomain.PROGRESS}::${entityKey}`;
                if (op === SyncOperation.UPSERT) {
                  // Temporary client compatibility inference ONLY when PROGRESS omits numeric
                  // observedHistoryEpoch & epoch (e.g. StoriesService/SnapshotDto).
                  // Explicit numeric values (including 0) are preserved verbatim to fail closed if stale.
                  // Compatibility inference does NOT prove independent server causality.
                  const hasExplicitObsEpoch =
                    typeof payload.observedHistoryEpoch === 'number' &&
                    Number.isFinite(payload.observedHistoryEpoch);
                  const hasExplicitEpoch =
                    typeof payload.epoch === 'number' &&
                    Number.isFinite(payload.epoch);
                  const inferredEpoch = Math.max(
                    effectiveEpochs[entityKey] || 0,
                    effectiveEpochs[GLOBAL_HISTORY_SENTINEL] || 0,
                    effectiveEpochs['all'] || 0,
                  );
                  const epoch = hasExplicitObsEpoch
                    ? (payload.observedHistoryEpoch as number)
                    : hasExplicitEpoch
                      ? (payload.epoch as number)
                      : inferredEpoch;

                  directShadowDeletes.delete(composite);
                  pendingUpserts.set(composite, {
                    ownerScope,
                    domain: SyncDomain.PROGRESS,
                    entityKey,
                    serverRevision: change.revision,
                    epoch,
                    payload,
                    isDeleted: false,
                    updatedAt: Date.now(),
                  });
                } else {
                  pendingUpserts.delete(composite);
                  directShadowDeletes.set(composite, { domain: SyncDomain.PROGRESS, entityKey });
                  recordPendingTombstone(SyncDomain.PROGRESS, entityKey, change.revision);
                }
              } else if (domain === SyncDomain.PREFERENCE) {
                const entityKey = String(payload.key || change.entityId);
                const composite = `${SyncDomain.PREFERENCE}::${entityKey}`;
                if (op === SyncOperation.UPSERT) {
                  directShadowDeletes.delete(composite);
                  pendingUpserts.set(composite, {
                    ownerScope,
                    domain: SyncDomain.PREFERENCE,
                    entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload,
                    isDeleted: false,
                    updatedAt: Date.now(),
                  });
                } else {
                  pendingUpserts.delete(composite);
                  directShadowDeletes.set(composite, { domain: SyncDomain.PREFERENCE, entityKey });
                  recordPendingTombstone(SyncDomain.PREFERENCE, entityKey, change.revision);
                }
              } else if (domain === SyncDomain.HISTORY) {
                if (op === SyncOperation.UPSERT) {
                  const storyId = String(
                    payload.storyId || (change.entityId.includes(':') ? change.entityId.split(':')[0] : change.entityId)
                  );
                  const chapterId = String(
                    payload.chapterId || (change.entityId.includes(':') ? change.entityId.split(':')[1] : '')
                  );
                  const entityKey = `${storyId}:${chapterId}`;
                  const composite = `${SyncDomain.HISTORY}::${entityKey}`;
                  const epoch =
                    typeof payload.observedHistoryEpoch === 'number' &&
                    Number.isFinite(payload.observedHistoryEpoch)
                      ? payload.observedHistoryEpoch
                      : typeof payload.epoch === 'number' && Number.isFinite(payload.epoch)
                        ? payload.epoch
                        : 0;
                  directShadowDeletes.delete(composite);
                  pendingUpserts.set(composite, {
                    ownerScope,
                    domain: SyncDomain.HISTORY,
                    entityKey,
                    serverRevision: change.revision,
                    epoch,
                    payload,
                    isDeleted: false,
                    updatedAt: Date.now(),
                  });
                } else if (op === SyncOperation.DELETE) {
                  const isGlobal =
                    change.entityId === GLOBAL_HISTORY_SENTINEL ||
                    change.entityId === 'all';
                  const newEpoch = payload.epoch as number;

                  if (isGlobal) {
                    const currentGlobalEpoch = Math.max(
                      effectiveEpochs[GLOBAL_HISTORY_SENTINEL] || 0,
                      effectiveEpochs['all'] || 0,
                    );
                    if (newEpoch <= currentGlobalEpoch) {
                      fail(
                        new InvalidDeltaPayloadError(
                          `NON_MONOTONIC_HISTORY_EPOCH: Incoming global HISTORY DELETE epoch (${newEpoch}) must be strictly greater than current global epoch (${currentGlobalEpoch}).`
                        )
                      );
                      return;
                    }

                    effectiveEpochs[GLOBAL_HISTORY_SENTINEL] = newEpoch;

                    for (const [k, rec] of pendingUpserts.entries()) {
                      if (rec.domain === SyncDomain.HISTORY || rec.domain === SyncDomain.PROGRESS) {
                        pendingUpserts.delete(k);
                      }
                    }

                    runGlobalCascade = true;
                    recordPendingTombstone(
                      SyncDomain.HISTORY,
                      GLOBAL_HISTORY_SENTINEL,
                      change.revision,
                      newEpoch,
                    );
                  } else {
                    const storyId = String(payload.storyId || change.entityId);
                    const currentStoryEpoch = effectiveEpochs[storyId] || 0;
                    const currentGlobalEpoch = Math.max(
                      effectiveEpochs[GLOBAL_HISTORY_SENTINEL] || 0,
                      effectiveEpochs['all'] || 0,
                    );
                    const currentEffectiveEpoch = Math.max(currentStoryEpoch, currentGlobalEpoch);
                    if (newEpoch <= currentEffectiveEpoch) {
                      fail(
                        new InvalidDeltaPayloadError(
                          `NON_MONOTONIC_HISTORY_EPOCH: Incoming story HISTORY DELETE epoch (${newEpoch}) for story "${storyId}" must be strictly greater than current effective epoch (${currentEffectiveEpoch}).`
                        )
                      );
                      return;
                    }

                    effectiveEpochs[storyId] = newEpoch;

                    for (const [k, rec] of pendingUpserts.entries()) {
                      if (
                        (rec.domain === SyncDomain.HISTORY &&
                          (rec.entityKey === storyId ||
                            rec.entityKey.startsWith(`${storyId}:`) ||
                            rec.payload?.storyId === storyId)) ||
                        (rec.domain === SyncDomain.PROGRESS && rec.entityKey === storyId)
                      ) {
                        pendingUpserts.delete(k);
                      }
                    }

                    storyCascadeIds.add(storyId);
                    recordPendingTombstone(SyncDomain.HISTORY, storyId, change.revision, newEpoch);
                  }
                }
              } else {
                // Other domains (e.g. FOLLOW)
                const entityKey = change.entityId;
                const composite = `${domain}::${entityKey}`;
                if (op === SyncOperation.UPSERT) {
                  directShadowDeletes.delete(composite);
                  pendingUpserts.set(composite, {
                    ownerScope,
                    domain,
                    entityKey,
                    serverRevision: change.revision,
                    epoch: 0,
                    payload,
                    isDeleted: false,
                    updatedAt: Date.now(),
                  });
                } else {
                  pendingUpserts.delete(composite);
                  directShadowDeletes.set(composite, { domain, entityKey });
                  recordPendingTombstone(domain, entityKey, change.revision);
                }
              }
            }

            // Phase B: Execute cursor cascades FIRST, and flush remaining deletes/upserts/tombstones/meta
            // ONLY after all openCursor cascades finish, eliminating intra-page FIFO overwrite hazards.
            const finalizeWrites = () => {
              if (isSettled) return;
              try {
                for (const target of directShadowDeletes.values()) {
                  shadowStore.delete([ownerScope, target.domain, target.entityKey]);
                }

                for (const record of pendingUpserts.values()) {
                  shadowStore.put(record);
                }

                for (const tombRecord of pendingTombstones.values()) {
                  tombstoneStore.put(tombRecord);
                }

                const updatedMeta: LocalSyncMeta = {
                  ownerScope,
                  lastSyncedServerRevision: targetCheckpoint,
                  minActiveRevision: page.minActiveRevision || existingMeta?.minActiveRevision || '0',
                  lastSyncTimestamp: new Date().toISOString(),
                  effectiveHistoryEpochs: effectiveEpochs,
                  syncState: 'IDLE',
                  // INVARIANT: Step 5.2b / P1-01 DOES NOT grant READY baseline status!
                  authoritativeBaselineStatus: existingMeta?.authoritativeBaselineStatus || 'UNINITIALIZED',
                  lastErrorMessage: null,
                };
                metaStore.put(updatedMeta);

                result = {
                  appliedCount: page.changes.length,
                  newCheckpoint: targetCheckpoint,
                  hasMore: Boolean(page.hasMore),
                  effectiveEpochs,
                };

                if (_testHookBeforeComplete) {
                  _testHookBeforeComplete(tx);
                }
              } catch (err) {
                fail(err);
              }
            };

            if (runGlobalCascade) {
              let remainingCursors = 2;
              const onCursorDone = () => {
                if (isSettled) return;
                remainingCursors -= 1;
                if (remainingCursors === 0) {
                  finalizeWrites();
                }
              };

              const hRange = IDBKeyRange.bound(
                [ownerScope, SyncDomain.HISTORY, ''],
                [ownerScope, SyncDomain.HISTORY, '\uffff'],
              );
              const hReq = shadowStore.openCursor(hRange);
              hReq.onerror = () => fail(hReq.error || new Error('Failed global HISTORY cascade cursor.'));
              hReq.onsuccess = () => {
                try {
                  const c = hReq.result;
                  if (c) {
                    c.delete();
                    c.continue();
                  } else {
                    onCursorDone();
                  }
                } catch (err) {
                  fail(err);
                }
              };

              const pRange = IDBKeyRange.bound(
                [ownerScope, SyncDomain.PROGRESS, ''],
                [ownerScope, SyncDomain.PROGRESS, '\uffff'],
              );
              const pReq = shadowStore.openCursor(pRange);
              pReq.onerror = () => fail(pReq.error || new Error('Failed global PROGRESS cascade cursor.'));
              pReq.onsuccess = () => {
                try {
                  const c = pReq.result;
                  if (c) {
                    c.delete();
                    c.continue();
                  } else {
                    onCursorDone();
                  }
                } catch (err) {
                  fail(err);
                }
              };
            } else if (storyCascadeIds.size > 0) {
              let remainingCursors = storyCascadeIds.size;
              const onCursorDone = () => {
                if (isSettled) return;
                remainingCursors -= 1;
                if (remainingCursors === 0) {
                  finalizeWrites();
                }
              };

              for (const storyId of storyCascadeIds) {
                shadowStore.delete([ownerScope, SyncDomain.HISTORY, storyId]);
                shadowStore.delete([ownerScope, SyncDomain.PROGRESS, storyId]);

                const sRange = IDBKeyRange.bound(
                  [ownerScope, SyncDomain.HISTORY, `${storyId}:`],
                  [ownerScope, SyncDomain.HISTORY, `${storyId}:\uffff`],
                );
                const sReq = shadowStore.openCursor(sRange);
                sReq.onerror = () => fail(sReq.error || new Error(`Failed story HISTORY cascade cursor for "${storyId}".`));
                sReq.onsuccess = () => {
                  try {
                    const c = sReq.result;
                    if (c) {
                      const item = c.value as AuthoritativeShadowRecord;
                      if (
                        item.entityKey === storyId ||
                        item.entityKey.startsWith(`${storyId}:`) ||
                        item.payload?.storyId === storyId
                      ) {
                        c.delete();
                      }
                      c.continue();
                    } else {
                      onCursorDone();
                    }
                  } catch (err) {
                    fail(err);
                  }
                };
              }
            } else {
              finalizeWrites();
            }
          } catch (err) {
            fail(err);
          }
        };

        const metaReq = metaStore.get(ownerScope);
        metaReq.onerror = () => fail(metaReq.error || new Error('Failed to load sync_meta in applyAuthoritativeDeltaPage.'));
        metaReq.onsuccess = () => {
          try {
            const existingMeta = metaReq.result as LocalSyncMeta | undefined;
            const currentCheckpoint = existingMeta?.lastSyncedServerRevision ?? '0';

            // 3. Mandatory Checkpoint OCC Guard:
            if (expectedCheckpoint !== currentCheckpoint) {
              fail(
                new CheckpointConflictError(
                  `OCC_CHECKPOINT_MISMATCH: Expected checkpoint "${expectedCheckpoint}", but current checkpoint is "${currentCheckpoint}".`
                )
              );
              return;
            }

            // 4. Monotonic Advance Guard: targetCheckpoint must be >= currentCheckpoint
            if (BigInt(targetCheckpoint) < BigInt(currentCheckpoint)) {
              fail(
                new InvalidDeltaPayloadError(
                  `REGRESSIVE_CHECKPOINT: Target checkpoint "${targetCheckpoint}" is less than current checkpoint "${currentCheckpoint}".`
                )
              );
              return;
            }

            if (!hasAnyDeletes) {
              executeDeltaWithTombstones(existingMeta, new Map());
              return;
            }

            const existingTombstoneMap = new Map<string, AuthoritativeTombstoneRecord>();
            const tRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
            const tReq = tombstoneStore.openCursor(tRange);
            tReq.onerror = () => fail(tReq.error || new Error('Failed loading tombstones in applyAuthoritativeDeltaPage.'));
            tReq.onsuccess = () => {
              try {
                const cursor = tReq.result;
                if (cursor) {
                  const rec = cursor.value as AuthoritativeTombstoneRecord;
                  if (rec && rec.ownerScope === ownerScope) {
                    existingTombstoneMap.set(`${rec.domain}::${rec.entityKey}`, rec);
                  }
                  cursor.continue();
                } else {
                  executeDeltaWithTombstones(existingMeta, existingTombstoneMap);
                }
              } catch (err) {
                fail(err);
              }
            };
          } catch (err) {
            fail(err);
          }
        };
      } catch (err) {
        fail(err);
      }
    });
  }

  // ==================== PENDING MUTATIONS QUEUE OPERATIONS (Phase 7C.3) ====================

  /**
   * Enqueues a new pending mutation using add() to enforce immutability.
   * Duplicate [ownerScope, mutationId] triggers ConstraintError and aborts transaction.
   */
  async enqueuePendingMutation(
    mutation: LocalPendingMutation,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(mutation.ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).add(mutation);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Failed to enqueue pending mutation.'));
          }
        };
        tx.onabort = () => {
          const error = tx.error;
          if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
            reject(new QuotaExceededStorageError());
          } else {
            reject(error || new Error('Enqueue pending mutation transaction aborted.'));
          }
        };
      } catch (err: any) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
          reject(new QuotaExceededStorageError());
        } else {
          reject(err);
        }
      }
    });
  }

  async getPendingMutation(ownerScope: string, mutationId: string): Promise<LocalPendingMutation | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readonly');
      const req = tx.objectStore(STORE_PENDING_MUTATIONS).get([ownerScope, mutationId]);
      req.onsuccess = () => resolve((req.result as LocalPendingMutation) || null);
      req.onerror = () => reject(tx.error || req.error);
    });
  }

  async getPendingMutations(ownerScope: string, limit: number = 100): Promise<LocalPendingMutation[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readonly');
      const store = tx.objectStore(STORE_PENDING_MUTATIONS);
      const index = store.index('by_scope_created');
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = index.openCursor(range, 'next'); // chronological
      const results: LocalPendingMutation[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && results.length < limit) {
          const item = cursor.value as LocalPendingMutation;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async deletePendingMutation(
    ownerScope: string,
    mutationId: string,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in deletePendingMutation.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async deletePendingMutationsBatch(
    ownerScope: string,
    mutationIds: string[],
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(ownerScope);
    if (mutationIds.length === 0) return;
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        const store = tx.objectStore(STORE_PENDING_MUTATIONS);
        for (const id of mutationIds) {
          store.delete([ownerScope, id]);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in deletePendingMutationsBatch.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async updatePendingMutationRetry(
    ownerScope: string,
    mutationId: string,
    retryCount: number,
    nextRetryAt?: number
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
      const store = tx.objectStore(STORE_PENDING_MUTATIONS);
      const req = store.get([ownerScope, mutationId]);
      req.onsuccess = () => {
        const item = req.result as LocalPendingMutation | undefined;
        if (item) {
          item.retryCount = retryCount;
          if (nextRetryAt !== undefined) {
            item.nextRetryAt = nextRetryAt;
          }
          store.put(item);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Atomic Primitive (Step 4a): Coordinates retry increment, exponential backoff calculation,
   * and quarantine transition in a single IndexedDB readwrite transaction across pending and quarantined stores.
   * Eliminates read-then-write race conditions and lost updates under concurrent failure handling.
   * Returns a TransientFailureResult with outcome 'RETRY_SCHEDULED' | 'QUARANTINED' | 'NOT_FOUND'.
   */
  async recordTransientFailureAtomic(
    ownerScope: string,
    mutationId: string,
    options: RecordTransientFailureOptions
  ): Promise<TransientFailureResult> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();

    if (options.checkAdmission) {
      options.checkAdmission();
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS], 'readwrite');
        const pStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        const qStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);

        const req = pStore.get([ownerScope, mutationId]);
        let result: TransientFailureResult = { outcome: 'NOT_FOUND' };

        req.onsuccess = () => {
          const item = req.result as LocalPendingMutation | undefined;
          if (!item) {
            result = { outcome: 'NOT_FOUND' };
            return;
          }

          const newRetryCount = (item.retryCount || 0) + 1;

          if (newRetryCount >= options.maxRetries) {
            // Reached maxRetries: atomically quarantine in the same transaction
            pStore.delete([ownerScope, mutationId]);

            const quarantined: LocalQuarantinedMutation = {
              ownerScope: item.ownerScope,
              mutationId: item.mutationId,
              clientId: item.clientId,
              domain: item.domain,
              entityId: item.entityId,
              operation: item.operation,
              baseServerRevision: item.baseServerRevision,
              payload: item.payload,
              rejectionReason: `EXCEEDED_MAX_RETRIES: ${options.failureReason}`,
              rejectionStatus: 'EXCEEDED_MAX_RETRIES',
              rejectedAt: new Date().toISOString(),
              triageStatus: 'PENDING',
              originalCreatedAt: item.createdAt,
            };

            qStore.put(quarantined);
            result = {
              outcome: 'QUARANTINED',
              retryCount: newRetryCount,
              quarantinedMutation: quarantined,
            };
          } else {
            // Below maxRetries: calculate exponential backoff and update in the same transaction
            const delay = Math.min(
              options.maxBackoffMs,
              options.initialBackoffMs * Math.pow(options.backoffFactor, newRetryCount - 1)
            );
            item.retryCount = newRetryCount;
            item.nextRetryAt = Date.now() + delay;

            pStore.put(item);
            result = {
              outcome: 'RETRY_SCHEDULED',
              retryCount: newRetryCount,
              nextRetryAt: item.nextRetryAt,
            };
          }

          if (options._testHookBeforeComplete) {
            try {
              options._testHookBeforeComplete(tx);
            } catch (hookErr) {
              reject(hookErr);
            }
          }
        };

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('Transaction error in recordTransientFailureAtomic.'));
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in recordTransientFailureAtomic.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Atomic Primitive: Increments retryCount and sets nextRetryAt in a SINGLE readwrite transaction.
   * Eliminates read-then-write race conditions under concurrent network failure handling.
   * Returns the updated retryCount and nextRetryAt, or null if mutation was not found.
   */
  async incrementPendingMutationRetryAtomic(
    ownerScope: string,
    mutationId: string,
    delayMs: number
  ): Promise<{ retryCount: number; nextRetryAt: number } | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        const store = tx.objectStore(STORE_PENDING_MUTATIONS);
        const req = store.get([ownerScope, mutationId]);
        let result: { retryCount: number; nextRetryAt: number } | null = null;

        req.onsuccess = () => {
          const item = req.result as LocalPendingMutation | undefined;
          if (!item) {
            result = null;
            return;
          }
          item.retryCount = (item.retryCount || 0) + 1;
          item.nextRetryAt = Date.now() + delayMs;
          store.put(item);
          result = { retryCount: item.retryCount, nextRetryAt: item.nextRetryAt };
        };

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in incrementPendingMutationRetryAtomic.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Atomic Primitive: Moves a mutation from pending_mutations to quarantined_mutations by direct composite key lookup.
   * Avoids scanning or pagination limits.
   */
  async quarantinePendingMutationByKey(
    ownerScope: string,
    mutationId: string,
    reason: string,
    status: QuarantineRejectionStatus = 'MANUAL',
    options?: { checkAdmission?: () => void }
  ): Promise<LocalQuarantinedMutation | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS], 'readwrite');
        const pStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        const qStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);

        const req = pStore.get([ownerScope, mutationId]);
        req.onsuccess = () => {
          const target = req.result as LocalPendingMutation | undefined;
          if (!target) {
            tx.oncomplete = () => resolve(null);
            return;
          }
          pStore.delete([ownerScope, mutationId]);
          const quarantined: LocalQuarantinedMutation = {
            ownerScope: target.ownerScope,
            mutationId: target.mutationId,
            clientId: target.clientId,
            domain: target.domain,
            entityId: target.entityId,
            operation: target.operation,
            baseServerRevision: target.baseServerRevision,
            payload: target.payload,
            rejectionReason: reason,
            rejectionStatus: status,
            rejectedAt: new Date().toISOString(),
            triageStatus: 'PENDING',
            originalCreatedAt: target.createdAt,
          };
          qStore.put(quarantined);
          tx.oncomplete = () => resolve(quarantined);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in quarantinePendingMutationByKey.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==================== QUARANTINED MUTATIONS OPERATIONS (Phase 7C.3) ====================

  async quarantineMutation(
    quarantined: LocalQuarantinedMutation,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(quarantined.ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS], 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).delete([quarantined.ownerScope, quarantined.mutationId]);
        const recordToStore: LocalQuarantinedMutation = {
          ...quarantined,
          rejectionStatus: quarantined.rejectionStatus || 'MANUAL',
          triageStatus: quarantined.triageStatus || 'PENDING',
        };
        tx.objectStore(STORE_QUARANTINED_MUTATIONS).put(recordToStore);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in quarantineMutation.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async getQuarantinedMutation(ownerScope: string, mutationId: string): Promise<LocalQuarantinedMutation | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUARANTINED_MUTATIONS, 'readonly');
      const req = tx.objectStore(STORE_QUARANTINED_MUTATIONS).get([ownerScope, mutationId]);
      req.onsuccess = () => resolve((req.result as LocalQuarantinedMutation) || null);
      req.onerror = () => reject(tx.error || req.error);
    });
  }

  async getQuarantinedMutations(ownerScope: string): Promise<LocalQuarantinedMutation[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUARANTINED_MUTATIONS, 'readonly');
      const store = tx.objectStore(STORE_QUARANTINED_MUTATIONS);
      const index = store.index('by_scope_rejected');
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = index.openCursor(range, 'prev');
      const results: LocalQuarantinedMutation[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const item = cursor.value as LocalQuarantinedMutation;
          if (item.ownerScope === ownerScope) {
            results.push(item);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  async deleteQuarantinedMutation(
    ownerScope: string,
    mutationId: string,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_QUARANTINED_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_QUARANTINED_MUTATIONS).delete([ownerScope, mutationId]);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in deleteQuarantinedMutation.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async clearQuarantinedMutations(
    ownerScope: string,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_QUARANTINED_MUTATIONS, 'readwrite');
        const store = tx.objectStore(STORE_QUARANTINED_MUTATIONS);
        const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const req = store.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const item = cursor.value as LocalQuarantinedMutation;
            if (item.ownerScope === ownerScope) {
              cursor.delete();
            }
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted in clearQuarantinedMutations.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Atomic Primitive: Requeues a quarantined mutation back to pending_mutations with retryCount = 0.
   * Transfers from quarantined_mutations to pending_mutations in a single atomic IDB transaction
   * alongside STORE_SYNC_META so revision watermarks cannot be bypassed via TOCTOU races.
   * Strictly preserves exact mutationId, payload, and baseServerRevision.
   *
   * Invariant Enforcement:
   * - P1-A: DISCARDED triageStatus is strictly terminal and CANNOT be requeued inside IDB transaction.
   * - P0-05: REJECTED_TOMBSTONE, REJECTED_STALE, and HTTP_410_GONE cannot be requeued.
   * - P1-B: Mutations with baseServerRevision < sync_meta.minActiveRevision cannot be requeued.
   */
  async requeueQuarantinedMutation(
    ownerScope: string,
    mutationId: string,
    triageProof?: CausalTriageProof,
    options?: {
      checkAdmission?: () => void;
      _testHookBeforeComplete?: (tx: IDBTransaction) => void;
    }
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let tx: IDBTransaction;

      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
        }
      };

      try {
        tx = db.transaction(
          [STORE_QUARANTINED_MUTATIONS, STORE_PENDING_MUTATIONS, STORE_SYNC_META],
          'readwrite'
        );
        const qStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);
        const pStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        const metaStore = tx.objectStore(STORE_SYNC_META);

        let qRecord: LocalQuarantinedMutation | undefined;
        let syncMeta: LocalSyncMeta | undefined;
        let remaining = 2;

        const onBothLoaded = () => {
          if (settled) return;
          try {
            if (options?.checkAdmission) {
              options.checkAdmission();
            }

            if (!qRecord) {
              fail(new Error(`Quarantined mutation [${ownerScope}, ${mutationId}] not found.`));
              return;
            }

            if (qRecord.triageStatus === 'DISCARDED') {
              fail(
                new Error(
                  'REQUEUE_PROHIBITED: Cannot requeue DISCARDED quarantined mutation. User discard decision is terminal.'
                )
              );
              return;
            }

            if (qRecord.rejectionStatus === 'REJECTED_TOMBSTONE') {
              fail(
                new Error(
                  'REQUEUE_PROHIBITED: Cannot requeue REJECTED_TOMBSTONE mutation. Entity has authoritative tombstone on server.'
                )
              );
              return;
            }

            if (
              qRecord.rejectionStatus === 'REJECTED_STALE' ||
              qRecord.rejectionStatus === 'HTTP_410_GONE'
            ) {
              fail(
                new Error(
                  'REQUEUE_PROHIBITED: Requeuing REJECTED_STALE or HTTP_410 mutations is locked until Step 6 Causal Triage Engine is implemented.'
                )
              );
              return;
            }

            if (syncMeta?.minActiveRevision !== undefined && syncMeta?.minActiveRevision !== null) {
              if (!isValidRevisionString(syncMeta.minActiveRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid minActiveRevision during requeue: "${syncMeta.minActiveRevision}".`
                  )
                );
                return;
              }
              const minActiveRev = BigInt(syncMeta.minActiveRevision);
              if (minActiveRev > 0n) {
                if (!isValidRevisionString(qRecord.baseServerRevision)) {
                  fail(
                    new InvalidDeltaPayloadError(
                      `Invalid baseServerRevision on quarantined mutation "${qRecord.mutationId}": "${qRecord.baseServerRevision}".`
                    )
                  );
                  return;
                }
                if (BigInt(qRecord.baseServerRevision) < minActiveRev) {
                  fail(
                    new Error(
                      `REQUEUE_PROHIBITED: Cannot requeue stale mutation "${qRecord.mutationId}" with baseServerRevision "${qRecord.baseServerRevision}" older than minActiveRevision "${syncMeta.minActiveRevision}".`
                    )
                  );
                  return;
                }
              }
            }

            qStore.delete([ownerScope, mutationId]);
            const pending: LocalPendingMutation = {
              ownerScope: qRecord.ownerScope,
              mutationId: qRecord.mutationId,
              clientId: qRecord.clientId,
              domain: qRecord.domain,
              entityId: qRecord.entityId,
              operation: qRecord.operation,
              baseServerRevision: qRecord.baseServerRevision,
              payload: qRecord.payload,
              createdAt: qRecord.originalCreatedAt || new Date().toISOString(),
              retryCount: 0,
              nextRetryAt: undefined,
            };
            pStore.add(pending);

            if (options?._testHookBeforeComplete) {
              options._testHookBeforeComplete(tx);
            }
          } catch (err) {
            fail(err);
          }
        };

        const qReq = qStore.get([ownerScope, mutationId]);
        qReq.onerror = () => fail(qReq.error || new Error('Failed reading quarantined mutation.'));
        qReq.onsuccess = () => {
          qRecord = qReq.result as LocalQuarantinedMutation | undefined;
          remaining -= 1;
          if (remaining === 0) onBothLoaded();
        };

        const mReq = metaStore.get(ownerScope);
        mReq.onerror = () => fail(mReq.error || new Error('Failed reading sync_meta during requeue.'));
        mReq.onsuccess = () => {
          syncMeta = mReq.result as LocalSyncMeta | undefined;
          remaining -= 1;
          if (remaining === 0) onBothLoaded();
        };

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        tx.onerror = () => fail(tx.error || new Error('Transaction error in requeueQuarantinedMutation.'));
        tx.onabort = () => fail(tx.error || new Error('Transaction aborted in requeueQuarantinedMutation.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * P1-B Atomic Watermark Sweep: Moves stale pending mutations (baseServerRevision < sync_meta.minActiveRevision)
   * from pending_mutations to quarantined_mutations inside ONE readwrite transaction shared with sync_meta.
   * Preserves full user payload and mutation metadata instead of silently deleting unconfirmed offline data.
   */
  async quarantineStalePendingMutationsByWatermark(
    ownerScope: string,
    options?: QuarantineStaleByWatermarkOptions
  ): Promise<QuarantineStaleByWatermarkResult> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }

    const excludedIds = options?.excludeMutationIds ? new Set(options.excludeMutationIds) : null;

    return new Promise<QuarantineStaleByWatermarkResult>((resolve, reject) => {
      let settled = false;
      let tx: IDBTransaction;
      let result: QuarantineStaleByWatermarkResult = {
        minActiveRevision: '0',
        scannedCount: 0,
        quarantinedCount: 0,
        quarantinedMutations: [],
      };

      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(err);
        }
      };

      try {
        tx = db.transaction(
          [STORE_SYNC_META, STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS],
          'readwrite'
        );
        const metaStore = tx.objectStore(STORE_SYNC_META);
        const pStore = tx.objectStore(STORE_PENDING_MUTATIONS);
        const qStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);

        let syncMeta: LocalSyncMeta | undefined;
        const scopedPending: LocalPendingMutation[] = [];
        let remaining = 2;

        const onAllLoaded = () => {
          if (settled) return;
          try {
            if (options?.checkAdmission) {
              options.checkAdmission();
            }

            let minActiveRevisionStr = '0';
            if (syncMeta?.minActiveRevision !== undefined && syncMeta?.minActiveRevision !== null) {
              if (!isValidRevisionString(syncMeta.minActiveRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid minActiveRevision during watermark quarantine: "${syncMeta.minActiveRevision}".`
                  )
                );
                return;
              }
              minActiveRevisionStr = syncMeta.minActiveRevision;
            }

            const minActiveRev = BigInt(minActiveRevisionStr);
            if (minActiveRev <= 0n) {
              result = {
                minActiveRevision: minActiveRevisionStr,
                scannedCount: scopedPending.length,
                quarantinedCount: 0,
                quarantinedMutations: [],
              };
              if (options?._testHookBeforeComplete) {
                options._testHookBeforeComplete(tx);
              }
              return;
            }

            // Fail-closed validation across ALL pending mutations before applying any delete/put
            const staleTargets: LocalPendingMutation[] = [];
            for (const item of scopedPending) {
              if (!isValidRevisionString(item.baseServerRevision)) {
                fail(
                  new InvalidDeltaPayloadError(
                    `Invalid baseServerRevision "${item.baseServerRevision}" on pending mutation "${item.mutationId}".`
                  )
                );
                return;
              }
              if (excludedIds?.has(item.mutationId)) {
                continue;
              }
              if (BigInt(item.baseServerRevision) < minActiveRev) {
                staleTargets.push(item);
              }
            }

            const rejectedAtIso = new Date().toISOString();
            const quarantinedMutations: LocalQuarantinedMutation[] = [];

            for (const target of staleTargets) {
              pStore.delete([ownerScope, target.mutationId]);
              const quarantined: LocalQuarantinedMutation = {
                ownerScope: target.ownerScope,
                mutationId: target.mutationId,
                clientId: target.clientId,
                domain: target.domain,
                entityId: target.entityId,
                operation: target.operation,
                baseServerRevision: target.baseServerRevision,
                payload: target.payload,
                rejectionReason: `BASE_REVISION_EXPIRED: baseServerRevision (${target.baseServerRevision}) is older than minActiveRevision (${minActiveRevisionStr}).`,
                rejectionStatus: 'REJECTED_STALE',
                rejectedAt: rejectedAtIso,
                triageStatus: 'PENDING',
                originalCreatedAt: target.createdAt,
              };
              qStore.put(quarantined);
              quarantinedMutations.push(quarantined);
            }

            result = {
              minActiveRevision: minActiveRevisionStr,
              scannedCount: scopedPending.length,
              quarantinedCount: quarantinedMutations.length,
              quarantinedMutations,
            };

            if (options?._testHookBeforeComplete) {
              options._testHookBeforeComplete(tx);
            }
          } catch (err) {
            fail(err);
          }
        };

        const mReq = metaStore.get(ownerScope);
        mReq.onerror = () =>
          fail(mReq.error || new Error('Failed reading sync_meta during watermark quarantine.'));
        mReq.onsuccess = () => {
          syncMeta = mReq.result as LocalSyncMeta | undefined;
          remaining -= 1;
          if (remaining === 0) onAllLoaded();
        };

        const pIndex = pStore.index('by_scope_created');
        const pRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const pReq = pIndex.openCursor(pRange, 'next');
        pReq.onerror = () =>
          fail(pReq.error || new Error('Failed scanning pending_mutations during watermark quarantine.'));
        pReq.onsuccess = () => {
          try {
            const cursor = pReq.result;
            if (cursor) {
              const item = cursor.value as LocalPendingMutation;
              if (item && item.ownerScope === ownerScope) {
                scopedPending.push(item);
              }
              cursor.continue();
            } else {
              remaining -= 1;
              if (remaining === 0) onAllLoaded();
            }
          } catch (err) {
            fail(err);
          }
        };

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        tx.onerror = () =>
          fail(tx.error || new Error('Transaction error in quarantineStalePendingMutationsByWatermark.'));
        tx.onabort = () =>
          fail(tx.error || new Error('Transaction aborted in quarantineStalePendingMutationsByWatermark.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Anti-Tombstone Resurrection (Atomic): Evicts local replica data from local store AND removes
   * pending mutation in a SINGLE atomic IndexedDB transaction.
   * Eliminates race conditions or partial failures between replica deletion and pending removal.
   */
  async evictReplicaAndRemovePending(
    ownerScope: string,
    domain: SyncDomain,
    entityId: string,
    mutationId: string,
    payload?: Record<string, unknown>,
    options?: { checkAdmission?: () => void }
  ): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    if (options?.checkAdmission) {
      options.checkAdmission();
    }

    return new Promise((resolve, reject) => {
      try {
        let tx: IDBTransaction;
        switch (domain) {
          case SyncDomain.BOOKMARK: {
            tx = db.transaction([STORE_BOOKMARKS, STORE_PENDING_MUTATIONS], 'readwrite');
            tx.objectStore(STORE_BOOKMARKS).delete([ownerScope, entityId]);
            tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
            break;
          }
          case SyncDomain.PROGRESS: {
            tx = db.transaction([STORE_PROGRESS, STORE_PENDING_MUTATIONS], 'readwrite');
            tx.objectStore(STORE_PROGRESS).delete([ownerScope, entityId]);
            tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
            break;
          }
          case SyncDomain.HISTORY: {
            tx = db.transaction([STORE_HISTORY, STORE_PROGRESS, STORE_PENDING_MUTATIONS], 'readwrite');
            const histStore = tx.objectStore(STORE_HISTORY);
            const progStore = tx.objectStore(STORE_PROGRESS);

            if (entityId === 'all' || entityId === '00000000-0000-0000-0000-000000000000') {
              const histRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
              const hReq = histStore.openCursor(histRange);
              hReq.onsuccess = () => {
                const c = hReq.result;
                if (c) { c.delete(); c.continue(); }
              };
              const progRange = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
              const pReq = progStore.openCursor(progRange);
              pReq.onsuccess = () => {
                const c = pReq.result;
                if (c) { c.delete(); c.continue(); }
              };
            } else if (payload && payload.storyId && payload.chapterId) {
              histStore.delete([ownerScope, String(payload.storyId), String(payload.chapterId)]);
            } else if (entityId.includes(':')) {
              const [sId, cId] = entityId.split(':');
              histStore.delete([ownerScope, sId, cId]);
            } else {
              const range = IDBKeyRange.bound([ownerScope, entityId, ''], [ownerScope, entityId, '\uffff']);
              const req = histStore.openCursor(range);
              req.onsuccess = () => {
                const c = req.result;
                if (c) { c.delete(); c.continue(); }
              };
              progStore.delete([ownerScope, entityId]);
            }
            tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
            break;
          }
          case SyncDomain.PREFERENCE: {
            tx = db.transaction([STORE_PREFERENCES, STORE_PENDING_MUTATIONS], 'readwrite');
            const key = String((payload && payload.key) || entityId);
            tx.objectStore(STORE_PREFERENCES).delete([ownerScope, key]);
            tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
            break;
          }
          default: {
            tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
            tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
            break;
          }
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Anti-Tombstone Resurrection: Evicts local replica data from local IndexedDB store
   * when server reports REJECTED_TOMBSTONE or authoritative tombstone.
   */
  async evictReplicaOnTombstone(
    ownerScope: string,
    domain: SyncDomain,
    entityId: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    assertValidScope(ownerScope);
    switch (domain) {
      case SyncDomain.BOOKMARK:
        await this.deleteBookmark(ownerScope, entityId);
        break;
      case SyncDomain.PROGRESS:
        await this.deleteProgress(ownerScope, entityId);
        break;
      case SyncDomain.HISTORY:
        if (entityId === 'all' || entityId === '00000000-0000-0000-0000-000000000000') {
          await this.clearAllHistory(ownerScope);
        } else if (payload && payload.storyId && payload.chapterId) {
          await this.deleteHistoryItem(ownerScope, String(payload.storyId), String(payload.chapterId));
        } else if (entityId.includes(':')) {
          const [storyId, chapterId] = entityId.split(':');
          await this.deleteHistoryItem(ownerScope, storyId, chapterId);
        } else {
          await this.deleteStoryHistory(ownerScope, entityId);
        }
        break;
      case SyncDomain.PREFERENCE: {
        const key = String((payload && payload.key) || entityId);
        await this.deletePreference(ownerScope, key);
        break;
      }
      default:
        break;
    }
  }

  // ==================== SNAPSHOT STAGING STORE OPERATIONS (Phase 7C.3) ====================

  async stageSnapshotItems(items: LocalSnapshotStagingItem[]): Promise<void> {
    if (items.length === 0) return;
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_SNAPSHOT_STAGING, 'readwrite');
        const store = tx.objectStore(STORE_SNAPSHOT_STAGING);
        for (const item of items) {
          assertValidScope(item.ownerScope);
          store.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async clearSnapshotStaging(ownerScope: string, sessionId?: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPSHOT_STAGING, 'readwrite');
      const store = tx.objectStore(STORE_SNAPSHOT_STAGING);

      if (sessionId) {
        const index = store.index('by_scope_session');
        const range = IDBKeyRange.only([ownerScope, sessionId]);
        const req = index.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      } else {
        const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const req = store.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSnapshotStagingItems(ownerScope: string, sessionId: string): Promise<LocalSnapshotStagingItem[]> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPSHOT_STAGING, 'readonly');
      const store = tx.objectStore(STORE_SNAPSHOT_STAGING);
      const index = store.index('by_scope_session');
      const range = IDBKeyRange.only([ownerScope, sessionId]);
      const req = index.openCursor(range);
      const results: LocalSnapshotStagingItem[] = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push(cursor.value as LocalSnapshotStagingItem);
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ==================== SCOPE PURGE & REBIND (Phase 7A/7B/7C) ====================

  async hasGuestData(guestScope: string): Promise<boolean> {
    assertValidScope(guestScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      let isSettled = false;

      let tx: IDBTransaction;
      try {
        tx = db.transaction([STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY], 'readonly');
      } catch (err) {
        reject(err);
        return;
      }

      const fail = (err: any) => {
        if (!isSettled) {
          isSettled = true;
          try {
            tx.abort();
          } catch (_) {}
          reject(err || new Error('Failed to verify guest data presence in IndexedDB.'));
        }
      };

      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error || new Error('Guest data check transaction aborted.'));

      let found = false;
      let pending = 3;

      const checkDone = () => {
        if (isSettled) return;
        pending -= 1;
        if (pending === 0) {
          isSettled = true;
          resolve(found);
        }
      };

      for (const storeName of [STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY]) {
        try {
          const store = tx.objectStore(storeName);
          const range = IDBKeyRange.bound([guestScope, ''], [guestScope, '\uffff']);
          const req = store.openCursor(range);
          req.onsuccess = () => {
            if (req.result && req.result.value?.ownerScope === guestScope) {
              found = true;
            }
            checkDone();
          };
          req.onerror = () => {
            fail(req.error || new Error(`Failed to read ${storeName} for guest scope.`));
          };
        } catch (err) {
          fail(err);
        }
      }
    });
  }

  async rebindScope(
    fromScope: string,
    toScope: string,
    conflictDecisions?: Record<string, ConflictResolution>,
  ): Promise<void> {
    assertValidScope(fromScope);
    assertValidScope(toScope);
    const db = await this.getDatabase();

    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY], 'readwrite');
        const bStore = tx.objectStore(STORE_BOOKMARKS);
        const pStore = tx.objectStore(STORE_PROGRESS);
        const hStore = tx.objectStore(STORE_HISTORY);

        // 1. Rebind Bookmarks: Read all from fromScope, put into toScope if not existing
        const bRange = IDBKeyRange.bound([fromScope, ''], [fromScope, '\uffff']);
        const bReq = bStore.openCursor(bRange);
        bReq.onsuccess = () => {
          const cursor = bReq.result;
          if (cursor) {
            const item = cursor.value as LocalBookmark;
            if (item.ownerScope === fromScope) {
              const targetKey = [toScope, item.storyId];
              const checkReq = bStore.get(targetKey);
              checkReq.onsuccess = () => {
                if (!checkReq.result) {
                  bStore.put({ ...item, ownerScope: toScope });
                }
              };
            }
            cursor.continue();
          }
        };

        // 2. Rebind Progress with Conflict-Aware Semantics
        const pRange = IDBKeyRange.bound([fromScope, ''], [fromScope, '\uffff']);
        const pReq = pStore.openCursor(pRange);
        pReq.onsuccess = () => {
          const cursor = pReq.result;
          if (cursor) {
            const item = cursor.value as LocalReadingProgress;
            if (item.ownerScope === fromScope) {
              const decision = conflictDecisions?.[item.storyId];

              if (decision === ConflictResolution.KEEP_CLOUD) {
                cursor.continue();
                return;
              }

              if (decision === ConflictResolution.USE_GUEST) {
                pStore.put({ ...item, ownerScope: toScope });
                cursor.continue();
                return;
              }

              const targetKey = [toScope, item.storyId];
              const checkReq = pStore.get(targetKey);
              checkReq.onsuccess = () => {
                if (!checkReq.result) {
                  pStore.put({ ...item, ownerScope: toScope });
                }
              };
            }
            cursor.continue();
          }
        };

        // 3. Rebind History with Monotonic Merge
        const hRange = IDBKeyRange.bound([fromScope, ''], [fromScope, '\uffff']);
        const hReq = hStore.openCursor(hRange);
        hReq.onsuccess = () => {
          const cursor = hReq.result;
          if (cursor) {
            const item = cursor.value as LocalReadingHistory;
            if (item.ownerScope === fromScope) {
              const targetKey = [toScope, item.storyId, item.chapterId];
              const checkReq = hStore.get(targetKey);
              checkReq.onsuccess = () => {
                const existing = checkReq.result as LocalReadingHistory | undefined;
                if (!existing) {
                  hStore.put({ ...item, ownerScope: toScope });
                } else {
                  const mergedPercentage = Math.max(existing.progressPercentage || 0, item.progressPercentage || 0);
                  const lastReadAt = (existing.lastReadAt && item.lastReadAt)
                    ? (new Date(existing.lastReadAt) > new Date(item.lastReadAt) ? existing.lastReadAt : item.lastReadAt)
                    : (existing.lastReadAt || item.lastReadAt);
                  hStore.put({
                    ...existing,
                    progressPercentage: mergedPercentage,
                    lastReadAt,
                  });
                }
              };
            }
            cursor.continue();
          }
        };

        tx.oncomplete = async () => {
          try {
            await this.purgeScope(fromScope);
            resolve();
          } catch (err) {
            reject(err);
          }
        };

        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Rebind transaction aborted'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async purgeScope(ownerScope: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const storesToPurge = [
        STORE_BOOKMARKS,
        STORE_PROGRESS,
        STORE_HISTORY,
        STORE_PREFERENCES,
        STORE_SYNC_META,
        STORE_PENDING_MUTATIONS,
        STORE_QUARANTINED_MUTATIONS,
        STORE_SNAPSHOT_STAGING,
        STORE_AUTHORITATIVE_REPLICAS,
        STORE_TOMBSTONES,
      ];

      const tx = db.transaction(storesToPurge, 'readwrite');

      // 1. Delete sync_meta for ownerScope (keyPath is ownerScope scalar)
      tx.objectStore(STORE_SYNC_META).delete(ownerScope);

      // 2. Delete composite stores prefixed by ownerScope
      const compositeStores = [
        STORE_BOOKMARKS,
        STORE_PROGRESS,
        STORE_HISTORY,
        STORE_PREFERENCES,
        STORE_PENDING_MUTATIONS,
        STORE_QUARANTINED_MUTATIONS,
        STORE_SNAPSHOT_STAGING,
        STORE_AUTHORITATIVE_REPLICAS,
        STORE_TOMBSTONES,
      ];

      for (const storeName of compositeStores) {
        const store = tx.objectStore(storeName);
        const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
        const req = store.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const indexedDbClient = new IndexedDbClient();
