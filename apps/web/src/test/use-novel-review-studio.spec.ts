import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
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

  it('4. saveSegment sends OCC payload and updates canonical segment on success', async () => {
    const detail = createMockJobDetail();
    const seg = createMockSegment('seg-1', 1, 'block-1', false);
    seg.rawText = 'Xin chào ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.translatedText = 'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.version = 1;

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [seg],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      workspaceRevision: 1,
    });

    const updateSpy = vi
      .spyOn(translationApi, 'updateTranslationSegment')
      .mockResolvedValue({
        ...seg,
        translatedText: 'Greetings ⟦S:0001⟧Lord Ainz⟦/S:0001⟧',
        version: 2,
        isHumanVerified: false,
      });

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.segments).toHaveLength(1);
    });

    // Set draft
    act(() => {
      result.current.setSegmentDraft(
        'seg-1',
        'Greetings ⟦S:0001⟧Lord Ainz⟦/S:0001⟧',
      );
    });
    expect(result.current.drafts['seg-1']).toBe(
      'Greetings ⟦S:0001⟧Lord Ainz⟦/S:0001⟧',
    );

    // Save segment
    await act(async () => {
      await result.current.saveSegment('seg-1');
    });

    // Invariant: Payload builder only sends translatedText and expectedVersion
    expect(updateSpy).toHaveBeenCalledWith(mockJobId, 'seg-1', {
      translatedText: 'Greetings ⟦S:0001⟧Lord Ainz⟦/S:0001⟧',
      expectedVersion: 1,
      isHumanVerified: false,
    });

    // Verify draft is cleared, segment is updated
    expect(result.current.drafts['seg-1']).toBeUndefined();
    expect(result.current.segments[0].translatedText).toBe(
      'Greetings ⟦S:0001⟧Lord Ainz⟦/S:0001⟧',
    );
    expect(result.current.segments[0].version).toBe(2);
  });

  it('5. saveSegment blocks invalid draft before PATCH (client UX gate)', async () => {
    const detail = createMockJobDetail();
    const seg = createMockSegment('seg-1', 1, 'block-1', false);
    seg.rawText = 'Xin chào ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.translatedText = 'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧';

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [seg],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      workspaceRevision: 1,
    });

    const updateSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.segments).toHaveLength(1);
    });

    // Missing closing tag ⟦/S:0001⟧
    act(() => {
      result.current.setSegmentDraft('seg-1', 'Hello ⟦S:0001⟧Ainz');
    });

    let saveResult: any;
    await act(async () => {
      saveResult = await result.current.saveSegment('seg-1');
    });
    expect(saveResult).toBe(false);

    // Client UX gate: PATCH count must be 0
    expect(updateSpy).not.toHaveBeenCalled();
    // Draft preserved
    expect(result.current.drafts['seg-1']).toBe('Hello ⟦S:0001⟧Ainz');
  });

  it('6. saveSegment handles 409 VERSION_CONFLICT: preserves draft, sets conflict state', async () => {
    const detail = createMockJobDetail();
    const seg = createMockSegment('seg-1', 1, 'block-1', false);
    seg.rawText = 'Xin chào ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.translatedText = 'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.version = 1;

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [seg],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      workspaceRevision: 1,
    });

    const conflictErr = {
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          code: 'VERSION_CONFLICT',
          message:
            'Xung đột phiên bản: server v2, expectedVersion v1',
        },
      },
    };
    vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue(
      conflictErr,
    );

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.segments).toHaveLength(1);
    });

    act(() => {
      result.current.setSegmentDraft(
        'seg-1',
        'My local change ⟦S:0001⟧Ainz⟦/S:0001⟧',
      );
    });

    await act(async () => {
      await result.current.saveSegment('seg-1');
    });

    // Invariant: Draft must NOT be lost on conflict
    expect(result.current.drafts['seg-1']).toBe(
      'My local change ⟦S:0001⟧Ainz⟦/S:0001⟧',
    );
    expect(result.current.conflictStates['seg-1']).toContain(
      'Xung đột phiên bản',
    );
    // Canonical text not overwritten
    expect(result.current.segments[0].translatedText).toBe(
      'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧',
    );
  });

  it('7. saveSegment handles 400 ANCHOR_TOPOLOGY_VIOLATION: preserves draft, sets error state', async () => {
    const detail = createMockJobDetail();
    const seg = createMockSegment('seg-1', 1, 'block-1', false);
    seg.rawText = 'Xin chào ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.translatedText = 'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧';
    seg.version = 1;

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [seg],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      workspaceRevision: 1,
    });

    const violationErr = {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          code: 'ANCHOR_TOPOLOGY_VIOLATION',
          message: 'Lỗi cấu trúc thẻ bảo vệ từ server authoritative',
        },
      },
    };
    vi.spyOn(translationApi, 'updateTranslationSegment').mockRejectedValue(
      violationErr,
    );

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.segments).toHaveLength(1);
    });

    act(() => {
      result.current.setSegmentDraft(
        'seg-1',
        'Client thinks this is valid ⟦S:0001⟧Ainz⟦/S:0001⟧',
      );
    });

    await act(async () => {
      await result.current.saveSegment('seg-1');
    });

    // Invariant: Draft preserved, error state recorded, canonical text not overwritten
    expect(result.current.drafts['seg-1']).toBe(
      'Client thinks this is valid ⟦S:0001⟧Ainz⟦/S:0001⟧',
    );
    expect(result.current.errorStates['seg-1']).toContain(
      'Lỗi cấu trúc thẻ bảo vệ',
    );
    expect(result.current.segments[0].translatedText).toBe(
      'Hello ⟦S:0001⟧Ainz⟦/S:0001⟧',
    );
  });

  it('8. toggleVerification sends expectedVersion and toggles isHumanVerified', async () => {
    const detail = createMockJobDetail();
    const seg = createMockSegment('seg-1', 1, 'block-1', false);
    seg.version = 2;

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [seg],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      workspaceRevision: 1,
    });

    const updateSpy = vi
      .spyOn(translationApi, 'updateTranslationSegment')
      .mockResolvedValue({
        ...seg,
        isHumanVerified: true,
        version: 3,
      });

    const { result } = renderHook(() =>
      useNovelReviewStudio(mockJobId, { initialJobDetail: detail }),
    );

    await waitFor(() => {
      expect(result.current.segments).toHaveLength(1);
    });

    await act(async () => {
      await result.current.toggleVerification('seg-1');
    });

    expect(updateSpy).toHaveBeenCalledWith(mockJobId, 'seg-1', {
      isHumanVerified: true,
      expectedVersion: 2,
    });

    expect(result.current.segments[0].isHumanVerified).toBe(true);
    expect(result.current.segments[0].version).toBe(3);
  });
});

