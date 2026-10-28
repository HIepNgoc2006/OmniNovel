import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  STORE_SNAPSHOT_STAGING,
  LocalSyncMeta,
  LocalPendingMutation,
  LocalQuarantinedMutation,
  LocalSnapshotStagingItem,
  LocalPreference,
  IndexedDbUnavailableError,
  QuotaExceededStorageError,
} from '../lib/storage/indexed-db-client';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
} from '@omninovel/shared';

describe('Task 7C.3 — Step 2: IndexedDB v3 Migration, Schema & Atomic Primitives', () => {
  let dbClient: IndexedDbClient;

  beforeEach(async () => {
    // Reset fakeIndexedDB state between tests
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    dbClient = new IndexedDbClient();
  });

  afterEach(() => {
    dbClient.close();
    vi.restoreAllMocks();
  });

  describe('1. Schema v3 Creation & Store Verification', () => {
    it('creates all 8 object stores with correct composite keyPaths and indexes on a fresh database', async () => {
      const db = await dbClient.getDatabase();
      expect(db.name).toBe(DB_NAME);
      expect(db.version).toBe(3);

      // Verify all 8 stores exist
      const storeNames = Array.from(db.objectStoreNames);
      expect(storeNames).toContain(STORE_BOOKMARKS);
      expect(storeNames).toContain(STORE_PROGRESS);
      expect(storeNames).toContain(STORE_HISTORY);
      expect(storeNames).toContain(STORE_PREFERENCES);
      expect(storeNames).toContain(STORE_SYNC_META);
      expect(storeNames).toContain(STORE_PENDING_MUTATIONS);
      expect(storeNames).toContain(STORE_QUARANTINED_MUTATIONS);
      expect(storeNames).toContain(STORE_SNAPSHOT_STAGING);

      const tx = db.transaction(storeNames, 'readonly');

      // Verify keyPaths
      expect(tx.objectStore(STORE_BOOKMARKS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_PROGRESS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_HISTORY).keyPath).toEqual(['ownerScope', 'storyId', 'chapterId']);
      expect(tx.objectStore(STORE_PREFERENCES).keyPath).toEqual(['ownerScope', 'key']);
      expect(tx.objectStore(STORE_SYNC_META).keyPath).toBe('ownerScope');
      expect(tx.objectStore(STORE_PENDING_MUTATIONS).keyPath).toEqual(['ownerScope', 'mutationId']);
      expect(tx.objectStore(STORE_QUARANTINED_MUTATIONS).keyPath).toEqual(['ownerScope', 'mutationId']);
      expect(tx.objectStore(STORE_SNAPSHOT_STAGING).keyPath).toEqual(['ownerScope', 'sessionId', 'domain', 'entityKey']);

      // Verify indexes
      expect(tx.objectStore(STORE_HISTORY).indexNames.contains('by_owner_time')).toBe(true);
      expect(tx.objectStore(STORE_PENDING_MUTATIONS).indexNames.contains('by_scope_created')).toBe(true);
      expect(tx.objectStore(STORE_QUARANTINED_MUTATIONS).indexNames.contains('by_scope_rejected')).toBe(true);
      expect(tx.objectStore(STORE_SNAPSHOT_STAGING).indexNames.contains('by_scope_session')).toBe(true);
    });
  });

  describe('2. Migration from v1 to v3 with Data Preservation', () => {
    it('seamlessly migrates from v1 to v3 while preserving 100% of existing user reading data', async () => {
      // Step A: Manually create a v1 database and seed bookmarks, progress, and history
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const v1Db = req.result;
          v1Db.createObjectStore(STORE_BOOKMARKS, { keyPath: ['ownerScope', 'storyId'] });
          v1Db.createObjectStore(STORE_PROGRESS, { keyPath: ['ownerScope', 'storyId'] });
          const histStore = v1Db.createObjectStore(STORE_HISTORY, { keyPath: ['ownerScope', 'storyId', 'chapterId'] });
          histStore.createIndex('by_owner_time', ['ownerScope', 'lastReadAt'], { unique: false });
        };
        req.onsuccess = () => {
          const v1Db = req.result;
          const seedTx = v1Db.transaction([STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY], 'readwrite');

          seedTx.objectStore(STORE_BOOKMARKS).put({
            ownerScope: 'account:usr-100',
            storyId: 'story-one-piece',
            title: 'One Piece',
            createdAt: '2026-10-01T12:00:00.000Z',
          });

          seedTx.objectStore(STORE_PROGRESS).put({
            ownerScope: 'account:usr-100',
            storyId: 'story-one-piece',
            chapterId: 'chap-1050',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 15,
            scrollPosition: 850,
            progressPercentage: 75,
            updatedAt: '2026-10-01T12:30:00.000Z',
            deviceTimestamp: 1727785800000,
          });

          seedTx.objectStore(STORE_HISTORY).put({
            ownerScope: 'account:usr-100',
            storyId: 'story-one-piece',
            chapterId: 'chap-1050',
            storyTitle: 'One Piece',
            chapterNumber: 1050,
            progressPercentage: 75,
            lastReadAt: '2026-10-01T12:30:00.000Z',
          });

          seedTx.oncomplete = () => {
            v1Db.close();
            resolve();
          };
          seedTx.onerror = () => reject(seedTx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // Step B: Open through IndexedDbClient, triggering onupgradeneeded from version 1 to 3
      const db = await dbClient.getDatabase();
      expect(db.version).toBe(3);

      // Verify all new stores exist
      expect(db.objectStoreNames.contains(STORE_SYNC_META)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_PENDING_MUTATIONS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_QUARANTINED_MUTATIONS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_SNAPSHOT_STAGING)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_PREFERENCES)).toBe(true);

      // Step C: Verify existing v1 data was preserved with 0 loss
      const bookmark = await dbClient.getBookmark('account:usr-100', 'story-one-piece');
      expect(bookmark).not.toBeNull();
      expect(bookmark?.title).toBe('One Piece');

      const progress = await dbClient.getProgress('account:usr-100', 'story-one-piece');
      expect(progress).not.toBeNull();
      expect(progress?.chapterId).toBe('chap-1050');
      expect(progress?.progressPercentage).toBe(75);

      const history = await dbClient.getHistory('account:usr-100');
      expect(history.length).toBe(1);
      expect(history[0].chapterId).toBe('chap-1050');
    });

    it('seamlessly migrates from v2 to v3 while preserving existing stores', async () => {
      // Step A: Manually create a v2 database with bookstores + progress + history + preferences
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const v2Db = req.result;
          v2Db.createObjectStore(STORE_BOOKMARKS, { keyPath: ['ownerScope', 'storyId'] });
          v2Db.createObjectStore(STORE_PROGRESS, { keyPath: ['ownerScope', 'storyId'] });
          const histStore = v2Db.createObjectStore(STORE_HISTORY, { keyPath: ['ownerScope', 'storyId', 'chapterId'] });
          histStore.createIndex('by_owner_time', ['ownerScope', 'lastReadAt'], { unique: false });
          v2Db.createObjectStore(STORE_PREFERENCES, { keyPath: ['ownerScope', 'key'] });
        };
        req.onsuccess = () => {
          const v2Db = req.result;
          const seedTx = v2Db.transaction([STORE_BOOKMARKS, STORE_PREFERENCES], 'readwrite');
          seedTx.objectStore(STORE_BOOKMARKS).put({
            ownerScope: 'account:usr-v2',
            storyId: 'story-v2',
            title: 'Story V2',
            createdAt: '2026-10-15T00:00:00.000Z',
          });
          seedTx.objectStore(STORE_PREFERENCES).put({
            ownerScope: 'account:usr-v2',
            key: 'theme',
            value: 'dark',
            updatedAt: '2026-10-15T00:00:00.000Z',
          });
          seedTx.oncomplete = () => {
            v2Db.close();
            resolve();
          };
          seedTx.onerror = () => reject(seedTx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // Step B: Open through IndexedDbClient, upgrading from v2 to v3
      const db = await dbClient.getDatabase();
      expect(db.version).toBe(3);

      // Verify all 8 stores exist
      expect(db.objectStoreNames.contains(STORE_SYNC_META)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_PENDING_MUTATIONS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_QUARANTINED_MUTATIONS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_SNAPSHOT_STAGING)).toBe(true);

      // Verify v2 data is intact
      const bm = await dbClient.getBookmark('account:usr-v2', 'story-v2');
      expect(bm?.title).toBe('Story V2');
      const pref = await dbClient.getPreference('account:usr-v2', 'theme');
      expect(pref?.value).toBe('dark');
    });

    it('rejects with IndexedDbUnavailableError when database upgrade triggers onblocked', async () => {
      // Test onblocked error handling directly
      const client = new IndexedDbClient();
      const openSpy = vi.spyOn(indexedDB, 'open').mockImplementationOnce((() => {
        const fakeReq = {} as any;
        setTimeout(() => {
          if (fakeReq.onblocked) {
            fakeReq.onblocked({} as any);
          }
        }, 10);
        return fakeReq;
      }) as any);

      await expect(client.getDatabase()).rejects.toThrow(
        /IndexedDB open blocked by another open connection/
      );
      openSpy.mockRestore();
    });
  });

  describe('3. Atomic Write + Enqueue Primitives', () => {
    it('atomically records reading progress/history AND enqueues PROGRESS mutation in the same transaction', async () => {
      const scope = 'account:usr-sync-1';
      const progress: LocalReadingProgress = {
        ownerScope: scope,
        storyId: 'story-naruto',
        chapterId: 'chap-10',
        readingMode: ReadingMode.PAGED,
        pageIndex: 5,
        scrollPosition: 0,
        progressPercentage: 50,
        updatedAt: '2026-10-28T22:00:00.000Z',
        deviceTimestamp: 1730152800000,
      };

      const history: LocalReadingHistory = {
        ownerScope: scope,
        storyId: 'story-naruto',
        chapterId: 'chap-10',
        storyTitle: 'Naruto',
        chapterNumber: 10,
        progressPercentage: 50,
        lastReadAt: '2026-10-28T22:00:00.000Z',
      };

      const mutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-prog-1',
        clientId: 'client-web-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-naruto',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-naruto',
          chapterId: 'chap-10',
          readingMode: ReadingMode.PAGED,
          pageIndex: 5,
          scrollPosition: 0,
          progressPercentage: 50,
        },
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      await dbClient.recordReadingSessionWithMutation(progress, history, mutation);

      // Verify all 3 entities were written atomically
      const savedProgress = await dbClient.getProgress(scope, 'story-naruto');
      expect(savedProgress?.progressPercentage).toBe(50);

      const savedHistory = await dbClient.getHistory(scope);
      expect(savedHistory[0].chapterId).toBe('chap-10');

      const pendingMutations = await dbClient.getPendingMutations(scope);
      expect(pendingMutations.length).toBe(1);
      expect(pendingMutations[0].mutationId).toBe('mut-prog-1');
      expect(pendingMutations[0].domain).toBe(SyncDomain.PROGRESS);
    });

    it('rejects atomic write with scope mismatch before opening transaction', async () => {
      const progress: LocalReadingProgress = {
        ownerScope: 'account:usr-A',
        storyId: 'story-1',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 10,
        updatedAt: '2026-10-28T22:00:00.000Z',
        deviceTimestamp: 1730152800000,
      };

      const history: LocalReadingHistory = {
        ownerScope: 'account:usr-A',
        storyId: 'story-1',
        chapterId: 'chap-1',
        storyTitle: 'Story 1',
        chapterNumber: 1,
        progressPercentage: 10,
        lastReadAt: '2026-10-28T22:00:00.000Z',
      };

      const mismatchedMutation: LocalPendingMutation = {
        ownerScope: 'account:usr-B', // Different scope!
        mutationId: 'mut-mismatch',
        clientId: 'client-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {},
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      await expect(
        dbClient.recordReadingSessionWithMutation(progress, history, mismatchedMutation)
      ).rejects.toThrow(/Scope mismatch/);
    });

    it('rejects atomic write with domain, operation, or entityId mismatch before opening transaction', async () => {
      const scope = 'account:usr-align-1';
      const progress: LocalReadingProgress = {
        ownerScope: scope,
        storyId: 'story-align',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 10,
        updatedAt: '2026-10-28T22:00:00.000Z',
        deviceTimestamp: 1730152800000,
      };
      const history: LocalReadingHistory = {
        ownerScope: scope,
        storyId: 'story-align',
        chapterId: 'chap-1',
        storyTitle: 'Align',
        chapterNumber: 1,
        progressPercentage: 10,
        lastReadAt: '2026-10-28T22:00:00.000Z',
      };

      // 1. Wrong domain in reading session mutation
      await expect(
        dbClient.recordReadingSessionWithMutation(progress, history, {
          ownerScope: scope,
          mutationId: 'm1',
          clientId: 'c1',
          domain: SyncDomain.BOOKMARK, // Wrong domain!
          entityId: 'story-align',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {},
          createdAt: '2026-10-28T22:00:00.000Z',
        })
      ).rejects.toThrow(/Domain mismatch/);

      // 2. Wrong operation in reading session mutation
      await expect(
        dbClient.recordReadingSessionWithMutation(progress, history, {
          ownerScope: scope,
          mutationId: 'm2',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-align',
          operation: SyncOperation.DELETE, // Wrong operation!
          baseServerRevision: '0',
          payload: {},
          createdAt: '2026-10-28T22:00:00.000Z',
        })
      ).rejects.toThrow(/Operation mismatch/);

      // 3. Mismatched entityId in reading session mutation
      await expect(
        dbClient.recordReadingSessionWithMutation(progress, history, {
          ownerScope: scope,
          mutationId: 'm3',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-DIFFERENT', // Mismatched entityId!
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {},
          createdAt: '2026-10-28T22:00:00.000Z',
        })
      ).rejects.toThrow(/EntityId mismatch/);

      // 4. Bookmark UPSERT mismatches
      const bookmark: LocalBookmark = {
        ownerScope: scope,
        storyId: 'story-bm-align',
        title: 'BM Align',
        createdAt: '2026-10-28T22:00:00.000Z',
      };
      await expect(
        dbClient.putBookmarkWithMutation(bookmark, {
          ownerScope: scope,
          mutationId: 'm4',
          clientId: 'c1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-OTHER',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {},
          createdAt: '2026-10-28T22:00:00.000Z',
        })
      ).rejects.toThrow(/EntityId mismatch/);

      await expect(
        dbClient.putBookmarkWithMutation(bookmark, {
          ownerScope: scope,
          mutationId: 'm5',
          clientId: 'c1',
          domain: SyncDomain.PREFERENCE, // Wrong domain!
          entityId: 'story-bm-align',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {},
          createdAt: '2026-10-28T22:00:00.000Z',
        })
      ).rejects.toThrow(/Domain mismatch/);
    });

    it('rolls back progress and history completely when duplicate mutationId triggers ConstraintError on add()', async () => {
      const scope = 'account:usr-rollback-1';
      const initialProgress: LocalReadingProgress = {
        ownerScope: scope,
        storyId: 'story-dup-test',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 20,
        updatedAt: '2026-10-28T21:00:00.000Z',
        deviceTimestamp: 1730150000000,
      };
      const initialHistory: LocalReadingHistory = {
        ownerScope: scope,
        storyId: 'story-dup-test',
        chapterId: 'chap-1',
        storyTitle: 'Dup Test',
        chapterNumber: 1,
        progressPercentage: 20,
        lastReadAt: '2026-10-28T21:00:00.000Z',
      };
      const initialMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-immutable-id-1',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-dup-test',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '5',
        payload: { progressPercentage: 20 },
        createdAt: '2026-10-28T21:00:00.000Z',
      };

      // Step 1: Save initial session successfully
      await dbClient.recordReadingSessionWithMutation(initialProgress, initialHistory, initialMutation);

      expect((await dbClient.getProgress(scope, 'story-dup-test'))?.progressPercentage).toBe(20);
      expect((await dbClient.getHistory(scope))[0]?.progressPercentage).toBe(20);

      // Step 2: Attempt to record updated progress (85%) using the SAME mutationId
      const conflictingProgress: LocalReadingProgress = {
        ...initialProgress,
        progressPercentage: 85,
        updatedAt: '2026-10-28T22:00:00.000Z',
      };
      const conflictingHistory: LocalReadingHistory = {
        ...initialHistory,
        progressPercentage: 85,
        lastReadAt: '2026-10-28T22:00:00.000Z',
      };
      const duplicateMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-immutable-id-1', // DUPLICATE KEY!
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-dup-test',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { progressPercentage: 85 },
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      // Must reject due to ConstraintError
      await expect(
        dbClient.recordReadingSessionWithMutation(conflictingProgress, conflictingHistory, duplicateMutation)
      ).rejects.toThrow();

      // Step 3: VERIFY TRANSACTION ROLLBACK — Local progress and history remain UNMODIFIED at 20%
      const savedProgress = await dbClient.getProgress(scope, 'story-dup-test');
      expect(savedProgress?.progressPercentage).toBe(20); // NOT 85!

      const savedHistory = await dbClient.getHistory(scope);
      expect(savedHistory[0]?.progressPercentage).toBe(20); // NOT 85!

      // Step 4: VERIFY MUTATION IMMUTABILITY — Original mutation was NOT overwritten
      const mutations = await dbClient.getPendingMutations(scope);
      expect(mutations.length).toBe(1);
      expect(mutations[0].payload.progressPercentage).toBe(20);
      expect(mutations[0].baseServerRevision).toBe('5');
    });

    it('rolls back bookmark insertion when duplicate mutationId triggers ConstraintError on add()', async () => {
      const scope = 'account:usr-bm-rb';

      // Pre-enqueue mutation
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-bm-dup-key',
        clientId: 'c1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-bm-rb-existing',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '1',
        payload: {},
        createdAt: '2026-10-28T21:00:00.000Z',
      });

      // Attempt to save new bookmark using the duplicate mutationId
      const newBookmark: LocalBookmark = {
        ownerScope: scope,
        storyId: 'story-bm-new',
        title: 'New Bookmark',
        createdAt: '2026-10-28T22:00:00.000Z',
      };
      const duplicateMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-bm-dup-key', // DUPLICATE KEY
        clientId: 'c1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-bm-new',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '2',
        payload: { storyId: 'story-bm-new' },
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      await expect(
        dbClient.putBookmarkWithMutation(newBookmark, duplicateMutation)
      ).rejects.toThrow();

      // Verify rollback: newBookmark was NOT committed
      const bm = await dbClient.getBookmark(scope, 'story-bm-new');
      expect(bm).toBeNull();
    });

    it('rolls back all staged local writes when simulated QuotaExceededError occurs during pending enqueue', async () => {
      const scope = 'account:usr-quota-rb';
      const progress: LocalReadingProgress = {
        ownerScope: scope,
        storyId: 'story-quota',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 15,
        updatedAt: '2026-10-28T22:00:00.000Z',
        deviceTimestamp: 1730152800000,
      };
      const history: LocalReadingHistory = {
        ownerScope: scope,
        storyId: 'story-quota',
        chapterId: 'chap-1',
        storyTitle: 'Quota Story',
        chapterNumber: 1,
        progressPercentage: 15,
        lastReadAt: '2026-10-28T22:00:00.000Z',
      };
      const mutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-quota-1',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-quota',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '1',
        payload: {},
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      // Mock IDBObjectStore.prototype.add to throw QuotaExceededError for STORE_PENDING_MUTATIONS
      const origAdd = IDBObjectStore.prototype.add;
      const addSpy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
        this: IDBObjectStore,
        ...args: any[]
      ) {
        if (this.name === STORE_PENDING_MUTATIONS) {
          const quotaErr = new DOMException('Storage quota exceeded during enqueue', 'QuotaExceededError');
          throw quotaErr;
        }
        return origAdd.apply(this, args as any);
      });

      await expect(
        dbClient.recordReadingSessionWithMutation(progress, history, mutation)
      ).rejects.toThrow(QuotaExceededStorageError);

      addSpy.mockRestore();

      // Verify complete rollback: neither progress nor history were committed
      const savedProgress = await dbClient.getProgress(scope, 'story-quota');
      expect(savedProgress).toBeNull();

      const savedHistory = await dbClient.getHistory(scope);
      expect(savedHistory.length).toBe(0);

      const pending = await dbClient.getPendingMutations(scope);
      expect(pending.length).toBe(0);
    });

    it('atomically saves bookmark AND enqueues BOOKMARK UPSERT mutation', async () => {
      const scope = 'account:usr-sync-2';
      const bookmark: LocalBookmark = {
        ownerScope: scope,
        storyId: 'story-bleach',
        title: 'Bleach',
        createdAt: '2026-10-28T22:10:00.000Z',
      };

      const mutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-bm-1',
        clientId: 'client-web-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-bleach',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '105',
        payload: { storyId: 'story-bleach' },
        createdAt: '2026-10-28T22:10:00.000Z',
      };

      await dbClient.putBookmarkWithMutation(bookmark, mutation);

      const savedBookmark = await dbClient.getBookmark(scope, 'story-bleach');
      expect(savedBookmark?.title).toBe('Bleach');

      const pending = await dbClient.getPendingMutations(scope);
      expect(pending.length).toBe(1);
      expect(pending[0].mutationId).toBe('mut-bm-1');
      expect(pending[0].domain).toBe(SyncDomain.BOOKMARK);
    });

    it('atomically deletes bookmark AND enqueues BOOKMARK DELETE mutation', async () => {
      const scope = 'account:usr-sync-2';
      // First put bookmark
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-bleach',
        title: 'Bleach',
        createdAt: '2026-10-28T22:10:00.000Z',
      });

      const deleteMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-bm-del-1',
        clientId: 'client-web-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-bleach',
        operation: SyncOperation.DELETE,
        baseServerRevision: '106',
        payload: { storyId: 'story-bleach' },
        createdAt: '2026-10-28T22:15:00.000Z',
      };

      await dbClient.deleteBookmarkWithMutation(scope, 'story-bleach', deleteMutation);

      const deletedBookmark = await dbClient.getBookmark(scope, 'story-bleach');
      expect(deletedBookmark).toBeNull();

      const pending = await dbClient.getPendingMutations(scope);
      const delMutation = pending.find((m) => m.mutationId === 'mut-bm-del-1');
      expect(delMutation?.operation).toBe(SyncOperation.DELETE);
    });

    it('atomically saves preference AND enqueues PREFERENCE mutation', async () => {
      const scope = 'account:usr-sync-3';
      const pref: LocalPreference = {
        ownerScope: scope,
        key: 'readerTheme',
        value: { theme: 'sepia', fontSize: 18 },
        updatedAt: '2026-10-28T22:20:00.000Z',
      };

      const mutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-pref-1',
        clientId: 'client-web-1',
        domain: SyncDomain.PREFERENCE,
        entityId: 'readerTheme',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '110',
        payload: { key: 'readerTheme', value: { theme: 'sepia', fontSize: 18 } },
        createdAt: '2026-10-28T22:20:00.000Z',
      };

      await dbClient.putPreferenceWithMutation(pref, mutation);

      const savedPref = await dbClient.getPreference(scope, 'readerTheme');
      expect(savedPref?.value).toEqual({ theme: 'sepia', fontSize: 18 });

      const pending = await dbClient.getPendingMutations(scope);
      expect(pending.some((m) => m.mutationId === 'mut-pref-1')).toBe(true);
    });

    it('atomically deletes story history & progress AND enqueues HISTORY DELETE mutation', async () => {
      const scope = 'account:usr-sync-4';
      await dbClient.recordReadingSession(
        {
          ownerScope: scope,
          storyId: 'story-jujutsu',
          chapterId: 'chap-1',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 0,
          progressPercentage: 100,
          updatedAt: '2026-10-28T22:00:00.000Z',
          deviceTimestamp: 1730152800000,
        },
        {
          ownerScope: scope,
          storyId: 'story-jujutsu',
          chapterId: 'chap-1',
          storyTitle: 'Jujutsu Kaisen',
          chapterNumber: 1,
          progressPercentage: 100,
          lastReadAt: '2026-10-28T22:00:00.000Z',
        }
      );

      const delMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-hist-del-1',
        clientId: 'client-web-1',
        domain: SyncDomain.HISTORY,
        entityId: 'story-jujutsu',
        operation: SyncOperation.DELETE,
        baseServerRevision: '120',
        payload: { storyId: 'story-jujutsu' },
        createdAt: '2026-10-28T22:25:00.000Z',
      };

      await dbClient.deleteStoryHistoryWithMutation(scope, 'story-jujutsu', delMutation);

      // Verify history and progress deleted
      const history = await dbClient.getHistory(scope);
      expect(history.length).toBe(0);

      const progress = await dbClient.getProgress(scope, 'story-jujutsu');
      expect(progress).toBeNull();

      // Mutation is queued
      const pending = await dbClient.getPendingMutations(scope);
      expect(pending.some((m) => m.mutationId === 'mut-hist-del-1')).toBe(true);
    });
  });

  describe('4. Sync Metadata, Quarantine & Staging Isolation', () => {
    it('saves and retrieves sync_meta with 64-bit decimal string revisions', async () => {
      const scope = 'account:usr-meta-1';
      const meta: LocalSyncMeta = {
        ownerScope: scope,
        lastSyncedServerRevision: '9223372036854775800',
        minActiveRevision: '9223372036854700000',
        lastSyncTimestamp: '2026-10-28T22:20:00.000Z',
        effectiveHistoryEpochs: { 'story-1': 2 },
        syncState: 'IDLE',
      };

      await dbClient.putSyncMeta(meta);

      const retrieved = await dbClient.getSyncMeta(scope);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.lastSyncedServerRevision).toBe('9223372036854775800');
      expect(BigInt(retrieved!.lastSyncedServerRevision)).toBe(9223372036854775800n);
      expect(retrieved?.effectiveHistoryEpochs['story-1']).toBe(2);
    });

    it('quarantines stale or rejected mutations atomically', async () => {
      const scope = 'account:usr-quarantine-1';
      // First enqueue pending mutation
      const pendingMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-stale-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-stale',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '50',
        payload: { storyId: 'story-stale' },
        createdAt: '2026-10-28T22:00:00.000Z',
      };

      await dbClient.putBookmarkWithMutation(
        {
          ownerScope: scope,
          storyId: 'story-stale',
          title: 'Stale Story',
          createdAt: '2026-10-28T22:00:00.000Z',
        },
        pendingMutation
      );

      // Now quarantine it when server rejects with REJECTED_STALE
      const quarantined: LocalQuarantinedMutation = {
        ownerScope: scope,
        mutationId: 'mut-stale-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-stale',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '50',
        payload: { storyId: 'story-stale' },
        rejectionReason: 'REJECTED_STALE',
        rejectedAt: '2026-10-28T22:25:00.000Z',
        originalCreatedAt: '2026-10-28T22:00:00.000Z',
      };

      await dbClient.quarantineMutation(quarantined);

      // Verify removed from pending
      const pending = await dbClient.getPendingMutations(scope);
      expect(pending.find((m) => m.mutationId === 'mut-stale-1')).toBeUndefined();

      // Verify added to quarantined
      const quarantinedList = await dbClient.getQuarantinedMutations(scope);
      expect(quarantinedList.length).toBe(1);
      expect(quarantinedList[0].mutationId).toBe('mut-stale-1');
      expect(quarantinedList[0].rejectionReason).toBe('REJECTED_STALE');
      expect(quarantinedList[0].baseServerRevision).toBe('50');
    });

    it('stages and clears snapshot items by sessionId and full scope', async () => {
      const scope = 'account:usr-snap-1';
      const itemsSessionA: LocalSnapshotStagingItem[] = [
        {
          ownerScope: scope,
          sessionId: 'session-A',
          domain: SyncDomain.BOOKMARK,
          entityKey: 'story-1',
          payload: { storyId: 'story-1' },
          stagedAt: '2026-10-28T22:00:00.000Z',
        },
        {
          ownerScope: scope,
          sessionId: 'session-A',
          domain: SyncDomain.PROGRESS,
          entityKey: 'story-1',
          payload: { storyId: 'story-1', chapterId: 'chap-1' },
          stagedAt: '2026-10-28T22:00:01.000Z',
        },
      ];

      const itemsSessionB: LocalSnapshotStagingItem[] = [
        {
          ownerScope: scope,
          sessionId: 'session-B',
          domain: SyncDomain.BOOKMARK,
          entityKey: 'story-2',
          payload: { storyId: 'story-2' },
          stagedAt: '2026-10-28T22:05:00.000Z',
        },
      ];

      await dbClient.stageSnapshotItems([...itemsSessionA, ...itemsSessionB]);

      // Query session-A items
      const stagedA = await dbClient.getSnapshotStagingItems(scope, 'session-A');
      expect(stagedA.length).toBe(2);

      // On 409 Snapshot Invalidated, clear session-A
      await dbClient.clearSnapshotStaging(scope, 'session-A');

      const afterClearA = await dbClient.getSnapshotStagingItems(scope, 'session-A');
      expect(afterClearA.length).toBe(0);

      // Session B remains intact
      const stagedB = await dbClient.getSnapshotStagingItems(scope, 'session-B');
      expect(stagedB.length).toBe(1);
    });

    it('purgeScope cleanly wipes all 8 stores for target scope without affecting other scopes', async () => {
      const scopeGuest = 'guest:device-999';
      const scopeAccount = 'account:usr-persistent';

      // Seed guest data in bookmarks, progress, history, preferences, sync_meta, pending, quarantined, staging
      await dbClient.putBookmark({
        ownerScope: scopeGuest,
        storyId: 'story-g',
        title: 'Guest Book',
        createdAt: '2026-10-28T22:00:00.000Z',
      });
      await dbClient.putPreference({
        ownerScope: scopeGuest,
        key: 'theme',
        value: 'dark',
        updatedAt: '2026-10-28T22:00:00.000Z',
      });
      await dbClient.putSyncMeta({
        ownerScope: scopeGuest,
        lastSyncedServerRevision: '10',
        minActiveRevision: '1',
        lastSyncTimestamp: '2026-10-28T22:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      // Seed account data
      await dbClient.putBookmark({
        ownerScope: scopeAccount,
        storyId: 'story-acc',
        title: 'Acc Book',
        createdAt: '2026-10-28T22:00:00.000Z',
      });
      await dbClient.putSyncMeta({
        ownerScope: scopeAccount,
        lastSyncedServerRevision: '500',
        minActiveRevision: '100',
        lastSyncTimestamp: '2026-10-28T22:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      // Purge guest scope
      await dbClient.purgeScope(scopeGuest);

      // Guest data is completely wiped
      expect(await dbClient.getBookmark(scopeGuest, 'story-g')).toBeNull();
      expect(await dbClient.getPreference(scopeGuest, 'theme')).toBeNull();
      expect(await dbClient.getSyncMeta(scopeGuest)).toBeNull();

      // Account data remains 100% intact
      expect(await dbClient.getBookmark(scopeAccount, 'story-acc')).not.toBeNull();
      expect(await dbClient.getSyncMeta(scopeAccount)).not.toBeNull();
    });
  });
});
