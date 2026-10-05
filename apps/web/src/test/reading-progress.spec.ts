import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useReadingProgress } from '../lib/reader/use-reading-progress';
import { activeScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import { guestReadingStateRepository } from '../lib/storage/guest-reading-state-repository';
import { accountReadingStateRepository } from '../lib/storage/account-reading-state-repository';
import {
  IndexedDbUnavailableError,
  QuotaExceededStorageError,
} from '../lib/storage/indexed-db-client';
import * as storiesApi from '../lib/api/stories';
import * as gamificationApi from '../lib/api/gamification';

vi.mock('../lib/api/stories', () => ({
  saveReadingProgressApi: vi.fn().mockResolvedValue({}),
  getReadingProgressApi: vi.fn().mockResolvedValue({
    storyId: 'mock-story',
    chapterId: null,
    chapterVersionId: null,
    readingMode: 'WEBTOON',
    progressPercentage: 0,
    scrollPosition: 0,
    readChapterIds: [],
  }),
}));

vi.mock('../lib/api/gamification', () => ({
  rewardReadChapterApi: vi.fn().mockResolvedValue({
    success: false,
    earnedExp: 0,
    totalExp: '0',
    level: 1,
    serverDateVN: '2026-10-05',
  }),
}));

describe('7A.4b/c/f: Repository-Driven Reading Progress Hook', () => {
  beforeEach(async () => {
    localStorage.clear();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.spyOn(storiesApi, 'getReadingProgressApi').mockResolvedValue({
      storyId: 'default-story',
      chapterId: '',
      chapterVersionId: null,
      readingMode: 'WEBTOON',
      progressPercentage: 0,
      scrollPosition: 0,
      updatedAt: new Date().toISOString(),
      readChapterIds: [],
    });
    vi.spyOn(storiesApi, 'saveReadingProgressApi').mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Guest Mode Lifecycle (IndexedDB SSoT & Zero API)', () => {
    beforeEach(async () => {
      await activeScopeCoordinator.onAuthStatusChanged('anonymous');
    });

    it('resumes from IndexedDB, persists session, and NEVER writes to localStorage', async () => {
      // Pre-populate IndexedDB for guest
      await guestReadingStateRepository.saveProgress(
        {
          storyId: 'story-guest-1',
          chapterId: 'chap-10',
          chapterVersionId: 'ver-1',
          readingMode: 'WEBTOON',
          progressPercentage: 55.0,
          scrollPosition: 1200,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        {
          storyTitle: 'Guest Story',
          chapterNumber: '10',
        }
      );

      const saveApiSpy = vi.spyOn(storiesApi, 'saveReadingProgressApi');
      const getApiSpy = vi.spyOn(storiesApi, 'getReadingProgressApi');
      const rewardSpy = vi.spyOn(gamificationApi, 'rewardReadChapterApi');

      const { result } = renderHook(() =>
        useReadingProgress({
          storyId: 'story-guest-1',
          chapterId: 'chap-10',
          storyTitle: 'Guest Story',
          chapterNumber: '10',
        })
      );

      // Resume position loaded from IndexedDB
      await waitFor(() => {
        expect(result.current.serverResume?.chapterId).toBe('chap-10');
      });
      expect(result.current.serverResume?.scrollPosition).toBe(1200);
      expect(result.current.serverResume?.progressPercentage).toBe(55.0);

      // Perform progress update using contract object
      await act(async () => {
        result.current.updateProgress({
          progressPercentage: 85.0,
          scrollPosition: 2500,
          pageIndex: 1,
        });
      });

      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('ready');
      });
      expect(result.current.scrollProgress).toBe(85.0);
      expect(result.current.readChapterIds).toContain('chap-10');

      // INVARIANT 1: Zero localStorage usage
      expect(localStorage.getItem('omninovel_reading_resume_story-guest-1')).toBeNull();

      // INVARIANT 2: Zero API calls or gamification
      expect(saveApiSpy).toHaveBeenCalledTimes(0);
      expect(getApiSpy).toHaveBeenCalledTimes(0);
      expect(rewardSpy).toHaveBeenCalledTimes(0);

      // INVARIANT 3: Exact resume persisted in IndexedDB
      const storedProgress = await guestReadingStateRepository.getProgress('story-guest-1');
      expect(storedProgress?.chapterId).toBe('chap-10');
      expect(storedProgress?.scrollPosition).toBe(2500);
      expect(storedProgress?.progressPercentage).toBe(85.0);
    });

    it('supports backward-compatible updateProgress(percentage, scrollPos)', async () => {
      const { result } = renderHook(() =>
        useReadingProgress({
          storyId: 'story-legacy-args',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
        })
      );

      await act(async () => {
        result.current.updateProgress(45.0, 600);
      });

      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('ready');
      });

      expect(result.current.scrollProgress).toBe(45.0);
      const stored = await guestReadingStateRepository.getProgress('story-legacy-args');
      expect(stored?.scrollPosition).toBe(600);
      expect(stored?.progressPercentage).toBe(45.0);
    });
  });

  describe('2. Authenticated Account Mode Lifecycle (Server Repository & Gamification)', () => {
    beforeEach(async () => {
      await activeScopeCoordinator.onAuthStatusChanged('authenticated', 'usr-test-account');
    });

    it('delegates to AccountReadingStateRepository, syncs with server, and awards gamification', async () => {
      vi.useFakeTimers();

      vi.spyOn(storiesApi, 'getReadingProgressApi').mockResolvedValue({
        storyId: 'story-acc-1',
        chapterId: 'chap-acc-1',
        chapterVersionId: null,
        readingMode: 'WEBTOON',
        progressPercentage: 40,
        scrollPosition: 800,
        updatedAt: new Date().toISOString(),
        readChapterIds: ['chap-acc-0'],
      });

      const saveSpy = vi.spyOn(storiesApi, 'saveReadingProgressApi').mockResolvedValue({} as any);
      const rewardSpy = vi.spyOn(gamificationApi, 'rewardReadChapterApi').mockResolvedValue({
        success: true,
        earnedExp: 10,
        totalExp: '150',
        level: 3,
        serverDateVN: '2026-10-05',
      });

      const { result } = renderHook(() =>
        useReadingProgress({
          storyId: 'story-acc-1',
          chapterId: 'chap-acc-1',
        })
      );

      // Advance initial mount ticks
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(result.current.readChapterIds).toContain('chap-acc-0');
      expect(result.current.serverResume?.chapterId).toBe('chap-acc-1');

      // Advance reading time past 45s
      await act(async () => {
        await vi.advanceTimersByTimeAsync(46000);
      });

      // Update progress to 90%
      await act(async () => {
        result.current.updateProgress({
          progressPercentage: 90,
          scrollPosition: 1800,
        });
      });

      // Advance debounce timer (2000ms)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          storyId: 'story-acc-1',
          chapterId: 'chap-acc-1',
          progressPercentage: 90,
        })
      );

      expect(rewardSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chapterId: 'chap-acc-1',
          progressPercentage: 90,
        })
      );

      expect(result.current.rewardStatus?.earnedExp).toBe(10);
      expect(result.current.showRewardToast).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('3. Persistence Failure UX & Non-Durable Fallback (7A.4f)', () => {
    beforeEach(async () => {
      await activeScopeCoordinator.onAuthStatusChanged('anonymous');
    });

    it('sets persistenceStatus to unavailable and refuses localStorage fallback when IndexedDb fails', async () => {
      // Force guest repository saveProgress to throw QuotaExceededStorageError
      vi.spyOn(guestReadingStateRepository, 'saveProgress').mockRejectedValue(
        new QuotaExceededStorageError('Simulated quota exceeded')
      );

      const { result } = renderHook(() =>
        useReadingProgress({
          storyId: 'story-quota',
          chapterId: 'chap-q',
        })
      );

      await act(async () => {
        result.current.updateProgress({
          progressPercentage: 50,
          scrollPosition: 400,
        });
        await Promise.resolve();
      });

      // Status marked as non-durable / unavailable
      expect(result.current.persistenceStatus).toBe('unavailable');
      // Reading still functional in UI
      expect(result.current.scrollProgress).toBe(50);
      // STRICT INVARIANT: Zero localStorage fallback!
      expect(localStorage.getItem('omninovel_reading_resume_story-quota')).toBeNull();
    });
  });

  describe('4. BOOTSTRAPPING Invariant: Write Operations Wait For Resolved Scope', () => {
    it('defers progress persistence until BOOTSTRAPPING scope is resolved', async () => {
      // Put coordinator in BOOTSTRAPPING
      await activeScopeCoordinator.onAuthStatusChanged('initializing');
      expect(activeScopeCoordinator.canMutateUserState).toBe(false);

      const saveProgressSpy = vi.spyOn(guestReadingStateRepository, 'saveProgress');

      const { result } = renderHook(() =>
        useReadingProgress({
          storyId: 'story-boot',
          chapterId: 'chap-b',
        })
      );

      // Trigger progress while still BOOTSTRAPPING
      act(() => {
        result.current.updateProgress(60, 500);
      });

      // While in BOOTSTRAPPING, saveProgress should NOT have executed yet
      expect(saveProgressSpy).toHaveBeenCalledTimes(0);

      // Now resolve coordinator to anonymous (GUEST)
      await act(async () => {
        await activeScopeCoordinator.onAuthStatusChanged('anonymous');
      });

      await waitFor(() => {
        expect(saveProgressSpy).toHaveBeenCalledTimes(1);
        expect(result.current.persistenceStatus).toBe('ready');
      });
    });
  });
});
