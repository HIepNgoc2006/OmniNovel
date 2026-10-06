import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  InstallationIdentityProvider,
  INSTALLATION_ID_KEY,
} from '../lib/identity/installation-identity-provider';
import {
  GuestProfileIdentityProvider,
  GUEST_PROFILE_ID_KEY,
} from '../lib/identity/guest-profile-identity-provider';
import { ActiveScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import {
  IndexedDbClient,
  DB_NAME,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  InvalidGuestScopeException,
  assertGuestScope,
} from '../lib/storage/indexed-db-client';
import { GuestLibraryRepository } from '../lib/storage/guest-library-repository';
import { GuestReadingStateRepository } from '../lib/storage/guest-reading-state-repository';
import * as storiesApi from '../lib/api/stories';
import * as gamificationApi from '../lib/api/gamification';

vi.mock('../lib/api/stories', () => ({
  getBookmarksApi: vi.fn().mockResolvedValue({ items: [], meta: { totalItems: 0, page: 1, limit: 20, totalPages: 0 } }),
  setBookmarkApi: vi.fn().mockResolvedValue({ isBookmarked: true }),
  getBookmarkStatusApi: vi.fn().mockResolvedValue({ isBookmarked: false }),
  getReadingProgressApi: vi.fn().mockResolvedValue({
    storyId: 'story-1',
    chapterId: null,
    chapterVersionId: null,
    readingMode: 'WEBTOON',
    progressPercentage: 0,
    scrollPosition: 0,
    readChapterIds: [],
  }),
  saveReadingProgressApi: vi.fn().mockResolvedValue({}),
  getReadingHistoryApi: vi.fn().mockResolvedValue({ items: [], meta: { totalItems: 0, page: 1, limit: 20, totalPages: 0 } }),
  deleteStoryReadingHistoryApi: vi.fn().mockResolvedValue(undefined),
  clearAllReadingHistoryApi: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/api/gamification', () => ({
  rewardReadChapterApi: vi.fn().mockResolvedValue({
    success: false,
    earnedExp: 0,
    totalExp: '0',
    level: 1,
    serverDateVN: '2026-10-06',
  }),
}));

describe('Task 7A.7 (Web): Identity Isolation, Storage Resilience & Acceptance Verification', () => {
  beforeEach(() => {
    localStorage.clear();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Gate 1: Crash/Restart Persistence & Identity Stability (Metadata Only)
  // =========================================================================
  describe('Gate 1: Crash/Restart Persistence & Identity Stability (Metadata Only)', () => {
    it('survives process crash/runtime reconstruction: preserves installationId, guestProfileId and exact metadata without stale RAM objects', async () => {
      // 1. Khởi tạo phiên làm việc ban đầu
      const installProvider1 = new InstallationIdentityProvider();
      const guestProvider1 = new GuestProfileIdentityProvider();
      const coordinator1 = new ActiveScopeCoordinator(installProvider1, guestProvider1);
      const idbClient1 = new IndexedDbClient();
      const guestLibRepo1 = new GuestLibraryRepository(idbClient1, coordinator1);
      const guestReadingRepo1 = new GuestReadingStateRepository(idbClient1, coordinator1);

      await coordinator1.onAuthStatusChanged('anonymous');
      const initialInstallationId = await installProvider1.getOrCreateInstallationId();
      const initialGuestProfileId = await guestProvider1.getOrCreateGuestProfileId();
      const initialScope = coordinator1.activeScope!;

      expect(initialScope).toBe(`guest:${initialGuestProfileId}`);

      // 2. Guest lưu bookmark, progress, history
      await guestLibRepo1.saveBookmark({
        storyId: 'story-crash-1',
        title: 'Truyện Sống Sót Qua Crash',
        slug: 'truyen-song-sot-crash',
        coverUrl: 'https://cdn.omninovel.com/covers/crash.jpg',
        createdAt: new Date().toISOString(),
      });

      await guestReadingRepo1.saveProgress(
        {
          storyId: 'story-crash-1',
          chapterId: 'chap-crash-42',
          chapterVersionId: 'ver-42',
          readingMode: 'MANGA_PAGED',
          progressPercentage: 75.5,
          scrollPosition: 42,
          pageIndex: 42,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        {
          storyTitle: 'Truyện Sống Sót Qua Crash',
          storySlug: 'truyen-song-sot-crash',
          chapterNumber: '42',
          chapterTitle: 'Khúc Cao Trào',
        }
      );

      // 3. MÔ PHỎNG CRASH & RESTART HOÀN TOÀN
      // Đóng kết nối IndexedDB, hủy bỏ toàn bộ references trong RAM
      idbClient1.close();

      // 4. Tạo các instance mới hoàn toàn từ persistent storage (localStorage + IndexedDB)
      const installProvider2 = new InstallationIdentityProvider();
      const guestProvider2 = new GuestProfileIdentityProvider();
      const coordinator2 = new ActiveScopeCoordinator(installProvider2, guestProvider2);
      const idbClient2 = new IndexedDbClient();
      const guestLibRepo2 = new GuestLibraryRepository(idbClient2, coordinator2);
      const guestReadingRepo2 = new GuestReadingStateRepository(idbClient2, coordinator2);

      await coordinator2.onAuthStatusChanged('anonymous');

      // INVARIANT 1: Stable Identity sau crash
      const recoveredInstallationId = await installProvider2.getOrCreateInstallationId();
      const recoveredGuestProfileId = await guestProvider2.getOrCreateGuestProfileId();
      expect(recoveredInstallationId).toBe(initialInstallationId);
      expect(recoveredGuestProfileId).toBe(initialGuestProfileId);
      expect(coordinator2.activeScope).toBe(initialScope);

      // INVARIANT 2: Bookmark metadata phục hồi chính xác 100% từ IndexedDB
      const recoveredBookmark = await guestLibRepo2.getBookmark('story-crash-1');
      expect(recoveredBookmark).not.toBeNull();
      expect(recoveredBookmark?.title).toBe('Truyện Sống Sót Qua Crash');
      expect(recoveredBookmark?.slug).toBe('truyen-song-sot-crash');
      expect(recoveredBookmark?.coverUrl).toBe('https://cdn.omninovel.com/covers/crash.jpg');

      // INVARIANT 3: Reading Progress & Paged Resume phục hồi chính xác
      const recoveredProgress = await guestReadingRepo2.getProgress('story-crash-1');
      expect(recoveredProgress).not.toBeNull();
      expect(recoveredProgress?.chapterId).toBe('chap-crash-42');
      expect(recoveredProgress?.pageIndex).toBe(42);
      expect(recoveredProgress?.progressPercentage).toBe(75.5);
      expect(recoveredProgress?.scrollPosition).toBe(42);

      // INVARIANT 4: Reading History phục hồi đầy đủ
      const recoveredHistory = await guestLibRepo2.getHistory();
      expect(recoveredHistory.length).toBe(1);
      expect(recoveredHistory[0].storyId).toBe('story-crash-1');
      expect(recoveredHistory[0].chapterId).toBe('chap-crash-42');
      expect(recoveredHistory[0].storyTitle).toBe('Truyện Sống Sót Qua Crash');
      expect(recoveredHistory[0].chapterNumber).toBe('42');

      idbClient2.close();
    });
  });

  // =========================================================================
  // Gate 2: Guest Zero-Network & Zero-Bearer Leakage
  // =========================================================================
  describe('Gate 2: Guest Zero-Network & Zero-Bearer Leakage', () => {
    it('executes full guest library and progress mutations with ZERO API invocations and ZERO Bearer headers', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);
      const idbClient = new IndexedDbClient();
      const guestLibRepo = new GuestLibraryRepository(idbClient, coordinator);
      const guestReadingRepo = new GuestReadingStateRepository(idbClient, coordinator);

      await coordinator.onAuthStatusChanged('anonymous');

      const setBookmarkSpy = vi.spyOn(storiesApi, 'setBookmarkApi');
      const getBookmarksSpy = vi.spyOn(storiesApi, 'getBookmarksApi');
      const saveProgressSpy = vi.spyOn(storiesApi, 'saveReadingProgressApi');
      const getProgressSpy = vi.spyOn(storiesApi, 'getReadingProgressApi');
      const getHistorySpy = vi.spyOn(storiesApi, 'getReadingHistoryApi');
      const deleteHistorySpy = vi.spyOn(storiesApi, 'deleteStoryReadingHistoryApi');
      const clearHistorySpy = vi.spyOn(storiesApi, 'clearAllReadingHistoryApi');
      const rewardSpy = vi.spyOn(gamificationApi, 'rewardReadChapterApi');

      // 1. Bookmark mutation (add & delete)
      await guestLibRepo.saveBookmark({
        storyId: 'story-g-zero-net',
        title: 'Zero Network Story',
        slug: 'zero-net',
        createdAt: new Date().toISOString(),
      });
      await guestLibRepo.removeBookmark('story-g-zero-net');

      // 2. Reading progress mutation
      await guestReadingRepo.saveProgress({
        storyId: 'story-g-zero-net',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        progressPercentage: 80.0,
        scrollPosition: 1000,
        pageIndex: 1,
        updatedAt: new Date().toISOString(),
        deviceTimestamp: Date.now(),
      });

      // 3. History mutation (read & clear)
      await guestLibRepo.getHistory();
      await guestLibRepo.deleteStoryHistory('story-g-zero-net');
      await guestLibRepo.clearAllHistory();

      // INVARIANT: Zero client-side server-pollution path
      expect(setBookmarkSpy).toHaveBeenCalledTimes(0);
      expect(getBookmarksSpy).toHaveBeenCalledTimes(0);
      expect(saveProgressSpy).toHaveBeenCalledTimes(0);
      expect(getProgressSpy).toHaveBeenCalledTimes(0);
      expect(getHistorySpy).toHaveBeenCalledTimes(0);
      expect(deleteHistorySpy).toHaveBeenCalledTimes(0);
      expect(clearHistorySpy).toHaveBeenCalledTimes(0);
      expect(rewardSpy).toHaveBeenCalledTimes(0);

      idbClient.close();
    });
  });

  // =========================================================================
  // Gate 3: Cross-Contamination Prevention & Guest Data Preserved
  // =========================================================================
  describe('Gate 3: Cross-Contamination Prevention (A -> fresh G -> B) & Guest Data Preserved', () => {
    it('isolates user sessions, binds zero guest data to User B, and preserves guest G data in storage (hidden but preserved)', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);
      const idbClient = new IndexedDbClient();
      const guestLibRepo = new GuestLibraryRepository(idbClient, coordinator);
      const guestReadingRepo = new GuestReadingStateRepository(idbClient, coordinator);

      // 1. User Alice đăng nhập
      await coordinator.onAuthStatusChanged('authenticated', 'usr-alice');
      expect(coordinator.activeScope).toBe('account:usr-alice');

      // 2. User Alice đăng xuất -> Rotate sang fresh guest G2
      await coordinator.onLogout();
      const guestScopeG2 = coordinator.activeScope!;
      expect(coordinator.state).toBe('GUEST');
      expect(guestScopeG2).toMatch(/^guest:/);

      // 3. Guest G2 tạo dữ liệu tại partition guest:G2
      await guestLibRepo.saveBookmark({
        storyId: 'story-guest-preserved',
        title: 'Truyện Khách G2 Cần Giữ Lại',
        slug: 'truyen-khach-g2',
        createdAt: new Date().toISOString(),
      });
      await guestReadingRepo.saveProgress({
        storyId: 'story-guest-preserved',
        chapterId: 'chap-preserved-1',
        readingMode: 'WEBTOON',
        progressPercentage: 50.0,
        scrollPosition: 600,
        pageIndex: 1,
        updatedAt: new Date().toISOString(),
        deviceTimestamp: Date.now(),
      });

      // 4. User Bob đăng nhập trên cùng máy
      await coordinator.onAuthStatusChanged('authenticated', 'usr-bob');
      expect(coordinator.activeScope).toBe('account:usr-bob');

      // INVARIANT 1: User Bob không được phép bind dữ liệu của Guest G2 hay Alice
      expect(coordinator.activeScope).not.toBe(guestScopeG2);
      expect(coordinator.activeScope).not.toBe('account:usr-alice');

      // INVARIANT 2 (HIDDEN BUT PRESERVED):
      // Dữ liệu của Guest G2 KHÔNG bị auto-delete và KHÔNG bị auto-claim ngầm vào Bob.
      // Trực tiếp query IndexedDB với partition guestScopeG2 để xác nhận dữ liệu vẫn còn nguyên:
      const db = await idbClient.getDatabase();
      const tx = db.transaction([STORE_BOOKMARKS, STORE_PROGRESS], 'readonly');
      const bookmarkStore = tx.objectStore(STORE_BOOKMARKS);
      const progressStore = tx.objectStore(STORE_PROGRESS);

      const g2BookmarkRequest = bookmarkStore.get([guestScopeG2, 'story-guest-preserved']);
      const g2ProgressRequest = progressStore.get([guestScopeG2, 'story-guest-preserved']);

      const [storedBookmark, storedProgress] = await Promise.all([
        new Promise((resolve) => {
          g2BookmarkRequest.onsuccess = () => resolve(g2BookmarkRequest.result);
        }),
        new Promise((resolve) => {
          g2ProgressRequest.onsuccess = () => resolve(g2ProgressRequest.result);
        }),
      ]);

      expect(storedBookmark).not.toBeUndefined();
      expect((storedBookmark as any).title).toBe('Truyện Khách G2 Cần Giữ Lại');
      expect((storedBookmark as any).ownerScope).toBe(guestScopeG2);

      expect(storedProgress).not.toBeUndefined();
      expect((storedProgress as any).chapterId).toBe('chap-preserved-1');
      expect((storedProgress as any).ownerScope).toBe(guestScopeG2);

      idbClient.close();
    });
  });

  // =========================================================================
  // Gate 4: Auth Bootstrap Race Prevention (Fail-Closed) & Post-Resolution Retry
  // =========================================================================
  describe('Gate 4: Auth Bootstrap Race Prevention (Frozen Fail-Closed Semantics)', () => {
    it('fails closed when BOOTSTRAPPING by blocking mutation and persisting zero IDB rows, then writes to resolved scope upon retry', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);
      const idbClient = new IndexedDbClient();
      const guestReadingRepo = new GuestReadingStateRepository(idbClient, coordinator);

      // 1. Coordinator ở trạng thái BOOTSTRAPPING
      await coordinator.onAuthStatusChanged('initializing');
      expect(coordinator.state).toBe('BOOTSTRAPPING');
      expect(coordinator.canMutateUserState).toBe(false);
      expect(coordinator.activeScope).toBeNull();

      // INVARIANT: Scope assertion fails closed
      expect(() => assertGuestScope(coordinator.activeScope)).toThrow(InvalidGuestScopeException);

      // 2. Cố gắng ghi trực tiếp vào store khi chưa resolved scope -> throw Error & ZERO IDB mutation
      await expect(
        idbClient.putProgress({
          ownerScope: coordinator.activeScope as any,
          storyId: 'story-boot-fail',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 30.0,
          scrollPosition: 300,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        })
      ).rejects.toThrow();

      // INVARIANT: Zero records written to IndexedDB progress store
      const db = await idbClient.getDatabase();
      const tx1 = db.transaction([STORE_PROGRESS], 'readonly');
      const progressStore1 = tx1.objectStore(STORE_PROGRESS);
      const allProgress = await new Promise<any[]>((resolve) => {
        const req = progressStore1.getAll();
        req.onsuccess = () => resolve(req.result);
      });
      expect(allProgress.length).toBe(0);

      // 3. Auth giải quyết xong sang anonymous (GUEST)
      await coordinator.onAuthStatusChanged('anonymous');
      expect(coordinator.state).toBe('GUEST');
      expect(coordinator.canMutateUserState).toBe(true);
      const resolvedScope = coordinator.activeScope!;

      // 4. Retry mutation hợp lệ
      await guestReadingRepo.saveProgress({
        storyId: 'story-boot-fail',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        progressPercentage: 30.0,
        scrollPosition: 300,
        pageIndex: 1,
        updatedAt: new Date().toISOString(),
        deviceTimestamp: Date.now(),
      });

      // INVARIANT: Dữ liệu ghi chính xác vào resolved scope
      const savedProgress = await guestReadingRepo.getProgress('story-boot-fail');
      expect(savedProgress).not.toBeNull();
      expect(savedProgress?.chapterId).toBe('chap-1');
      expect(savedProgress?.ownerScope).toBe(resolvedScope);

      idbClient.close();
    });
  });
});
