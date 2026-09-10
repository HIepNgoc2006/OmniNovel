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

  const mockSegments: TranslationSegmentDto[] = [
    {
      id: 'seg-1',
      jobId: mockJobId,
      pageNumber: 1,
      anchorBlockId: null,
      sortOrder: 1,
      bboxX: 10,
      bboxY: 20,
      bboxW: 100,
      bboxH: 50,
      rawText: 'こんにちは',
      translatedText: 'Xin chào',
      confidence: 0.98,
      isHumanVerified: false,
      blockType: null,
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
      pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
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
      expect(saveOk).toBe(false);
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
      let saveResult = false;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Bản sửa mới');
      });

      expect(saveResult).toBe(false);
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

      let saveSuccess = true;
      await act(async () => {
        saveSuccess = await result.current.saveSegment('seg-1', 'Bản dịch của tôi');
      });

      expect(saveSuccess).toBe(false);
      expect(result.current.conflictState).toEqual({
        segmentId: 'seg-1',
        currentVersion: 3,
        expectedVersion: 1,
        draftText: 'Bản dịch của tôi',
      });
    });

    it('should catch 409 NOT_REVIEWABLE and transition workspace mode to non-reviewable', async () => {
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

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      await act(async () => {
        await result.current.saveSegment('seg-1', 'Bản dịch');
      });

      expect(result.current.workspaceMode?.canEdit).toBe(false);
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
      let savePromise: Promise<boolean>;
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
});
