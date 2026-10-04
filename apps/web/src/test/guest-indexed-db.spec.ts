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
} from '../lib/storage/indexed-db-client';
import { GuestReadingStateRepository } from '../lib/storage/guest-reading-state-repository';
import { GuestLibraryRepository } from '../lib/storage/guest-library-repository';
import { ActiveScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import { InstallationIdentityProvider } from '../lib/identity/installation-identity-provider';
import { GuestProfileIdentityProvider } from '../lib/identity/guest-profile-identity-provider';
import { LocalReadingProgress, LocalReadingHistory } from '@omninovel/shared';

describe('Task 7A.3: Web IndexedDB Client & Guest Repositories', () => {
  let dbClient: IndexedDbClient;
  let installProvider: InstallationIdentityProvider;
  let guestProvider: GuestProfileIdentityProvider;
  let coordinator: ActiveScopeCoordinator;
  let readingRepo: GuestReadingStateRepository;
  let libraryRepo: GuestLibraryRepository;

  beforeEach(async () => {
    localStorage.clear();
    // Reset fake IndexedDB
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

    it('fails closed during SSR when window is undefined', async () => {
      const originalWindow = global.window;
      // @ts-expect-error test SSR
      delete global.window;

      const ssrClient = new IndexedDbClient();
      await expect(ssrClient.getDatabase()).rejects.toThrow(/client-only/i);

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

    it('FAILS CLOSED if activeScope is account:*, device:*, or malformed in Guest repository', async () => {
      // Chuyển coordinator sang account
      await coordinator.onAuthStatusChanged('authenticated', 'user-alpha');

      await expect(libraryRepo.getBookmarks()).rejects.toThrow(InvalidGuestScopeException);
      await expect(readingRepo.getProgress('story-123')).rejects.toThrow(InvalidGuestScopeException);
    });

    it('strictly isolates data between two different guest profiles', async () => {
      // Guest A lưu dữ liệu
      await libraryRepo.saveBookmark({
        storyId: 'shared-story',
        title: 'Title of Guest A',
        createdAt: new Date().toISOString(),
      });
      const bookmarksA = await libraryRepo.getBookmarks();
      expect(bookmarksA.length).toBe(1);

      // Rotate sang Guest B (sau khi logout hoặc switch)
      await guestProvider.rotateGuestProfileId();
      await coordinator.onAuthStatusChanged('anonymous');

      // Guest B mở thư viện -> Thư viện hoàn toàn trống, không thấy truyện của Guest A
      const bookmarksB = await libraryRepo.getBookmarks();
      expect(bookmarksB.length).toBe(0);
      expect(await libraryRepo.getBookmark('shared-story')).toBeNull();
    });
  });

  describe('3. Atomic recordReadingSession & Rollback Guarantee', () => {
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

    it('rolls back both progress and history if transaction encounters an error (Atomicity Test)', async () => {
      // Mock historyStore.put to throw an error inside transaction
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
  });

  describe('4. Monotonic History & Read Chapters Threshold (>= 80%)', () => {
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

      const readIds = await readingRepo.getReadChapterIds('story-threshold');
      expect(readIds).toContain('chap-completed');
      expect(readIds).not.toContain('chap-partial');
    });
  });

  describe('5. Library Management Operations (Bookmarks & History deletion)', () => {
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

    it('deletes history for a specific story', async () => {
      await readingRepo.recordSession(
        {
          storyId: 'story-del-1',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
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

      await libraryRepo.deleteStoryHistory('story-del-1');

      const remainingHistory = await libraryRepo.getHistory();
      expect(remainingHistory.some((h) => h.storyId === 'story-del-1')).toBe(false);
      expect(remainingHistory.some((h) => h.storyId === 'story-keep-2')).toBe(true);
    });

    it('clears all history for the active guest scope', async () => {
      await readingRepo.recordSession(
        {
          storyId: 'story-clear-1',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        { storyTitle: 'Clear 1', chapterNumber: '1' }
      );

      await libraryRepo.clearAllHistory();
      const history = await libraryRepo.getHistory();
      expect(history).toHaveLength(0);
    });
  });
});
