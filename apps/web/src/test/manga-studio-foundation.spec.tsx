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

    it('should set pageCount to null and isAvailable to false when resultPageCount is null (MUST NEVER fallback to 1 or OCR count)', async () => {
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

  describe('6. Non-Ready Pipeline Monitor State', () => {
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
  });

  describe('7. Error Handling: OCC VERSION_CONFLICT vs NOT_REVIEWABLE', () => {
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

  describe('8. Materialization Freshness & Shared Response Contract', () => {
    it('should reflect needsMaterialize when reviewRevision > materializedRevision', async () => {
      const staleJob: TranslationJobReviewDetailResponse = {
        ...mockComicJobDetail,
        job: {
          ...mockComicJobDetail.job,
          reviewRevision: 4,
          materializedRevision: 2,
        },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(staleJob);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      expect(result.current.freshness.isFresh).toBe(false);
      expect(result.current.freshness.needsMaterialize).toBe(true);
    });

    it('should handle ALREADY_FRESH response without creating fake rendering state', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ALREADY_FRESH',
        targetRevision: 1,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationStatus).toBe('ALREADY_FRESH');
      expect(result.current.freshness.needsMaterialize).toBe(false);
    });
  });

  describe('9. Segment Mutation & Revision Reconciliation', () => {
    it('should reconcile updated segment from response and refetch detail without manually incrementing reviewRevision', async () => {
      const updatedSegment: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Xin chào đã duyệt',
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSegment);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });

      // Spy on refetch
      const initialFetchCount = (translationApi.fetchTranslationJobDetail as any).mock.calls.length;

      let saveOk = false;
      await act(async () => {
        saveOk = await result.current.saveSegment('seg-1', 'Xin chào đã duyệt');
      });

      expect(saveOk).toBe(true);
      expect(result.current.segments[0].translatedText).toBe('Xin chào đã duyệt');
      expect(result.current.segments[0].isHumanVerified).toBe(true);
      expect(result.current.segments[0].version).toBe(2);

      // Must have called refetchTranslationJobDetail to sync authoritative server revision
      expect((translationApi.fetchTranslationJobDetail as any).mock.calls.length).toBeGreaterThan(initialFetchCount);
    });
  });
});
