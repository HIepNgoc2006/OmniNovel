import {
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
  ConflictResolution,
} from '@omninovel/shared';

export const DB_NAME = 'omninovel_local_v2';
export const DB_VERSION = 1;

export const STORE_BOOKMARKS = 'bookmarks';
export const STORE_PROGRESS = 'progress';
export const STORE_HISTORY = 'history';

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

        request.onupgradeneeded = (event) => {
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
        if (error && error.name === 'QuotaExceededError') {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction failed.'));
        }
      };

      tx.onabort = () => {
        const error = tx.error;
        if (error && error.name === 'QuotaExceededError') {
          reject(new QuotaExceededStorageError());
        } else {
          reject(error || new Error('Transaction aborted.'));
        }
      };

      tx.oncomplete = () => {
        resolve();
      };

      try {
        // 1. Fetch existing history for chapter to enforce monotonic progressPercentage
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

            // 2. Put progress
            progressStore.put(progress);

            // 3. Put history with preserved monotonic progress
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
      // KeyRange bound by ownerScope
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
      // Read in reverse order (newest lastReadAt first)
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
      
      // 1. Delete all history records for (ownerScope, storyId)
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

      // 2. Also delete current reading progress for (ownerScope, storyId) to prevent resurrection
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

      // 1. Delete all history records for ownerScope
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

      // 2. Delete all progress records for ownerScope
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
                // Invariant P0: User chose KEEP_CLOUD. Cloud/Account progress authoritative.
                // Do NOT overwrite existing account progress nor copy guest progress over cloud.
                cursor.continue();
                return;
              }

              if (decision === ConflictResolution.USE_GUEST) {
                // Invariant P0: User chose USE_GUEST. Overwrite target account progress.
                pStore.put({ ...item, ownerScope: toScope });
                cursor.continue();
                return;
              }

              // Default / No conflict decision specified:
              // Only put into toScope if account does not already have an existing progress entry.
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
          // 4. Purge source fromScope cleanly
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
      const tx = db.transaction([STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY], 'readwrite');

      for (const storeName of [STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY]) {
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
