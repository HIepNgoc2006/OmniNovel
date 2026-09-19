import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import { useMangaReviewStudio } from '../lib/studio/use-manga-review-studio';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';

let socketCallbacks: {
  jobId?: string;
  onProgress?: (event: any) => void;
  onReady?: (event: any) => void;
  onFailed?: (event: any) => void;
  onCanceled?: (event: any) => void;
} = {};

vi.mock('../lib/websocket/use-translation-socket', () => ({
  useTranslationSocket: vi.fn((opts) => {
    socketCallbacks = opts;
    return {
      isConnected: true,
      subscriptionState: 'subscribed',
      lastProgress: null,
      error: null,
      subscribeJob: vi.fn(),
      unsubscribeJob: vi.fn(),
    };
  }),
}));

vi.mock('../lib/api/translation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/translation')>();
  return {
    ...actual,
    fetchTranslationJobDetail: vi.fn(),
    fetchTranslationJobSegments: vi.fn(),
    fetchTranslationJobPreviews: vi.fn(),
    updateTranslationSegment: vi.fn(),
    requestJobMaterialization: vi.fn(),
    cancelTranslationJob: vi.fn(),
  };
});

vi.mock('../lib/auth/auth-context');

describe('Manga Review Studio Realtime & Cleanup Integration (#149 RED 6)', () => {
  const mockJobId = 'job-comic-red6';

  const mockComicJobDetail: TranslationJobReviewDetailResponse = {
    job: {
      id: mockJobId,
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o-mini',
      promptVersion: 'manga-ja-vi-v1',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: '2026-09-01T10:00:00Z',
      startedAt: '2026-09-01T10:01:00Z',
      heartbeatAt: '2026-09-01T10:05:00Z',
      completedAt: '2026-09-01T10:05:00Z',
      expiresAt: null,
      reviewRevision: 1,
      materializedRevision: 1,
      workspaceRevision: 1,
    },
    context: {
      story: {
        id: 'story-comic-1',
        title: 'Truyện Manga Trắng Đen',
        slug: 'truyen-manga-trang-den',
        mediaFormat: MediaFormat.COMIC,
      },
      edition: {
        id: 'edition-1',
        editionName: 'Tiếng Việt',
        language: 'vi',
        isDefault: true,
      },
      chapter: {
        id: 'chapter-1',
        chapterNumber: '1',
        title: 'Chương 1',
      },
      project: {
        id: 'project-1',
        sourceLanguage: 'ja',
        targetLanguage: 'vi',
      },
      sourceVersion: {
        id: 'version-1',
        versionNumber: 1,
      },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 2,
      verifiedCount: 1,
      pageCount: 1,
      resultPageCount: 3,
      blockCount: 2,
    },
    permissions: {
      canApply: true,
    },
  };

  const mockSegments: TranslationSegmentDto[] = [
    {
      id: 'seg-1',
      jobId: mockJobId,
      sortOrder: 1,
      rawText: 'こんにちは',
      translatedText: 'Xin chào',
      isHumanVerified: false,
      version: 1,
      pageNumber: 1,
      bboxX: 10,
      bboxY: 10,
      bboxW: 100,
      bboxH: 50,
      confidence: 0.99,
      anchorBlockId: null,
    },
    {
      id: 'seg-2',
      jobId: mockJobId,
      sortOrder: 2,
      rawText: 'ありがとう',
      translatedText: 'Cảm ơn',
      isHumanVerified: true,
      version: 1,
      pageNumber: 1,
      bboxX: 20,
      bboxY: 20,
      bboxW: 100,
      bboxH: 50,
      confidence: 0.99,
      anchorBlockId: null,
    },
  ];

  const mockPreviewsResponse = {
    jobId: mockJobId,
    workspaceRevision: 1,
    fromPage: 1,
    toPage: 3,
    totalPages: 3,
    sourceAssets: [
      {
        pageNumber: 1,
        url: 'https://cdn.example.com/source-1.webp',
        expiresAt: '2026-09-01T11:00:00Z',
        width: 800,
        height: 1200,
      },
    ],
    resultAssets: [
      {
        pageNumber: 1,
        url: 'https://cdn.example.com/result-1.webp',
        expiresAt: '2026-09-01T11:00:00Z',
        width: 800,
        height: 1200,
      },
    ],
  };

  let currentDetailState: TranslationJobReviewDetailResponse = mockComicJobDetail;

  beforeEach(() => {
    vi.clearAllMocks();
    socketCallbacks = {};
    currentDetailState = mockComicJobDetail;

    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 'user-red6-reviewer', email: 'reviewer@omninovel.com' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    } as any);

    vi.mocked(translationApi.fetchTranslationJobDetail).mockImplementation(
      async () => currentDetailState,
    );
    vi.mocked(translationApi.fetchTranslationJobSegments).mockImplementation(async () => {
      return {
        data: mockSegments,
        pagination: { total: mockSegments.length, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: currentDetailState.job.workspaceRevision,
      } as any;
    });
    vi.mocked(translationApi.fetchTranslationJobPreviews).mockImplementation(async () => {
      return {
        jobId: currentDetailState.job.id,
        workspaceRevision: currentDetailState.job.workspaceRevision,
        fromPage: 1,
        toPage: 3,
        totalPages: 3,
        sourceAssets: [
          {
            pageNumber: 1,
            url: 'https://cdn.example.com/source-1.webp',
            expiresAt: '2026-09-01T11:00:00Z',
            width: 800,
            height: 1200,
          },
        ],
        resultAssets: [
          {
            pageNumber: 1,
            url: `https://cdn.example.com/result-v${currentDetailState.job.workspaceRevision}-1.webp`,
            expiresAt: '2026-09-01T11:00:00Z',
            width: 800,
            height: 1200,
          },
        ],
      } as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Scenario 1: Stale socket event after job switch is dropped (Lock B)', async () => {
    const { result, rerender } = renderHook(({ jobId }) => useMangaReviewStudio(jobId), {
      initialProps: { jobId: 'job-1' },
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Switch to job-2
    vi.mocked(translationApi.fetchTranslationJobDetail).mockClear();
    act(() => {
      rerender({ jobId: 'job-2' });
    });

    // Stale event for job-1 arrives in flight
    act(() => {
      socketCallbacks.onProgress?.({
        jobId: 'job-1',
        status: TranslationJobStatus.TRANSLATING,
        progress: 50,
        timestamp: new Date().toISOString(),
      });
    });

    // Must NOT trigger refetch for job-1
    expect(translationApi.fetchTranslationJobDetail).not.toHaveBeenCalledWith('job-1');
  });

  it('Scenario 2: Late event after unmount produces no error or memory leak (Lock F)', async () => {
    const { result, unmount } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    unmount();

    // Late event arriving after component is destroyed
    expect(() => {
      act(() => {
        socketCallbacks.onProgress?.({
          jobId: mockJobId,
          status: TranslationJobStatus.READY_FOR_REVIEW,
          progress: 100,
          timestamp: new Date().toISOString(),
        });
      });
    }).not.toThrow();
  });

  it('Scenario 3: Duplicate socket events coalesce without double-fetch (Lock E)', async () => {
    let resolveDetail: (val: any) => void = () => {};
    const delayedDetailPromise = new Promise((resolve) => {
      resolveDetail = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    vi.mocked(translationApi.fetchTranslationJobDetail).mockClear();
    vi.mocked(translationApi.fetchTranslationJobDetail).mockImplementation(
      () => delayedDetailPromise as any,
    );

    // Fire 3 socket ready events in quick succession
    act(() => {
      socketCallbacks.onReady?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        timestamp: new Date().toISOString(),
      });
      socketCallbacks.onReady?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        timestamp: new Date().toISOString(),
      });
      socketCallbacks.onReady?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        timestamp: new Date().toISOString(),
      });
    });

    // Exactly 1 fetch is in flight
    expect(translationApi.fetchTranslationJobDetail).toHaveBeenCalledTimes(1);

    // Resolve the in-flight fetch
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      mockComicJobDetail,
    );
    await act(async () => {
      resolveDetail(mockComicJobDetail);
    });

    // Exactly 1 coalesced follow-up executed
    await waitFor(() => {
      expect(translationApi.fetchTranslationJobDetail).toHaveBeenCalledTimes(2);
    });
  });

  it('Scenario 4: Terminal state fences against late progress/ready events (Lock C & P1-1)', async () => {
    const canceledJobDetail: TranslationJobReviewDetailResponse = {
      ...mockComicJobDetail,
      job: {
        ...mockComicJobDetail.job,
        status: TranslationJobStatus.CANCELED,
      },
    };

    currentDetailState = canceledJobDetail;
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      canceledJobDetail,
    );

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.workspaceMode?.mode).toBe('TERMINAL_STATE');
    });

    vi.mocked(translationApi.fetchTranslationJobDetail).mockClear();

    // Late socket progress arrives
    act(() => {
      socketCallbacks.onProgress?.({
        jobId: mockJobId,
        status: TranslationJobStatus.TRANSLATING,
        progress: 80,
        timestamp: new Date().toISOString(),
      });
    });

    // Must be strictly fenced out by Lock C
    expect(translationApi.fetchTranslationJobDetail).not.toHaveBeenCalled();
    expect(result.current.workspaceMode?.mode).toBe('TERMINAL_STATE');
  });

  it('Scenario 5: Socket event during active materialization TRACKING does NOT reset RED 5 lifecycle (P1-3 & Lock A)', async () => {
    const staleJobDetail: TranslationJobReviewDetailResponse = {
      ...mockComicJobDetail,
      job: {
        ...mockComicJobDetail.job,
        reviewRevision: 2,
        materializedRevision: 1,
        workspaceRevision: 2,
      },
    };
    currentDetailState = staleJobDetail;
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      staleJobDetail,
    );

    vi.mocked(translationApi.requestJobMaterialization).mockResolvedValue({
      status: 'ENQUEUED',
      targetRevision: 2,
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.freshness?.isFresh).toBe(false);
    });

    // Trigger materialization
    await act(async () => {
      await result.current.triggerMaterialization();
    });

    expect(result.current.materializationLifecycle.phase).toBe('TRACKING');
    expect(result.current.materializationLifecycle.targetRevision).toBe(2);

    // Socket progress arrives during active tracking
    act(() => {
      socketCallbacks.onProgress?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        timestamp: new Date().toISOString(),
      });
    });

    // Tracking phase and immutable targetRevision must be preserved!
    expect(result.current.materializationLifecycle.phase).toBe('TRACKING');
    expect(result.current.materializationLifecycle.targetRevision).toBe(2);
  });

  it('Scenario 6: Cancel vs completion race resolves to authoritative terminal state (Lock D & P2-6)', async () => {
    vi.mocked(translationApi.cancelTranslationJob).mockResolvedValue({
      id: mockJobId,
      status: TranslationJobStatus.CANCELED,
    });

    // Server authoritative detail resolves to APPLIED (completed concurrently by publisher)
    const appliedJobDetail: TranslationJobReviewDetailResponse = {
      ...mockComicJobDetail,
      job: {
        ...mockComicJobDetail.job,
        status: TranslationJobStatus.APPLIED,
      },
    };
    currentDetailState = appliedJobDetail;
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      appliedJobDetail,
    );

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let cancelSuccess = false;
    await act(async () => {
      cancelSuccess = await result.current.cancelJob();
    });

    // cancelSuccess must be false because authoritative state was APPLIED, not CANCELED
    expect(cancelSuccess).toBe(false);
    expect(result.current.workspaceMode?.mode).toBe('APPLIED');
  });

  it('Scenario 7: Cancel on already terminal job (400) resolves gracefully without crashing (P2-6 & Lock D)', async () => {
    // Backend returns 400 when job is already terminal
    vi.mocked(translationApi.cancelTranslationJob).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'JOB_ALREADY_TERMINAL',
            message: 'Không thể hủy job đã ở trạng thái kết thúc (CANCELED).',
          },
        },
      },
    });

    const canceledJobDetail: TranslationJobReviewDetailResponse = {
      ...mockComicJobDetail,
      job: {
        ...mockComicJobDetail.job,
        status: TranslationJobStatus.CANCELED,
      },
    };
    currentDetailState = canceledJobDetail;
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      canceledJobDetail,
    );

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let cancelOutcome = false;
    await act(async () => {
      cancelOutcome = await result.current.cancelJob();
    });

    // Since authoritative status is CANCELED, cancel goal was achieved
    expect(cancelOutcome).toBe(true);
    expect(result.current.cancelError).toBeNull();
    expect(result.current.workspaceMode?.mode).toBe('TERMINAL_STATE');
  });

  it('Scenario 8: User drafts preserved across background reconciliations; purged on true job switch (Lock F & P1-2)', async () => {
    const { result, rerender } = renderHook(({ jobId }) => useMangaReviewStudio(jobId), {
      initialProps: { jobId: mockJobId },
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // User types draft
    act(() => {
      result.current.setSegmentDraft('seg-1', 'Bản nháp người dùng');
    });

    expect(result.current.drafts['seg-1']).toBe('Bản nháp người dùng');

    // Background socket event triggers reconciliation
    act(() => {
      socketCallbacks.onProgress?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        timestamp: new Date().toISOString(),
      });
    });

    // Draft is preserved across same-job background reconciliation
    expect(result.current.drafts['seg-1']).toBe('Bản nháp người dùng');

    // Job switch to different job
    act(() => {
      rerender({ jobId: 'job-other-chapter' });
    });

    // Draft for old job must be purged on true job switch
    expect(result.current.drafts['seg-1']).toBeUndefined();
  });

  it('Scenario 9: Foreground reconciliation and socket event coalesce without parallel fetch (Lock E)', async () => {
    let resolveDetail: (val: any) => void = () => {};
    const inFlightPromise = new Promise((resolve) => {
      resolveDetail = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    vi.mocked(translationApi.fetchTranslationJobDetail).mockClear();
    vi.mocked(translationApi.fetchTranslationJobDetail).mockImplementation(
      () => inFlightPromise as any,
    );

    // Foreground refetchDetail starts
    let refetchPromise: Promise<any>;
    act(() => {
      refetchPromise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
    });

    expect(translationApi.fetchTranslationJobDetail).toHaveBeenCalledTimes(1);

    // Concurrently, a socket ready event arrives
    act(() => {
      socketCallbacks.onReady?.({
        jobId: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        timestamp: new Date().toISOString(),
      });
    });

    // Still only 1 in flight
    expect(translationApi.fetchTranslationJobDetail).toHaveBeenCalledTimes(1);

    // Resolve first request
    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(
      mockComicJobDetail,
    );
    await act(async () => {
      resolveDetail(mockComicJobDetail);
      await refetchPromise;
    });

    // Follow-up runs sequentially
    await waitFor(() => {
      expect(translationApi.fetchTranslationJobDetail).toHaveBeenCalledTimes(2);
    });
  });
});
