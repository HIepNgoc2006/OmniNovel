import {
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
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
