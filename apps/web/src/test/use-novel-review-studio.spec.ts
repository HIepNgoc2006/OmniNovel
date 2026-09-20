import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNovelReviewStudio } from '../lib/studio/use-novel-review-studio';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationSegmentDto,
  TranslationJobReviewDetailResponse,
} from '@omninovel/shared';

describe('useNovelReviewStudio Hook (#150 Task 2)', () => {
  const mockJobId = 'novel-job-456';

  const createMockJobDetail = (
    status: TranslationJobStatus = TranslationJobStatus.READY_FOR_REVIEW,
    mediaFormat: MediaFormat = MediaFormat.NOVEL,
  ): TranslationJobReviewDetailResponse => ({
    job: {
      id: mockJobId,
      status,
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
      workspaceRevision: 1,
    },
    context: {
      story: { id: 's1', title: 'Overlord Novel', slug: 'overlord-novel', mediaFormat },
      edition: { id: 'e1', editionName: 'Bản Dịch Việt', language: 'vi', isDefault: true },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Mở Đầu' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 4,
      verifiedCount: 1,
      pageCount: null,
      resultPageCount: null,
      blockCount: 2,
    },
    permissions: {
      canApply: false,
    },
  });

  const createMockSegment = (
    id: string,
    sortOrder: number,
    anchorBlockId: string,
    isHumanVerified = false,
  ): TranslationSegmentDto => ({
    id,
    jobId: mockJobId,
    pageNumber: null,
    anchorBlockId,
    sortOrder,
    bboxX: null,
    bboxY: null,
    bboxW: null,
    bboxH: null,
    rawText: `Source ${id}`,
    translatedText: `Dịch ${id}`,
    confidence: 0.98,
    isHumanVerified,
    version: 1,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'u1', username: 'editor', email: 'editor@omninovel.com', role: 'TRANSLATOR' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });
  });

  it('1. initializes with initialJobDetail and exhausts paginated segments loader', async () => {
    const detail = createMockJobDetail();

    // Mock paginated segments API: 2 pages of segments (limit=2 per page for test)
    const page1Segments = [
      createMockSegment('seg-2', 20, 'block-b', false),
      createMockSegment('seg-1', 10, 'block-a', true),
    ];
    const page2Segments = [
      createMockSegment('seg-4', 40, 'block-b', false),
      createMockSegment('seg-3', 30, 'block-a', false),
    ];

    const segSpy = vi
      .spyOn(translationApi, 'fetchTranslationJobSegments')
      .mockImplementation(async (_jobId, pageOrQuery) => {
        const page = typeof pageOrQuery === 'number' ? pageOrQuery : pageOrQuery?.page ?? 1;
        if (page === 1) {
          return {
            data: page1Segments,
            pagination: { page: 1, limit: 2, total: 4, totalPages: 2 },
            workspaceRevision: 1,
          };
        }
        return {
          data: page2Segments,
          pagination: { page: 2, limit: 2, total: 4, totalPages: 2 },
          workspaceRevision: 1,
        };
      });

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
      expect(result.current.segmentsLoading).toBe(false);
      expect(result.current.segments).toHaveLength(4);
    });

    // Verify 2 pages were requested to exhaust pagination
    expect(segSpy).toHaveBeenCalledTimes(2);

    // Verify deterministic sorting across full segments set
    expect(result.current.segments.map((s) => s.id)).toEqual([
      'seg-1',
      'seg-2',
      'seg-3',
      'seg-4',
    ]);

    // Verify grouped blocks
    expect(result.current.blocks).toHaveLength(2);
    expect(result.current.blocks[0].anchorBlockId).toBe('block-a');
    expect(result.current.blocks[0].segments.map((s) => s.id)).toEqual(['seg-1', 'seg-3']);
    expect(result.current.blocks[0].verifiedCount).toBe(1);

    expect(result.current.blocks[1].anchorBlockId).toBe('block-b');
    expect(result.current.blocks[1].segments.map((s) => s.id)).toEqual(['seg-2', 'seg-4']);
    expect(result.current.blocks[1].verifiedCount).toBe(0);
  });

  it('2. sets workspaceMode to UNSUPPORTED_FORMAT when mediaFormat is COMIC and does not fetch segments', async () => {
    const detail = createMockJobDetail(
      TranslationJobStatus.READY_FOR_REVIEW,
      MediaFormat.COMIC,
    );
    const segSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments');

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.workspaceMode?.mode).toBe('UNSUPPORTED_FORMAT');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
    });

    expect(segSpy).not.toHaveBeenCalled();
    expect(result.current.segments).toEqual([]);
  });

  it('3. does not fetch review segments when job is in PIPELINE_MONITOR state (e.g. TRANSLATING)', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.TRANSLATING);
    const segSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments');

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.workspaceMode?.mode).toBe('PIPELINE_MONITOR');
      expect(result.current.workspaceMode?.canEdit).toBe(false);
    });

    expect(segSpy).not.toHaveBeenCalled();
    expect(result.current.segments).toEqual([]);
  });
});
