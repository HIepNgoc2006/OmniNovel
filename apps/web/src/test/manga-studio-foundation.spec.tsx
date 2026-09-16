import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import {
  useMangaReviewStudio,
  ReconciliationOutcome,
  buildSaveSegmentResult,
  SaveSegmentResult,
} from '../lib/studio/use-manga-review-studio';
import { computeMaterializationFreshness } from '../lib/studio/manga-studio-policy';
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
  };
});
vi.mock('../lib/auth/auth-context');

describe('Manga Review Studio Foundation (#149 RED 0)', () => {
  const mockJobId = 'job-comic-123';

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
        title: 'Manga Test',
        slug: 'manga-test',
        mediaFormat: MediaFormat.COMIC,
      },
      edition: {
        id: 'ed-1',
        editionName: 'Tiếng Việt',
        language: 'vi',
        isDefault: true,
      },
      chapter: {
        id: 'chap-1',
        chapterNumber: '1.00',
        title: 'Chương 1',
      },
      project: {
        id: 'proj-1',
        sourceLanguage: 'ja',
        targetLanguage: 'vi',
      },
      sourceVersion: { id: 'ver-src', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 4,
      verifiedCount: 2,
      pageCount: 3, // OCR page count
      resultPageCount: 5, // Authoritative result manifest count
      blockCount: null,
    },
  };

  const mockStaleComicJobDetail: TranslationJobReviewDetailResponse = {
    ...mockComicJobDetail,
    job: {
      ...mockComicJobDetail.job,
      reviewRevision: 2,
      materializedRevision: 1,
      workspaceRevision: 1,
    },
  };

  const mockSegments: TranslationSegmentDto[] = [
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
      rawText: 'こんにちは',
      translatedText: 'Xin chào',
      confidence: 0.95,
      isHumanVerified: true,
      version: 1,
    },
    {
      id: 'seg-2',
      jobId: mockJobId,
      pageNumber: 1,
      anchorBlockId: null,
      sortOrder: 2,
      bboxX: 70,
      bboxY: 10,
      bboxW: 50,
      bboxH: 20,
      rawText: 'ありがとう',
      translatedText: 'Cảm ơn',
      confidence: 0.98,
      isHumanVerified: false,
      version: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Default authenticated translator user
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', email: 'translator@example.com', username: 'translator', role: 'USER' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: mockSegments,
      pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
      workspaceRevision: 1,
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Auth Gate & Lifecycle', () => {
    it('should NOT fetch private workspace if auth is initializing or user is unauthenticated', async () => {
      vi.spyOn(authContext, 'useAuth').mockReturnValue({
        status: 'initializing',
        user: null,
        isAuthenticated: false,
        isLoading: true,
        login: vi.fn(),
        logout: vi.fn(),
        refetchUser: vi.fn(),
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      expect(translationApi.fetchTranslationJobDetail).not.toHaveBeenCalled();
      expect(result.current.status).toBe('auth_required');
      expect(result.current.jobDetail).toBeNull();
    });
  });

  describe('2. Access & Clean-Slate Privacy (403/404)', () => {
    it('should purge cached workspace data immediately on 403 Forbidden without leaking previous job state', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 403,
          data: {
            error: {
              code: 'FORBIDDEN',
              message: 'Bạn không có quyền truy cập job này.',
              requestId: 'req-403',
              timestamp: '2026-09-10T12:00:00Z',
            },
          },
        },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.jobDetail).toBeNull();
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
      expect(result.current.error?.code).toBe('FORBIDDEN');
    });
  });

  describe('3. Job Media Format Enforcement', () => {
    it('should reject NOVEL jobs with UNSUPPORTED_FORMAT mode and handoff notice', async () => {
      const novelJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        context: {
          ...mockComicJobDetail.context,
          story: {
            ...mockComicJobDetail.context.story,
            mediaFormat: MediaFormat.NOVEL,
          },
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(novelJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.workspaceMode?.mode).toBe('UNSUPPORTED_FORMAT');
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.message).toContain('Tiểu thuyết');
    });
  });

  describe('4. Authoritative Page Count vs Fail-Closed Fallback', () => {
    it('should expose authoritative resultPageCount (5) and NOT fallback to OCR pageCount (3)', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.pageCountInfo.pageCount).toBe(5);
      expect(result.current.pageCountInfo.isAvailable).toBe(true);
    });

    it('should set pageCount to null and isAvailable to false when resultPageCount is null, and STRICTLY block previews, save, and materialization', async () => {
      const nullCountJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        reviewSummary: {
          ...mockComicJobDetail.reviewSummary,
          pageCount: 7, // OCR page count is 7
          resultPageCount: null, // Null authoritative count
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(nullCountJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.pageCountInfo.pageCount).toBeNull();
      expect(result.current.pageCountInfo.isAvailable).toBe(false);

      // Invariant: Count unavailable MUST transition to COUNT_UNAVAILABLE mode
      expect(result.current.workspaceMode?.mode).toBe('COUNT_UNAVAILABLE');
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Previews MUST NOT be called when count is unavailable
      expect(translationApi.fetchTranslationJobPreviews).not.toHaveBeenCalled();

      // Mutations MUST be blocked
      const saveOk = await result.current.saveSegment('seg-1', 'Thử lưu');
      expect(saveOk.success).toBe(false);
      expect(translationApi.updateTranslationSegment).not.toHaveBeenCalled();

      const matRes = await result.current.triggerMaterialization();
      expect(matRes).toBeNull();
      expect(translationApi.requestJobMaterialization).not.toHaveBeenCalled();
    });
  });

  describe('5. APPLIED State Policy & Mutation Blocking', () => {
    it('should display APPLIED mode with authoritative count but STRICTLY block preview and segment edit', async () => {
      const appliedJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          status: TranslationJobStatus.APPLIED,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Attempting to save a segment in APPLIED state MUST fail without calling API
      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Bản sửa mới');
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('STATE_CHANGED');
      expect(translationApi.updateTranslationSegment).not.toHaveBeenCalled();
    });
  });

  describe('6. Non-Ready Pipeline Monitor vs Terminal States', () => {
    it('should set PIPELINE_MONITOR mode for QUEUED/TRANSLATING and disable previews & editing', async () => {
      const queuedJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          status: TranslationJobStatus.QUEUED,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(queuedJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.workspaceMode?.mode).toBe('PIPELINE_MONITOR');
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(translationApi.fetchTranslationJobPreviews).not.toHaveBeenCalled();
    });

    it.each([
      TranslationJobStatus.FAILED,
      TranslationJobStatus.CANCELED,
      TranslationJobStatus.EXPIRED,
    ])('should set TERMINAL_STATE mode for %s with terminal message (not waiting instruction)', async (terminalStatus) => {
      const termJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          status: terminalStatus,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(termJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.workspaceMode?.mode).toBe('TERMINAL_STATE');
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);
      expect(result.current.workspaceMode?.message).not.toContain('tiến trình xử lý tự động');
      expect(result.current.workspaceMode?.message).not.toContain('Vui lòng chờ');
    });
  });

  describe('7. Error Handling: Revocation (403/404) & OCC Conflicts', () => {
    it('should purge cached workspace data when refetchDetail returns 403 Forbidden after initial load', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.jobDetail).not.toBeNull();
      expect(result.current.segments.length).toBeGreaterThan(0);

      // Now user membership is revoked -> refetchDetail returns 403
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 403,
          data: {
            error: {
              code: 'FORBIDDEN',
              message: 'Quyền truy cập đã bị thu hồi.',
            },
          },
        },
      });

      await act(async () => {
        await result.current.refetchDetail();
      });

      // MUST purge all private workspace data and switch to error
      expect(result.current.status).toBe('error');
      expect(result.current.jobDetail).toBeNull();
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
      expect(result.current.error?.code).toBe('FORBIDDEN');
    });

    it('should purge workspace data if previews request returns 403 Forbidden', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 403,
          data: {
            error: {
              code: 'FORBIDDEN',
              message: 'Không có quyền xem preview.',
            },
          },
        },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.jobDetail).toBeNull();
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
      expect(result.current.error?.code).toBe('FORBIDDEN');
    });

    it('should catch 409 VERSION_CONFLICT, populate conflictState with error.meta, and preserve user draft', async () => {
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Segment đã bị thay đổi bởi người khác.',
              requestId: 'req-conflict-1',
              timestamp: '2026-09-10T12:00:00Z',
              meta: {
                currentVersion: 3,
                expectedVersion: 1,
              },
            },
          },
        },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Bản dịch của tôi');
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('VERSION_CONFLICT');
      expect(result.current.conflictState).toMatchObject({
        segmentId: 'seg-1',
        currentVersion: 3,
        expectedVersion: 1,
        draftText: 'Bản dịch của tôi',
      });
    });

    it('should reconcile authoritative state to APPLIED when saveSegment receives 409 NOT_REVIEWABLE', async () => {
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'NOT_REVIEWABLE',
              message: 'Job không còn ở trạng thái READY_FOR_REVIEW.',
              requestId: 'req-nr-1',
              timestamp: '2026-09-10T12:00:00Z',
            },
          },
        },
      });

      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockResolvedValueOnce(mockComicJobDetail)
        .mockResolvedValueOnce(appliedJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
        expect(result.current.segments.length).toBeGreaterThan(0);
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Bản dịch mới');
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('STATE_CHANGED');
      expect(result.current.jobDetail?.job.status).toBe(TranslationJobStatus.APPLIED);
      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.workspaceMode?.mode).not.toBe('PIPELINE_MONITOR');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should reconcile authoritative state to TERMINAL_STATE when saveSegment receives 409 NOT_REVIEWABLE and server is FAILED', async () => {
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'NOT_REVIEWABLE',
              message: 'Job đã kết thúc thất bại.',
              requestId: 'req-nr-failed',
              timestamp: '2026-09-10T12:00:00Z',
            },
          },
        },
      });

      const failedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.FAILED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockResolvedValueOnce(mockComicJobDetail)
        .mockResolvedValueOnce(failedJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Bản dịch');
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('STATE_CHANGED');

      expect(result.current.jobDetail?.job.status).toBe(TranslationJobStatus.FAILED);
      expect(result.current.workspaceMode?.mode).toBe('TERMINAL_STATE');
      expect(result.current.workspaceMode?.mode).not.toBe('PIPELINE_MONITOR');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
    });

    it('should not allow an in-flight older preview 403 to purge workspace after a newer same-job refetch succeeds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch 1: Preview request hangs
      let rejectOldPreview: (err: any) => void;
      const oldPreviewPromise = new Promise((_, reject) => {
        rejectOldPreview = reject;
      });

      let previewCalledSignal: () => void;
      const previewCalledPromise = new Promise<void>((resolve) => {
        previewCalledSignal = resolve;
      });

      let previewCallCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
        previewCallCount++;
        if (previewCallCount === 1) {
          previewCalledSignal();
          return oldPreviewPromise as any;
        }
        return {
          sourceAssets: [{ url: 'https://cdn.example.com/page1-new.jpg' }],
          resultAssets: [],
          workspaceRevision: 1,
        };
      });

      let refetch1Promise: Promise<ReconciliationOutcome>;
      act(() => {
        refetch1Promise = result.current.refetchDetail();
      });

      // Wait until Refetch 1 has actually launched its preview request
      await act(async () => {
        await previewCalledPromise;
      });

      // Refetch 2: Newer request succeeds
      await act(async () => {
        await result.current.refetchDetail();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.previews?.sourceAssets[0]?.url).toBe('https://cdn.example.com/page1-new.jpg');
      });

      // Now Refetch 1 preview fails with 403
      await act(async () => {
        rejectOldPreview!({
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: { code: 'FORBIDDEN', message: 'Stale access denied' } },
          },
        });
        await refetch1Promise.catch(() => {});
      });

      // Invariant: Workspace MUST NOT be purged by the stale error!
      expect(result.current.status).toBe('ready');
      expect(result.current.jobDetail).not.toBeNull();
      expect(result.current.previews?.sourceAssets[0]?.url).toBe('https://cdn.example.com/page1-new.jpg');
    });

    it('should not allow an in-flight older segments 403 to purge workspace after a newer same-job refetch succeeds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let rejectOldSegments: (err: any) => void;
      const oldSegmentsPromise = new Promise((_, reject) => {
        rejectOldSegments = reject;
      });

      let segmentsCalledSignal: () => void;
      const segmentsCalledPromise = new Promise<void>((resolve) => {
        segmentsCalledSignal = resolve;
      });

      let segmentsCallCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async () => {
        segmentsCallCount++;
        if (segmentsCallCount === 1) {
          segmentsCalledSignal();
          return oldSegmentsPromise as any;
        }
        return {
          data: [{ ...mockSegments[0], translatedText: 'Newer Segments' }],
          pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        } as any;
      });

      let refetch1Promise: Promise<ReconciliationOutcome>;
      act(() => {
        refetch1Promise = result.current.refetchDetail();
      });

      // Wait until Refetch 1 has actually launched its segments request
      await act(async () => {
        await segmentsCalledPromise;
      });

      // Newer refetch succeeds
      await act(async () => {
        await result.current.refetchDetail();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.segments[0]?.translatedText).toBe('Newer Segments');
      });

      // Stale segments from refetch 1 rejects with 403
      await act(async () => {
        rejectOldSegments!({
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: { code: 'FORBIDDEN', message: 'Stale access denied' } },
          },
        });
        await refetch1Promise.catch(() => {});
      });

      // Invariant: Workspace MUST NOT be purged by stale child error!
      expect(result.current.status).toBe('ready');
      expect(result.current.jobDetail).not.toBeNull();
      expect(result.current.segments[0]?.translatedText).toBe('Newer Segments');
    });

    it('should not allow an in-flight older detail 403 to purge workspace after a newer same-job refetch succeeds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch 1: Detail request hangs
      let rejectOldDetail: (err: any) => void;
      const oldDetailPromise = new Promise((_, reject) => {
        rejectOldDetail = reject;
      });

      let detailCalledSignal: () => void;
      const detailCalledPromise = new Promise<void>((resolve) => {
        detailCalledSignal = resolve;
      });

      let detailCallCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => {
        detailCallCount++;
        if (detailCallCount === 1) {
          detailCalledSignal();
          return oldDetailPromise as any;
        }
        return {
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 2 },
        };
      });

      let refetch1Promise: Promise<ReconciliationOutcome>;
      act(() => {
        refetch1Promise = result.current.refetchDetail();
      });

      // Wait until Refetch 1 detail is launched
      await act(async () => {
        await detailCalledPromise;
      });

      // Refetch 2: Newer request succeeds
      await act(async () => {
        await result.current.refetchDetail();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.jobDetail?.job.reviewRevision).toBe(2);
      });

      // Now Refetch 1 detail fails with 403
      await act(async () => {
        rejectOldDetail!({
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: { code: 'FORBIDDEN', message: 'Stale access denied' } },
          },
        });
        await refetch1Promise.catch(() => {});
      });

      // Invariant: Workspace MUST NOT be purged by the stale detail error!
      expect(result.current.status).toBe('ready');
      expect(result.current.jobDetail).not.toBeNull();
      expect(result.current.jobDetail?.job.reviewRevision).toBe(2);
    });

    it('should purge workspace when GET segments returns 404 indicating job or story deleted', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // GET segments returns 404 NOT_FOUND
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: { code: 'NOT_FOUND', message: 'Job không tồn tại' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Invariant: GET segments 404 is a job-level fatal error -> purge!
      expect(result.current.status).toBe('error');
      expect(result.current.jobDetail).toBeNull();
      expect(result.current.segments).toEqual([]);
    });

    it('should reconcile authoritative state to APPLIED when preview API returns 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch detail returns READY_FOR_REVIEW first so Preview API is launched!
      let detailCallCount = 0;
      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => {
        detailCallCount++;
        if (detailCallCount === 1) {
          // Refetch 1 detail: still reports READY_FOR_REVIEW
          return mockComicJobDetail;
        }
        // Second detail call during reconcileAuthoritativeWorkspace: reports APPLIED
        return appliedJobDetail;
      });

      // Preview API returns 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS when called
      let previewApiCalled = false;
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
        previewApiCalled = true;
        throw {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: {
                code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
                message: 'Job không còn ở trạng thái READY_FOR_REVIEW.',
              },
            },
          },
        };
      });

      // Trigger refetchDetail
      await act(async () => {
        await result.current.refetchDetail();
      });

      // Assert that Preview API WAS actually called and received the 409!
      expect(previewApiCalled).toBe(true);
      // Assert that reconcile called fetchTranslationJobDetail a second time
      expect(detailCallCount).toBeGreaterThanOrEqual(2);
      // Assert authoritative workspace mode is APPLIED
      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.jobDetail?.job.status).toBe(TranslationJobStatus.APPLIED);
      expect(result.current.previews).toBeNull();
      expect(result.current.segments).toEqual([]);
    });

    it('should reconcile to APPLIED during initial loadJobData when preview returns 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS', async () => {
      let detailCallCount = 0;
      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => {
        detailCallCount++;
        if (detailCallCount === 1) {
          return mockComicJobDetail;
        }
        return appliedJobDetail;
      });

      let previewCalled = false;
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
        previewCalled = true;
        throw {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: {
                code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
                message: 'Server transition to APPLIED during load',
              },
            },
          },
        };
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      });

      expect(previewCalled).toBe(true);
      expect(detailCallCount).toBeGreaterThanOrEqual(2);
      expect(result.current.previews).toBeNull();
      expect(result.current.segments).toEqual([]);
    });

    it('should clear old preview immediately when materializedRevision increments even if reviewRevision and status remain unchanged', async () => {
      // Start with rev 5, matRev 4, status READY_FOR_REVIEW
      const rev5JobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 5,
          materializedRevision: 4,
          status: TranslationJobStatus.READY_FOR_REVIEW,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(rev5JobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [{ url: 'https://cdn.example.com/page1-rev4.jpg', kind: 'SOURCE' as any, pageNumber: 1, width: 800, height: 1200 }],
        resultAssets: [{ url: 'https://cdn.example.com/page1-rev4-result.jpg', kind: 'RESULT' as any, pageNumber: 1, width: 800, height: 1200 }],
        workspaceRevision: 1,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.previews?.sourceAssets[0]?.url).toBe('https://cdn.example.com/page1-rev4.jpg');
        expect(result.current.freshness.status).toBe('STALE');
      });

      // Materialization finishes: reviewRevision stays 5, materializedRevision becomes 5
      const materializedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 5,
          materializedRevision: 5,
          status: TranslationJobStatus.READY_FOR_REVIEW,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(materializedJobDetail);

      // But the new preview fetch fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'CDN timeout' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Invariant: Previews MUST be cleared so stale rev-4 image is NOT displayed alongside FRESH status!
      expect(result.current.freshness.status).toBe('FRESH');
      expect(result.current.previews).toBeNull();
    });

    it('should preserve Segment A conflict draft when saving Segment B succeeds', async () => {
      const seg2: TranslationSegmentDto = {
        ...mockSegments[0],
        id: 'seg-2',
        translatedText: 'Seg 2 original',
        version: 1,
      };
      vi.spyOn(translationApi, 'fetchTranslationJobSegments')
        .mockResolvedValueOnce({
          data: [mockSegments[0], seg2],
          pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        } as any)
        .mockResolvedValue({
          data: [{ ...mockSegments[0], version: 2 }, seg2],
          pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        } as any);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Save Segment A -> VERSION_CONFLICT
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Conflict on segment A',
              currentVersion: 2,
              expectedVersion: 1,
            },
          },
        },
      });

      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft of Seg A');
      });

      expect(result.current.conflictState).not.toBeNull();
      expect(result.current.conflictState?.draftText).toBe('Draft of Seg A');

      // Now user switches to Segment 2 and saves Segment 2 successfully
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...seg2,
        translatedText: 'Seg 2 saved',
        version: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [{ ...mockSegments[0], version: 2 }, { ...seg2, translatedText: 'Seg 2 saved', version: 2 }],
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      } as any);

      act(() => {
        result.current.setSelectedSegmentId('seg-2');
      });

      await act(async () => {
        const saved = await result.current.saveSegment('seg-2', 'Seg 2 saved');
        expect(saved.success).toBe(true);
      });

      // Switch back to Segment A
      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });

      // Invariant: Segment A conflict draft MUST survive after saving Segment B!
      expect(result.current.conflictState).not.toBeNull();
      expect(result.current.conflictState?.segmentId).toBe('seg-1');
      expect(result.current.conflictState?.draftText).toBe('Draft of Seg A');
    });

    it('should preserve newer conflict draft when an older in-flight save arrives later for the same segment', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });

      // Save A1 hangs
      let resolveSave1: (val: any) => void;
      const save1Promise = new Promise((resolve) => {
        resolveSave1 = resolve;
      });

      let saveCall = 0;
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementation(async () => {
        saveCall++;
        if (saveCall === 1) {
          return save1Promise as any;
        }
        // Save A2 throws VERSION_CONFLICT
        throw {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Conflict on A2',
                currentVersion: 3,
                expectedVersion: 1,
              },
            },
          },
        };
      });

      // Trigger Save A1
      let save1ResultPromise: Promise<any>;
      act(() => {
        save1ResultPromise = result.current.saveSegment('seg-1', 'Text A1');
      });

      // Trigger Save A2 (newer) which fails with VERSION_CONFLICT
      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft A2');
      });

      expect(result.current.conflictState?.draftText).toBe('Draft A2');

      // Now Save A1 completes
      await act(async () => {
        resolveSave1!({
          ...mockSegments[0],
          translatedText: 'Text A1',
          version: 2,
        });
        await save1ResultPromise.catch(() => {});
      });

      // Invariant: Newer conflict draft A2 MUST NOT be wiped by older success!
      expect(result.current.conflictState).not.toBeNull();
      expect(result.current.conflictState?.draftText).toBe('Draft A2');
    });

    it('should report save as true when two saves on different segments overlap and one detail refetch is superseded', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.segments.length).toBeGreaterThanOrEqual(2);
      });

      // Mock updateTranslationSegment to succeed for both seg-1 and seg-2 independently
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementation(async (_job, segId, payload) => {
        const seg = mockSegments.find((s) => s.id === segId) || mockSegments[0];
        return {
          ...seg,
          id: segId,
          translatedText: payload.translatedText ?? null,
          version: 2,
        };
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async () => {
        return {
          data: [
            { ...mockSegments[0], translatedText: 'Text 1', version: 2 },
            { ...mockSegments[1], translatedText: 'Text 2', version: 2 },
          ],
          pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        };
      });

      // Refetch detail 1 hangs, Refetch detail 2 completes
      let resolveDetail1: (val: any) => void;
      const detail1Promise = new Promise((resolve) => {
        resolveDetail1 = resolve;
      });

      let detailCall = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => {
        detailCall++;
        if (detailCall === 1) {
          return detail1Promise as any;
        }
        return {
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 3 },
        };
      });

      let save1Promise: Promise<any>;
      act(() => {
        save1Promise = result.current.saveSegment('seg-1', 'Text 1');
      });

      // Save 2 on seg-2 starts and completes with newer refetch detail
      let save2Result: any;
      await act(async () => {
        save2Result = await result.current.saveSegment('seg-2', 'Text 2');
      });

      expect(save2Result.success).toBe(true);
      expect(save2Result.outcome).toBe('SAVED_AND_SYNCED');

      // Now Refetch 1 resolves (it is superseded by successful refetch 2)
      await act(async () => {
        resolveDetail1!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 2 },
        });
      });

      const save1Result = await save1Promise!;
      // Invariant: Save 1 on seg-1 committed on backend and its refetch was superseded by a newer successful sync -> MUST report true!
      expect(save1Result.success).toBe(true);
      expect(save1Result.outcome).toBe('SAVED_AND_SYNCED');
    });

    it('should clear old segments when detail reviewRevision increments so stale segments are not shown if new fetch fails', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.segments.length).toBeGreaterThan(0);
      });

      // Detail has new reviewRevision = 2
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 2 },
      });

      // But segments fetch fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'DB down' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Invariant: Stale segments MUST NOT remain under revision 2!
      expect(result.current.segments).toEqual([]);
    });

    it('should NOT remain FRESH and should return false when PATCH segment succeeds but authoritative detail refetch fails with 500', async () => {
      // Start in a FRESH state (1, 1)
      const freshJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 1,
          materializedRevision: 1,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(freshJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.freshness.status).toBe('FRESH');
      });

      // PATCH succeeds
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        translatedText: 'Nội dung mới',
        version: 2,
      });

      // But authoritative detail refetch fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'DB connection timeout' } },
        },
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Nội dung mới');
      });

      // Invariant: Save must NOT report clean success if authoritative sync failed!
      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('SAVED_SYNC_FAILED');
      // Invariant: Freshness MUST NOT remain FRESH!
      expect(result.current.freshness.status).not.toBe('FRESH');
      expect(result.current.freshness.status).toBe('UNKNOWN');
      expect(result.current.freshness.isFresh).toBe(false);
    });

    it('should purge workspace and return false when PATCH segment succeeds but detail refetch fails with 403', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // PATCH succeeds
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        translatedText: 'Nội dung mới',
        version: 2,
      });

      // But authoritative detail refetch encounters 403
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: { code: 'FORBIDDEN', message: 'Permission revoked during save' } },
        },
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Nội dung mới');
      });

      // Invariant: Save MUST NOT return true when workspace was purged!
      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('ACCESS_REVOKED');
      expect(result.current.status).toBe('error');
      expect(result.current.error?.code).toBe('FORBIDDEN');
    });

    it('should NOT purge whole workspace when PATCH segment returns 404 for a missing segment if job detail remains 200', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // PATCH segment returns 404 NOT_FOUND (segment missing/deleted)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 404,
          data: {
            error: {
              code: 'NOT_FOUND',
              message: 'Không tìm thấy TranslationSegment với id seg-1.',
            },
          },
        },
      });

      // Job Detail is still valid (200)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Nội dung');
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.outcome).toBe('FAILED_BEFORE_COMMIT');
      // Invariant: Workspace MUST NOT be purged!
      expect(result.current.status).not.toBe('error');
      expect(result.current.jobDetail).not.toBeNull();
      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
    });

    it('should not allow in-flight older preview to revive previews after 409 NOT_REVIEWABLE', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
      });

      // Prepare in-flight preview that hangs during a refetch
      let resolveOldPreviews: (val: any) => void;
      const oldPreviewsPromise = new Promise((resolve) => {
        resolveOldPreviews = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockReturnValue(
        oldPreviewsPromise as any,
      );

      // Trigger refetch while in reviewable state -> launches fetchTranslationJobPreviews which hangs
      act(() => {
        result.current.refetchDetail();
      });

      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'NOT_REVIEWABLE',
              message: 'Job không còn reviewable',
            },
          },
        },
      });

      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedJobDetail);

      // Trigger saveSegment which receives 409 NOT_REVIEWABLE and reconciles to APPLIED
      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch');
      });

      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.previews).toBeNull();
      expect(result.current.segments).toEqual([]);

      // In-flight preview from earlier generation resolves now
      await act(async () => {
        resolveOldPreviews!({
          sourceAssets: [{ url: 'https://cdn.example.com/stale-page.jpg' }],
          resultAssets: [],
          workspaceRevision: 1,
        });
      });

      // Invariant: Data must NOT be revived!
      expect(result.current.previews).toBeNull();
      expect(result.current.segments).toEqual([]);
    });

    it('should not allow in-flight older segments to revive segments after 409 NOT_REVIEWABLE', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveOldSegments: (val: any) => void;
      const oldSegmentsPromise = new Promise((resolve) => {
        resolveOldSegments = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockReturnValue(
        oldSegmentsPromise as any,
      );

      act(() => {
        result.current.refetchDetail();
      });

      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: { error: { code: 'NOT_REVIEWABLE', message: 'Job is not reviewable' } },
        },
      });

      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedJobDetail);

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch');
      });

      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.segments).toEqual([]);

      // In-flight older segments resolves now
      await act(async () => {
        resolveOldSegments!({
          data: [{ ...mockSegments[0], translatedText: 'Revived text' }],
          pagination: { total: 1, page: 1, limit: 100, totalPages: 1 },
          workspaceRevision: 1,
        });
      });

      // Invariant: Segments MUST remain empty in APPLIED mode!
      expect(result.current.segments).toEqual([]);
    });

    it('should clear materializationStatus and preserve currentPage during same-scope authoritative reconciliation (#149 RED 1)', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockStaleComicJobDetail);
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      await act(async () => {
        await result.current.triggerMaterialization();
        result.current.setCurrentPage(3);
      });

      expect(result.current.materializationStatus).toBe('ENQUEUED');
      expect(result.current.currentPage).toBe(3);

      // Save encounters 409 NOT_REVIEWABLE, server is APPLIED
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: { error: { code: 'NOT_REVIEWABLE', message: 'Job is now applied' } },
        },
      });

      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedJobDetail);

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch');
      });

      // Invariant: materializationStatus is cleared while currentPage is preserved across same-scope reconciliation (RED 1)
      expect(result.current.materializationStatus).toBeNull();
      expect(result.current.currentPage).toBe(3);
      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
    });

    it('should reconcile authoritative state to APPLIED when materialization receives 409 NOT_REVIEWABLE without generic error', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'NOT_REVIEWABLE',
              message: 'Chỉ có thể yêu cầu tạo artifact cho job đang ở trạng thái READY_FOR_REVIEW.',
            },
          },
        },
      });

      const appliedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockResolvedValueOnce(mockStaleComicJobDetail)
        .mockResolvedValueOnce(appliedJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let matResult: any;
      await act(async () => {
        matResult = await result.current.triggerMaterialization();
      });

      expect(matResult).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.jobDetail?.job.status).toBe(TranslationJobStatus.APPLIED);
      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.segments).toEqual([]);
      expect(result.current.previews).toBeNull();
    });

    it('should reconcile authoritative state and reflect INVARIANT_VIOLATION freshness when materialization returns REVISION_INVARIANT_VIOLATION', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'REVISION_INVARIANT_VIOLATION',
              message: 'Lỗi bất biến phiên bản: materializedRevision không thể lớn hơn reviewRevision.',
              meta: { reviewRevision: 1, materializedRevision: 2 },
            },
          },
        },
      });

      const invariantJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 1,
          materializedRevision: 2,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockResolvedValueOnce(mockStaleComicJobDetail)
        .mockResolvedValueOnce(invariantJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let matResult: any;
      await act(async () => {
        matResult = await result.current.triggerMaterialization();
      });

      expect(matResult).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.freshness.status).toBe('INVARIANT_VIOLATION');
      expect(result.current.freshness.isFresh).toBe(false);
      expect(result.current.freshness.needsMaterialize).toBe(false);
    });

    it('should correctly handle materialization lifecycle: ENQUEUED, ALREADY_ENQUEUED, and ALREADY_FRESH with causal assertion', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockStaleComicJobDetail);
      // 6a: ENQUEUED
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let res1: any;
      await act(async () => {
        res1 = await result.current.triggerMaterialization();
      });

      expect(res1?.status).toBe('ENQUEUED');
      expect(result.current.materializationStatus).toBe('ENQUEUED');

      // 6b: ALREADY_ENQUEUED
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ALREADY_ENQUEUED',
        targetRevision: 2,
      });

      let res2: any;
      await act(async () => {
        res2 = await result.current.triggerMaterialization();
      });

      expect(res2?.status).toBe('ALREADY_ENQUEUED');
      expect(result.current.materializationStatus).toBe('ALREADY_ENQUEUED');

      // 6c: ALREADY_FRESH
      const freshJobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 2,
          materializedRevision: 2,
        },
      };

      const refetchSpy = vi
        .spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockResolvedValue(freshJobDetail);

      const callsBefore = refetchSpy.mock.calls.length;

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ALREADY_FRESH',
        targetRevision: 2,
      });

      let res3: any;
      await act(async () => {
        res3 = await result.current.triggerMaterialization();
      });

      expect(res3?.status).toBe('ALREADY_FRESH');
      expect(result.current.materializationStatus).toBe('ALREADY_FRESH');
      // Invariant: Assert causal call count increment
      expect(refetchSpy.mock.calls.length).toBe(callsBefore + 1);
      // Invariant: Assert authoritative outcome
      expect(result.current.jobDetail?.job.materializedRevision).toBe(2);
      expect(result.current.freshness.status).toBe('FRESH');
      expect(result.current.freshness.isFresh).toBe(true);
    });
  });

  describe('8. Out-of-Order Responses & Job/Session Identity Isolation', () => {
    it('should not allow an out-of-order older detail response to downgrade reviewRevision', async () => {
      let resolveFirst: (val: any) => void;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      let resolveSecond: (val: any) => void;
      const secondPromise = new Promise((resolve) => {
        resolveSecond = resolve;
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Prepare refetch calls
      let callCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPromise as any;
        return secondPromise as any;
      });

      // Trigger two refetches concurrently
      act(() => {
        result.current.refetchDetail(); // Call 1 (older)
        result.current.refetchDetail(); // Call 2 (newer)
      });

      // Newer call (Call 2) resolves FIRST with reviewRevision: 5
      await act(async () => {
        resolveSecond!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 5, materializedRevision: 4 },
        });
      });

      expect(result.current.jobDetail?.job.reviewRevision).toBe(5);
      expect(result.current.freshness.needsMaterialize).toBe(true);

      // Older call (Call 1) resolves LATER with reviewRevision: 4
      await act(async () => {
        resolveFirst!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 4, materializedRevision: 4 },
        });
      });

      // Invariant: Older response MUST NOT downgrade reviewRevision back to 4 or clear needsMaterialize!
      expect(result.current.jobDetail?.job.reviewRevision).toBe(5);
      expect(result.current.freshness.needsMaterialize).toBe(true);
    });

    it('should isolate pending mutation / preview callback when jobId switches from Job A to Job B', async () => {
      let resolveSaveA: (val: any) => void;
      const savePromiseA = new Promise((_, reject) => {
        resolveSaveA = reject;
      });

      vi.spyOn(translationApi, 'updateTranslationSegment').mockReturnValue(savePromiseA as any);

      const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
        initialProps: { id: 'job-A' },
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Start save on Job A
      let savePromise: Promise<any>;
      act(() => {
        savePromise = result.current.saveSegment('seg-1', 'Text A');
      });

      // Switch to Job B
      const jobBDetail = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-B', status: TranslationJobStatus.READY_FOR_REVIEW },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobBDetail);

      rerender({ id: 'job-B' });

      await waitFor(() => {
        expect(result.current.jobDetail?.job.id).toBe('job-B');
      });

      // Now Job A save fails with 409 NOT_REVIEWABLE
      await act(async () => {
        resolveSaveA!({
          isAxiosError: true,
          response: {
            status: 409,
            data: { error: { code: 'NOT_REVIEWABLE', message: 'Job A is not reviewable' } },
          },
        });
        try {
          await savePromise!;
        } catch {
          // ignore
        }
      });

      // Invariant: Job A error MUST NOT mutate Job B workspace mode or conflict state!
      expect(result.current.jobDetail?.job.id).toBe('job-B');
      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
      expect(result.current.workspaceMode?.canEdit).toBe(true);
      expect(result.current.conflictState).toBeNull();
    });
  });

  describe('9. Status Transition Coordination during Refetch', () => {
    it('should dynamically load segments and previews when refetch transitions job from QUEUED to READY_FOR_REVIEW', async () => {
      const queuedJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          status: TranslationJobStatus.QUEUED,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(queuedJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.workspaceMode?.mode).toBe('PIPELINE_MONITOR');
      expect(translationApi.fetchTranslationJobPreviews).not.toHaveBeenCalled();

      // Clear calls, then transition to READY_FOR_REVIEW
      (translationApi.fetchTranslationJobSegments as any).mockClear();
      (translationApi.fetchTranslationJobPreviews as any).mockClear();

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);

      await act(async () => {
        await result.current.refetchDetail();
      });

      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
      expect(translationApi.fetchTranslationJobSegments).toHaveBeenCalled();
      expect(translationApi.fetchTranslationJobPreviews).toHaveBeenCalled();
      expect(result.current.segments.length).toBeGreaterThan(0);
    });
  });

  describe('10. Save Semantics (No Silent Auto-Verify)', () => {
    it('should NOT send isHumanVerified: true by default on normal text edit', async () => {
      const updatedSegment: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Bản dịch mới',
        isHumanVerified: false,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSegment);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch mới');
      });

      // Invariant: Default text save MUST NOT force isHumanVerified: true!
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        expect.not.objectContaining({ isHumanVerified: true }),
      );
    });

    it('should only send isHumanVerified: true when explicitly requested via options', async () => {
      const updatedSegment: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Bản dịch đã duyệt',
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSegment);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch đã duyệt', { isHumanVerified: true });
      });

      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        expect.objectContaining({ isHumanVerified: true }),
      );
    });
  });

  describe('11. Materialization Freshness Invariants', () => {
    it('should identify materializedRevision > reviewRevision as INVARIANT_VIOLATION and NOT fresh', async () => {
      const corruptJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 3,
          materializedRevision: 4, // INVARIANT VIOLATION
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(corruptJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.freshness.isFresh).toBe(false);
      expect(result.current.freshness.needsMaterialize).toBe(false);
      expect((result.current.freshness as any).status).toBe('INVARIANT_VIOLATION');
    });
  });

  describe('12. Out-of-Order & Cross-Job Scope Isolation (Hardening)', () => {
    it('should NOT purge Job B when Job A pending preview returns 403 after job switch', async () => {
      let rejectPreviewA: (err: any) => void;
      const previewAPromise = new Promise((_, reject) => {
        rejectPreviewA = reject;
      });

      let previewCallCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(() => {
        previewCallCount++;
        if (previewCallCount === 1) return previewAPromise as any;
        return Promise.resolve({
          sourceAssets: [{ url: 'https://cdn.example.com/b.jpg' }],
          resultAssets: [],
          workspaceRevision: 1,
        }) as any;
      });

      const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
        initialProps: { id: 'job-A' },
      });

      // Wait until preview A is requested
      await waitFor(() => {
        expect(previewCallCount).toBe(1);
      });

      // Switch to Job B before preview A returns
      const jobBDetail = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-B' },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobBDetail);

      rerender({ id: 'job-B' });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.jobDetail?.job.id).toBe('job-B');
      });

      // Preview A returns 403 now
      await act(async () => {
        rejectPreviewA!({
          isAxiosError: true,
          response: {
            status: 403,
            data: { error: { code: 'FORBIDDEN', message: 'Job A forbidden' } },
          },
        });
      });

      // Invariant: Job B must NOT be purged!
      expect(result.current.status).toBe('ready');
      expect(result.current.jobDetail?.job.id).toBe('job-B');
    });

    it('should keep workspace locked and data empty if an older in-flight request succeeds after 403 purge', async () => {
      // Start in 403 error state
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: { code: 'FORBIDDEN', message: 'Access denied' } },
        },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      // Simulate a lingering previous request returning 200 after purge
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockComicJobDetail);

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Invariant: Should remain locked in error state until user explicitly retries!
      expect(result.current.status).toBe('error');
      expect(result.current.jobDetail).toBeNull();
    });

    it('should preserve latest segments when older segments response arrives out of order', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveFirstSegments: (val: any) => void;
      const firstSegmentsPromise = new Promise((resolve) => {
        resolveFirstSegments = resolve;
      });

      let resolveSecondSegments: (val: any) => void;
      const secondSegmentsPromise = new Promise((resolve) => {
        resolveSecondSegments = resolve;
      });

      let segCall = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(() => {
        segCall++;
        if (segCall === 1) return firstSegmentsPromise as any;
        return secondSegmentsPromise as any;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);

      // Trigger first refetch (starts Call 1)
      act(() => {
        result.current.refetchDetail();
      });

      // Wait until segments Call 1 is in-flight
      await waitFor(() => {
        expect(segCall).toBe(1);
      });

      // Trigger second refetch (starts Call 2)
      act(() => {
        result.current.refetchDetail();
      });

      // Wait until segments Call 2 is in-flight
      await waitFor(() => {
        expect(segCall).toBe(2);
      });

      // Call 2 segments resolve FIRST with version 2
      await act(async () => {
        resolveSecondSegments!({
          data: [{ ...mockSegments[0], translatedText: 'Newer Text v2', version: 2 }],
          pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        });
      });

      expect(result.current.segments[0].translatedText).toBe('Newer Text v2');

      // Call 1 segments resolve LATER with version 1
      await act(async () => {
        resolveFirstSegments!({
          data: [{ ...mockSegments[0], translatedText: 'Older Text v1', version: 1 }],
          pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
          workspaceRevision: 1,
        });
      });

      // Invariant: Older segments response MUST NOT overwrite newer segments!
      expect(result.current.segments[0].translatedText).toBe('Newer Text v2');
    });

    it('should not restore previews if preview response arrives after leaving REVIEWABLE mode', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Prepare pending preview promise for refetch
      let resolvePendingPreview: (val: any) => void;
      const pendingPreviewPromise = new Promise((resolve) => {
        resolvePendingPreview = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockReturnValue(pendingPreviewPromise as any);

      // Trigger refetch while READY_FOR_REVIEW
      act(() => {
        result.current.refetchDetail();
      });

      // Transition to APPLIED via refetchDetail
      const appliedDetail = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedDetail);

      await act(async () => {
        await result.current.refetchDetail();
      });

      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.previews).toBeNull();
      expect(result.current.segments).toEqual([]);

      // Now pending preview from earlier reviewable state resolves
      await act(async () => {
        resolvePendingPreview!({
          sourceAssets: [{ url: 'https://cdn.example.com/stale.jpg' }],
          resultAssets: [],
          workspaceRevision: 1,
        });
      });

      // Invariant: Previews MUST remain null when leaving REVIEWABLE!
      expect(result.current.previews).toBeNull();
    });

    it('should recover workspace when retry succeeds, and remain locked when retry fails', async () => {
      // Start in error state
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: { code: 'FORBIDDEN', message: 'Access denied' } },
        },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      // Subtest 1: Retry still fails with 403
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 403,
          data: { error: { code: 'FORBIDDEN', message: 'Still denied' } },
        },
      });

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.jobDetail).toBeNull();

      // Subtest 2: Permissions granted, retry succeeds
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.status).toBe('ready');
      expect(result.current.error).toBeNull();
      expect(result.current.jobDetail?.job.id).toBe(mockJobId);
      expect(result.current.workspaceMode?.canEdit).toBe(true);
    });

    it('should correctly evaluate the entire revision freshness matrix including 0 and invalid invariants', () => {
      // (0, 0) -> FRESH
      const res00 = computeMaterializationFreshness(0, 0);
      expect(res00.status).toBe('FRESH');
      expect(res00.isFresh).toBe(true);
      expect(res00.needsMaterialize).toBe(false);

      // (0, 1) -> INVARIANT_VIOLATION
      const res01 = computeMaterializationFreshness(0, 1);
      expect(res01.status).toBe('INVARIANT_VIOLATION');
      expect(res01.isFresh).toBe(false);
      expect(res01.needsMaterialize).toBe(false);

      // (1, 0) -> STALE
      const res10 = computeMaterializationFreshness(1, 0);
      expect(res10.status).toBe('STALE');
      expect(res10.isFresh).toBe(false);
      expect(res10.needsMaterialize).toBe(true);

      // (3, 3) -> FRESH
      const res33 = computeMaterializationFreshness(3, 3);
      expect(res33.status).toBe('FRESH');
      expect(res33.isFresh).toBe(true);

      // (3, 4) -> INVARIANT_VIOLATION
      const res34 = computeMaterializationFreshness(3, 4);
      expect(res34.status).toBe('INVARIANT_VIOLATION');
      expect(res34.isFresh).toBe(false);

      // missing / null / negative -> UNKNOWN
      expect(computeMaterializationFreshness(null, 0).status).toBe('UNKNOWN');
      expect(computeMaterializationFreshness(-1, 0).status).toBe('UNKNOWN');
      expect(computeMaterializationFreshness(1, -1).status).toBe('UNKNOWN');
    });
  });

  describe('13. Interleaving Invariants & Concurrency Hardening (Round 3)', () => {
    it('1 & 11. should NOT treat in-flight detail refetch A as superseded when newer refetch B starts then FAILS', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveDetailA: (val: any) => void;
      const detailAPromise = new Promise((resolve) => {
        resolveDetailA = resolve;
      });

      let detailCall = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => {
        detailCall++;
        if (detailCall === 1) {
          // Refetch A hangs
          return detailAPromise as any;
        }
        // Refetch B fails with 500
        throw {
          isAxiosError: true,
          response: {
            status: 500,
            data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'DB error on B' } },
          },
        };
      });

      // Launch Refetch A
      let refetchAPromise: Promise<ReconciliationOutcome>;
      act(() => {
        refetchAPromise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Launch Refetch B which starts newer than A, but fails
      let refetchBOutcome: ReconciliationOutcome | undefined;
      await act(async () => {
        refetchBOutcome = await result.current.refetchDetail({ requirement: 'BEST_EFFORT' });
      });

      expect(refetchBOutcome).toBe('FAILED');

      // Now Refetch A returns valid 200 with reviewRevision: 2
      await act(async () => {
        resolveDetailA!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 2 },
        });
      });

      const outcomeA = await refetchAPromise!;
      // Invariant: Because B failed, A is NOT discarded as superseded by newer sync! A successfully applies!
      expect(outcomeA).toBe('SYNCED');
      expect(result.current.jobDetail?.job.reviewRevision).toBe(2);
    });

    it('2. should preserve conflict draft A when PATCH segment B returns 404', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // 1. Create conflict draft on seg-1
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 3 }, { ...mockSegments[0], id: 'seg-2', version: 1 }],
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Conflict on seg-1',
              currentVersion: 3,
              expectedVersion: 1,
            },
          },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft of Seg A');
      });

      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-1'].draftText).toBe('Draft of Seg A');

      // 2. Now user saves seg-2 which returns 404 NOT_FOUND
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 404,
          data: {
            error: {
              code: 'NOT_FOUND',
              message: 'Segment seg-2 not found on server',
            },
          },
        },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [mockSegments[0]],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      let saveBResult: any;
      await act(async () => {
        saveBResult = await result.current.saveSegment('seg-2', 'Text B');
      });

      expect(saveBResult.success).toBe(false);
      expect(['FAILED_BEFORE_COMMIT', 'RETRY_BLOCKED']).toContain(saveBResult.outcome);

      // Invariant: Draft on seg-1 MUST survive, NOT be wiped by segment 404!
      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-1'].draftText).toBe('Draft of Seg A');

      // Invariant: Segment 404 operation error MUST remain visible!
      expect(result.current.operationError?.code).toBe('NOT_FOUND');

      // Invariant: seg-2 was removed, seg-1 remains
      expect(result.current.segments.find((s) => s.id === 'seg-2')).toBeUndefined();
      expect(result.current.segments.find((s) => s.id === 'seg-1')).toBeDefined();
      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
    });

    it('3. should boundedly stop with STATE_DESYNCHRONIZED error when preview repeatedly returns 409', async () => {
      let previewCallCount = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
        previewCallCount++;
        throw {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: {
                code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
                message: 'Previews not available for current status',
              },
            },
          },
        };
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      // Invariant: Preview calls must be bounded (initial + 2 reconcile attempts = 3 calls max)
      expect(previewCallCount).toBeLessThanOrEqual(3);
      expect(result.current.fatalError?.code).toBe('STATE_DESYNCHRONIZED');
    });

    it('4. should NOT clear isMaterializing on Job B when stale materialization on Job A settles', async () => {
      let resolveMatA: (val: any) => void;
      const matPromiseA = new Promise((resolve) => {
        resolveMatA = resolve;
      });

      let resolveMatB: (val: any) => void;
      const matPromiseB = new Promise((resolve) => {
        resolveMatB = resolve;
      });

      let matCall = 0;
      vi.spyOn(translationApi, 'requestJobMaterialization').mockImplementation(async () => {
        matCall++;
        if (matCall === 1) return matPromiseA as any;
        return matPromiseB as any;
      });

      const jobADetail = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-A', reviewRevision: 2, materializedRevision: 1 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobADetail);

      const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
        initialProps: { id: 'job-A' },
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Start materialization on Job A
      act(() => {
        result.current.triggerMaterialization();
      });
      expect(result.current.isMaterializing).toBe(true);

      // Switch to Job B
      const jobBDetail = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-B', reviewRevision: 2, materializedRevision: 1 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobBDetail);

      rerender({ id: 'job-B' });

      await waitFor(() => {
        expect(result.current.jobDetail?.job.id).toBe('job-B');
      });

      // Start materialization on Job B
      let triggerPromiseB: Promise<any>;
      act(() => {
        triggerPromiseB = result.current.triggerMaterialization();
      });
      expect(result.current.isMaterializing).toBe(true);

      // Settle Job A materialization
      await act(async () => {
        resolveMatA!({
          status: 'ENQUEUED',
          targetRevision: 1,
        });
      });

      // Invariant: Settling Job A must NOT set Job B isMaterializing to false!
      expect(result.current.isMaterializing).toBe(true);

      // Now settle Job B materialization
      await act(async () => {
        resolveMatB!({
          status: 'ENQUEUED',
          targetRevision: 2,
        });
        await triggerPromiseB!;
      });
      expect(result.current.isMaterializing).toBe(false);
    });

    it('5. should NOT repopulate materializationStatus if old materialization settles after transitioning to APPLIED', async () => {
      let resolveMat: (val: any) => void;
      const matPromise = new Promise((resolve) => {
        resolveMat = resolve;
      });

      vi.spyOn(translationApi, 'requestJobMaterialization').mockReturnValue(matPromise as any);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Start materialization
      act(() => {
        result.current.triggerMaterialization();
      });

      // Server transitions to APPLIED
      const appliedJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, status: TranslationJobStatus.APPLIED },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(appliedJob);

      await act(async () => {
        await result.current.refetchDetail();
      });

      expect(result.current.workspaceMode?.mode).toBe('APPLIED');
      expect(result.current.materializationStatus).toBeNull();

      // Old materialization response arrives
      await act(async () => {
        resolveMat!({
          status: 'ENQUEUED',
          targetRevision: 1,
        });
      });

      // Invariant: Old materialization MUST NOT repopulate status after leaving REVIEWABLE!
      expect(result.current.materializationStatus).toBeNull();
    });

    it('6. should issue exactly ONE network request when triggerMaterialization is called twice in the same tick', async () => {
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      // Job needs materialize (reviewRevision 2 > materializedRevision 1)
      const staleJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 2, materializedRevision: 1 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(staleJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.freshness.needsMaterialize).toBe(true);
      });

      let res1: any;
      let res2: any;
      await act(async () => {
        const p1 = result.current.triggerMaterialization();
        const p2 = result.current.triggerMaterialization();
        [res1, res2] = await Promise.all([p1, p2]);
      });

      // Invariant: Synchronous atomic in-flight guard allows exactly ONE network request!
      expect(matSpy).toHaveBeenCalledTimes(1);
      expect(res1?.status).toBe('ENQUEUED');
      expect(res2).toBeNull();
    });

    it('7. should set operationError when child segments fetch fails on verification-only update with unchanged reviewRevision', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Server detail still has reviewRevision: 1 (verification-only update does not bump revision)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      // But child segments fetch fails
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Segments fetch failed' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'BEST_EFFORT' });
      });

      // Invariant: Child fetch failure MUST be surfaced via operationError!
      expect(result.current.operationError?.code).toBe('SEGMENTS_SYNC_FAILED');
    });

    it('8. should clear operationError when retry succeeds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Set an operation error via failed save
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Database save error' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Test text');
      });

      expect(result.current.operationError).not.toBeNull();

      // Now retry succeeds
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      await act(async () => {
        await result.current.retry();
      });

      // Invariant: Operation error MUST be cleared after retry!
      expect(result.current.operationError).toBeNull();
    });

    it('9. should only clear target conflict when clearConflict is called with targetSegmentId and no selection exists', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Seed conflicts for seg-1 and seg-2
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'Draft 1',
            retryBlocked: false,
          },
          'seg-2': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-2',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'Draft 2',
            retryBlocked: false,
          },
        });
      });

      // Deselect segment
      act(() => {
        result.current.setSelectedSegmentId(null);
      });

      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-2']).toBeDefined();

      // User closes conflict for seg-1
      act(() => {
        result.current.clearConflict('seg-1');
      });

      // Invariant: Only seg-1 conflict was cleared; seg-2 conflict MUST survive!
      expect(result.current.conflictStates['seg-1']).toBeUndefined();
      expect(result.current.conflictStates['seg-2']).toBeDefined();
      expect(result.current.conflictStates['seg-2'].draftText).toBe('Draft 2');

      // Calling clearConflict with no args and null selection is a safe no-op
      act(() => {
        result.current.clearConflict();
      });
      expect(result.current.conflictStates['seg-2']).toBeDefined();
    });
  });

  describe('14. Round 4 Hardening: Monotonic Versioning, Scoped Invalidation & Failure Boundaries', () => {
    it('1. should return SCOPE_INVALIDATED and outcome STATE_CHANGED when generation changes even if detail fetch returns 200 later', async () => {
      let resolveDetail1: (val: any) => void;
      const detailPromise1 = new Promise((resolve) => {
        resolveDetail1 = resolve;
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch detail 1 starts while on gen 1
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(() => detailPromise1 as any);

      let refetchPromise: Promise<any>;
      act(() => {
        refetchPromise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // A reconciliation occurs, bumping generation to gen 2
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 1 },
      });

      await act(async () => {
        await result.current.reconcileAuthoritativeWorkspace();
      });

      // Now the delayed detail 1 resolves with 200
      await act(async () => {
        resolveDetail1!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 2 },
        });
      });

      const outcome = await refetchPromise!;
      // Invariant: Because generation changed, outcome MUST be SCOPE_INVALIDATED, NOT SUPERSEDED_BY_SUCCESSFUL_SYNC!
      expect(outcome).toBe('SCOPE_INVALIDATED');
    });

    it('2. should NEVER replace local segment version N with response version < N when delayed PATCH arrives after newer refetch', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolvePatchOld: (val: any) => void;
      const patchOldPromise = new Promise((resolve) => {
        resolvePatchOld = resolve;
      });

      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(() => patchOldPromise as any);

      // Start Save A (aiming to save v2)
      let saveAPromise: Promise<any>;
      act(() => {
        saveAPromise = result.current.saveSegment('seg-1', 'Text v2');
      });

      // Meanwhile collaborator updates server segment to v3, and frontend refetches segments
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 3, translatedText: 'Collaborator text v3' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      } as any);

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Wait for segments promise to apply
      await waitFor(() => {
        expect(result.current.segments.find((s) => s.id === 'seg-1')?.version).toBe(3);
      });
      expect(result.current.segments.find((s) => s.id === 'seg-1')?.translatedText).toBe('Collaborator text v3');

      // Now the delayed Save A response arrives with version 2
      await act(async () => {
        resolvePatchOld!({
          ...mockSegments[0],
          translatedText: 'Stale Text v2',
          version: 2,
        });
      });

      // Invariant: Monotonic rule prevents overwriting version 3 with version 2!
      const segAfter = result.current.segments.find((s) => s.id === 'seg-1');
      expect(segAfter?.version).toBe(3);
      expect(segAfter?.translatedText).toBe('Collaborator text v3');
    });

    it('3. should fail closed with SAVED_SYNC_FAILED and reset selection when PATCH segment returns 404 and authoritative detail check fails', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // PATCH returns 404 (ambiguous: job might be gone or segment gone)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: { code: 'NOT_FOUND', message: 'Segment or job not found' } },
        },
      });

      // Authoritative check GET detail fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_ERROR', message: 'Database failure' } },
        },
      });

      let saveRes: any;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Updated text');
      });

      // Invariant: Fail closed with FAILED_BEFORE_COMMIT when commitState is REJECTED (canonical two-axis, no contradictory SAVED_SYNC_FAILED)
      expect(saveRes.success).toBe(false);
      expect(saveRes.commitState).toBe('REJECTED');
      expect(saveRes.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveRes.outcome).toBe('FAILED_BEFORE_COMMIT');

      // Invariant P2: Selection of transient 404 is preserved when authoritative check fails (not confirmed absent)
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Invariant: Freshness must be UNKNOWN because authoritative sync failed
      expect(result.current.freshness.status).toBe('UNKNOWN');
    });

    it('4. should NOT destroy user-owned conflict drafts during transient preview reconciliation until authoritative state is verified non-reviewable', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Create a conflict on seg-1
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: { code: 'VERSION_CONFLICT', currentVersion: 2, expectedVersion: 1 },
          },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'User Draft Text');
      });

      expect(result.current.conflictStates['seg-1']?.draftText).toBe('User Draft Text');

      // Transient preview reconciliation failure (e.g. GET detail 500)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'SERVER_ERROR', message: 'Temporary failure' } },
        },
      });

      await act(async () => {
        await result.current.reconcileAuthoritativeWorkspace();
      });

      // Invariant: Draft MUST NOT be wiped on transient failure!
      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('User Draft Text');
    });

    it('5. should drop older DB snapshot response even if its client request sequence is higher or arrived late', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveDetailOlderSnapshot: (val: any) => void;
      const olderSnapshotPromise = new Promise((resolve) => {
        resolveDetailOlderSnapshot = resolve;
      });

      // Request A (starts first)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(
        () => olderSnapshotPromise as any,
      );

      let reqAPromise: Promise<any>;
      act(() => {
        reqAPromise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Request B (starts second, resolves first with newer snapshot rev 2, mat 2)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 2, materializedRevision: 2 },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.jobDetail?.job.reviewRevision).toBe(2);
      expect(result.current.jobDetail?.job.materializedRevision).toBe(2);

      // Now Request A arrives with older snapshot (rev 2, mat 1)
      await act(async () => {
        resolveDetailOlderSnapshot!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, reviewRevision: 2, materializedRevision: 1 },
        });
      });

      const outcomeA = await reqAPromise!;
      // Invariant: Older DB snapshot is dropped with SUPERSEDED_BY_SUCCESSFUL_SYNC, not downgrading materializedRevision!
      expect(outcomeA).toBe('SUPERSEDED_BY_SUCCESSFUL_SYNC');
      expect(result.current.jobDetail?.job.materializedRevision).toBe(2);
    });

    it('6. should set segmentsSyncStatus to FAILED when verification refresh fails on unchanged reviewRevision', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.segmentsSyncStatus).toBe('SYNCED');

      // Refetch detail returns same reviewRevision (verification-only server change)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 1 },
      });

      // Segments refresh fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch segments' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: segmentsSyncStatus must be FAILED, not SYNCED!
      expect(result.current.segmentsSyncStatus).toBe('FAILED');
      expect(result.current.operationError?.code).toBe('SEGMENTS_SYNC_FAILED');
    });

    it('7. should fail-closed and return null immediately without making network call when triggerMaterialization is called on FRESH workspace', async () => {
      // Default mockComicJobDetail has reviewRevision: 1, materializedRevision: 1 (FRESH)
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.freshness.status).toBe('FRESH');

      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });

      // Invariant: Fail-closed gate blocks materialization when not STALE!
      expect(matRes).toBeNull();
      expect(matSpy).toHaveBeenCalledTimes(0);
      expect(result.current.isMaterializing).toBe(false);
    });

    it('8. should mark materializationStatus as obsolete (null) when reviewRevision changes after materialization request was enqueued for older revision', async () => {
      // Start in STALE state: reviewRevision 2, materializedRevision 1
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockStaleComicJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.freshness.status).toBe('STALE');

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationStatus).toBe('ENQUEUED');

      // Now user edits text and server bumps reviewRevision to 3
      const rev3Detail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 3, materializedRevision: 1 },
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        version: 2,
        translatedText: 'New edit rev 3',
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(rev3Detail);

      await act(async () => {
        await result.current.saveSegment('seg-1', 'New edit rev 3');
      });

      // Invariant: materializationStatus for rev 2 is obsolete and MUST be null in rev 3!
      expect(result.current.jobDetail?.job.reviewRevision).toBe(3);
      expect(result.current.materializationStatus).toBeNull();
    });

    it('9. should isolate operation errors: saving segment B success must not clear saving segment A error, and materialization success must not clear segmentsSyncError', async () => {
      // Start with STALE workspace
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockStaleComicJobDetail);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Save segment A encounters 422
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 422,
          data: { error: { code: 'VALIDATION_FAILED', message: 'Failed to save segment A' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft A');
      });

      expect(result.current.operationError?.code).toBe('VALIDATION_FAILED');

      // Now save segment B succeeds
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[1],
        version: 2,
        translatedText: 'Seg B ok',
      });

      await act(async () => {
        await result.current.saveSegment('seg-2', 'Seg B ok');
      });

      // Invariant: Error for segment A MUST remain in operationError!
      expect(result.current.operationError?.code).toBe('VALIDATION_FAILED');

      // Trigger segments sync failure
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'SEGMENTS_SYNC_FAILED', message: 'Failed' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      await waitFor(() => {
        expect(result.current.operationError?.code).toBe('SEGMENTS_SYNC_FAILED');
      });

      // Now trigger materialization (workspace is already STALE)
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValueOnce({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      // Invariant: Materialization success does NOT clear segmentsSyncError!
      expect(result.current.operationError?.code).toBe('SEGMENTS_SYNC_FAILED');
    });

    it('10. should record PREVIEWS_SYNC_FAILED when preview fetch encounters 500 network error', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Preview fetch fails with 500
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'PREVIEWS_FAIL', message: 'Preview server down' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: Preview 500 error is NOT swallowed silently!
      expect(result.current.operationError?.code).toBe('PREVIEWS_SYNC_FAILED');
    });

    it('11. should reset consecutive 409 counter when review revision changes so non-consecutive conflicts are not falsely aborted', async () => {
      let previewCalls = 0;
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
        previewCalls++;
        if (previewCalls === 1) {
          // Attempt 1 on rev 1
          throw {
            isAxiosError: true,
            response: {
              status: 409,
              data: { error: { code: 'NOT_REVIEWABLE', message: 'Not reviewable yet' } },
            },
          };
        }
        if (previewCalls === 2) {
          // Reconcile on rev 1 succeeds
          return { sourceAssets: [], resultAssets: [], workspaceRevision: 1 };
        }
        if (previewCalls === 3) {
          // 409 on rev 2 (should be attempt 1 of rev 2, NOT consecutive attempt 2 of rev 1)
          throw {
            isAxiosError: true,
            response: {
              status: 409,
              data: { error: { code: 'NOT_REVIEWABLE', message: 'Not reviewable yet' } },
            },
          };
        }
        // Reconcile on rev 2 succeeds
        return { sourceAssets: [], resultAssets: [], workspaceRevision: 1 };
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        // Initial load encounters 409 preview and reconciles
        expect(result.current.status).toBe('ready');
      });

      // Revision 1 had a preview 409 attempt that resolved. Now server moves to revision 2
      const rev2JobDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, reviewRevision: 2 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(rev2JobDetail);

      // Now refetch detail on revision 2. Preview returns 409 (1st attempt on rev 2)
      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: It should NOT falsely abort with STATE_DESYNCHRONIZED because the revision changed!
      expect(result.current.fatalError).toBeNull();
      expect(result.current.status).toBe('ready');
    });
  });

  describe('15. Round 5 Hardening: Authoritative Monotonic Workspace Snapshot & 5-Case Uncertainty Resolution', () => {
    it('FE-13: should trigger bounded coherence breaker (MAX_COHERENCE_RECONCILE_ATTEMPTS = 2) and set RECONCILIATION_REQUIRED mode when child segments workspaceRevision persistently mismatches detail', async () => {
      // Detail has workspaceRevision 2, but segments has workspaceRevision 1
      const mismatchDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mismatchDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      });

      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canPreview).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);
    });

    it('FE-14: should fail-closed with ZERO network calls when saveSegment is called on segment with pendingUnknownMutation or retryBlocked', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Save encounters network error 500 -> enters pendingUnknownMutations
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'NETWORK_TIMEOUT', message: 'Gateway timeout' } },
        },
      });

      const saveRes1 = await act(async () => {
        return await result.current.saveSegment('seg-1', 'Attempt text');
      });

      expect(saveRes1.commitState).toBe('UNKNOWN');
      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();

      // Clear spy to verify 0 network calls
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      updateSpy.mockClear();

      // Second save on same segment MUST fail-closed with 0 network calls
      let saveRes2: any;
      await act(async () => {
        saveRes2 = await result.current.saveSegment('seg-1', 'Attempt text 2');
      });

      expect(updateSpy).not.toHaveBeenCalled();
      expect(saveRes2.outcome).toBe('PENDING_UNKNOWN_CONFLICT');
      expect(saveRes2.reason).toBe('PENDING_UNKNOWN_MUTATION');

      // Now test orphan-locked (retryBlocked) segment
      act(() => {
        result.current.replaceConflictStates({
          'seg-2': {
            kind: 'SEGMENT_REMOVED',
            segmentId: 'seg-2',
            draftText: 'Draft removed',
            retryBlocked: true,
          },
        });
      });

      updateSpy.mockClear();
      let saveRes3: any;
      await act(async () => {
        saveRes3 = await result.current.saveSegment('seg-2', 'Trying removed seg');
      });

      expect(updateSpy).not.toHaveBeenCalled();
      expect(saveRes3.outcome).toBe('RETRY_BLOCKED');
      expect(saveRes3.reason).toBe('SEGMENT_REMOVED');
    });

    it('FE-15: should reject out-of-order mutation settlement when older operation arrives later', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveOp1: (val: any) => void;
      const op1Promise = new Promise((resolve) => {
        resolveOp1 = resolve;
      });

      // Op 1 hangs
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(() => op1Promise as any);

      act(() => {
        result.current.saveSegment('seg-1', 'Draft Op 1');
      });

      // Op 2 arrives and fails with VERSION_CONFLICT
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Conflict Op 2',
              meta: { currentVersion: 3, expectedVersion: 1 },
            },
          },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft Op 2');
      });

      expect(result.current.conflictStates['seg-1']?.draftText).toBe('Draft Op 2');

      // Now older Op 1 settles with 200 OK
      await act(async () => {
        resolveOp1!({
          ...mockSegments[0],
          version: 2,
          translatedText: 'Text Op 1',
        });
      });

      // Invariant: Older Op 1 MUST NOT wipe the newer conflict draft Op 2!
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('Draft Op 2');
    });

    it('FE-16: should detect Case 5 INVALID_VERSION_ORDER and lock workspace when server segment version regresses below expectedVersion', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Save on seg-1 with baseVersion 2 encounters 500 -> pending mutation with expectedVersion: 2
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_ERROR', message: 'Fail' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Text v3', { baseVersion: 2 });
      });

      expect(result.current.pendingUnknownMutations['seg-1']?.expectedVersion).toBe(2);

      // Coherent sync cycle arrives, but server seg-1 has version 1 (< expectedVersion 2)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 1 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: Case 5 triggers fatal desynchronized error and locks workspace
      await waitFor(() => {
        expect(result.current.status).toBe('error');
        expect(result.current.fatalError?.code).toBe('STATE_DESYNCHRONIZED');
        expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      });
    });

    it('FE-17: should validate Scope Identity (jobId/generation/session) BEFORE comparing workspaceRevision', async () => {
      // Job A has workspaceRevision 5
      const jobADetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-A', workspaceRevision: 5 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobADetail);

      const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
        initialProps: { id: 'job-A' },
      });

      await waitFor(() => {
        expect(result.current.jobDetail?.job.workspaceRevision).toBe(5);
      });

      // Switch to Job B which has workspaceRevision 1 (1 < 5)
      const jobBDetail: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: 'job-B', workspaceRevision: 1 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(jobBDetail);

      rerender({ id: 'job-B' });

      // Invariant: Job B response is NOT dropped because scope changed!
      await waitFor(() => {
        expect(result.current.jobDetail?.job.id).toBe('job-B');
        expect(result.current.jobDetail?.job.workspaceRevision).toBe(1);
      });
    });

    it('FE-18: should atomically clean up pending mutation, same-segment conflict, and same-operation error on Case 2 EFFECT_PRESENT', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // First create a conflict on seg-1 (reconciled to version 1 from expectedVersion 0)
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 1,
            expectedVersion: 0,
            draftText: 'Draft text',
            retryBlocked: false,
          },
        });
      });

      // Save encounters 500 -> registers pending mutation and operationError
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'ERR_TIMEOUT', message: 'Timeout' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Attempted commit', { baseVersion: 1 });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();
      expect(result.current.operationError).not.toBeNull();

      // Coherent sync cycle arrives: seg-1 committed on DB (version = 2, text = Attempted commit)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2, translatedText: 'Attempted commit' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: Case 2 atomically cleared pending mutation, same-segment conflict, and operationError
      await waitFor(() => {
        expect(result.current.pendingUnknownMutations['seg-1']).toBeUndefined();
        expect(result.current.conflictStates['seg-1']).toBeUndefined();
        expect(result.current.operationError).toBeNull();
      });
    });
  });

  describe('16. Round 6 Hardening: Final RED 0 Robustness & Regression Protection', () => {
    it('Round 6 P1-1: should preserve user conflict drafts and pending unknown mutations across user retry()', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // User has a draft from VERSION_CONFLICT
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'User Draft On Seg 1',
            retryBlocked: false,
          },
        });
      });

      expect(result.current.conflictStates['seg-1']?.draftText).toBe('User Draft On Seg 1');

      // Transient reconcile/detail error (e.g. 500)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'SERVER_ERROR', message: 'Transient 500' } },
        },
      });

      // User hits Retry button
      await act(async () => {
        await result.current.retry();
      });

      // Status becomes error due to transient 500
      expect(result.current.status).toBe('error');

      // Invariant P1-1: User draft MUST NOT be wiped on retry!
      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('User Draft On Seg 1');

      // Server recovers, user hits Retry again
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockComicJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      await act(async () => {
        await result.current.retry();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Draft is STILL preserved even when workspace recovers to ready!
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('User Draft On Seg 1');
    });

    it('Round 6 P1-2: should preserve user drafts when workspace transitions to COUNT_UNAVAILABLE', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // User has a conflict draft
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'Preserved Draft Across Mode Change',
            retryBlocked: false,
          },
        });
      });

      // Server detail returns READY_FOR_REVIEW but resultPageCount is null/0 (COUNT_UNAVAILABLE mode)
      const countUnavailableDetail: typeof mockComicJobDetail = {
        ...mockComicJobDetail,
        reviewSummary: {
          ...mockComicJobDetail.reviewSummary!,
          resultPageCount: 0,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(countUnavailableDetail);

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Mode changed to COUNT_UNAVAILABLE (not REVIEWABLE)
      expect(result.current.workspaceMode?.mode).toBe('COUNT_UNAVAILABLE');

      // Invariant P1-2: Server cache (segments) cleared, but user-owned conflict drafts MUST NOT be cleared!
      expect(result.current.segments).toEqual([]);
      expect(result.current.conflictStates['seg-1']).toBeDefined();
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('Preserved Draft Across Mode Change');
    });

    it('Round 6 P1-3: should return COMMITTED + RECONCILIATION_REQUIRED when PATCH succeeds but segments fetch fails with 500', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        translatedText: 'New text',
        version: 2,
      });

      // Detail fetch succeeds with bumped workspace revision 2
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });

      // Segments fetch fails with 500 (transient network or server crash)
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'INTERNAL_ERROR', message: 'Segments DB error' } },
        },
      });

      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'New text');
      });

      // Invariant P1-3: PATCH succeeded (COMMITTED) but segments are NOT coherent (RECONCILIATION_REQUIRED)
      // saveSegment MUST NEVER return SYNCED!
      expect(saveRes!.commitState).toBe('COMMITTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveRes!.success).toBe(false);
      expect(saveRes!.outcome).toBe('SAVED_SYNC_FAILED');
      expect(result.current.segmentsSyncStatus).toBe('FAILED');
    });

    it('Round 6 P1-4: should return REJECTED + RECONCILIATION_REQUIRED when saveSegment encounters 409 VERSION_CONFLICT', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // PATCH returns 409 VERSION_CONFLICT
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Phiên bản không khớp',
              meta: { currentVersion: 3, expectedVersion: 1 },
            },
          },
        },
      });

      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'My draft edit');
      });

      // Invariant P1-4: Local expectedVersion != server currentVersion -> workspaceState MUST be RECONCILIATION_REQUIRED!
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveRes!.reason).toBe('VERSION_CONFLICT');
      expect(saveRes!.success).toBe(false);
      expect(saveRes!.outcome).toBe('VERSION_CONFLICT');
      expect(saveRes!.conflict?.currentVersion).toBe(3);
      expect(saveRes!.conflict?.draftText).toBe('My draft edit');
    });

    it('Round 6 P1-5A: should preserve error of mutation B when older mutation A succeeds late', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveMutationA: (val: any) => void;
      const mutationAPromise = new Promise((resolve) => {
        resolveMutationA = resolve;
      });

      // Mutation A starts (deferred)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(() => mutationAPromise as any);

      let saveAPromise: Promise<SaveSegmentResult>;
      act(() => {
        saveAPromise = result.current.saveSegment('seg-1', 'Text A');
      });

      // Mutation B starts and FAILS with 500
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'FAIL_B', message: 'Mutation B failed' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Text B');
      });

      // Error B is recorded
      expect(result.current.operationError?.code).toBe('FAIL_B');

      // Now Mutation A resolves successfully late
      await act(async () => {
        resolveMutationA!({
          ...mockSegments[0],
          translatedText: 'Text A',
          version: 2,
        });
      });

      await saveAPromise!;

      // Invariant P1-5A: Mutation A is stale (mutationSeq A < mutationSeq B)
      // A MUST NOT call clearSegmentSaveError to clear B's error!
      expect(result.current.operationError?.code).toBe('FAIL_B');
    });

    it('Round 6 P1-5B: should NOT overwrite newer mutation B success with stale 409 from older mutation A', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let rejectMutationA: (err: any) => void;
      const mutationAPromise = new Promise((_, reject) => {
        rejectMutationA = reject;
      });

      // Mutation A starts (deferred)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(() => mutationAPromise as any);

      let saveAPromise: Promise<SaveSegmentResult>;
      act(() => {
        saveAPromise = result.current.saveSegment('seg-1', 'Text A');
      });

      // Mutation B starts and SUCCEEDS
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        translatedText: 'Text B',
        version: 2,
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Text B');
      });

      expect(result.current.conflictStates['seg-1']).toBeUndefined();
      expect(result.current.operationError).toBeNull();

      // Now Mutation A finishes late with 409 VERSION_CONFLICT
      await act(async () => {
        rejectMutationA!({
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Stale 409',
                meta: { currentVersion: 2, expectedVersion: 1 },
              },
            },
          },
        });
      });

      await saveAPromise!;

      // Invariant P1-5B: Mutation A is stale -> MUST NOT set stale conflict or error over B's success!
      expect(result.current.conflictStates['seg-1']).toBeUndefined();
      expect(result.current.operationError).toBeNull();
    });

    it('Round 6 P1-6: should classify HTTP 400 validation as REJECTED + VALIDATION without creating PendingUnknownMutation', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Backend returns deterministic 400 ANCHOR_TOPOLOGY_VIOLATION before commit
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: {
              code: 'ANCHOR_TOPOLOGY_VIOLATION',
              message: 'Anchor tags are misaligned with source tokens',
            },
          },
        },
      });

      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Malformed <anchor> text');
      });

      // Invariant P1-6: Deterministic reject happened BEFORE commit
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('SYNCED');
      expect(saveRes!.reason).toBe('VALIDATION');
      expect(saveRes!.backendCode).toBe('ANCHOR_TOPOLOGY_VIOLATION');
      expect(saveRes!.success).toBe(false);

      // Invariant P1-6: TUYỆT ĐỐI KHÔNG tạo PendingUnknownMutation!
      expect(result.current.pendingUnknownMutations['seg-1']).toBeUndefined();
      expect(result.current.operationError?.code).toBe('ANCHOR_TOPOLOGY_VIOLATION');
    });

    it('Round 6 P2-1: should dismiss only the active error channel without clearing unrelated error channels', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // 1. Trigger Segment Error on seg-1
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: { code: 'SEGMENT_ERROR_A', message: 'Segment A failed' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Invalid text');
      });

      expect(result.current.operationError?.code).toBe('SEGMENT_ERROR_A');

      // 2. Trigger Segments Sync Error (e.g. refetchDetail segment fetch 500)
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'SEGMENTS_SYNC_FAILED', message: 'Segments sync down' } },
        },
      });

      await act(async () => {
        await result.current.refetchDetail();
      });

      // Currently active error is SEGMENTS_SYNC_FAILED (latest)
      expect(result.current.operationError?.code).toBe('SEGMENTS_SYNC_FAILED');

      // 3. User clicks Dismiss on the currently displayed banner
      act(() => {
        result.current.clearOperationError();
      });

      // Invariant P2-1: SEGMENTS_SYNC_FAILED was dismissed, but SEGMENT_ERROR_A on seg-1 is NOT wiped!
      // When selectedSegmentId is seg-1, operationError re-surfaces SEGMENT_ERROR_A
      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });

      expect(result.current.operationError?.code).toBe('SEGMENT_ERROR_A');
    });

    it('Round 6 P2-2 & P2-3: should derive success strictly from commitState === COMMITTED && workspaceState === SYNCED, and resolve Case 2 when serverVersion > expectedVersion', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Verify two-axis builder contract:
      const resCommSynced = buildSaveSegmentResult('COMMITTED', 'SYNCED');
      expect(resCommSynced.success).toBe(true);
      expect(resCommSynced.outcome).toBe('SAVED_AND_SYNCED');

      const resCommRecon = buildSaveSegmentResult('COMMITTED', 'RECONCILIATION_REQUIRED');
      expect(resCommRecon.success).toBe(false);
      expect(resCommRecon.outcome).toBe('SAVED_SYNC_FAILED');

      const resRejRecon = buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED', { reason: 'VERSION_CONFLICT' });
      expect(resRejRecon.success).toBe(false);
      expect(resRejRecon.outcome).toBe('VERSION_CONFLICT');

      // Resolver Case 2: serverVersion = 7, expectedVersion = 5, text and verification match
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'NETWORK_ERROR', message: 'Connection timed out' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Matching Text', {
          baseVersion: 5,
          isHumanVerified: true,
        });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();
      expect(result.current.pendingUnknownMutations['seg-1'].expectedVersion).toBe(5);

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 8 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 7, translatedText: 'Matching Text', isHumanVerified: true }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 8,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: Case 2 clears pending unknown lock because desired effect is present, even if serverVersion > expectedVersion + 1!
      expect(result.current.pendingUnknownMutations['seg-1']).toBeUndefined();
    });
  });

  describe('17. Round 7 Hardening: Revision Ordering, Authoritative Gates, Safe Purge & Proof Isolation', () => {
    it('P1-1: Inverted sequence with newer revision applies rev 21 and child segments match rev 21', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Request 1: Started first, resolves later with newer revision 21
      let resolveDetail1: (val: any) => void;
      const detail1Promise = new Promise((resolve) => {
        resolveDetail1 = resolve;
      });

      // Request 2: Started second, resolves earlier with revision 20
      let resolveDetail2: (val: any) => void;
      const detail2Promise = new Promise((resolve) => {
        resolveDetail2 = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockImplementationOnce(() => detail1Promise as any)
        .mockImplementationOnce(() => detail2Promise as any);

      let refetch1Promise: Promise<ReconciliationOutcome>;
      let refetch2Promise: Promise<ReconciliationOutcome>;

      act(() => {
        refetch1Promise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });
      act(() => {
        refetch2Promise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Resolve Request 2 first (seq 2, rev 20)
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], translatedText: 'Rev 20 Seg' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 20,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 20,
      });

      await act(async () => {
        resolveDetail2!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 20 },
        });
      });
      await refetch2Promise!;

      expect(result.current.jobDetail?.job.workspaceRevision).toBe(20);
      expect(result.current.segments[0].translatedText).toBe('Rev 20 Seg');

      // Now Resolve Request 1 (seq 1, rev 21) - newer revision wins even though sequence is older!
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], translatedText: 'Rev 21 Seg' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 21,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 21,
      });

      await act(async () => {
        resolveDetail1!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 21 },
        });
      });
      await refetch1Promise!;

      expect(result.current.jobDetail?.job.workspaceRevision).toBe(21);
      expect(result.current.segments[0].translatedText).toBe('Rev 21 Seg');
    });

    it('P1-2: AuthoritativeSyncProof mode-awareness returns STATE_CHANGED when superseded by STATE_CHANGED proof', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch A starts (seq 1) with slow network
      let resolveDetailA: (val: any) => void;
      const detailAPromise = new Promise((resolve) => {
        resolveDetailA = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockImplementationOnce(() => detailAPromise as any);

      let refetchAPromise: Promise<ReconciliationOutcome>;
      act(() => {
        refetchAPromise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Refetch B starts (seq 2) and records STATE_CHANGED proof (status: APPLIED)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          workspaceRevision: 2,
          status: TranslationJobStatus.APPLIED,
        },
      });

      let outcomeB: ReconciliationOutcome;
      await act(async () => {
        outcomeB = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(outcomeB!).toBe('STATE_CHANGED');

      // Now Refetch A finishes (seq 1, rev 1). It is superseded by proof with outcome 'STATE_CHANGED'.
      let outcomeA: ReconciliationOutcome;
      await act(async () => {
        resolveDetailA!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 1 },
        });
        outcomeA = await refetchAPromise!;
      });

      // Invariant P1-2: Must return 'STATE_CHANGED', NEVER 'SUPERSEDED_BY_SUCCESSFUL_SYNC'!
      expect(outcomeA!).toBe('STATE_CHANGED');
    });

    it('P1-2: Segment fetch 500 prevents SUPERSEDED_BY_SUCCESSFUL_SYNC proof from being recorded', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch 1 detail 200, but segments 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 5 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'SYNC_FAILED' } } },
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Must fail with FAILED and lock gate with RECONCILIATION_REQUIRED
      expect(outcome!).toBe('FAILED');
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
    });

    it('P1-3: Concurrent transition to APPLIED returns COMMITTED + STATE_CHANGED', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // saveSegment succeeds on server with 200
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        version: 2,
        translatedText: 'Saved text',
      });

      // But follow-up refetchDetail finds job has transitioned to APPLIED
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          workspaceRevision: 2,
          status: TranslationJobStatus.APPLIED,
        },
      });

      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Saved text');
      });

      expect(saveResult!.commitState).toBe('COMMITTED');
      expect(saveResult!.workspaceState).toBe('STATE_CHANGED');
      expect(saveResult!.outcome).toBe('STATE_CHANGED');
      expect(saveResult!.success).toBe(false);
    });

    it('P1-4: Detail 200 + segments 500 locks workspace with 0 subsequent PATCH calls', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Trigger detail 200 + segments 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 6 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'INTERNAL_ERROR' } } },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Subsequent saveSegment call MUST fail-closed with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Blocked text');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveResult!.commitState).toBe('REJECTED');
      expect(saveResult!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveResult!.success).toBe(false);
    });

    it('P1-4: Revision mismatch breaker exhaustion locks workspace with 0 subsequent PATCH calls', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Detail returns rev 10, but segments persistently returns rev 9
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 10 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 9, // persistent mismatch
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Blocked edit');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveResult!.commitState).toBe('REJECTED');
      expect(saveResult!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });

    it('P1-5: Terminal draft purge on APPLIED/FAILED vs preservation on COUNT_UNAVAILABLE', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Create a pending unknown draft by simulating network timeout
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'NETWORK_TIMEOUT' } } },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft to preserve');
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();

      // Case A: COUNT_UNAVAILABLE (non-terminal transient degradation) preserves drafts
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        reviewSummary: {
          ...mockComicJobDetail.reviewSummary!,
          resultPageCount: 0,
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();

      // Case B: APPLIED (terminal state) purges all drafts
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          status: TranslationJobStatus.APPLIED,
          workspaceRevision: 2,
        },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.pendingUnknownMutations).toEqual({});
      expect(result.current.conflictState).toBeNull();
    });

    it('P2-1 & Lock 1: Canonical builder commitState === UNKNOWN takes precedence over workspaceState and produces COMMIT_UNKNOWN', () => {
      // UNKNOWN + SYNCED
      const res1 = buildSaveSegmentResult('UNKNOWN', 'SYNCED');
      expect(res1.commitState).toBe('UNKNOWN');
      expect(res1.outcome).toBe('COMMIT_UNKNOWN');
      expect(res1.success).toBe(false);

      // Lock 1: UNKNOWN + STATE_CHANGED MUST produce COMMIT_UNKNOWN, not STATE_CHANGED!
      const res2 = buildSaveSegmentResult('UNKNOWN', 'STATE_CHANGED');
      expect(res2.commitState).toBe('UNKNOWN');
      expect(res2.outcome).toBe('COMMIT_UNKNOWN');
      expect(res2.success).toBe(false);

      // UNKNOWN + ACCESS_REVOKED MUST produce COMMIT_UNKNOWN, not ACCESS_REVOKED!
      const res3 = buildSaveSegmentResult('UNKNOWN', 'ACCESS_REVOKED');
      expect(res3.commitState).toBe('UNKNOWN');
      expect(res3.outcome).toBe('COMMIT_UNKNOWN');
      expect(res3.success).toBe(false);

      // Exception: pending unknown conflict
      const res4 = buildSaveSegmentResult('UNKNOWN', 'RECONCILIATION_REQUIRED', {
        reason: 'PENDING_UNKNOWN_MUTATION',
      });
      expect(res4.outcome).toBe('PENDING_UNKNOWN_CONFLICT');

      // REJECTED + RECONCILIATION_REQUIRED yields FAILED_BEFORE_COMMIT, never SAVED_SYNC_FAILED
      const res5 = buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED');
      expect(res5.outcome).toBe('FAILED_BEFORE_COMMIT');

      // REJECTED + NOT_FOUND yields FAILED_BEFORE_COMMIT, never RETRY_BLOCKED
      const res6 = buildSaveSegmentResult('REJECTED', 'SYNCED', { reason: 'NOT_FOUND' });
      expect(res6.outcome).toBe('FAILED_BEFORE_COMMIT');

      // REJECTED + SEGMENT_REMOVED with retryBlocked yields RETRY_BLOCKED
      const res7 = buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED', {
        reason: 'SEGMENT_REMOVED',
        conflict: { kind: 'SEGMENT_REMOVED', segmentId: 'seg-1', retryBlocked: true },
      });
      expect(res7.outcome).toBe('RETRY_BLOCKED');
    });

    it('P2-2: Case 1 creates UNCOMMITTED_DRAFT, and clearConflict clears both conflict and same-segment operation error', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // saveSegment fails with 500 (packet loss before commit)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'TIMEOUT', message: 'Connection timeout' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Uncommitted draft text', { baseVersion: 1 });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();
      expect(result.current.operationError?.code).toBe('TIMEOUT');

      // Server segment still at version 1 (packet loss -> effect not present)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [{ ...mockSegments[0], version: 1 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Case 1 converts to UNCOMMITTED_DRAFT and clears transport error
      expect(result.current.conflictState?.kind).toBe('UNCOMMITTED_DRAFT');
      expect(result.current.conflictState?.draftText).toBe('Uncommitted draft text');
      expect(result.current.operationError).toBeNull(); // Transport error cleared

      // User clears conflict
      act(() => {
        result.current.clearConflict('seg-1');
      });

      // Invariant: Both conflict and same-segment error are cleared!
      expect(result.current.conflictState).toBeNull();
      expect(result.current.operationError).toBeNull();
    });

    it('P2-3: clearOperationError actively dismisses error from backing channel without clearing other channels', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Trigger segment save error (HTTP 400 validation error)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: { code: 'VALIDATION_FAILED', message: 'Invalid segment text' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', '');
      });

      expect(result.current.operationError?.code).toBe('VALIDATION_FAILED');

      // User calls clearOperationError('latest')
      act(() => {
        result.current.clearOperationError('latest');
      });

      expect(result.current.operationError).toBeNull();
    });

    it('Lock 2: Stale REVIEW_SYNCED proof is cleared and rejected when authoritative gate is closed', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Refetch 1 starts (seq 1) with slow network
      let resolveDetail1: (val: any) => void;
      const detail1Promise = new Promise((resolve) => {
        resolveDetail1 = resolve;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockImplementationOnce(() => detail1Promise as any);

      let refetch1Promise: Promise<ReconciliationOutcome>;
      act(() => {
        refetch1Promise = result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Now gate is closed due to segment fetch 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'SEGMENTS_500' } } },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');

      // Refetch 1 finishes late
      let outcome1: ReconciliationOutcome;
      await act(async () => {
        resolveDetail1!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 1 },
        });
        outcome1 = await refetch1Promise!;
      });

      // Invariant Lock 2: Gate is closed -> must return RECONCILIATION_REQUIRED, never SUPERSEDED_BY_SUCCESSFUL_SYNC
      expect(outcome1!).toBe('RECONCILIATION_REQUIRED');
    });

    it('Same-segment mutation race: Newer mutation B rejects older in-flight mutation A', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      let resolveMutationA: (val: any) => void;
      const mutationAPromise = new Promise((resolve) => {
        resolveMutationA = resolve;
      });

      // Mutation A starts (seq 1)
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(() => mutationAPromise as any);

      let saveAPromise: Promise<SaveSegmentResult>;
      act(() => {
        saveAPromise = result.current.saveSegment('seg-1', 'Text A');
      });

      // Mutation B starts (seq 2) and completes immediately
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        version: 2,
        translatedText: 'Text B',
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2, translatedText: 'Text B' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Text B');
      });

      expect(result.current.segments[0].translatedText).toBe('Text B');

      // Mutation A now resolves late with Text A
      await act(async () => {
        resolveMutationA!({
          ...mockSegments[0],
          version: 2,
          translatedText: 'Text A',
        });
      });
      await saveAPromise!;

      // Invariant: Mutation A is stale, does NOT overwrite Mutation B's Text B
      expect(result.current.segments[0].translatedText).toBe('Text B');
    });
  });

  describe('18. Round 8 Hardening: Coherence Invariants, 404 Lifecycle & Conflict Gates', () => {
    // 1. Existing REVIEW_SYNCED rev10 -> newer detail rev12 accepted -> BEST_EFFORT segments fail -> stale rev9 response không được trả SUPERSEDED_BY_SUCCESSFUL_SYNC
    it('1. Existing proof is invalidated when newer detail rev12 wins ordering, preventing stale rev9 from returning SUPERSEDED_BY_SUCCESSFUL_SYNC', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Establish coherent proof at rev 10
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 10 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 10,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 10,
      });

      const outcome10 = await act(async () => {
        return await result.current.refetchDetail();
      });
      expect(outcome10).toBe('SYNCED');

      // Now start Request A (deferred, returns rev 9)
      let resolveDetailA: (val: any) => void;
      const detailAPromise = new Promise((res) => {
        resolveDetailA = res;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail')
        .mockImplementationOnce(() => detailAPromise as any);

      let refetchAPromise: Promise<ReconciliationOutcome>;
      act(() => {
        refetchAPromise = result.current.refetchDetail();
      });

      // Request B arrives with newer revision 12, but segments fetch fails (500 under BEST_EFFORT)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 12 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'SYNC_FAILED' } } },
      });

      const outcomeB = await act(async () => {
        return await result.current.refetchDetail();
      });
      expect(outcomeB).toBe('FAILED');

      // Now resolve Request A with stale rev 9
      let outcomeA: ReconciliationOutcome;
      await act(async () => {
        resolveDetailA!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 9 },
        });
        outcomeA = await refetchAPromise!;
      });

      // Invariant Lock 1: Proof was cleared when rev 12 won ordering. Rev 9 MUST NOT be SUPERSEDED_BY_SUCCESSFUL_SYNC!
      expect(outcomeA!).toBe('RECONCILIATION_REQUIRED');
    });

    // 2. Existing proof -> accepted COUNT_UNAVAILABLE/uncoherent newer snapshot -> old proof không được tái sử dụng
    it('2. Existing proof is not reused when a newer COUNT_UNAVAILABLE snapshot is accepted', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Start Request A (deferred rev 1)
      let resolveDetailA: (val: any) => void;
      const detailAPromise = new Promise((res) => {
        resolveDetailA = res;
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(() => detailAPromise as any);

      let refetchAPromise: Promise<ReconciliationOutcome>;
      act(() => {
        refetchAPromise = result.current.refetchDetail();
      });

      // Newer detail B arrives with rev 2 but COUNT_UNAVAILABLE (0 resultPageCount)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
        reviewSummary: { ...mockComicJobDetail.reviewSummary, resultPageCount: 0 },
      });

      const outcomeB = await act(async () => {
        return await result.current.refetchDetail();
      });
      expect(outcomeB).toBe('RECONCILIATION_REQUIRED');

      // Now Request A completes with rev 1
      let outcomeA: ReconciliationOutcome;
      await act(async () => {
        resolveDetailA!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 1 },
        });
        outcomeA = await refetchAPromise!;
      });

      // Old proof was invalidated when rev 2 was accepted
      expect(outcomeA!).toBe('RECONCILIATION_REQUIRED');
    });

    // 3. PATCH 404 -> authoritative refetch returns RECONCILIATION_REQUIRED -> result phải là REJECTED + RECONCILIATION_REQUIRED, tuyệt đối không SYNCED
    it('3. PATCH 404 where authoritative refetch returns RECONCILIATION_REQUIRED maps to REJECTED + RECONCILIATION_REQUIRED, never SYNCED', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // saveSegment fails with 404
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: { error: { code: 'NOT_FOUND' } } },
      });

      // Authoritative refetch: detail 200 rev 2, but segments has revision mismatch (rev 1 != rev 2) across attempts -> RECONCILIATION_REQUIRED
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1, // Mismatch!
      });

      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Updated text');
      });

      // Invariant: Must return RECONCILIATION_REQUIRED, NEVER SYNCED!
      expect(saveResult!.commitState).toBe('REJECTED');
      expect(saveResult!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });

    // 4. PATCH 404 -> authoritative segments contains same segment -> no SEGMENT_REMOVED retryBlocked; subsequent save allowed
    it('4. PATCH 404 where authoritative segments still contains the segment does NOT orphan-lock and allows retry', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: { error: { code: 'NOT_FOUND' } } },
      });

      // Authoritative refetch proves segment is still present on server!
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments, // contains seg-1
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Updated text');
      });

      expect(saveResult!.commitState).toBe('REJECTED');
      expect(saveResult!.workspaceState).toBe('SYNCED');
      expect(saveResult!.conflict).toBeUndefined(); // No SEGMENT_REMOVED
      expect(result.current.conflictState).toBeNull();
      expect(result.current.segments.some((s) => s.id === 'seg-1')).toBe(true);

      // Subsequent save on seg-1 is allowed to execute and send PATCH
      let patchSent = false;
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementationOnce(async () => {
        patchSent = true;
        return { ...mockSegments[0], version: 2 };
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 3,
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'New text');
      });

      expect(patchSent).toBe(true);
    });

    // 5. PATCH 404 -> authoritative segments absent -> orphan lock confirmed with retryBlocked = true
    it('5. PATCH 404 where authoritative segments confirms segment absent creates SEGMENT_REMOVED with retryBlocked = true', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: { error: { code: 'NOT_FOUND' } } },
      });

      // Authoritative refetch confirms seg-1 is gone
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [mockSegments[1]], // only seg-2, seg-1 absent!
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let saveResult: SaveSegmentResult;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Updated text');
      });

      expect(saveResult!.commitState).toBe('REJECTED');
      expect(saveResult!.workspaceState).toBe('SYNCED');
      expect(saveResult!.conflict?.kind).toBe('SEGMENT_REMOVED');
      expect(saveResult!.conflict?.retryBlocked).toBe(true);
      expect(result.current.segments.some((s) => s.id === 'seg-1')).toBe(false);

      // Subsequent save on seg-1 is blocked with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let retryResult: SaveSegmentResult;
      await act(async () => {
        retryResult = await result.current.saveSegment('seg-1', 'Retry text');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(retryResult!.outcome).toBe('RETRY_BLOCKED');
    });

    // 6. Persistent preview revision mismatch on loadJobData across SAME workspaceRevision -> generations increase but budget preserved -> bounded attempts (2), no infinite reconciliation
    it('6. Persistent preview revision mismatch on loadJobData preserves budget across reconciles and trips breaker at attempt 2', async () => {
      // Setup: detail rev 5, segments rev 5, preview persistently rev 4
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 5 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 5,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 4, // Persistent mismatch!
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        // Breaker must trip and close gate, stopping infinite reconciliation
        expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
        expect(result.current.workspaceMode?.canEdit).toBe(false);
      });
    });

    // 7. Preview mismatch budget resets for a NEW workspaceRevision
    it('7. Preview mismatch budget resets when detail moves to a new workspaceRevision', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Detail rev 5 with preview rev 4 -> mismatch (attempt 1)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 5 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 5,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 4,
      });

      const outcome5 = await act(async () => {
        return await result.current.refetchDetail();
      });
      // P1 Unified Preview Fail-Close: Incoherence #1 closes gate immediately and returns STATE_CHANGED
      expect(outcome5).toBe('STATE_CHANGED');
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');

      // Now server advances to rev 6, but preview is rev 5 (1 mismatch for rev 6)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 6 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 6,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 5,
      });

      const outcome6 = await act(async () => {
        return await result.current.refetchDetail();
      });
      expect(outcome6).toBe('STATE_CHANGED');
      // Invariant: Budget was reset for rev 6, so attempt was 1 (< 2), closes gate fail-closed without fatal error
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.status).not.toBe('error');
    });

    // 8. Preview mismatch during refetchDetail -> returns STATE_CHANGED and closes gate, never silent SYNCED
    it('8. Preview mismatch during refetchDetail returns RECONCILIATION_REQUIRED, never silent SYNCED', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2, // Mismatch!
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail();
      });

      expect(outcome!).toBe('STATE_CHANGED');
      expect(outcome!).not.toBe('SYNCED');
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
    });

    // 9. Preview 500 during AUTHORITATIVE_REQUIRED refetchDetail -> no REVIEW_SYNCED proof, returns FAILED, closes gate fail-closed so subsequent save is rejected
    it('9. Preview 500 during AUTHORITATIVE_REQUIRED refetchDetail returns FAILED, closes gate fail-closed, and rejects subsequent save', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 4 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 4,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'CDN_ERROR' } } },
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(outcome!).toBe('FAILED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Subsequent save is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Text');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });

    // 10. PATCH 404 mutation race: Mutation A 404 deferred -> Mutation B success -> Mutation A late completion does not orphan lock or overwrite Mutation B
    it('10. PATCH 404 mutation race: Mutation A late completion does not orphan lock or overwrite Mutation B', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Mutation A starts and gets 404
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: { error: { code: 'NOT_FOUND' } } },
      });

      let resolveRefetchA: (val: any) => void;
      const refetchAPromise = new Promise((res) => {
        resolveRefetchA = res;
      });

      // Refetch for A is deferred
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(() => refetchAPromise as any);

      let saveAPromise: Promise<SaveSegmentResult>;
      act(() => {
        saveAPromise = result.current.saveSegment('seg-1', 'Draft A');
      });
      await act(async () => {
        await Promise.resolve();
      });

      // Mutation B starts (seq 2 on seg-1) and succeeds
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        version: 2,
        translatedText: 'Text B',
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2, translatedText: 'Text B' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let saveBResult: SaveSegmentResult;
      await act(async () => {
        saveBResult = await result.current.saveSegment('seg-1', 'Text B');
      });

      expect(saveBResult!.commitState).toBe('COMMITTED');
      expect(result.current.segments[0].translatedText).toBe('Text B');

      // Now Refetch A completes late with stale revision 1 (initiated before B)
      let saveAResult: SaveSegmentResult;
      await act(async () => {
        resolveRefetchA!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 1 },
        });
        saveAResult = await saveAPromise!;
      });

      // Invariant Lock 4: Mutation A is not current, returns SUPERSEDED_BY_NEWER_MUTATION, does NOT orphan-lock
      expect(saveAResult!.reason).toBe('SUPERSEDED_BY_NEWER_MUTATION');
      expect(result.current.conflictState).toBeNull();
      expect(result.current.segments[0].translatedText).toBe('Text B');
    });

    // 11. VERSION_CONFLICT -> immediate retry same segment before background reconcile -> zero PATCH (0 network calls); retry only allowed when reconciled to currentSeg.version
    it('11. VERSION_CONFLICT blocks immediate retry on same segment with 0 network calls until reconciled to exact authoritative version', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // saveSegment fails with 409 VERSION_CONFLICT
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Version mismatch',
              meta: { currentVersion: 2, expectedVersion: 1 },
              details: { currentVersion: 2, expectedVersion: 1 },
            },
          },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Draft text', { baseVersion: 1 });
      });

      expect(result.current.conflictState?.kind).toBe('VERSION_CONFLICT');

      // Immediate retry before reconcile completes: MUST be rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let retryResult: SaveSegmentResult;
      await act(async () => {
        retryResult = await result.current.saveSegment('seg-1', 'Draft text');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(retryResult!.commitState).toBe('REJECTED');
      expect(retryResult!.workspaceState).toBe('RECONCILIATION_REQUIRED');

      // Retry with forged baseVersion 999: still rejected with 0 network calls!
      await act(async () => {
        retryResult = await result.current.saveSegment('seg-1', 'Draft text', { baseVersion: 999 });
      });
      expect(patchSpy).not.toHaveBeenCalled();

      // Now reconcile completes and updates segment to version 2
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Now retry with exact baseVersion 2 is allowed to send PATCH!
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValueOnce({
        ...mockSegments[0],
        version: 3,
        translatedText: 'Draft text',
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 3, translatedText: 'Draft text' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 3,
      });

      let successSaveResult: SaveSegmentResult;
      await act(async () => {
        successSaveResult = await result.current.saveSegment('seg-1', 'Draft text', { baseVersion: 2 });
      });

      expect(successSaveResult!.commitState).toBe('COMMITTED');
    });

    // 12. COMMIT_UNKNOWN Case 1 & 3 resolution -> stale transport error (TIMEOUT) cleared, conflict state is canonical UI state
    it('12. COMMIT_UNKNOWN Case 1 and Case 3 resolutions clear stale transport error so conflict state is canonical UI state', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Test Case 3: Save fails with 500 TIMEOUT, server segment at version 3 (> expectedVersion 1) but different text
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: { code: 'TIMEOUT', message: 'Connection timeout' } },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'My draft text', { baseVersion: 1 });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();
      expect(result.current.operationError?.code).toBe('TIMEOUT');

      // Server segment is version 3 with other text (Case 3)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [{ ...mockSegments[0], version: 3, translatedText: 'Other writer text' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 3,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Case 3 converts to COMMIT_UNKNOWN_CONFLICT and clears TIMEOUT
      expect(result.current.conflictState?.kind).toBe('COMMIT_UNKNOWN_CONFLICT');
      expect(result.current.operationError).toBeNull();
    });

    // 13. Initial loadJobData with preview 500 -> locks workspace fail-closed (canEdit === false), zero PATCH on saveSegment, no REVIEW_SYNCED proof
    it('13. Initial loadJobData with preview 500 locks workspace fail-closed with zero PATCH on saveSegment and no proof', async () => {
      // Preview 500 on initial load
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'CDN_DOWN' } } },
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Invariant: Full Coherence requires preview; failure closes gate fail-closed!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // saveSegment is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Text');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });
  });

  describe('19. Round 9 Hardening & Closed-Gate Invariants (12 Regression Cases)', () => {
    // 1. Closed-gate recovery via refetchDetail() succeeds when gate was previously closed
    it('1. Closed-gate recovery via refetchDetail() establishes full coherence and reopens gate without aborting', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Close gate via preview 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'PREVIEW_FAIL' } } },
      });

      let failOutcome: ReconciliationOutcome;
      await act(async () => {
        failOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });
      expect(failOutcome!).toBe('FAILED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Now run recovery via refetchDetail under closed gate
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 3,
      });

      let recoveryOutcome: ReconciliationOutcome;
      await act(async () => {
        recoveryOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Implementation Lock 1: Closed-gate recovery succeeds and reopens gate!
      expect(recoveryOutcome!).toBe('SYNCED');
      expect(result.current.workspaceMode?.canEdit).toBe(true);
      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
    });

    // 2. Closed-gate recovery via loadJobData() (same-scope retry/reconcile) succeeds when gate was closed
    it('2. Closed-gate recovery via loadJobData() (retry) establishes full coherence and reopens gate', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Close gate
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'SEGMENT_500' } } },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Now retry() triggers loadJobData under closed gate
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 3,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 3,
      });

      await act(async () => {
        await result.current.retry();
      });

      // Implementation Lock 1: Recovery via loadJobData succeeds, gate reopens!
      expect(result.current.workspaceMode?.canEdit).toBe(true);
      expect(result.current.workspaceMode?.mode).toBe('REVIEWABLE');
    });

    // 3. Reconcile does NOT prematurely reopen gate at start; gate remains closed throughout in-flight recovery
    it('3. Reconcile does not prematurely reopen gate at start and keeps gate closed throughout recovery', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      let resolveDetail: (val: any) => void;
      const detailPromise = new Promise((res) => {
        resolveDetail = res;
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(() => detailPromise as any);

      // Start reconcile
      let reconcilePromise: Promise<void>;
      act(() => {
        reconcilePromise = result.current.reconcileAuthoritativeWorkspace();
      });

      // In-flight assertion: gate must be closed RECONCILIATION_REQUIRED, NOT open!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Save while reconcile is in flight: rejected fail-closed with 0 network calls!
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Text');
      });
      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');

      // Now resolve reconcile
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      await act(async () => {
        resolveDetail!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
        });
        await reconcilePromise!;
      });

      expect(result.current.workspaceMode?.canEdit).toBe(true);
    });

    // 4. Global gate blocks saveSegment() before checking pending VERSION_CONFLICT safe-retry logic
    it('4. Global gate blocks saveSegment() before checking pending VERSION_CONFLICT safe-retry logic', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Inject VERSION_CONFLICT with expectedVersion 1
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'Draft',
            retryBlocked: false,
          },
        });
      });

      // Segment local version is 1
      expect(result.current.segments[0].version).toBe(1);

      // Close global gate
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'ERROR' } } },
      });
      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Implementation Lock 2: Even with baseVersion 2, closed gate blocks with 0 network calls!
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Text', { baseVersion: 2 });
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });

    // 5. Canonical 409 VERSION_CONFLICT locks workspace: records outbound expectedVersion and closes gate
    it('5. Canonical 409 VERSION_CONFLICT records outbound expectedVersion and closes global gate immediately', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Conflict',
              meta: { currentVersion: 3, expectedVersion: 1 },
            },
          },
        },
      });

      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'My draft', { baseVersion: 1 });
      });

      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');

      // 1. Outbound expectedVersion recorded
      expect(result.current.conflictState?.kind).toBe('VERSION_CONFLICT');
      expect(result.current.conflictState?.expectedVersion).toBe(1);

      // 2. Global gate closed
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // 3. Subsequent save on any other segment is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let secondSaveRes: SaveSegmentResult;
      await act(async () => {
        secondSaveRes = await result.current.saveSegment('seg-2', 'Other');
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(secondSaveRes!.commitState).toBe('REJECTED');
      expect(secondSaveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
    });

    // 6. Authoritative finalization resolves VERSION_CONFLICT lock when serverSeg.version > attemptedExpectedVersion
    it('6. Authoritative finalization resolves VERSION_CONFLICT lock when serverSeg.version > attemptedExpectedVersion', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Trigger 409 on seg-1 with expectedVersion 1
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              meta: { currentVersion: 2, expectedVersion: 1 },
            },
          },
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'My draft', { baseVersion: 1 });
      });
      expect(result.current.conflictState?.kind).toBe('VERSION_CONFLICT');
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      // Authoritative recovery returns segment with version 2 (> 1)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2 }, mockSegments[1]],
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let syncOutcome: ReconciliationOutcome;
      await act(async () => {
        syncOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Implementation Lock 4: Lock is cleared (converted to uncommitted draft), proof is written, gate reopens!
      expect(syncOutcome!).toBe('SYNCED');
      expect(result.current.conflictStates['seg-1']?.kind).toBe('UNCOMMITTED_DRAFT');
      expect(result.current.conflictStates['seg-1']?.retryBlocked).toBe(false);
      expect(result.current.workspaceMode?.canEdit).toBe(true);
    });

    // 7. Authoritative finalization does NOT resolve VERSION_CONFLICT if serverSeg.version <= attemptedExpectedVersion
    it('7. Authoritative finalization does not resolve VERSION_CONFLICT if serverSeg.version <= attemptedExpectedVersion', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Conflict has expectedVersion 2
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 2,
            draftText: 'Draft',
            retryBlocked: false,
          },
        });
      });

      // Refetch detail returns segment with version 2 (<= 2)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [{ ...mockSegments[0], version: 2 }, mockSegments[1]],
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValueOnce({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let syncOutcome: ReconciliationOutcome;
      await act(async () => {
        syncOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Implementation Lock 4: Conflict remains unresolved, no proof, gate remains closed!
      expect(syncOutcome!).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.conflictStates['seg-1']?.kind).toBe('VERSION_CONFLICT');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
    });

    // 8. Disappeared segment during VERSION_CONFLICT recovery converts to confirmed SEGMENT_REMOVED and reopens valid segments
    it('8. Disappeared segment during VERSION_CONFLICT recovery converts to SEGMENT_REMOVED and reopens valid segments', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Conflict on seg-1
      act(() => {
        result.current.replaceConflictStates({
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 2,
            expectedVersion: 1,
            draftText: 'Draft seg 1',
            retryBlocked: false,
          },
        });
      });

      // Server returns segments list WITHOUT seg-1 (seg-1 deleted)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [mockSegments[1]], // only seg-2
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let syncOutcome: ReconciliationOutcome;
      await act(async () => {
        syncOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(syncOutcome!).toBe('SYNCED');
      // Converted to SEGMENT_REMOVED with draft preserved and retryBlocked: true
      expect(result.current.conflictStates['seg-1']?.kind).toBe('SEGMENT_REMOVED');
      expect(result.current.conflictStates['seg-1']?.draftText).toBe('Draft seg 1');
      expect(result.current.conflictStates['seg-1']?.retryBlocked).toBe(true);

      // Version lock removed: workspace gate opens for remaining valid segments
      expect(result.current.workspaceMode?.canEdit).toBe(true);
    });

    // 9. Ref-based triggerMaterialization fail-closed: rejects immediately with 0 network calls when gate closed or FRESH
    it('9. Ref-based triggerMaterialization rejects immediately with 0 network calls when gate is closed or FRESH', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');

      // 1. When workspace is FRESH: returns null with 0 network calls
      expect(result.current.freshness.status).toBe('FRESH');
      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();

      // 2. When gate is closed: returns null with 0 network calls
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockStaleComicJobDetail,
        job: { ...mockStaleComicJobDetail.job, workspaceRevision: 3 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'FAIL' } } },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });
      expect(result.current.workspaceMode?.canEdit).toBe(false);

      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();
    });

    // 10. In-flight recovery blocks save and materialize: deferred network promise verifies fail-closed while pending
    it('10. Defer network promise during recovery: saveSegment and triggerMaterialization are blocked with 0 network calls while recovery is pending', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // 409 triggers recovery
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              meta: { currentVersion: 2, expectedVersion: 1 },
            },
          },
        },
      });

      let resolveRecoveryDetail: (val: any) => void;
      const deferredDetailPromise = new Promise((res) => {
        resolveRecoveryDetail = res;
      });

      // Defer recovery network call
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(() => deferredDetailPromise as any);

      // Trigger saveSegment which receives 409 and starts deferred background recovery
      let saveRes409: SaveSegmentResult;
      await act(async () => {
        saveRes409 = await result.current.saveSegment('seg-1', 'Text 1', { baseVersion: 1 });
      });

      expect(saveRes409!.commitState).toBe('REJECTED');
      expect(saveRes409!.workspaceState).toBe('RECONCILIATION_REQUIRED');

      // WHILE RECOVERY IS STILL PENDING:
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');

      let concurrentSaveRes: SaveSegmentResult;
      let concurrentMatRes: any;
      await act(async () => {
        concurrentSaveRes = await result.current.saveSegment('seg-2', 'Text 2');
        concurrentMatRes = await result.current.triggerMaterialization();
      });

      // Both rejected fail-closed with ZERO network calls!
      expect(patchSpy).not.toHaveBeenCalled();
      expect(matSpy).not.toHaveBeenCalled();
      expect(concurrentSaveRes!.commitState).toBe('REJECTED');
      expect(concurrentSaveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(concurrentMatRes).toBeNull();

      // Now resolve the deferred recovery
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: [{ ...mockSegments[0], version: 2 }, mockSegments[1]],
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      await act(async () => {
        resolveRecoveryDetail!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
        });
      });

      // Recovery completes and gate opens!
      await waitFor(() => {
        expect(result.current.workspaceMode?.canEdit).toBe(true);
      });
      expect(result.current.conflictStates['seg-1']?.kind).toBe('UNCOMMITTED_DRAFT');
      expect(result.current.conflictStates['seg-1']?.retryBlocked).toBe(false);
    });

    // 11. Scope boundary vs chronology preservation: same-scope rev11 rejects rev10, new scope accepts rev1
    it('11. Chronology and Scope Boundary: same-scope rev11 drops delayed rev10 after retry, but new scope accepts rev1', async () => {
      // Half A: Same Scope - establish rev 11
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 11 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 11,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 11,
      });

      const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
        initialProps: { id: mockJobId },
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.jobDetail?.job.workspaceRevision).toBe(11);

      // Call retry() on same job
      // Delayed out-of-order response with revision 10 arrives
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 10 },
      });

      await act(async () => {
        await result.current.retry();
      });

      // Half A assertion: Same scope preserves watermark 11, drops rev 10!
      expect(result.current.jobDetail?.job.workspaceRevision).not.toBe(10);

      // Half B: New Scope - switch to new jobId
      const newJobId = 'job-comic-scope-2';
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, id: newJobId, workspaceRevision: 1 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 1,
      });

      rerender({ id: newJobId });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Half B assertion: New scope resets watermark to 0, accepts rev 1!
      expect(result.current.jobDetail?.job.id).toBe(newJobId);
      expect(result.current.jobDetail?.job.workspaceRevision).toBe(1);
    });

    // 12. Unified preview breaker: trips after 2 consecutive attempts within same revision, resets on revision advance
    it('12. Unified preview breaker trips after 2 attempts in same revision and resets on revision advance', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Attempt 1: Preview 409 NOT_REVIEWABLE triggers reconcile
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2, reviewRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: { code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' } } },
      });

      // Reconcile response for Attempt 1 also returns preview 409 (Attempt 2)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2, reviewRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: { code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' } } },
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Breaker trips on consecutive attempt 2: sets fatal error STATE_DESYNCHRONIZED
      expect(result.current.fatalError?.code).toBe('STATE_DESYNCHRONIZED');
      expect(result.current.status).toBe('error');
    });
  });

  describe('20. Round 10 Hardening: Full Coherence Fail-Closed Invariants & BEST_EFFORT Protection', () => {
    // 1. BEST_EFFORT + segments 500 => save/materialize 0 network
    it('1. BEST_EFFORT + segments 500 closes gate fail-closed: save and materialize issue 0 network calls', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current.workspaceMode?.canEdit).toBe(true);

      // BEST_EFFORT refetch accepts detail rev 2, but segments 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2, reviewRevision: 2, materializedRevision: 1 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: 'DB down' } } },
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail();
      });

      expect(outcome!).toBe('FAILED');
      // Gate MUST be closed fail-closed even under BEST_EFFORT!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Verify saveSegment() is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'New Draft');
      });
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(patchSpy).not.toHaveBeenCalled();

      // Verify triggerMaterialization() is rejected with 0 network calls
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');
      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();
    });

    // 2. BEST_EFFORT + preview 500 => save/materialize 0 network
    it('2. BEST_EFFORT + preview 500 closes gate fail-closed: save and materialize issue 0 network calls', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // BEST_EFFORT refetch accepts detail rev 2 and segments rev 2, but preview 500
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2, reviewRevision: 2, materializedRevision: 1 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: [{ ...mockSegments[0], version: 2, translatedText: 'Rev 2 Seg' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: 'Storage error' } } },
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail();
      });

      expect(outcome!).toBe('RECONCILIATION_REQUIRED');
      // Gate MUST be closed fail-closed even under BEST_EFFORT!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Verify saveSegment() is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'New Draft');
      });
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(patchSpy).not.toHaveBeenCalled();

      // Verify triggerMaterialization() is rejected with 0 network calls
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');
      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();
    });

    // 3. Segment revision mismatch attempt #1 with recursive detail deferred => materialize 0 network during pending
    it('3. Segment revision mismatch attempt #1 closes gate immediately: materialize and save issue 0 network calls while recursive recovery is pending', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Initial refetch detail rev 2
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: 2, reviewRevision: 2, materializedRevision: 1 },
      });
      // Segments returns rev 1 (mismatch attempt #1)
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValueOnce({
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      // Recursive refetchDetail() detail call is deferred
      let resolveRecursiveDetail: (val: any) => void;
      const recursiveDetailPromise = new Promise((res) => {
        resolveRecursiveDetail = res;
      });
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementationOnce(
        () => recursiveDetailPromise as any,
      );

      let refetchPromise: Promise<ReconciliationOutcome>;
      act(() => {
        refetchPromise = result.current.refetchDetail();
      });

      // Flush microtasks so refetchDetail reaches segments mismatch and calls recursive refetch
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Gate MUST already be fail-closed during the pending recursive recovery!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Verify triggerMaterialization() is blocked with 0 network calls
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');
      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();

      // Verify saveSegment() is blocked with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'Attempt text');
      });
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(saveRes!.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(patchSpy).not.toHaveBeenCalled();

      // Clean up deferred promise
      await act(async () => {
        resolveRecursiveDetail!({
          ...mockComicJobDetail,
          job: { ...mockComicJobDetail.job, workspaceRevision: 2 },
        });
      });
    });

    // 4. BEST_EFFORT invalid workspaceRevision => save/materialize 0 network
    it('4. BEST_EFFORT invalid workspaceRevision closes gate fail-closed: save and materialize issue 0 network calls', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Server returns invalid negative workspaceRevision under BEST_EFFORT
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce({
        ...mockComicJobDetail,
        job: { ...mockComicJobDetail.job, workspaceRevision: -5 },
      });

      let outcome: ReconciliationOutcome;
      await act(async () => {
        outcome = await result.current.refetchDetail();
      });

      expect(outcome!).toBe('FAILED');
      expect(result.current.status).toBe('error');
      expect(result.current.fatalError?.code).toBe('INVALID_WORKSPACE_REVISION');
      // Gate MUST be closed fail-closed even under BEST_EFFORT!
      expect(result.current.workspaceMode?.mode).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
      expect(result.current.workspaceMode?.canMaterialize).toBe(false);

      // Verify saveSegment() is rejected with 0 network calls
      const patchSpy = vi.spyOn(translationApi, 'updateTranslationSegment');
      let saveRes: SaveSegmentResult;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-1', 'New Draft');
      });
      expect(saveRes!.commitState).toBe('REJECTED');
      expect(patchSpy).not.toHaveBeenCalled();

      // Verify triggerMaterialization() is rejected with 0 network calls
      const matSpy = vi.spyOn(translationApi, 'requestJobMaterialization');
      let matRes: any;
      await act(async () => {
        matRes = await result.current.triggerMaterialization();
      });
      expect(matRes).toBeNull();
      expect(matSpy).not.toHaveBeenCalled();
    });
  });
});

