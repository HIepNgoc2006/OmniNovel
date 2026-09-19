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
    permissions: {
      canApply: true,
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

  const mockPageSegmentsResponse: TranslationJobSegmentsResponse = {
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

  describe('2. toggleSegmentVerification() & 4-State Matrix (Lock 2 & P1-2)', () => {
    it('clean unverified segment: sends ONLY isHumanVerified: true with expectedVersion', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [
          { ...mockSegments[0], isHumanVerified: true, version: 2 },
          mockSegments[1],
          mockSegments[2],
        ],
      });

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
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        expect.not.objectContaining({ translatedText: expect.anything() }),
      );
    });

    it('P1-2: dirty unverified draft: executes atomic save+verify sending BOTH draft text and isHumanVerified: true', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Bản dịch mới lưu và duyệt',
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User has dirty draft
      act(() => {
        result.current.setSegmentDraft('seg-1', 'Bản dịch mới lưu và duyệt');
      });
      expect(result.current.drafts['seg-1']).toBe('Bản dịch mới lưu và duyệt');

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [updatedSeg, mockSegments[1], mockSegments[2]],
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('SYNCED');
      // Must send both translatedText and isHumanVerified atomically
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-1',
        {
          translatedText: 'Bản dịch mới lưu và duyệt',
          isHumanVerified: true,
          expectedVersion: 1,
        },
      );
      // Post-commit cleanup: user draft is wiped on successful atomic save+verify!
      expect(result.current.drafts['seg-1']).toBeUndefined();
    });

    it('P1-2: dirty verified draft: executes atomic save+unverify sending BOTH draft text and isHumanVerified: false', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[1], // seg-2 is initially verified: true
        translatedText: 'Cảm ơn đã sửa',
        isHumanVerified: false,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User types draft on verified segment
      act(() => {
        result.current.setSegmentDraft('seg-2', 'Cảm ơn đã sửa');
      });

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [mockSegments[0], updatedSeg, mockSegments[2]],
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-2');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('SYNCED');
      expect(updateSpy).toHaveBeenCalledWith(
        mockJobId,
        'seg-2',
        {
          translatedText: 'Cảm ơn đã sửa',
          isHumanVerified: false,
          expectedVersion: 1,
        },
      );
      expect(result.current.drafts['seg-2']).toBeUndefined();
    });

    it('P1-2: dirty draft with empty string "" on non-empty canonical executes atomic save with "" and verify', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: '',
        isHumanVerified: true,
        version: 2,
      };
      const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-1', '');
      });

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [updatedSeg, mockSegments[1], mockSegments[2]],
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
          translatedText: '',
          isHumanVerified: true,
          expectedVersion: 1,
        },
      );
    });

    it('clean draft identical to canonical sends verification only without text payload', async () => {
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
  });

  describe('3. P1-1: Unconditional Full-DTO Post-Commit Coherence', () => {
    it('detects divergence when authoritative text mismatches committed text post-commit', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        translatedText: 'Xin chào bạn',
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Authoritative refetch returns null or different text due to concurrent writer
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        workspaceRevision: 2,
        data: [
          { ...mockSegments[0], translatedText: null, version: 3 },
          mockSegments[1],
          mockSegments[2],
        ],
      });

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveSegment('seg-1', 'Xin chào bạn', { baseVersion: 1 });
      });

      // P1-1: Full-DTO text divergence MUST trigger RECONCILIATION_REQUIRED
      expect(saveResult.commitState).toBe('COMMITTED');
      expect(saveResult.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveResult.success).toBe(false);
    });

    it('detects divergence when authoritative verification mismatches committed verification post-commit', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // Authoritative refetch returns isHumanVerified: false due to concurrent unverify
      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        workspaceRevision: 2,
        data: [
          { ...mockSegments[0], isHumanVerified: false, version: 3 },
          mockSegments[1],
          mockSegments[2],
        ],
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      // P1-1: Full-DTO verification divergence MUST trigger RECONCILIATION_REQUIRED
      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(toggleResult.success).toBe(false);
    });

    it('succeeds with SYNCED when authoritative full-DTO matches updated segment unconditionally', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
        ...mockPageSegmentsResponse,
        data: [
          updatedSeg,
          mockSegments[1],
          mockSegments[2],
        ],
      });

      let toggleResult: any;
      await act(async () => {
        toggleResult = await result.current.toggleSegmentVerification('seg-1');
      });

      expect(toggleResult.commitState).toBe('COMMITTED');
      expect(toggleResult.workspaceState).toBe('SYNCED');
      expect(toggleResult.success).toBe(true);
    });
  });

  describe('4. Verification-Only Draft Preservation', () => {
    it('preserves user drafts for other segments when toggling verification', async () => {
      const updatedSeg: TranslationSegmentDto = {
        ...mockSegments[0],
        isHumanVerified: true,
        version: 2,
      };
      vi.spyOn(translationApi, 'updateTranslationSegment').mockResolvedValue(updatedSeg);

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

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

  describe('5. Unknown Mutation Case 2 EFFECT_PRESENT', () => {
    it('records pending unknown mutation on network failure and resolves via Case 2 EFFECT_PRESENT', async () => {
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

      // Server refetch reveals the mutation did commit
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
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      expect(result.current.pendingUnknownMutations['seg-1']).toBeUndefined();
    });
  });

  describe('6. P2-1: Deterministic Bounded Traversal (No-Wrap)', () => {
    it('navigates next, prev, and next unverified strictly within bounds without wrapping', async () => {
      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSelectedSegmentId('seg-1');
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Next -> seg-2
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-2');

      // Next -> seg-3
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');

      // At end: clamped at seg-3 (bounded, no-wrap)
      act(() => {
        result.current.selectNextSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');

      // Prev -> seg-2
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-2');

      // Prev -> seg-1
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // At start: clamped at seg-1 (bounded, no-wrap)
      act(() => {
        result.current.selectPrevSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-1');

      // Next unverified from seg-1:
      // seg-2 is verified (true), seg-3 is unverified (false) -> selects seg-3!
      act(() => {
        result.current.selectNextUnverifiedSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');

      // P2-1 NO-WRAP: When already at seg-3 (last segment), selectNextUnverifiedSegment()
      // MUST NOT wrap around to seg-1. It stays at seg-3!
      act(() => {
        result.current.selectNextUnverifiedSegment();
      });
      expect(result.current.selectedSegmentId).toBe('seg-3');
    });
  });
});
