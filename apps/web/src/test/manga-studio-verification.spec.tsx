import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMangaReviewStudio } from '../lib/studio/use-manga-review-studio';
import * as translationApi from '../lib/api/translation';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobPreviewsResponse,
  TranslationJobSegmentsResponse,
  ReviewAssetDto,
} from '@omninovel/shared';

vi.mock('../lib/auth/auth-context', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'user-1', email: 'tester@example.com' },
    isAuthenticated: true,
    isLoading: false,
  })),
}));

describe('Manga Review Studio RED 4 — Verification Interactions & Traversal', () => {
  const mockJobId = 'job-red4-test';

  const mockJobDetail: TranslationJobReviewDetailResponse = {
    job: {
      id: mockJobId,
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      promptVersion: 'v1',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: '2026-09-17T00:00:00Z',
      startedAt: '2026-09-17T00:00:00Z',
      heartbeatAt: '2026-09-17T00:00:00Z',
      completedAt: '2026-09-17T00:00:00Z',
      expiresAt: null,
      reviewRevision: 1,
      materializedRevision: 1,
      workspaceRevision: 1,
    },
    context: {
      story: {
        id: 'story-1',
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
        title: 'Chapter 1',
        chapterNumber: '1',
      },
      project: {
        id: 'proj-1',
        sourceLanguage: 'ja',
        targetLanguage: 'vi',
      },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 3,
      verifiedCount: 1,
      pageCount: 1,
      resultPageCount: 1,
      blockCount: null,
    },
  };

  const mockSegments: TranslationSegmentDto[] = [
    {
      id: 'seg-1',
      jobId: mockJobId,
      pageNumber: 1,
      sortOrder: 1,
      anchorBlockId: null,
      bboxX: 0,
      bboxY: 0,
      bboxW: 100,
      bboxH: 100,
      rawText: 'こんにちは',
      translatedText: 'Xin chào',
      confidence: 0.98,
      isHumanVerified: false,
      version: 1,
    },
    {
      id: 'seg-2',
      jobId: mockJobId,
      pageNumber: 1,
      sortOrder: 2,
      anchorBlockId: null,
      bboxX: 0,
      bboxY: 0,
      bboxW: 100,
      bboxH: 100,
      rawText: 'ありがとう',
      translatedText: 'Cảm ơn',
      confidence: 0.95,
      isHumanVerified: true,
      version: 1,
    },
    {
      id: 'seg-3',
      jobId: mockJobId,
      pageNumber: 1,
      sortOrder: 3,
      anchorBlockId: null,
      bboxX: 0,
      bboxY: 0,
      bboxW: 100,
      bboxH: 100,
      rawText: 'さようなら',
      translatedText: 'Tạm biệt',
      confidence: 0.92,
      isHumanVerified: false,
      version: 1,
    },
  ];

  const mockPreviews: TranslationJobPreviewsResponse = {
    sourceAssets: [
      {
        kind: 'SOURCE_MEDIA',
        id: 'asset-src-1',
        pageNumber: 1,
        width: 800,
        height: 1200,
        url: 'https://cdn.example.com/src-1.jpg',
      },
    ],
    resultAssets: [
      {
        kind: 'RESULT',
        pageNumber: 1,
        width: 800,
        height: 1200,
        url: 'https://cdn.example.com/res-1.jpg',
      },
    ],
    workspaceRevision: 1,
  };

  const mockPageSegmentsResponse = {
    data: mockSegments,
    pagination: {
      total: mockSegments.length,
      page: 1,
      limit: 50,
      totalPages: 1,
    },
    workspaceRevision: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockJobDetail);
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue(mockPreviews);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue(mockPageSegmentsResponse);
  });

  describe('1. saveSegment() Contract Locking (Lock 1)', () => {
    it('saveSegment() does not forward isHumanVerified and only sends translatedText and expectedVersion', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Xin chào bạn',
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      await act(async () => {
        // @ts-expect-error - testing that isHumanVerified is not accepted in SaveSegmentOptions
        await result.current.saveSegment('seg-1', 'Xin chào bạn', { isHumanVerified: true, baseVersion: 1 });
      });

      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        {
          translatedText: 'Xin chào bạn',
          expectedVersion: 1,
        },
      );
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        expect.not.objectContaining({ isHumanVerified: true }),
      );
    });
  });

  describe('2. toggleSegmentVerification() Core & Dirty Detection (Lock 2)', () => {
    it('allows verifying when no draft key exists in drafts (hasDraft is false)', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Authoritative segments after mutation return updated seg-1
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [
          { ...mockSegments[0], isHumanVerified: true, version: 2 },
          mockSegments[1],
          mockSegments[2],
        ],
      } as any);

      // drafts is empty; seg-1 has canonical text 'Xin chào'
      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('SYNCED');
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        {
          isHumanVerified: true,
          expectedVersion: 1,
        },
      );
    });

    it('rejects with reason DRAFT_DIRTY with 0 network calls when draft is dirty', async () => {
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User enters draft for seg-1
      act(() => {
        result.current.setSegmentDraft('seg-1', 'Bản dịch đang chỉnh sửa dở dang');
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('REJECTED');
      expect(toggleResult.reason).toBe('DRAFT_DIRTY');
      expect(toggleResult.error?.code).toBe('DRAFT_DIRTY');
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('rejects with DRAFT_DIRTY when draft is empty string "" and canonical text is non-empty', async () => {
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Explicit empty string draft
      act(() => {
        result.current.setSegmentDraft('seg-1', '');
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('REJECTED');
      expect(toggleResult.reason).toBe('DRAFT_DIRTY');
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('allows toggling verification when draft exists but is identical to canonical text', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-1', 'Xin chào  '); // identical when trimmed
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        {
          isHumanVerified: true,
          expectedVersion: 1,
        },
      );
    });

    it('toggles verified segment (isHumanVerified: true) to unverified (isHumanVerified: false)', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[1], // seg-2 is already verified
        isHumanVerified: false,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-2');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-2',
        {
          isHumanVerified: false,
          expectedVersion: 1,
        },
      );
    });
  });

  describe('3. Verification-Only Draft Preservation', () => {
    it('preserves user drafts for other segments when toggling verification', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User has a draft on seg-3
      act(() => {
        result.current.setSegmentDraft('seg-3', 'Draft for segment 3');
      });

      await act(async () => {
        await result.current.toggleSegmentVerification('seg-1');
      });

      // seg-3 draft MUST remain intact!
      expect(result.current.drafts['seg-3']).toBe('Draft for segment 3');
    });
  });

  describe('4. Exact Null Coherence & Unknown Mutation Reconciliation', () => {
    it('matches exact null coherence for verification during authoritative reconcile', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Authoritative detail returns seg-1 with isHumanVerified: true on refetch
      const authDetail: TranslationJobReviewDetailResponse = {
        ...mockJobDetail,
        job: { ...mockJobDetail.job, reviewRevision: 2, workspaceRevision: 2 },
        reviewSummary: { ...mockJobDetail.reviewSummary, verifiedCount: 2 },
      };
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(authDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
        ...mockPreviews,
        workspaceRevision: 2,
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        workspaceRevision: 2,
        data: [
          { ...mockSegments[0], isHumanVerified: true, version: 2 },
          mockSegments[1],
          mockSegments[2],
        ],
      } as any);

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('SYNCED');
    });

    it('records pending unknown mutation on network failure and resolves via Case 2 EFFECT_PRESENT', async () => {
      // Simulate network failure on updateTranslationSegment
      vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue(new Error('Network timeout'));

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('UNKNOWN');
      expect(toggleResult.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(result.current.pendingUnknownMutations['seg-1']).toBeDefined();
      expect(result.current.pendingUnknownMutations['seg-1'].attemptedVerification).toBe(true);
      expect(result.current.pendingUnknownMutations['seg-1'].attemptedText).toBeUndefined();

      // Now server refetch reveals the mutation did commit (version 2, isHumanVerified: true)
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
        ...mockJobDetail,
        job: { ...mockJobDetail.job, workspaceRevision: 2, reviewRevision: 2 },
      });
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        workspaceRevision: 2,
        data: [
          { ...mockSegments[0], isHumanVerified: true, version: 2 },
          mockSegments[1],
          mockSegments[2],
        ],
      } as any);

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Pending unknown mutation should be resolved and cleared!
      expect(result.current.pendingUnknownMutations['seg-1']).toBeUndefined();
    });
  });

  describe('5. Bounded Traversal Helpers', () => {
    it('navigates next, prev, and next unverified segments within bounds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Initially select seg-1
      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Next segment -> seg-2
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-2');

      // Next segment -> seg-3
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');

      // Next segment at end -> bounded, remains seg-3
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');

      // Prev segment -> seg-2
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-2');

      // Prev segment -> seg-1
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Prev segment at start -> bounded, remains seg-1
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Next unverified segment from seg-1:
      // seg-2 is verified (true), seg-3 is unverified (false) -> selects seg-3!
      act(() => {
        result.current.selectNextUnverifiedSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');
    });
  });

  describe('6. Authoritative reviewSummary & verifyingSegmentIds', () => {
    it('exposes authoritative reviewSummary from jobDetail and tracks verifyingSegmentIds', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      expect(result.current.reviewSummary).toEqual({
        segmentCount: 3,
        verifiedCount: 1,
        pageCount: 1,
        resultPageCount: 1,
        blockCount: null,
      });

      expect(result.current.verifyingSegmentIds).toBeDefined();
      expect(result.current.verifyingSegmentIds['seg-1']).toBeFalsy();
    });
  });
});
