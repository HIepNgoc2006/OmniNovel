import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStudioDashboard } from '../lib/studio/use-studio-dashboard';
import * as translationApi from '../lib/api/translation';
import * as socketHook from '../lib/websocket/use-translation-socket';
import {
  TranslationJobStatus,
  MediaFormat,
  ManagedStorySummaryDto,
  TranslationProjectSummaryDto,
  TranslationJobSummaryDto,
  JOB_STATUS_GROUPS,
} from '@omninovel/shared';

vi.mock('../lib/api/translation');
vi.mock('../lib/websocket/use-translation-socket');

describe('useStudioDashboard Hook (#145 Task 3)', () => {
  const mockStories: ManagedStorySummaryDto[] = [
    {
      id: 'story-1',
      title: 'One Piece',
      slug: 'one-piece',
      mediaFormat: MediaFormat.COMIC,
      publicationFormat: 'WEBTOON' as any,
      originCountry: 'JP',
      originalLanguage: 'ja',
      coverUrl: null,
      status: 'ONGOING' as any,
      visibility: 'PUBLIC' as any,
      summary: null,
      viewsCount: '1000',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  const mockProjects: TranslationProjectSummaryDto[] = [
    {
      id: 'project-1',
      storyId: 'story-1',
      storyEditionId: 'edition-1',
      sourceLanguage: 'ja',
      targetLanguage: 'vi',
      createdAt: '2026-09-01T00:00:00Z',
    },
  ];

  const mockJobs: TranslationJobSummaryDto[] = [
    {
      id: 'job-1',
      projectId: 'project-1',
      storyId: 'story-1',
      storyTitle: 'One Piece',
      storySlug: 'one-piece',
      mediaFormat: MediaFormat.COMIC,
      storyEditionId: 'edition-1',
      editionName: 'Tiếng Việt',
      chapterId: 'chapter-1',
      chapterNumber: '1.00',
      chapterTitle: 'Khởi đầu',
      sourceLanguage: 'ja',
      targetLanguage: 'vi',
      status: TranslationJobStatus.TRANSLATING,
      progressPercentage: 45,
      provider: 'OPENAI',
      modelName: 'gpt-4o-mini',
      createdAt: '2026-09-01T00:00:00Z',
      startedAt: '2026-09-01T00:01:00Z',
      completedAt: null,
      heartbeatAt: '2026-09-01T00:05:00Z',
    },
    {
      id: 'job-2',
      projectId: 'project-1',
      storyId: 'story-1',
      storyTitle: 'One Piece',
      storySlug: 'one-piece',
      mediaFormat: MediaFormat.COMIC,
      storyEditionId: 'edition-1',
      editionName: 'Tiếng Việt',
      chapterId: 'chapter-2',
      chapterNumber: '2.00',
      chapterTitle: 'Đồng đội',
      sourceLanguage: 'ja',
      targetLanguage: 'vi',
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o-mini',
      createdAt: '2026-09-01T01:00:00Z',
      startedAt: '2026-09-01T01:01:00Z',
      completedAt: '2026-09-01T01:05:00Z',
      heartbeatAt: null,
    },
  ];

  let socketCallbacks: {
    onProgress?: Function;
    onReady?: Function;
    onFailed?: Function;
    onCanceled?: Function;
  } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    socketCallbacks = {};

    vi.spyOn(translationApi, 'fetchManagedStories').mockResolvedValue({
      data: mockStories,
      pagination: { total: 1, page: 1, limit: 100, totalPages: 1 },
    });

    vi.spyOn(translationApi, 'fetchTranslationProjects').mockResolvedValue({
      data: mockProjects,
      pagination: { total: 1, page: 1, limit: 100, totalPages: 1 },
    });

    vi.spyOn(translationApi, 'fetchTranslationJobs').mockResolvedValue({
      data: mockJobs,
      pagination: { total: 2, page: 1, limit: 20, totalPages: 1 },
    });

    vi.spyOn(socketHook, 'useTranslationSocket').mockImplementation((options: any) => {
      socketCallbacks = options || {};
      return {
        isConnected: true,
        subscriptionState: 'subscribed',
        lastProgress: null,
        error: null,
        subscribeJob: vi.fn(),
        unsubscribeJob: vi.fn(),
        subscribeJobs: vi.fn(),
        unsubscribeJobs: vi.fn(),
      };
    });
  });

  it('1. Loads initial stories and jobs concurrently on mount', async () => {
    const { result } = renderHook(() => useStudioDashboard());

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });

    expect(translationApi.fetchManagedStories).toHaveBeenCalledTimes(1);
    expect(translationApi.fetchTranslationJobs).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 20 }),
    );
    expect(result.current.stories).toHaveLength(1);
    expect(result.current.jobs).toHaveLength(2);
  });

  it('2. Selecting status group maps to canonical query statuses array and resets to page 1', async () => {
    const { result } = renderHook(() => useStudioDashboard());

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });

    // Switch filter to ACTIVE group
    await act(async () => {
      result.current.setFilterGroup('ACTIVE');
    });

    expect(translationApi.fetchTranslationJobs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        statuses: JOB_STATUS_GROUPS.ACTIVE,
      }),
    );
    expect(result.current.filterGroup).toBe('ACTIVE');

    // Switch filter to REVIEW group
    await act(async () => {
      result.current.setFilterGroup('REVIEW');
    });

    expect(translationApi.fetchTranslationJobs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        statuses: JOB_STATUS_GROUPS.REVIEW,
      }),
    );
    expect(result.current.filterGroup).toBe('REVIEW');
  });

  it('3. Search keyword debounces/submits search query and resets to page 1', async () => {
    const { result } = renderHook(() => useStudioDashboard());

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });

    await act(async () => {
      result.current.setSearchKeyword('One Piece');
    });

    expect(translationApi.fetchTranslationJobs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        search: 'One Piece',
      }),
    );
  });

  it('4. Realtime job_progress event accelerates local progress without triggering REST refetch', async () => {
    const { result } = renderHook(() => useStudioDashboard());

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });

    const restCallsBefore = vi.mocked(translationApi.fetchTranslationJobs).mock.calls.length;

    // Simulate socket job_progress for job-1
    act(() => {
      socketCallbacks.onProgress?.({
        jobId: 'job-1',
        status: TranslationJobStatus.INPAINTING,
        progress: 75,
        timestamp: '2026-09-01T00:07:00Z',
      });
    });

    // Job-1 state should be accelerated in memory
    const updatedJob1 = result.current.jobs.find((j) => j.id === 'job-1');
    expect(updatedJob1?.progressPercentage).toBe(75);
    expect(updatedJob1?.status).toBe(TranslationJobStatus.INPAINTING);
    expect(updatedJob1?.heartbeatAt).toBe('2026-09-01T00:07:00Z');

    // REST must NOT be called for simple progress acceleration
    expect(vi.mocked(translationApi.fetchTranslationJobs).mock.calls.length).toBe(restCallsBefore);
  });

  it('5. Realtime terminal or ready events trigger authoritative REST refetch', async () => {
    const { result } = renderHook(() => useStudioDashboard());

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });

    const restCallsBefore = vi.mocked(translationApi.fetchTranslationJobs).mock.calls.length;

    // Simulate socket job_ready_for_review
    await act(async () => {
      socketCallbacks.onReady?.({
        jobId: 'job-1',
        timestamp: '2026-09-01T00:08:00Z',
      });
    });

    // Authoritative REST refetch must be triggered
    expect(vi.mocked(translationApi.fetchTranslationJobs).mock.calls.length).toBeGreaterThan(
      restCallsBefore,
    );
  });
});
