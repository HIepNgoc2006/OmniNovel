import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import MangaStudioJobPage from '../app/(site)/(studio)/studio/ai/jobs/[jobId]/page';
import * as studioHook from '../lib/studio/use-manga-review-studio';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationSegmentDto,
  ReviewAssetDto,
} from '@omninovel/shared';

vi.mock('../lib/studio/use-manga-review-studio');

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams('page=1'),
  usePathname: () => '/studio/ai/jobs/job-route-test-123',
}));

describe('MangaStudioJobPage Route Component (#149 RED 0)', () => {
  const mockJobId = 'job-route-test-123';
  const mockParams = Promise.resolve({ jobId: mockJobId });

  const mockDefaultSegments: TranslationSegmentDto[] = [
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
      rawText: 'ヤッホー',
      translatedText: 'Yoohoo',
      confidence: 0.99,
      isHumanVerified: false,
      version: 1,
    },
  ];

  const defaultMockReturn: studioHook.UseMangaReviewStudioReturn = {
    status: 'ready',
    jobDetail: {
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
        workspaceRevision: 1,
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
        verifiedCount: 0,
        pageCount: 1,
        resultPageCount: 3,
        blockCount: null,
      },
    },
    segments: mockDefaultSegments,
    segmentsSyncStatus: 'SYNCED',
    previews: null,
    workspaceMode: {
      mode: 'REVIEWABLE',
      canPreview: true,
      canEdit: true,
      canMaterialize: true,
      status: TranslationJobStatus.READY_FOR_REVIEW,
    },
    pageCountInfo: { pageCount: 3, isAvailable: true },
    freshness: { isFresh: true, needsMaterialize: false, status: 'FRESH' },
    isGateClosed: false,
    previewWindow: null,
    previewWindowLoading: false,
    previewWindowError: null,
    previewWindowGeneration: 0,
    pageSegments: mockDefaultSegments,
    pageSegmentsPagination: null,
    pageSegmentsLoading: false,
    pageSegmentsError: null,
    currentPage: 1,
    setCurrentPage: vi.fn(),
    goToPage: vi.fn(),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    retryPreviewWindow: vi.fn(),
    retryPageSegments: vi.fn(),
    goToPageSegmentsPage: vi.fn(),
    selectedSegmentId: null,
    setSelectedSegmentId: vi.fn(),
    conflictState: null,
    conflictStates: {},
    pendingUnknownMutations: {},
    clearConflict: vi.fn(),
    replaceConflictStates: vi.fn(),
    drafts: {},
    setSegmentDraft: vi.fn(),
    discardSegmentDraft: vi.fn(),
    savingSegmentIds: {},
    verifyingSegmentIds: {},
    reviewSummary: { segmentCount: 1, verifiedCount: 0, pageCount: 1, resultPageCount: 3, blockCount: null },
    toggleSegmentVerification: vi.fn().mockResolvedValue({
      success: true,
      outcome: 'SAVED_AND_SYNCED',
      commitState: 'COMMITTED',
      workspaceState: 'SYNCED',
    }),
    selectNextSegment: vi.fn(),
    selectPrevSegment: vi.fn(),
    selectNextUnverifiedSegment: vi.fn(),
    saveSegment: vi.fn().mockResolvedValue({
      success: true,
      outcome: 'SAVED_AND_SYNCED',
      commitState: 'COMMITTED',
      workspaceState: 'SYNCED',
    }),
    loadServerVersion: vi.fn().mockResolvedValue(true),
    segmentSaveErrors: {},
    triggerMaterialization: vi.fn(),
    materializationStatus: null,
    isMaterializing: false,
    materializationLifecycle: {
      phase: 'IDLE',
      targetRevision: null,
      requestStatus: null,
      pollAttempts: 0,
      lastError: null,
    },
    recheckMaterialization: vi.fn().mockResolvedValue(true),
    error: null,
    fatalError: null,
    operationError: null,
    clearOperationError: vi.fn(),
    refetchDetail: vi.fn(),
    reconcileAuthoritativeWorkspace: vi.fn(),
    retry: vi.fn(),
    // RED 6 Realtime & Cancel Protocol
    isSocketConnected: true,
    subscriptionState: 'subscribed',
    cancelJob: vi.fn().mockResolvedValue(true),
    isCanceling: false,
    cancelError: null,
    canCancel: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders COUNT_UNAVAILABLE view with retry button and does NOT render READY shell', async () => {
    const refetchSpy = vi.fn();
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      workspaceMode: {
        mode: 'COUNT_UNAVAILABLE',
        canPreview: false,
        canEdit: false,
        canMaterialize: false,
        message: 'Chưa có thông tin số trang kết xuất hợp lệ từ máy chủ.',
      },
      pageCountInfo: { pageCount: null, isAvailable: false },
      refetchDetail: refetchSpy,
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Số Trang Chưa Sẵn Sàng')).toBeDefined();
    expect(screen.getByText('Dữ Liệu Kết Xuất Chưa Hoàn Tất')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();

    // Click retry button
    const retryBtn = screen.getByText('Tải Lại Dữ Liệu');
    fireEvent.click(retryBtn);
    expect(refetchSpy).toHaveBeenCalled();
  });

  it('renders TERMINAL_STATE view for FAILED job and does NOT show in-progress waiting bar', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      jobDetail: {
        ...defaultMockReturn.jobDetail!,
        job: { ...defaultMockReturn.jobDetail!.job, status: TranslationJobStatus.FAILED },
      },
      workspaceMode: {
        mode: 'TERMINAL_STATE',
        canPreview: false,
        canEdit: false,
        canMaterialize: false,
        message: 'Job dịch đã kết thúc ở trạng thái FAILED.',
        status: TranslationJobStatus.FAILED,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Job Dịch Đã Kết Thúc')).toBeDefined();
    expect(screen.getByText('FAILED')).toBeDefined();
    expect(screen.queryByText('Tiến Trình Dịch Tự Động Đang Xử Lý')).toBeNull();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
  });

  it('renders Error view on 403 FORBIDDEN and does NOT leak workspace shell', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      status: 'error',
      jobDetail: null,
      segments: [],
      error: {
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền truy cập job dịch này.',
        status: 403,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Không Thể Truy Cập Job Dịch')).toBeDefined();
    expect(screen.getByText('FORBIDDEN')).toBeDefined();
    expect(screen.getByText('Bạn không có quyền truy cập job dịch này.')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
  });

  it('renders full READY_FOR_REVIEW shell when jobDetail and count are valid', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue(defaultMockReturn);

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('One Piece — Chương 1.00: Khởi đầu')).toBeDefined();
    expect(screen.getByText('READY_FOR_REVIEW')).toBeDefined();
    expect(screen.getByText('1..3')).toBeDefined();
    expect(screen.getByText('Canvas So Sánh & Vùng Thoại OCR')).toBeDefined();
    expect(screen.getByText('Danh Sách Ô Thoại (Segments)')).toBeDefined();
    expect(screen.getByText('ヤッホー')).toBeDefined();
  });

  it('renders Loading state and does NOT render READY shell', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      status: 'loading',
      jobDetail: null,
      segments: [],
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(
      await screen.findByText('Đang tải dữ liệu không gian duyệt Manga Studio...'),
    ).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
  });

  it('renders Error view with retry button that calls studio.retry()', async () => {
    const retrySpy = vi.fn();
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      status: 'error',
      jobDetail: null,
      segments: [],
      error: {
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền truy cập job dịch này.',
        status: 403,
      },
      retry: retrySpy,
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Không Thể Truy Cập Job Dịch')).toBeDefined();
    const retryBtn = screen.getByText('Thử Lại');
    fireEvent.click(retryBtn);
    expect(retrySpy).toHaveBeenCalled();
  });

  it('renders UNKNOWN freshness correctly without showing Kết Xuất Mới Nhất or Đã Cập Nhật', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      freshness: {
        status: 'UNKNOWN',
        isFresh: false,
        needsMaterialize: false,
        message: 'Thông tin phiên bản chưa xác định.',
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(
      (await screen.findAllByText('Chưa Xác Định Phiên Bản')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Kết Xuất Mới Nhất')).toBeNull();
    expect(screen.queryByText('Đã Cập Nhật')).toBeNull();
  });

  it('renders INVARIANT_VIOLATION freshness with alert banner without showing Kết Xuất Mới Nhất or Đã Cập Nhật', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      freshness: {
        status: 'INVARIANT_VIOLATION',
        isFresh: false,
        needsMaterialize: false,
        message:
          'Lỗi bất biến phiên bản: materializedRevision không thể lớn hơn reviewRevision.',
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(
      await screen.findByText('Dữ Liệu Phiên Bản Không Nhất Quán'),
    ).toBeDefined();
    expect(screen.getByText('Cảnh Báo Bất Biến Phiên Bản:')).toBeDefined();
    expect(screen.getByText('Phiên Bản Không Hợp Lệ')).toBeDefined();
    expect(screen.queryByText('Kết Xuất Mới Nhất')).toBeNull();
    expect(screen.queryByText('Đã Cập Nhật')).toBeNull();
  });

  it('renders Lỗi Tải Dữ Liệu Workspace for non-access 500 error and not Không Thể Truy Cập Job Dịch', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      status: 'error',
      jobDetail: null,
      segments: [],
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Lỗi máy chủ kết nối cơ sở dữ liệu.',
        status: 500,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Lỗi Tải Dữ Liệu Workspace')).toBeDefined();
    expect(screen.queryByText('Không Thể Truy Cập Job Dịch')).toBeNull();
    expect(screen.getByText('Lỗi máy chủ kết nối cơ sở dữ liệu.')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
  });

  it('triggers early identity fail-closed guard when jobDetail.job.id does not match route jobId', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      jobDetail: {
        ...defaultMockReturn.jobDetail!,
        job: {
          ...defaultMockReturn.jobDetail!.job,
          id: 'job-different-id',
        },
      },
      // Even if workspaceMode was somehow populated
      workspaceMode: {
        mode: 'REVIEWABLE',
        canPreview: true,
        canEdit: true,
        canMaterialize: true,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Đang chuẩn bị không gian làm việc...')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
    expect(screen.queryByText('One Piece — Chương 1.00: Khởi đầu')).toBeNull();
  });

  it('does NOT fallback null pageNumber to page 1 in segments list', async () => {
    const customSegs = [
      {
        ...mockDefaultSegments[0],
        pageNumber: null,
        sortOrder: 42,
      },
    ];
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      segments: customSegs,
      pageSegments: customSegs,
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText(/Chưa gán trang • Thứ tự #42/)).toBeDefined();
    expect(screen.queryByText(/Trang 1 • Thứ tự #42/)).toBeNull();
  });

  it('disables materialization button when isMaterializing is true', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      freshness: { isFresh: false, needsMaterialize: true, status: 'STALE' },
      isMaterializing: true,
      materializationLifecycle: {
        phase: 'TRACKING',
        targetRevision: 2,
        requestStatus: 'ENQUEUED',
        pollAttempts: 1,
        lastError: null,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    const btn = await screen.findByTestId('btn-materializing');
    expect(btn).toBeDefined();
    expect(btn.closest('button')?.disabled).toBe(true);
  });

  it('gracefully handles VERSION_CONFLICT without version numbers without rendering vundefined', async () => {
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      conflictState: {
        kind: 'VERSION_CONFLICT',
        segmentId: 'seg-1',
        currentVersion: undefined,
        expectedVersion: undefined,
        draftText: 'Draft with no version',
        retryBlocked: false,
      },
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Xung Đột Phiên Bản (409 VERSION_CONFLICT):')).toBeDefined();
    expect(screen.getByText(/Phiên bản trên máy chủ đã thay đổi/)).toBeDefined();
    expect(screen.queryByText(/vundefined/)).toBeNull();
  });

  it('passes target segmentId to clearConflict when close button is clicked', async () => {
    const clearConflictSpy = vi.fn();
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      conflictState: {
        kind: 'VERSION_CONFLICT',
        segmentId: 'seg-42',
        currentVersion: 3,
        expectedVersion: 2,
        draftText: 'Draft',
        retryBlocked: false,
      },
      clearConflict: clearConflictSpy,
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    const closeBtn = await screen.findByText('Đóng');
    fireEvent.click(closeBtn);
    expect(clearConflictSpy).toHaveBeenCalledWith('seg-42');
  });

  it('renders "Chưa xác minh" badge when segmentsSyncStatus is not SYNCED, even if segment has isHumanVerified: true', async () => {
    const unverifiedSegs = [
      {
        ...mockDefaultSegments[0],
        isHumanVerified: true,
      },
    ];
    vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
      ...defaultMockReturn,
      segments: unverifiedSegs,
      pageSegments: unverifiedSegs,
      segmentsSyncStatus: 'FAILED',
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    expect(await screen.findByText('Chưa xác minh')).toBeDefined();
    expect(screen.queryByText('Đã Duyệt')).toBeNull();
  });

  describe('Presigned URL auto-refresh on focus/error (#149)', () => {
    const mockSourceAsset: ReviewAssetDto = {
      kind: 'SOURCE_REVIEW',
      pageNumber: 1,
      url: 'https://cdn.example.com/source-u1.png',
      width: 1000,
      height: 1500,
    };
    const mockResultAsset: ReviewAssetDto = {
      kind: 'RESULT',
      pageNumber: 1,
      url: 'https://cdn.example.com/result-u1.png',
      width: 1000,
      height: 1500,
    };

    it('1. source U1 onError invokes onPreviewAssetError and triggers exactly 1 retryPreviewWindow call', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [mockResultAsset],
          workspaceRevision: 1,
        },
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const sourceImg = screen.getByTestId('canvas-source-image');
      expect(sourceImg).toBeInTheDocument();

      await act(async () => {
        fireEvent.error(sourceImg);
      });

      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);
    });

    it('2. result U1 onError invokes onPreviewAssetError and triggers exactly 1 retryPreviewWindow call', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [mockResultAsset],
          workspaceRevision: 1,
        },
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      // Switch to RESULT mode
      const resultTabBtn = screen.getByTestId('view-mode-result-button');
      await act(async () => {
        fireEvent.click(resultTabBtn);
      });

      const resultImg = screen.getByTestId('canvas-result-image');
      expect(resultImg).toBeInTheDocument();

      await act(async () => {
        fireEvent.error(resultImg);
      });

      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);
    });

    it('3. same-URL retry remounts fresh image DOM instance and prevents infinite retry if error persists (#149 P1-2)', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);

      const { rerender } = render(<MangaStudioJobPage params={mockParams} />);

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 0,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      const sourceImg = screen.getByTestId('canvas-source-image');
      expect(sourceImg.getAttribute('data-presentation-epoch')).toBe('0');

      // First error on U1
      await act(async () => {
        fireEvent.error(sourceImg);
      });
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);

      // Simulates successful preview refresh response: hook commits previewWindow and increments previewWindowGeneration to 1
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 1,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      // P1-2 Invariant: Even though URL is identical, previewWindowGeneration incremented to 1 and a new <img> DOM instance mounted
      const remountedImg = await screen.findByTestId('canvas-source-image');
      expect(remountedImg.getAttribute('data-presentation-epoch')).toBe('1');

      // Second error event on the remounted image with same U1 URL (before onLoad success)
      await act(async () => {
        fireEvent.error(remountedImg);
      });
      // Dedupe guard MUST prevent infinite auto-retry for same attempt/key!
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);
    });

    it('3b. after successful reload on same URL, later independent error allows auto-retry again (#149 P1-2)', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);

      const { rerender } = render(<MangaStudioJobPage params={mockParams} />);

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 0,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      const sourceImg = screen.getByTestId('canvas-source-image');

      // 1. Initial error triggers first retry
      await act(async () => {
        fireEvent.error(sourceImg);
      });
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);

      // 2. Refresh completes, previewWindowGeneration becomes 1
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 1,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      const remountedImg = await screen.findByTestId('canvas-source-image');
      expect(remountedImg.getAttribute('data-presentation-epoch')).toBe('1');

      // 3. Image successfully decodes and verifies -> clears dedupe entry via onPreviewAssetLoaded
      Object.defineProperty(remountedImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(remountedImg, 'naturalHeight', { value: 1500 });
      await act(async () => {
        fireEvent.load(remountedImg);
      });

      // 4. Later independent error occurs on the same asset (e.g. presigned URL expired minutes later)
      await act(async () => {
        fireEvent.error(remountedImg);
      });

      // Because dedupe was cleared upon successful load, one auto-retry is allowed again!
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(2);
    });

    it('4. stale error event from U1 after U2 active does not trigger refresh', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      // Currently active asset is U2
      const activeSourceU2: ReviewAssetDto = {
        kind: 'SOURCE_REVIEW',
        pageNumber: 1,
        url: 'https://cdn.example.com/source-u2.png',
        width: 1000,
        height: 1500,
      };

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [activeSourceU2],
          resultAssets: [],
          workspaceRevision: 1,
        },
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const sourceImg = screen.getByTestId('canvas-source-image');

      // Simulate a late/stale error event from U1 DOM node carrying old key
      sourceImg.setAttribute('data-image-key', '1:1:https://cdn.example.com/source-u1.png');

      await act(async () => {
        fireEvent.error(sourceImg);
      });

      // Does not trigger retry because key does not match active asset U2
      expect(retryPreviewWindowSpy).not.toHaveBeenCalled();
    });

    it('5. single focus owner (P1-1): route delegates window focus refresh exclusively to useMangaReviewStudio', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [mockResultAsset],
          workspaceRevision: 1,
        },
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      // Route itself does NOT attach a duplicate focus listener (single focus owner in hook)
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      // Route-level spy is not called directly; hook manages authoritative request lifecycle
      expect(retryPreviewWindowSpy).not.toHaveBeenCalled();
    });

    it('6. window error banner retry button triggers retryPreviewWindow and increments presentationEpoch', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [],
          workspaceRevision: 1,
        },
        previewWindowError: 'PREVIEWS_WINDOW_FAILED',
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const retryBtn = screen.getByText('Thử lại tải ảnh');
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);
    });

    it('7. thumbnail RESULT R1 onError triggers exactly 1 preview refresh and remounts thumbnail via generation (#149 P1-2)', async () => {
      const retryPreviewWindowSpy = vi.fn().mockResolvedValue(undefined);
      const mockResultR1: ReviewAssetDto = {
        kind: 'RESULT',
        pageNumber: 1,
        url: 'https://cdn.example.com/thumb-res-r1.png',
        width: 1000,
        height: 1500,
      };

      const { rerender } = render(<MangaStudioJobPage params={mockParams} />);

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [mockResultR1],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 0,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      const thumbImg = screen.getByTestId('thumbnail-image-1');
      expect(thumbImg).toBeInTheDocument();
      expect(thumbImg.getAttribute('data-generation')).toBe('0');

      // 1. Thumbnail load error triggers retry
      await act(async () => {
        fireEvent.error(thumbImg);
      });
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);

      // 2. Successful preview refresh returns same R1 URL, but previewWindowGeneration increments to 1
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        previewWindow: {
          fromPage: 1,
          toPage: 3,
          size: 3,
          sourceAssets: [mockSourceAsset],
          resultAssets: [mockResultR1],
          workspaceRevision: 1,
        },
        previewWindowGeneration: 1,
        retryPreviewWindow: retryPreviewWindowSpy,
      });

      rerender(<MangaStudioJobPage params={mockParams} />);

      // Fresh thumbnail <img> DOM instance mounted with data-generation=1
      const freshThumbImg = screen.getByTestId('thumbnail-image-1');
      expect(freshThumbImg.getAttribute('data-generation')).toBe('1');

      // 3. Second error before load success does not trigger infinite retry
      await act(async () => {
        fireEvent.error(freshThumbImg);
      });
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(1);

      // 4. Successful load clears dedupe entry
      await act(async () => {
        fireEvent.load(freshThumbImg);
      });

      // 5. Later independent error allows auto-retry again
      await act(async () => {
        fireEvent.error(freshThumbImg);
      });
      expect(retryPreviewWindowSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Translation Editor & Draft OCC Integration (#149 RED 3)', () => {
    it('1. renders placeholder empty state when selectedSegmentId is null', async () => {
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: null,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      expect(screen.getByTestId('segment-editor-empty')).toBeInTheDocument();
      expect(screen.getByText('Chưa Chọn Ô Thoại')).toBeInTheDocument();
    });

    it('2. renders MangaSegmentEditor when selectedSegmentId is set, displaying rawText and translated text', async () => {
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      expect(screen.getByTestId('segment-editor-container')).toBeInTheDocument();
      expect(screen.getByTestId('segment-raw-text')).toHaveTextContent('ヤッホー');
      expect(screen.getByTestId('segment-translation-textarea')).toHaveValue('Yoohoo');
      expect(screen.getByTestId('badge-synced')).toBeInTheDocument();
    });

    it('3. typing in editor calls studio.setSegmentDraft without mutating canonical segment', async () => {
      const setSegmentDraftSpy = vi.fn();
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        setSegmentDraft: setSegmentDraftSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const textarea = screen.getByTestId('segment-translation-textarea');
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Bản dịch mới từ editor' } });
      });

      expect(setSegmentDraftSpy).toHaveBeenCalledWith('seg-1', 'Bản dịch mới từ editor');
      expect(mockDefaultSegments[0].translatedText).toBe('Yoohoo');
    });

    it('4. renders draft text and dirty badge when studio.drafts has entry for selected segment', async () => {
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        drafts: {
          'seg-1': 'Bản dịch nháp trong bộ nhớ',
        },
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      expect(screen.getByTestId('segment-translation-textarea')).toHaveValue(
        'Bản dịch nháp trong bộ nhớ',
      );
      expect(screen.getByTestId('badge-dirty')).toBeInTheDocument();
      expect(screen.getByText('Bản nháp chưa lưu')).toBeInTheDocument();
      // Segment list also reflects draft badge
      expect(screen.getAllByText('Nháp').length).toBeGreaterThanOrEqual(1);
    });

    it('5. clicking discard draft calls studio.discardSegmentDraft', async () => {
      const discardSegmentDraftSpy = vi.fn();
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        drafts: {
          'seg-1': 'Bản dịch sắp bị hủy',
        },
        discardSegmentDraft: discardSegmentDraftSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const discardBtn = screen.getByTestId('btn-discard-draft');
      expect(discardBtn).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(discardBtn);
      });

      expect(discardSegmentDraftSpy).toHaveBeenCalledWith('seg-1');
    });

    it('6. clicking save calls studio.saveSegment with draft text and canonical baseVersion', async () => {
      const saveSegmentSpy = vi.fn().mockResolvedValue({
        success: true,
        outcome: 'SAVED_AND_SYNCED',
      });

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        drafts: {
          'seg-1': 'Bản dịch chính thức',
        },
        saveSegment: saveSegmentSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const saveBtn = screen.getByTestId('btn-save-segment');
      expect(saveBtn).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(saveBtn);
      });

      expect(saveSegmentSpy).toHaveBeenCalledTimes(1);
      expect(saveSegmentSpy).toHaveBeenCalledWith('seg-1', 'Bản dịch chính thức', {
        baseVersion: 1,
      });
    });

    it('7. displays OCC conflict banner when conflictStates has VERSION_CONFLICT for segment', async () => {
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        drafts: {
          'seg-1': 'Bản nháp xung đột',
        },
        conflictStates: {
          'seg-1': {
            kind: 'VERSION_CONFLICT',
            segmentId: 'seg-1',
            currentVersion: 3,
            expectedVersion: 1,
            retryBlocked: false,
          },
        },
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      expect(screen.getByTestId('editor-occ-conflict-banner')).toBeInTheDocument();
      expect(
        screen.getByText(/Máy chủ đã được cập nhật lên v3 \(bạn đang chỉnh sửa dựa trên v1\)/),
      ).toBeInTheDocument();
      // User draft remains intact in textarea
      expect(screen.getByTestId('segment-translation-textarea')).toHaveValue(
        'Bản nháp xung đột',
      );
    });
  });

  describe('Verification & Bounded Traversal Integration (#149 RED 4)', () => {
    it('1. renders authoritative review summary badge in header', async () => {
      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        reviewSummary: {
          segmentCount: 10,
          verifiedCount: 4,
          pageCount: 1,
          resultPageCount: 3,
          blockCount: null,
        },
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const badge = screen.getByTestId('review-summary-badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Đã duyệt:4/10 (40%)');
    });

    it('2. clicking verify button in editor invokes studio.toggleSegmentVerification', async () => {
      const toggleSpy = vi.fn().mockResolvedValue({
        success: true,
        outcome: 'SAVED_AND_SYNCED',
      });

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: mockDefaultSegments,
        segments: mockDefaultSegments,
        toggleSegmentVerification: toggleSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const verifyBtn = screen.getByTestId('btn-toggle-verify');
      expect(verifyBtn).toBeInTheDocument();
      expect(verifyBtn).toHaveTextContent('Duyệt');

      await act(async () => {
        fireEvent.click(verifyBtn);
      });

      expect(toggleSpy).toHaveBeenCalledWith('seg-1');
    });

    it('3. clicking traversal buttons invokes corresponding studio methods', async () => {
      const nextSpy = vi.fn();
      const prevSpy = vi.fn();
      const nextUnverifiedSpy = vi.fn();

      const twoSegments: TranslationSegmentDto[] = [
        mockDefaultSegments[0],
        {
          ...mockDefaultSegments[0],
          id: 'seg-2',
          sortOrder: 2,
          isHumanVerified: false,
        },
      ];

      vi.spyOn(studioHook, 'useMangaReviewStudio').mockReturnValue({
        ...defaultMockReturn,
        selectedSegmentId: 'seg-1',
        pageSegments: twoSegments,
        segments: twoSegments,
        selectNextSegment: nextSpy,
        selectPrevSegment: prevSpy,
        selectNextUnverifiedSegment: nextUnverifiedSpy,
      });

      await act(async () => {
        render(<MangaStudioJobPage params={mockParams} />);
      });

      const nextBtn = screen.getByTestId('btn-next-segment');
      const nextUnverifiedBtn = screen.getByTestId('btn-next-unverified');

      expect(nextBtn).not.toBeDisabled();
      expect(nextUnverifiedBtn).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(nextBtn);
      });
      expect(nextSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(nextUnverifiedBtn);
      });
      expect(nextUnverifiedSpy).toHaveBeenCalledTimes(1);
    });
  });
});


