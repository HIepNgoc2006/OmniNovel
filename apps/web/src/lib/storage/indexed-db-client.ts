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
  if (!scope || typeof scope !== 'string' || !scope.startsWith('guest:')) {
    throw new InvalidGuestScopeException(scope);
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
          reject(request.error || new IndexedDbUnavailableError('Failed to open IndexedDB.'));
        };

        request.onblocked = () => {
          this.openPromise = null;
          reject(new IndexedDbUnavailableError('IndexedDB open blocked by another open connection.'));
        };
      } catch (err) {
        this.openPromise = null;
        reject(err);
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
        reject(tx.error || new Error('Transaction aborted.'));
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
          } catch (err) {
            try {
              tx.abort();
            } catch (_) {}
            reject(err);
          }
        };

        getRequest.onerror = () => {
          try {
            tx.abort();
          } catch (_) {}
          reject(getRequest.error || new Error('Failed to read existing history.'));
        };
      } catch (err) {
        try {
          tx.abort();
        } catch (_) {}
        reject(err);
      }
    });
  }

  // ==================== BOOKMARKS SCOPE-BOUND OPERATIONS ====================

  async putBookmark(bookmark: LocalBookmark): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
      tx.objectStore(STORE_BOOKMARKS).put(bookmark);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getBookmark(ownerScope: string, storyId: string): Promise<LocalBookmark | null> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKMARKS).get([ownerScope, storyId]);
      req.onsuccess = () => resolve((req.result as LocalBookmark) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteBookmark(ownerScope: string, storyId: string): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
      tx.objectStore(STORE_BOOKMARKS).delete([ownerScope, storyId]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getBookmarks(ownerScope: string): Promise<LocalBookmark[]> {
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
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROGRESS, 'readonly');
      const req = tx.objectStore(STORE_PROGRESS).get([ownerScope, storyId]);
      req.onsuccess = () => resolve((req.result as LocalReadingProgress) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putProgress(progress: LocalReadingProgress): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROGRESS, 'readwrite');
      tx.objectStore(STORE_PROGRESS).put(progress);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==================== READING HISTORY SCOPE-BOUND OPERATIONS ====================

  async getHistory(ownerScope: string): Promise<LocalReadingHistory[]> {
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
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY, 'readwrite');
      const store = tx.objectStore(STORE_HISTORY);
      const range = IDBKeyRange.bound([ownerScope, storyId, ''], [ownerScope, storyId, '\uffff']);
      const req = store.openCursor(range);

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAllHistory(ownerScope: string): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HISTORY, 'readwrite');
      const store = tx.objectStore(STORE_HISTORY);
      const range = IDBKeyRange.bound([ownerScope, ''], [ownerScope, '\uffff']);
      const req = store.openCursor(range);

      req.onsuccess = () => {
        const cursor = req.result;
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
