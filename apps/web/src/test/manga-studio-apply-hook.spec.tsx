import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  ApplyTranslationMode,
  ApplyTranslationJobResponse,
  ChapterVersionType,
} from '@omninovel/shared';
import { useMangaReviewStudio } from '../lib/studio/use-manga-review-studio';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';

vi.mock('../lib/api/translation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/translation')>();
  return {
    ...actual,
    fetchTranslationJobDetail: vi.fn(),
    fetchTranslationJobSegments: vi.fn(),
    fetchTranslationJobPreviews: vi.fn(),
    updateTranslationSegment: vi.fn(),
    requestJobMaterialization: vi.fn(),
    applyTranslationJob: vi.fn(),
  };
});

vi.mock('../lib/auth/auth-context');

describe('useMangaReviewStudio Apply / Publish Lifecycle (#152 Task 4)', () => {
  const mockJobId = 'job-apply-123';

  const mockBaseDetail: TranslationJobReviewDetailResponse = {
    job: {
      id: mockJobId,
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o-mini',
      promptVersion: 'v1',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: '2026-09-01T10:00:00Z',
      startedAt: '2026-09-01T10:01:00Z',
      heartbeatAt: '2026-09-01T10:05:00Z',
      completedAt: '2026-09-01T10:05:00Z',
      expiresAt: null,
      reviewRevision: 1,
      materializedRevision: 1,
      workspaceRevision: 2,
    },
    context: {
      story: { id: 's1', title: 'One Piece', slug: 'one-piece', mediaFormat: MediaFormat.COMIC },
      edition: { id: 'e1', editionName: 'Việt', language: 'vi', isDefault: true },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Khởi đầu' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 1,
      verifiedCount: 1,
      pageCount: 1,
      resultPageCount: 1,
      blockCount: null,
    },
    permissions: {
      canApply: true,
    },
  };

  const mockApplySuccessResponse: ApplyTranslationJobResponse = {
    chapterId: 'c1',
    activeVersionId: 'ver-target-1',
    targetVersionId: 'ver-target-1',
    versionNumber: 2,
    versionType: ChapterVersionType.AI_TRANSLATED,
    isAlreadyApplied: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authContext.useAuth).mockReturnValue({
      status: 'authenticated',
      user: { id: 'u1', email: 'owner@example.com', role: 'USER' } as any,
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(mockBaseDetail);
    vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
      data: [
        {
          id: 'seg-1',
          jobId: mockJobId,
          pageNumber: 1,
          anchorBlockId: null,
          sortOrder: 1,
          bboxX: 10,
          bboxY: 10,
          bboxW: 50,
          bboxH: 20,
          rawText: 'Raw',
          translatedText: 'Dịch',
          confidence: 0.95,
          isHumanVerified: true,
          version: 1,
        },
      ],
      pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
      workspaceRevision: 2,
    });
    vi.mocked(translationApi.fetchTranslationJobPreviews).mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Happy path: POST 200 -> RECONCILING -> refetchDetail confirms APPLIED + targetVersionId matches + bump revision -> SUCCEEDED', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockResolvedValueOnce(mockApplySuccessResponse);

    const reconciledDetail: TranslationJobReviewDetailResponse = {
      ...mockBaseDetail,
      job: {
        ...mockBaseDetail.job,
        status: TranslationJobStatus.APPLIED,
        workspaceRevision: 3, // strictly > previous 2
      },
      context: {
        ...mockBaseDetail.context,
        targetVersion: { id: 'ver-target-1', versionNumber: 2 },
      },
    };

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.canApply).toBe(true);
    expect(result.current.applyLifecycle).toBe('IDLE');

    let applyOutcome: any;
    await act(async () => {
      // Mock subsequent detail call during reconciliation
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce(reconciledDetail);
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('SUCCEEDED');
    expect(applyOutcome.response).toEqual(mockApplySuccessResponse);
    expect(result.current.applyLifecycle).toBe('SUCCEEDED');
    expect(result.current.applyResponse).toEqual(mockApplySuccessResponse);
    expect(result.current.applyError).toBeNull();
  });

  it('2. Network drop / timeout during POST -> outcome SUBMISSION_OUTCOME_UNKNOWN (NOT FAILED), retains frozen submission', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockRejectedValueOnce({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 30000ms exceeded',
      response: null,
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.current.applyLifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.current.applyError?.isAmbiguous).toBe(true);
  });

  it('3. HTTP 5xx during POST -> outcome SUBMISSION_OUTCOME_UNKNOWN (ambiguous, retains frozen key & mode), NOT FAILED', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 502,
        data: { error: { code: 'BAD_GATEWAY', message: 'Upstream server error' } },
      },
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.current.applyLifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.current.applyError?.status).toBe(502);
    expect(result.current.applyError?.isAmbiguous).toBe(true);
  });

  it('4. Deterministic 403 / 409 error during POST -> outcome FAILED, non-ambiguous', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'FORBIDDEN', message: 'Chỉ OWNER hoặc EDITOR mới được áp dụng.' } },
      },
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('FAILED');
    expect(result.current.applyLifecycle).toBe('FAILED');
    expect(result.current.applyError?.status).toBe(403);
    expect(result.current.applyError?.isAmbiguous).toBe(false);
  });

  it('5. Post succeeds on server but refetchDetail fails -> outcome COMMITTED_RECONCILIATION_REQUIRED', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockResolvedValueOnce(mockApplySuccessResponse);

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      // Reconcile detail fetch fails
      vi.mocked(translationApi.fetchTranslationJobDetail).mockRejectedValueOnce(new Error('Network error on refetch'));
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('COMMITTED_RECONCILIATION_REQUIRED');
    expect(result.current.applyLifecycle).toBe('COMMITTED_RECONCILIATION_REQUIRED');
    expect(result.current.applyResponse).toEqual(mockApplySuccessResponse);
  });

  it('6. Coherence failure (targetVersionId mismatch): refetchDetail returns APPLIED but targetVersionId does not match -> COMMITTED_RECONCILIATION_REQUIRED', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockResolvedValueOnce(mockApplySuccessResponse);

    const mismatchedDetail: TranslationJobReviewDetailResponse = {
      ...mockBaseDetail,
      job: {
        ...mockBaseDetail.job,
        status: TranslationJobStatus.APPLIED,
        workspaceRevision: 3,
      },
      context: {
        ...mockBaseDetail.context,
        targetVersion: { id: 'foreign-target-version', versionNumber: 99 },
      },
    };

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce(mismatchedDetail);
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('COMMITTED_RECONCILIATION_REQUIRED');
    expect(result.current.applyLifecycle).toBe('COMMITTED_RECONCILIATION_REQUIRED');
  });

  it('7. Coherence failure (workspaceRevision <= previousWorkspaceRevision): refetchDetail returns APPLIED but revision not bumped -> COMMITTED_RECONCILIATION_REQUIRED', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockResolvedValueOnce(mockApplySuccessResponse);

    // Initial revision was 2. If server returns APPLIED but revision is still 2 (not > 2), coherence violation!
    const unbumpedRevisionDetail: TranslationJobReviewDetailResponse = {
      ...mockBaseDetail,
      job: {
        ...mockBaseDetail.job,
        status: TranslationJobStatus.APPLIED,
        workspaceRevision: 2, // Violates strict inequality > 2
      },
      context: {
        ...mockBaseDetail.context,
        targetVersion: { id: 'ver-target-1', versionNumber: 2 },
      },
    };

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    let applyOutcome: any;
    await act(async () => {
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce(unbumpedRevisionDetail);
      applyOutcome = await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(applyOutcome.outcome).toBe('COMMITTED_RECONCILIATION_REQUIRED');
    expect(result.current.applyLifecycle).toBe('COMMITTED_RECONCILIATION_REQUIRED');
  });

  it('8. Frozen submission enforcement: retry uses exact same idempotencyKey and mode', async () => {
    // Attempt 1: 504 timeout (ambiguous)
    vi.mocked(translationApi.applyTranslationJob).mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 504, data: { error: { code: 'GATEWAY_TIMEOUT', message: 'Gateway Timeout' } } },
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      await result.current.applyJob(ApplyTranslationMode.CREATE_ALTERNATE_VERSION);
    });

    expect(result.current.applyLifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');

    const firstCallKey = vi.mocked(translationApi.applyTranslationJob).mock.calls[0][2];
    const firstCallMode = vi.mocked(translationApi.applyTranslationJob).mock.calls[0][1].mode;
    expect(firstCallMode).toBe(ApplyTranslationMode.CREATE_ALTERNATE_VERSION);
    expect(firstCallKey).toBeTruthy();

    // Attempt 2: retryApplyAction() MUST send same key and mode
    const reconciledDetail: TranslationJobReviewDetailResponse = {
      ...mockBaseDetail,
      job: {
        ...mockBaseDetail.job,
        status: TranslationJobStatus.APPLIED,
        workspaceRevision: 3,
      },
      context: {
        ...mockBaseDetail.context,
        targetVersion: { id: 'ver-target-1', versionNumber: 2 },
      },
    };

    vi.mocked(translationApi.applyTranslationJob).mockResolvedValueOnce(mockApplySuccessResponse);

    let retryOutcome: any;
    await act(async () => {
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce(reconciledDetail);
      retryOutcome = await result.current.retryApplyAction();
    });

    expect(retryOutcome.outcome).toBe('SUCCEEDED');
    expect(vi.mocked(translationApi.applyTranslationJob)).toHaveBeenCalledTimes(2);
    const secondCallKey = vi.mocked(translationApi.applyTranslationJob).mock.calls[1][2];
    const secondCallMode = vi.mocked(translationApi.applyTranslationJob).mock.calls[1][1].mode;
    expect(secondCallKey).toBe(firstCallKey);
    expect(secondCallMode).toBe(firstCallMode);
  });

  it('9. canApply strictly respects uncommitted drafts fence across all segments', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.canApply).toBe(true);

    // Typing a draft introduces uncommitted change
    act(() => {
      result.current.setSegmentDraft('seg-1', 'Bản nháp chưa lưu');
    });

    expect(result.current.canApply).toBe(false);

    // Discarding draft restores canApply = true
    act(() => {
      result.current.discardSegmentDraft('seg-1');
    });

    expect(result.current.canApply).toBe(true);
  });

  it('10. resetApplyAction only resets frozen state if server is verified READY_FOR_REVIEW', async () => {
    vi.mocked(translationApi.applyTranslationJob).mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 504, data: { error: { code: 'GATEWAY_TIMEOUT', message: 'Gateway Timeout' } } },
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await act(async () => {
      await result.current.applyJob(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);
    });

    expect(result.current.applyLifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');

    // If server is still READY_FOR_REVIEW, reset is allowed
    let resetSuccess = false;
    await act(async () => {
      resetSuccess = result.current.resetApplyAction();
    });

    expect(resetSuccess).toBe(true);
    expect(result.current.applyLifecycle).toBe('IDLE');
    expect(result.current.applyError).toBeNull();
  });
});
