import {
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
  ConflictResolution,
  SyncDomain,
  SyncOperation,
} from '@omninovel/shared';

export const DB_NAME = 'omninovel_local_v2';
export const DB_VERSION = 3;

export const STORE_BOOKMARKS = 'bookmarks';
export const STORE_PROGRESS = 'progress';
export const STORE_HISTORY = 'history';
export const STORE_PREFERENCES = 'preferences';
export const STORE_SYNC_META = 'sync_meta';
export const STORE_PENDING_MUTATIONS = 'pending_mutations';
export const STORE_QUARANTINED_MUTATIONS = 'quarantined_mutations';
export const STORE_SNAPSHOT_STAGING = 'snapshot_staging_store';

export const ALL_OBJECT_STORES = [
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  STORE_SNAPSHOT_STAGING,
] as const;

export interface LocalPreference {
  ownerScope: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface LocalSyncMeta {
  ownerScope: string;
  lastSyncedServerRevision: string;
  minActiveRevision: string;
  lastSyncTimestamp: string;
  effectiveHistoryEpochs: Record<string, number>;
  syncState: 'IDLE' | 'PULLING' | 'PUSHING' | 'RECONCILING_410' | 'ERROR';
  lastErrorMessage?: string | null;
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
  rejectedAt: string;
  originalCreatedAt?: string;
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

        request.onupgradeneeded = () => {
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

  // ==================== SYNC METADATA SCOPE-BOUND OPERATIONS (Phase 7C.3) ====================

  async getSyncMeta(ownerScope: string): Promise<LocalSyncMeta | null> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SYNC_META, 'readonly');
      const req = tx.objectStore(STORE_SYNC_META).get(ownerScope);
      req.onsuccess = () => resolve((req.result as LocalSyncMeta) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putSyncMeta(meta: LocalSyncMeta): Promise<void> {
    assertValidScope(meta.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_SYNC_META, 'readwrite');
        tx.objectStore(STORE_SYNC_META).put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ==================== PENDING MUTATIONS QUEUE OPERATIONS (Phase 7C.3) ====================

  /**
   * Enqueues a new pending mutation using add() to enforce immutability.
   * Duplicate [ownerScope, mutationId] triggers ConstraintError and aborts transaction.
   */
  async enqueuePendingMutation(mutation: LocalPendingMutation): Promise<void> {
    assertValidScope(mutation.ownerScope);
    const db = await this.getDatabase();
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

  async deletePendingMutation(ownerScope: string, mutationId: string): Promise<void> {
    assertValidScope(ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
      tx.objectStore(STORE_PENDING_MUTATIONS).delete([ownerScope, mutationId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deletePendingMutationsBatch(ownerScope: string, mutationIds: string[]): Promise<void> {
    assertValidScope(ownerScope);
    if (mutationIds.length === 0) return;
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
      const store = tx.objectStore(STORE_PENDING_MUTATIONS);
      for (const id of mutationIds) {
        store.delete([ownerScope, id]);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== QUARANTINED MUTATIONS OPERATIONS (Phase 7C.3) ====================

  async quarantineMutation(quarantined: LocalQuarantinedMutation): Promise<void> {
    assertValidScope(quarantined.ownerScope);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS], 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).delete([quarantined.ownerScope, quarantined.mutationId]);
        tx.objectStore(STORE_QUARANTINED_MUTATIONS).put(quarantined);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
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
