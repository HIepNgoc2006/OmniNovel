import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReadingProgress } from '../lib/reader/use-reading-progress';
import * as storiesApi from '../lib/api/stories';
import * as gamificationApi from '../lib/api/gamification';
import * as authContext from '../lib/auth/auth-context';

describe('Reading Progress & Gamification Lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'u-123', username: 'reader1', email: 'r@omninovel.com', role: 'READER' } as any,
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(storiesApi, 'getReadingProgressApi').mockResolvedValue({
      storyId: 's-1',
      chapterId: 'c-1',
      chapterVersionId: 'v-1',
      readingMode: 'WEBTOON',
      progressPercentage: 85,
      scrollPosition: 1500,
      updatedAt: new Date().toISOString(),
      readChapterIds: ['c-0', 'c-1'],
    });

    vi.spyOn(storiesApi, 'saveReadingProgressApi').mockResolvedValue({
      storyId: 's-1',
      chapterId: 'c-1',
      readingMode: 'WEBTOON',
      progressPercentage: 85,
      scrollPosition: 1500,
      updatedAt: new Date().toISOString(),
    });

    vi.spyOn(gamificationApi, 'rewardReadChapterApi').mockResolvedValue({
      success: true,
      earnedExp: 5,
      totalExp: '105',
      level: 2,
    });
  });

  it('should calculate progress percentage and update local storage', async () => {
    const { result } = renderHook(() =>
      useReadingProgress({
        storyId: 's-1',
        chapterId: 'c-1',
        readingMode: 'WEBTOON',
      }),
    );

    await act(async () => {
      // Allow bootstrap promise to resolve
      await Promise.resolve();
    });

    expect(result.current.readChapterIds).toContain('c-0');
    expect(result.current.serverResume?.chapterId).toBe('c-1');
    expect(result.current.serverResume?.chapterVersionId).toBe('v-1');
    expect(result.current.serverResume?.readingMode).toBe('WEBTOON');
    expect(result.current.serverResume?.scrollPosition).toBe(1500);

    act(() => {
      result.current.updateProgress(45.5, 800);
    });

    expect(result.current.scrollProgress).toBe(45.5);

    const saved = JSON.parse(localStorage.getItem('omninovel_reading_resume_s-1') || '{}');
    expect(saved.chapterId).toBe('c-1');
    expect(saved.readingMode).toBe('WEBTOON');
    expect(saved.progressPercentage).toBe(45.5);
  });

  it('should trigger gamification reward and show toast when criteria (>=45s & >=80%) are satisfied', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useReadingProgress({
        storyId: 's-1',
        chapterId: 'c-1',
        readingMode: 'WEBTOON',
      }),
    );

    // Tiến thời gian 46 giây
    act(() => {
      vi.advanceTimersByTime(46000);
    });

    // Cuộn tới 85%
    await act(async () => {
      result.current.updateProgress(85, 2000);
    });

    expect(gamificationApi.rewardReadChapterApi).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 'c-1',
        progressPercentage: 85,
      }),
    );

    expect(result.current.rewardStatus?.success).toBe(true);
    expect(result.current.rewardStatus?.earnedExp).toBe(5);
    expect(result.current.showRewardToast).toBe(true);

    vi.useRealTimers();
  });
});
