import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  DB_VERSION,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  InvalidGuestScopeException,
  IndexedDbUnavailableError,
  QuotaExceededStorageError,
  assertGuestScope,
} from '../lib/storage/indexed-db-client';
import { GuestReadingStateRepository } from '../lib/storage/guest-reading-state-repository';
import { GuestLibraryRepository } from '../lib/storage/guest-library-repository';
import { ActiveScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import { InstallationIdentityProvider } from '../lib/identity/installation-identity-provider';
import { GuestProfileIdentityProvider } from '../lib/identity/guest-profile-identity-provider';
import { LocalReadingProgress, LocalReadingHistory } from '@omninovel/shared';

describe('Task 7A.3: Web IndexedDB Client & Guest Repositories Invariants', () => {
  let dbClient: IndexedDbClient;
  let installProvider: InstallationIdentityProvider;
  let guestProvider: GuestProfileIdentityProvider;
  let coordinator: ActiveScopeCoordinator;
  let readingRepo: GuestReadingStateRepository;
  let libraryRepo: GuestLibraryRepository;

  beforeEach(async () => {
    localStorage.clear();
    // Reset fake IndexedDB factory
    indexedDB = new IDBFactory();

    dbClient = new IndexedDbClient();
    installProvider = new InstallationIdentityProvider();
    guestProvider = new GuestProfileIdentityProvider();
    coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

    // Kích hoạt anonymous guest
    await coordinator.onAuthStatusChanged('anonymous');

    readingRepo = new GuestReadingStateRepository(dbClient, coordinator);
    libraryRepo = new GuestLibraryRepository(dbClient, coordinator);
  });

  afterEach(() => {
    dbClient.close();
    vi.restoreAllMocks();
  });

  describe('1. IndexedDbClient Schema & Composite Keys', () => {
    it('initializes omninovel_local_v2 (v1) with composite key stores', async () => {
      const db = await dbClient.getDatabase();
      expect(db.name).toBe(DB_NAME);
      expect(db.version).toBe(DB_VERSION);

      expect(db.objectStoreNames.contains(STORE_BOOKMARKS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_PROGRESS)).toBe(true);
      expect(db.objectStoreNames.contains(STORE_HISTORY)).toBe(true);

      const tx = db.transaction([STORE_BOOKMARKS, STORE_PROGRESS, STORE_HISTORY], 'readonly');
      expect(tx.objectStore(STORE_BOOKMARKS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_PROGRESS).keyPath).toEqual(['ownerScope', 'storyId']);
      expect(tx.objectStore(STORE_HISTORY).keyPath).toEqual(['ownerScope', 'storyId', 'chapterId']);
      expect(tx.objectStore(STORE_HISTORY).indexNames.contains('by_owner_time')).toBe(true);
    });

    it('fails closed during SSR when window or indexedDB is undefined', async () => {
      const originalWindow = global.window;
      // @ts-expect-error test SSR environment
      delete global.window;

      const ssrClient = new IndexedDbClient();
      await expect(ssrClient.getDatabase()).rejects.toThrow(IndexedDbUnavailableError);

      const ssrReadingRepo = new GuestReadingStateRepository(ssrClient, coordinator);
      const ssrLibraryRepo = new GuestLibraryRepository(ssrClient, coordinator);

      await expect(ssrReadingRepo.getProgress('story-ssr')).rejects.toThrow(IndexedDbUnavailableError);
      await expect(ssrLibraryRepo.getBookmarks()).rejects.toThrow(IndexedDbUnavailableError);

      global.window = originalWindow;
    });
  });

  describe('2. Scope Invariants & Fail-Closed Guardrails', () => {
    it('automatically injects ownerScope from ActiveScopeCoordinator and forbids caller override', async () => {
      const activeScope = coordinator.activeScope;
      expect(activeScope).toMatch(/^guest:/);

      await libraryRepo.saveBookmark({
        storyId: 'story-123',
        title: 'Solo Leveling',
        slug: 'solo-leveling',
        coverUrl: 'https://img.com/cover.jpg',
        createdAt: new Date().toISOString(),
      });

      const bookmark = await libraryRepo.getBookmark('story-123');
      expect(bookmark).not.toBeNull();
      expect(bookmark?.ownerScope).toBe(activeScope);
      expect(bookmark?.title).toBe('Solo Leveling');
    });

    it('assertGuestScope strictly rejects non-guest, empty, or malformed scopes', () => {
      expect(() => assertGuestScope('account:usr-123')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('device:d-456')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('   ')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope(null)).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope(undefined)).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('guest:')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('guest:   ')).toThrow(InvalidGuestScopeException);
      expect(() => assertGuestScope('random_scope')).toThrow(InvalidGuestScopeException);

      // Valid guest scope passes cleanly
      expect(() => assertGuestScope('guest:valid-profile-uuid')).not.toThrow();
    });

    it('FAILS CLOSED across all Guest repository methods if scope is account:* or device:*', async () => {
      // Authenticated account scope
      await coordinator.onAuthStatusChanged('authenticated', 'user-alpha');

      await expect(libraryRepo.getBookmarks()).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.getBookmark('s1')).rejects.toThrow(InvalidGuestScopeException);
      await expect(
        libraryRepo.saveBookmark({ storyId: 's1', title: 'T1', createdAt: new Date().toISOString() })
      ).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.removeBookmark('s1')).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.getHistory()).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.deleteStoryHistory('s1')).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.clearAllHistory()).rejects.toThrow(InvalidGuestScopeException);
      await expect(libraryRepo.purgeGuestScope()).rejects.toThrow(InvalidGuestScopeException);

      await expect(readingRepo.getProgress('s1')).rejects.toThrow(InvalidGuestScopeException);
      await expect(
        readingRepo.saveProgress({
          storyId: 's1',
          chapterId: 'c1',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
          scrollPosition: 100,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        })
      ).rejects.toThrow(InvalidGuestScopeException);
      await expect(
        readingRepo.recordSession(
          {
            storyId: 's1',
            chapterId: 'c1',
            readingMode: 'WEBTOON',
            progressPercentage: 50,
            scrollPosition: 100,
            pageIndex: 1,
            updatedAt: new Date().toISOString(),
            deviceTimestamp: Date.now(),
          },
          { storyTitle: 'Title', chapterNumber: '1' }
        )
      ).rejects.toThrow(InvalidGuestScopeException);
      await expect(readingRepo.getReadChapterIds('s1')).rejects.toThrow(InvalidGuestScopeException);
    });

    it('strictly isolates data between two different guest profiles under the SAME storyId', async () => {
      const sameStoryId = 'shared-story-parallel';

      // 1. Guest A actions on sameStoryId
      await libraryRepo.saveBookmark({
        storyId: sameStoryId,
        title: 'Story of Guest A',
        createdAt: new Date().toISOString(),
      });
      await readingRepo.recordSession(
        {
          storyId: sameStoryId,
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 40.0,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: 1000,
        },
        { storyTitle: 'Shared Story', chapterNumber: '1' }
      );

      const guestABookmarks = await libraryRepo.getBookmarks();
      expect(guestABookmarks).toHaveLength(1);
      const guestAProgress = await readingRepo.getProgress(sameStoryId);
      expect(guestAProgress?.chapterId).toBe('chap-1');
      expect(guestAProgress?.progressPercentage).toBe(40.0);
      const guestARead = await readingRepo.getReadChapterIds(sameStoryId);
      expect(guestARead).toEqual([]); // 40% < 80%

      // 2. Rotate to Guest B
      const guestAScope = coordinator.activeScope;
      await guestProvider.rotateGuestProfileId();
      await coordinator.onAuthStatusChanged('anonymous');
      const guestBScope = coordinator.activeScope;
      expect(guestBScope).not.toBe(guestAScope);

      // Guest B view on sameStoryId -> Empty, no contamination
      expect(await libraryRepo.getBookmark(sameStoryId)).toBeNull();
      expect(await libraryRepo.getBookmarks()).toEqual([]);
      expect(await readingRepo.getProgress(sameStoryId)).toBeNull();
      expect(await libraryRepo.getHistory()).toEqual([]);
      expect(await readingRepo.getReadChapterIds(sameStoryId)).toEqual([]);

      // Guest B reads sameStoryId chapter 5 to 90%
      await readingRepo.recordSession(
        {
          storyId: sameStoryId,
          chapterId: 'chap-5',
          readingMode: 'WEBTOON',
          progressPercentage: 90.0,
          scrollPosition: 3000,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: 2000,
        },
        { storyTitle: 'Shared Story', chapterNumber: '5' }
      );

      const guestBProgress = await readingRepo.getProgress(sameStoryId);
      expect(guestBProgress?.chapterId).toBe('chap-5');
      expect(guestBProgress?.progressPercentage).toBe(90.0);
      const guestBRead = await readingRepo.getReadChapterIds(sameStoryId);
      expect(guestBRead).toEqual(['chap-5']); // 90% >= 80%

      // 3. Guest B deletes history for sameStoryId
      await libraryRepo.deleteStoryHistory(sameStoryId);
      expect(await libraryRepo.getHistory()).toEqual([]);

      // 4. Verify Guest A's data in IndexedDB remains completely intact
      const directAProgress = await dbClient.getProgress(guestAScope!, sameStoryId);
      expect(directAProgress?.chapterId).toBe('chap-1');
      expect(directAProgress?.progressPercentage).toBe(40.0);

      const directABookmark = await dbClient.getBookmark(guestAScope!, sameStoryId);
      expect(directABookmark?.title).toBe('Story of Guest A');

      const directAHistory = await dbClient.getHistory(guestAScope!);
      expect(directAHistory).toHaveLength(1);
      expect(directAHistory[0].chapterId).toBe('chap-1');
    });
  });

  describe('3. Error Handling & Invariant: NO localStorage Fallback', () => {
    it('throws QuotaExceededStorageError and never falls back to localStorage on quota exhaustion', async () => {
      const db = await dbClient.getDatabase();
      const origTransaction = db.transaction.bind(db);

      // Simulate QuotaExceededError inside IDBTransaction
      vi.spyOn(db, 'transaction').mockImplementation((storeNames, mode) => {
        const tx = origTransaction(storeNames, mode);
        const origObjectStore = tx.objectStore.bind(tx);
        vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
          const store = origObjectStore(name);
          vi.spyOn(store, 'put').mockImplementation(() => {
            const quotaErr = new DOMException('Storage quota exceeded', 'QuotaExceededError');
            throw quotaErr;
          });
          return store;
        });
        return tx;
      });

      // recordSession failure
      await expect(
        readingRepo.recordSession(
          {
            storyId: 'quota-story',
            chapterId: 'chap-q',
            readingMode: 'WEBTOON',
            progressPercentage: 50,
            scrollPosition: 100,
            pageIndex: 1,
            updatedAt: new Date().toISOString(),
            deviceTimestamp: Date.now(),
          },
          { storyTitle: 'Quota Story', chapterNumber: '1' }
        )
      ).rejects.toThrow(QuotaExceededStorageError);

      // saveBookmark failure
      await expect(
        libraryRepo.saveBookmark({
          storyId: 'quota-story',
          title: 'Quota Story',
          createdAt: new Date().toISOString(),
        })
      ).rejects.toThrow(QuotaExceededStorageError);

      // INVARIANT CHECK: Zero reading state or library items in localStorage - NO fallback
      expect(localStorage.getItem('omninovel_local_v2')).toBeNull();
      expect(localStorage.getItem('quota-story')).toBeNull();
      // Only identity keys (e.g. guest profile id) exist, no storage fallback occurred
      const storageKeys = Object.keys(localStorage);
      expect(storageKeys.every((k) => k.startsWith('omninovel_guest') || k.startsWith('omninovel_install'))).toBe(true);
    });

    it('throws IndexedDbUnavailableError and never falls back to localStorage if DB cannot open', async () => {
      const unavailClient = new IndexedDbClient();
      vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        throw new Error('IndexedDB blocked in private container');
      });

      const unavailReadingRepo = new GuestReadingStateRepository(unavailClient, coordinator);
      const unavailLibraryRepo = new GuestLibraryRepository(unavailClient, coordinator);

      await expect(unavailReadingRepo.getProgress('blocked-story')).rejects.toThrow(
        IndexedDbUnavailableError
      );
      await expect(unavailLibraryRepo.getBookmarks()).rejects.toThrow(
        IndexedDbUnavailableError
      );

      // INVARIANT CHECK: localStorage was not used as a fallback for data
      expect(localStorage.getItem('omninovel_local_v2')).toBeNull();
      expect(localStorage.getItem('blocked-story')).toBeNull();
      const storageKeys = Object.keys(localStorage);
      expect(storageKeys.every((k) => k.startsWith('omninovel_guest') || k.startsWith('omninovel_install'))).toBe(true);
    });
  });

  describe('4. Atomic recordReadingSession & Rollback Guarantee', () => {
    it('atomically records progress and history in a single transaction', async () => {
      await readingRepo.recordSession(
        {
          storyId: 'story-comic-1',
          chapterId: 'chap-1',
          chapterVersionId: 'ver-1',
          readingMode: 'WEBTOON',
          progressPercentage: 45.0,
          scrollPosition: 1200,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        {
          storyTitle: 'Comic Title',
          chapterNumber: '1',
          chapterTitle: 'Awakening',
        }
      );

      const progress = await readingRepo.getProgress('story-comic-1');
      expect(progress).not.toBeNull();
      expect(progress?.chapterId).toBe('chap-1');
      expect(progress?.scrollPosition).toBe(1200);

      const history = await libraryRepo.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].chapterNumber).toBe('1');
      expect(history[0].progressPercentage).toBe(45.0);
    });

    it('rolls back both progress and history if history store put fails (Atomicity Test 1)', async () => {
      const db = await dbClient.getDatabase();
      const origTransaction = db.transaction.bind(db);

      vi.spyOn(db, 'transaction').mockImplementation((storeNames, mode) => {
        const tx = origTransaction(storeNames, mode);
        const origObjectStore = tx.objectStore.bind(tx);
        vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
          const store = origObjectStore(name);
          if (name === STORE_HISTORY) {
            vi.spyOn(store, 'put').mockImplementation(() => {
              throw new Error('Simulated disk failure during history put');
            });
          }
          return store;
        });
        return tx;
      });

      await expect(
        readingRepo.recordSession(
          {
            storyId: 'story-rollback-test',
            chapterId: 'chap-err',
            readingMode: 'NOVEL',
            progressPercentage: 90,
            scrollPosition: 500,
            pageIndex: 1,
            updatedAt: new Date().toISOString(),
            deviceTimestamp: Date.now(),
          },
          {
            storyTitle: 'Rollback Story',
            chapterNumber: '99',
          }
        )
      ).rejects.toThrow(/Simulated disk failure/);

      // Verify ZERO records persisted in either store!
      const progress = await readingRepo.getProgress('story-rollback-test');
      expect(progress).toBeNull();

      const history = await libraryRepo.getHistory();
      expect(history.filter((h) => h.storyId === 'story-rollback-test')).toHaveLength(0);
    });

    it('rolls back both progress and history if progress store put fails (Atomicity Test 2)', async () => {
      const db = await dbClient.getDatabase();
      const origTransaction = db.transaction.bind(db);

      vi.spyOn(db, 'transaction').mockImplementation((storeNames, mode) => {
        const tx = origTransaction(storeNames, mode);
        const origObjectStore = tx.objectStore.bind(tx);
        vi.spyOn(tx, 'objectStore').mockImplementation((name) => {
          const store = origObjectStore(name);
          if (name === STORE_PROGRESS) {
            vi.spyOn(store, 'put').mockImplementation(() => {
              throw new Error('Simulated progress store write failure');
            });
          }
          return store;
        });
        return tx;
      });

      await expect(
        readingRepo.recordSession(
          {
            storyId: 'story-progress-rollback',
            chapterId: 'chap-p-err',
            readingMode: 'WEBTOON',
            progressPercentage: 70,
            scrollPosition: 300,
            pageIndex: 1,
            updatedAt: new Date().toISOString(),
            deviceTimestamp: Date.now(),
          },
          {
            storyTitle: 'Progress Rollback Story',
            chapterNumber: '1',
          }
        )
      ).rejects.toThrow(/Simulated progress store write failure/);

      expect(await readingRepo.getProgress('story-progress-rollback')).toBeNull();
      const history = await libraryRepo.getHistory();
      expect(history.filter((h) => h.storyId === 'story-progress-rollback')).toHaveLength(0);
    });
  });

  describe('5. Monotonic History & Read Chapters Threshold (>= 80%)', () => {
    it('preserves MAX(oldProgress, newProgress) in history when user re-reads from start', async () => {
      // Lần đọc 1: Đọc đến 85%
      await readingRepo.recordSession(
        {
          storyId: 'story-monotonic',
          chapterId: 'chap-10',
          readingMode: 'WEBTOON',
          progressPercentage: 85.0,
          scrollPosition: 4000,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: 1000,
        },
        {
          storyTitle: 'Monotonic Story',
          chapterNumber: '10',
        }
      );

      // Lần đọc 2: Đọc lại từ đầu (progressPercentage = 10%)
      await readingRepo.recordSession(
        {
          storyId: 'story-monotonic',
          chapterId: 'chap-10',
          readingMode: 'WEBTOON',
          progressPercentage: 10.0,
          scrollPosition: 100,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: 2000,
        },
        {
          storyTitle: 'Monotonic Story',
          chapterNumber: '10',
        }
      );

      // Progress resume hiện tại PHẢI cập nhật về 10% để người dùng tiếp tục đọc từ vị trí mới
      const currentProgress = await readingRepo.getProgress('story-monotonic');
      expect(currentProgress?.progressPercentage).toBe(10.0);
      expect(currentProgress?.scrollPosition).toBe(100);

      // Nhưng History snapshot KHÔNG ĐƯỢC thụt lùi, phải giữ MAX = 85.0%
      const history = await libraryRepo.getHistory();
      const item = history.find((h) => h.chapterId === 'chap-10');
      expect(item).toBeDefined();
      expect(item?.progressPercentage).toBe(85.0);

      // Trạng thái chương đã đọc (>= 80%) vẫn được bảo toàn
      const readChapters = await readingRepo.getReadChapterIds('story-monotonic');
      expect(readChapters).toContain('chap-10');
    });

    it('computes getReadChapterIds correctly based on >= 80% threshold', async () => {
      await readingRepo.recordSession(
        {
          storyId: 'story-threshold',
          chapterId: 'chap-completed',
          readingMode: 'WEBTOON',
          progressPercentage: 80.0,
          scrollPosition: 2000,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Story', chapterNumber: '1' }
      );

      await readingRepo.recordSession(
        {
          storyId: 'story-threshold',
          chapterId: 'chap-partial',
          readingMode: 'WEBTOON',
          progressPercentage: 79.5,
          scrollPosition: 1900,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Story', chapterNumber: '2' }
      );

      await readingRepo.recordSession(
        {
          storyId: 'story-threshold',
          chapterId: 'chap-full',
          readingMode: 'NOVEL',
          progressPercentage: 100.0,
          scrollPosition: 5000,
          pageIndex: 10,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Story', chapterNumber: '3' }
      );

      const readIds = await readingRepo.getReadChapterIds('story-threshold');
      expect(readIds).toContain('chap-completed');
      expect(readIds).toContain('chap-full');
      expect(readIds).not.toContain('chap-partial');
    });
  });

  describe('6. Zero API Calls & Zero Gamification Side Effects', () => {
    it('executes library & reading operations purely locally with 0 API calls or gamification events', async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      // Bookmark operation
      await libraryRepo.saveBookmark({
        storyId: 'story-isolated-net',
        title: 'Network Free Story',
        createdAt: new Date().toISOString(),
      });
      await libraryRepo.getBookmarks();
      await libraryRepo.getBookmark('story-isolated-net');

      // Reading session
      await readingRepo.recordSession(
        {
          storyId: 'story-isolated-net',
          chapterId: 'c1',
          readingMode: 'WEBTOON',
          progressPercentage: 85.0,
          scrollPosition: 1000,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Net Free', chapterNumber: '1' }
      );
      await readingRepo.getProgress('story-isolated-net');
      await readingRepo.getReadChapterIds('story-isolated-net');

      // History deletion
      await libraryRepo.deleteStoryHistory('story-isolated-net');
      await libraryRepo.clearAllHistory();
      await libraryRepo.purgeGuestScope();

      // STRICT INVARIANT: Exactly 0 network calls!
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('7. Library Management Operations (Bookmarks & History Deletion)', () => {
    it('manages bookmarks: add, check, remove', async () => {
      await libraryRepo.saveBookmark({
        storyId: 'story-b1',
        title: 'Story B1',
        createdAt: new Date().toISOString(),
      });

      expect(await libraryRepo.getBookmark('story-b1')).not.toBeNull();
      const list = await libraryRepo.getBookmarks();
      expect(list.some((b) => b.storyId === 'story-b1')).toBe(true);

      await libraryRepo.removeBookmark('story-b1');
      expect(await libraryRepo.getBookmark('story-b1')).toBeNull();
    });

    it('deletes history for a specific story and ALSO deletes its reading progress while leaving bookmarks intact', async () => {
      // 1. Setup bookmark
      await libraryRepo.saveBookmark({
        storyId: 'story-del-1',
        title: 'Del 1 Bookmarked',
        createdAt: new Date().toISOString(),
      });

      // 2. Setup reading sessions
      await readingRepo.recordSession(
        {
          storyId: 'story-del-1',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 85,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Del 1', chapterNumber: '1' }
      );

      await readingRepo.recordSession(
        {
          storyId: 'story-keep-2',
          chapterId: 'chap-2',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Keep 2', chapterNumber: '2' }
      );

      expect(await readingRepo.getProgress('story-del-1')).not.toBeNull();
      expect(await readingRepo.getReadChapterIds('story-del-1')).toContain('chap-1');

      // 3. Delete story history
      await libraryRepo.deleteStoryHistory('story-del-1');

      // 4. Invariant: history removed for story-del-1, kept for story-keep-2
      const remainingHistory = await libraryRepo.getHistory();
      expect(remainingHistory.some((h) => h.storyId === 'story-del-1')).toBe(false);
      expect(remainingHistory.some((h) => h.storyId === 'story-keep-2')).toBe(true);

      // 5. Invariant: progress for story-del-1 is GONE (no resurrection on resume)
      expect(await readingRepo.getProgress('story-del-1')).toBeNull();
      expect(await readingRepo.getProgress('story-keep-2')).not.toBeNull();
      expect(await readingRepo.getReadChapterIds('story-del-1')).toHaveLength(0);

      // 6. Invariant: bookmark for story-del-1 remains completely intact
      expect(await libraryRepo.getBookmark('story-del-1')).not.toBeNull();
    });

    it('clears all history for the active guest scope and ALSO clears all reading progress while leaving bookmarks intact', async () => {
      // 1. Setup bookmark
      await libraryRepo.saveBookmark({
        storyId: 'story-clear-1',
        title: 'Clear 1 Bookmarked',
        createdAt: new Date().toISOString(),
      });

      await readingRepo.recordSession(
        {
          storyId: 'story-clear-1',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 90,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Clear 1', chapterNumber: '1' }
      );

      expect(await readingRepo.getProgress('story-clear-1')).not.toBeNull();

      // 2. Clear all history
      await libraryRepo.clearAllHistory();

      // 3. Invariants: history empty, progress empty, readChapterIds empty
      const history = await libraryRepo.getHistory();
      expect(history).toHaveLength(0);
      expect(await readingRepo.getProgress('story-clear-1')).toBeNull();
      expect(await readingRepo.getReadChapterIds('story-clear-1')).toHaveLength(0);

      // 4. Invariant: bookmark remains intact
      expect(await libraryRepo.getBookmark('story-clear-1')).not.toBeNull();
    });
  });
});
