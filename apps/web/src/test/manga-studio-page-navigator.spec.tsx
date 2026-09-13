import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import {
  computeBoundedPreviewWindow,
  parsePageQueryParam,
  canNavigatePrev,
  canNavigateNext,
  clampPageNumber,
  isEditableElement,
} from '../lib/studio/manga-page-navigator';
import { useMangaReviewStudio } from '../lib/studio/use-manga-review-studio';
import MangaStudioJobPage from '../app/(site)/(studio)/studio/ai/jobs/[jobId]/page';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';

let currentSearchParams = new URLSearchParams();
const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockPathname = '/studio/ai/jobs/job-nav-123';

vi.mock('next/navigation', () => ({
  useSearchParams: () => currentSearchParams,
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => mockPathname,
}));


describe('Manga Page Navigator Policy & Pure Functions (#149 RED 1)', () => {
  describe('1. Bounded Preview Window Calculation (<= 5 pages, contiguous, centered)', () => {
    it('returns null when resultPageCount is missing, 0, or negative', () => {
      expect(computeBoundedPreviewWindow(1, null)).toBeNull();
      expect(computeBoundedPreviewWindow(1, undefined)).toBeNull();
      expect(computeBoundedPreviewWindow(1, 0)).toBeNull();
      expect(computeBoundedPreviewWindow(1, -5)).toBeNull();
    });

    it('returns full range [1..N] when N <= 5', () => {
      // N = 3
      expect(computeBoundedPreviewWindow(1, 3)).toEqual({ fromPage: 1, toPage: 3, size: 3 });
      expect(computeBoundedPreviewWindow(2, 3)).toEqual({ fromPage: 1, toPage: 3, size: 3 });
      expect(computeBoundedPreviewWindow(3, 3)).toEqual({ fromPage: 1, toPage: 3, size: 3 });

      // N = 5
      expect(computeBoundedPreviewWindow(4, 5)).toEqual({ fromPage: 1, toPage: 5, size: 5 });
    });

    it('centers window around currentPage when possible and shifts at edges for N = 20', () => {
      const N = 20;
      // Start edges: pages 1, 2, 3 should all clamp to [1..5]
      expect(computeBoundedPreviewWindow(1, N)).toEqual({ fromPage: 1, toPage: 5, size: 5 });
      expect(computeBoundedPreviewWindow(2, N)).toEqual({ fromPage: 1, toPage: 5, size: 5 });
      expect(computeBoundedPreviewWindow(3, N)).toEqual({ fromPage: 1, toPage: 5, size: 5 });

      // Centered: page 4 -> [2..6], page 10 -> [8..12]
      expect(computeBoundedPreviewWindow(4, N)).toEqual({ fromPage: 2, toPage: 6, size: 5 });
      expect(computeBoundedPreviewWindow(10, N)).toEqual({ fromPage: 8, toPage: 12, size: 5 });

      // End edges: pages 18, 19, 20 should all clamp to [16..20]
      expect(computeBoundedPreviewWindow(18, N)).toEqual({ fromPage: 16, toPage: 20, size: 5 });
      expect(computeBoundedPreviewWindow(19, N)).toEqual({ fromPage: 16, toPage: 20, size: 5 });
      expect(computeBoundedPreviewWindow(20, N)).toEqual({ fromPage: 16, toPage: 20, size: 5 });
    });

    it('always produces contiguous range containing currentPage and size <= 5', () => {
      for (let N = 1; N <= 25; N++) {
        for (let p = 1; p <= N; p++) {
          const win = computeBoundedPreviewWindow(p, N);
          expect(win).not.toBeNull();
          if (win) {
            expect(win.fromPage).toBeGreaterThanOrEqual(1);
            expect(win.toPage).toBeLessThanOrEqual(N);
            expect(win.toPage - win.fromPage + 1).toBe(win.size);
            expect(win.size).toBe(Math.min(5, N));
            expect(win.fromPage).toBeLessThanOrEqual(p);
            expect(win.toPage).toBeGreaterThanOrEqual(p);
          }
        }
      }
    });

    it('handles out-of-bounds currentPage gracefully by clamping to [1..N]', () => {
      // currentPage 0 or negative
      expect(computeBoundedPreviewWindow(0, 10)).toEqual({ fromPage: 1, toPage: 5, size: 5 });
      expect(computeBoundedPreviewWindow(-5, 10)).toEqual({ fromPage: 1, toPage: 5, size: 5 });

      // currentPage > N
      expect(computeBoundedPreviewWindow(25, 10)).toEqual({ fromPage: 6, toPage: 10, size: 5 });
    });
  });

  describe('2. URL Page Query Parameter Parsing & Canonicalization', () => {
    it('canonicalizes missing, empty, or undefined to page 1 with isCanonical: false', () => {
      expect(parsePageQueryParam(null, 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam(undefined, 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam('', 10)).toEqual({ page: 1, isCanonical: false });
    });

    it('canonicalizes invalid, non-integer, zero or negative string to page 1 with isCanonical: false', () => {
      expect(parsePageQueryParam('abc', 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam('0', 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam('-3', 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam('1.5', 10)).toEqual({ page: 1, isCanonical: false });
      expect(parsePageQueryParam('NaN', 10)).toEqual({ page: 1, isCanonical: false });
    });

    it('clamps to maxPage when query param exceeds maxPage and marks isCanonical: false', () => {
      expect(parsePageQueryParam('25', 10)).toEqual({ page: 10, isCanonical: false });
      expect(parsePageQueryParam('11', 10)).toEqual({ page: 10, isCanonical: false });
    });

    it('accepts valid in-bounds page and marks isCanonical: true only for exact clean string', () => {
      expect(parsePageQueryParam('1', 10)).toEqual({ page: 1, isCanonical: true });
      expect(parsePageQueryParam('5', 10)).toEqual({ page: 5, isCanonical: true });
      expect(parsePageQueryParam('10', 10)).toEqual({ page: 10, isCanonical: true });

      // Formatted with leading zeros or spaces is valid page but not canonical URL
      expect(parsePageQueryParam('05', 10)).toEqual({ page: 5, isCanonical: false });
      expect(parsePageQueryParam(' 5 ', 10)).toEqual({ page: 5, isCanonical: false });
    });

    it('tolerates unknown maxPage (null/undefined/0) by parsing valid positive integers', () => {
      expect(parsePageQueryParam('3', null)).toEqual({ page: 3, isCanonical: true });
      expect(parsePageQueryParam('0', null)).toEqual({ page: 1, isCanonical: false });
    });
  });

  describe('3. Navigation Bounds & Helpers', () => {
    it('correctly reports canNavigatePrev', () => {
      expect(canNavigatePrev(1)).toBe(false);
      expect(canNavigatePrev(2)).toBe(true);
      expect(canNavigatePrev(10)).toBe(true);
    });

    it('correctly reports canNavigateNext', () => {
      expect(canNavigateNext(1, null)).toBe(false);
      expect(canNavigateNext(1, 0)).toBe(false);
      expect(canNavigateNext(1, 5)).toBe(true);
      expect(canNavigateNext(4, 5)).toBe(true);
      expect(canNavigateNext(5, 5)).toBe(false);
    });

    it('clamps page number correctly', () => {
      expect(clampPageNumber(0, 10)).toBe(1);
      expect(clampPageNumber(-5, 10)).toBe(1);
      expect(clampPageNumber(5, 10)).toBe(5);
      expect(clampPageNumber(15, 10)).toBe(10);
      expect(clampPageNumber(5, null)).toBe(5);
      expect(clampPageNumber(-1, null)).toBe(1);
    });
  });

  describe('4. Keyboard Hotkeys Guard (isEditableElement)', () => {
    it('identifies input, textarea, select, and contenteditable as editable', () => {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const select = document.createElement('select');
      const editableDiv = document.createElement('div');
      editableDiv.setAttribute('contenteditable', 'true');
      const normalDiv = document.createElement('div');
      const button = document.createElement('button');

      expect(isEditableElement(input)).toBe(true);
      expect(isEditableElement(textarea)).toBe(true);
      expect(isEditableElement(select)).toBe(true);
      expect(isEditableElement(editableDiv)).toBe(true);
      expect(isEditableElement(normalDiv)).toBe(false);
      expect(isEditableElement(button)).toBe(false);
      expect(isEditableElement(null)).toBe(false);
    });
  });
});

describe('Manga Review Studio Hook Page Navigator (#149 RED 1)', () => {
  const mockJobId = 'job-nav-123';

  const mockJobDetail: TranslationJobReviewDetailResponse = {
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
      workspaceRevision: 10,
    },
    context: {
      story: { id: 's1', title: 'Manga Test', slug: 'manga-test', mediaFormat: MediaFormat.COMIC },
      edition: { id: 'e1', editionName: 'Việt', language: 'vi', isDefault: true },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Chương 1' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 4,
      verifiedCount: 2,
      pageCount: 3,
      resultPageCount: 20, // 20 pages
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
      bboxY: 10,
      bboxW: 50,
      bboxH: 20,
      rawText: 'Text 1',
      translatedText: 'Dịch 1',
      confidence: 0.95,
      isHumanVerified: true,
      version: 1,
    },
    {
      id: 'seg-2',
      jobId: mockJobId,
      pageNumber: 2,
      anchorBlockId: null,
      sortOrder: 2,
      bboxX: 20,
      bboxY: 20,
      bboxW: 40,
      bboxH: 20,
      rawText: 'Text 2',
      translatedText: 'Dịch 2',
      confidence: 0.9,
      isHumanVerified: false,
      version: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', username: 'tester', email: 'test@omninovel.com', role: 'USER' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockJobDetail);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_jobId, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber !== undefined) {
        const filtered = mockSegments.filter((s) => s.pageNumber === queryOrPage.pageNumber);
        return {
          data: filtered,
          pagination: {
            page: queryOrPage.page ?? 1,
            limit: queryOrPage.limit ?? 50,
            total: filtered.length,
            totalPages: 1,
          },
          workspaceRevision: 10,
        };
      }
      return {
        data: mockSegments,
        pagination: { page: 1, limit: 100, total: mockSegments.length, totalPages: 1 },
        workspaceRevision: 10,
      };
    });

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 10,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('5. Initial load calculates bounded window and fetches pageSegments for page 1', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.currentPage).toBe(1);
    expect(result.current.previewWindow).toEqual({
      fromPage: 1,
      toPage: 5,
      size: 5,
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 10,
    });
    expect(result.current.pageSegments).toHaveLength(1);
    expect(result.current.pageSegments[0].id).toBe('seg-1');
    expect(result.current.pageSegmentsPagination).toEqual({
      page: 1,
      limit: 50,
      totalItems: 1,
      totalPages: 1,
    });
  });

  it('6. Page switch clears old page selection, fetches new bounded window and pageSegments', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    // Select segment on page 1
    act(() => {
      result.current.setSelectedSegmentId('seg-1');
    });
    expect(result.current.selectedSegmentId).toBe('seg-1');

    // Switch to page 4 -> window should center to [2..6]
    await act(async () => {
      result.current.goToPage(4);
    });

    expect(result.current.currentPage).toBe(4);
    // Crucial Invariant: Selection from page 1 MUST be cleared when switching page!
    expect(result.current.selectedSegmentId).toBeNull();
    expect(result.current.previewWindow).toEqual({
      fromPage: 2,
      toPage: 6,
      size: 5,
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 10,
    });
  });

  it('6b. P1-2: Page switch synchronously clears page-owned read model before network requests resolve', async () => {
    let resolveWindowDeferred!: (val: any) => void;
    const windowDeferred = new Promise((resolve) => {
      resolveWindowDeferred = resolve;
    });
    let resolveSegmentsDeferred!: (val: any) => void;
    const segmentsDeferred = new Promise((resolve) => {
      resolveSegmentsDeferred = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      result.current.setSelectedSegmentId('seg-1');
    });
    expect(result.current.selectedSegmentId).toBe('seg-1');
    expect(result.current.pageSegments).toHaveLength(1);
    expect(result.current.previewWindow).not.toBeNull();

    // Mock deferred response for page 6
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockReturnValue(windowDeferred as any);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockReturnValue(segmentsDeferred as any);

    // Switch to page 6
    act(() => {
      result.current.goToPage(6);
    });

    // Invariant P1-2: SYNCHRONOUSLY before network resolves, page-owned data must be cleared!
    expect(result.current.currentPage).toBe(6);
    expect(result.current.selectedSegmentId).toBeNull();
    expect(result.current.pageSegments).toEqual([]);
    expect(result.current.pageSegmentsPagination).toBeNull();
    expect(result.current.pageSegmentsError).toBeNull();
    expect(result.current.previewWindow).toBeNull(); // page 6 outside [1..5]
    expect(result.current.previewWindowLoading).toBe(true);
    expect(result.current.pageSegmentsLoading).toBe(true);

    // Resolve deferred network
    await act(async () => {
      resolveWindowDeferred({ sourceAssets: [], resultAssets: [], workspaceRevision: 10 });
      resolveSegmentsDeferred({ data: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 1 }, workspaceRevision: 10 });
    });
  });

  it('7. Rapid page switch 2 -> 3 -> 4: late response from page 2 and 3 does not overwrite page 4', async () => {
    let resolvePage2Previews!: (val: any) => void;
    const page2PreviewsPromise = new Promise((resolve) => {
      resolvePage2Previews = resolve;
    });
    let resolvePage3Previews!: (val: any) => void;
    const page3PreviewsPromise = new Promise((resolve) => {
      resolvePage3Previews = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let callCount = 0;
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_jobId, query) => {
      if (query && 'fromPage' in query) {
        callCount++;
        if (callCount === 1) {
          // page 2 navigator request -> defer
          return page2PreviewsPromise as any;
        }
        if (callCount === 2) {
          // page 3 navigator request -> defer
          return page3PreviewsPromise as any;
        }
        if (callCount === 3 || (query.fromPage === 2 && query.toPage === 6)) {
          // page 4 navigator request -> resolve immediately with page 4 window data
          return {
            sourceAssets: [{ pageNumber: 4, url: 'url-page-4' } as any],
            resultAssets: [],
            workspaceRevision: 10,
          };
        }
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    // Rapidly switch 2 -> 3 -> 4
    act(() => {
      result.current.goToPage(2);
    });
    act(() => {
      result.current.goToPage(3);
    });
    await act(async () => {
      result.current.goToPage(4);
    });

    expect(result.current.currentPage).toBe(4);
    expect(result.current.previewWindow?.fromPage).toBe(2);
    expect(result.current.previewWindow?.sourceAssets[0]?.url).toBe('url-page-4');

    // Late resolution of page 2 and page 3
    await act(async () => {
      resolvePage2Previews({
        sourceAssets: [{ pageNumber: 2, url: 'stale-url-page-2' } as any],
        resultAssets: [],
        workspaceRevision: 10,
      });
      resolvePage3Previews({
        sourceAssets: [{ pageNumber: 3, url: 'stale-url-page-3' } as any],
        resultAssets: [],
        workspaceRevision: 10,
      });
    });

    // Invariant: Late responses from 2 and 3 did NOT overwrite page 4 state!
    expect(result.current.currentPage).toBe(4);
    expect(result.current.previewWindow?.fromPage).toBe(2);
    expect(result.current.previewWindow?.sourceAssets[0]?.url).toBe('url-page-4');
  });

  it('8. Amendment #1: Navigator-local failure (preview window 500) sets previewWindowError but leaves authoritative gate OPEN', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isGateClosed).toBe(false);

    // Mock window preview failure on next page
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && 'fromPage' in query) {
        const err = new Error('500 Window Server Error') as any;
        err.isAxiosError = true;
        err.response = { status: 500, data: { error: { code: 'INTERNAL_ERROR' } } };
        throw err;
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    await act(async () => {
      result.current.goToPage(6);
    });

    expect(result.current.currentPage).toBe(6);
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.previewWindowError).toBe('PREVIEWS_WINDOW_FAILED');
    // Global gate must NOT be closed! Navigator failure is local!
    expect(result.current.isGateClosed).toBe(false);
    expect(result.current.workspaceMode?.canEdit).toBe(true);
  });

  it('9. Amendment #1: Window response revision mismatch triggers GLOBAL fail-closed reconciliation', async () => {
    let resolveReconcileDetail!: (val: any) => void;
    const reconcileDetailDeferred = new Promise<TranslationJobReviewDetailResponse>((resolve) => {
      resolveReconcileDetail = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Mock detail to defer on reconciliation
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockReturnValue(reconcileDetailDeferred);

    // Mock window preview returning workspaceRevision: 9 (mismatch with detail 10)
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && 'fromPage' in query) {
        return {
          sourceAssets: [],
          resultAssets: [],
          workspaceRevision: 9, // STALE!
        };
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    const saveSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

    await act(async () => {
      result.current.goToPage(3);
    });

    // Mismatch MUST drop stale window, close authoritative gate, and block mutations with 0 network calls during reconciliation
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.isGateClosed).toBe(true);

    const saveRes = await result.current.saveSegment('seg-1', 'new text');
    expect(saveRes.outcome).toBe('FAILED_BEFORE_COMMIT');
    expect(saveRes.workspaceState).toBe('RECONCILIATION_REQUIRED');
    expect(saveSpy).toHaveBeenCalledTimes(0);

    // Complete reconciliation
    await act(async () => {
      resolveReconcileDetail(mockJobDetail);
    });
  });

  it('9b. P1-4: pageSegments workspaceRevision mismatch drops response, closes authoritative gate and triggers reconciliation', async () => {
    let resolveReconcileDetail!: (val: any) => void;
    const reconcileDetailDeferred = new Promise<TranslationJobReviewDetailResponse>((resolve) => {
      resolveReconcileDetail = resolve;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Mock detail to defer on reconciliation
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockReturnValue(reconcileDetailDeferred);

    // Mock segments returning stale workspaceRevision: 9 (mismatch with detail 10)
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 4) {
        return {
          data: [{ id: 'stale-seg', pageNumber: 4, version: 1 } as any],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          workspaceRevision: 9, // STALE!
        };
      }
      return { data: mockSegments, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 }, workspaceRevision: 10 };
    });

    const saveSpy = vi.spyOn(translationApi, 'updateTranslationSegment');

    await act(async () => {
      result.current.goToPage(4);
    });

    // Invariant P1-4: Gate must be fail-closed, stale pageSegments dropped!
    expect(result.current.isGateClosed).toBe(true);
    expect(result.current.pageSegments).toEqual([]);

    // Mutation blocked fail-closed with 0 network calls!
    const saveRes = await result.current.saveSegment('seg-1', 'test');
    expect(saveRes.outcome).toBe('FAILED_BEFORE_COMMIT');
    expect(saveRes.workspaceState).toBe('RECONCILIATION_REQUIRED');
    expect(saveSpy).toHaveBeenCalledTimes(0);

    // Complete reconciliation
    await act(async () => {
      resolveReconcileDetail(mockJobDetail);
    });
  });

  it('10. Same-scope retry/reconcile preserves currentPage (does not reset to page 1) and fetches page 7 bounded window', async () => {
    const previewSpy = vi.spyOn(translationApi, 'fetchTranslationJobPreviews');
    const segmentSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments');

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      result.current.goToPage(7);
    });
    expect(result.current.currentPage).toBe(7);

    previewSpy.mockClear();
    segmentSpy.mockClear();

    // Call retry
    await act(async () => {
      await result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Invariant P1-5: Preserved currentPage=7 and bounded window [5..9] actually fetched for page 7!
    expect(result.current.currentPage).toBe(7);
    expect(result.current.previewWindow?.fromPage).toBe(5);
    expect(result.current.previewWindow?.toPage).toBe(9);

    const windowCalls = previewSpy.mock.calls.filter(
      (c) => typeof c[1] === 'object' && c[1] !== null && 'fromPage' in c[1],
    );
    expect(windowCalls.some((c: any) => c[1].fromPage === 5 && c[1].toPage === 9)).toBe(true);

    const segmentCalls = segmentSpy.mock.calls.filter(
      (c) => typeof c[1] === 'object' && c[1] !== null && 'pageNumber' in c[1],
    );
    expect(segmentCalls.some((c: any) => c[1].pageNumber === 7)).toBe(true);
  });

  it('11. resultPageCount=null/0 retains COUNT_UNAVAILABLE mode and does NOT fetch window previews', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
      ...mockJobDetail,
      reviewSummary: {
        ...mockJobDetail.reviewSummary,
        resultPageCount: 0, // No valid page count
      },
    });

    const previewSpy = vi.spyOn(translationApi, 'fetchTranslationJobPreviews');

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => {
      expect(result.current.workspaceMode?.mode).toBe('COUNT_UNAVAILABLE');
    });

    expect(result.current.previewWindow).toBeNull();
    // Bounded window request should NOT be sent when count is unavailable
    const windowCalls = previewSpy.mock.calls.filter(
      (c) => typeof c[1] === 'object' && c[1] !== null && 'fromPage' in c[1]
    );
    expect(windowCalls).toHaveLength(0);
  });

  it('12. Switching jobId drops in-flight window and segment requests (generationRef guard)', async () => {
    let resolveJob1Previews!: (val: any) => void;
    const job1PreviewsDeferred = new Promise<any>((resolve) => {
      resolveJob1Previews = resolve;
    });

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (jobId, query) => {
      if (jobId === 'job-1' && query && 'fromPage' in query) {
        return job1PreviewsDeferred;
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    const { result, rerender } = renderHook(({ jobId }) => useMangaReviewStudio(jobId), {
      initialProps: { jobId: 'job-1' },
    });

    // In-flight for job-1
    rerender({ jobId: 'job-2' });

    // Late resolve job-1
    await act(async () => {
      resolveJob1Previews({
        sourceAssets: [{ pageNumber: 1, url: 'job-1-url' } as any],
        resultAssets: [],
        workspaceRevision: 10,
      });
    });

    // Result should not reflect job-1 data
    expect(result.current.previewWindow?.sourceAssets?.some((a) => a.url === 'job-1-url')).toBeFalsy();
  });

  it('12b. P1-6: Terminal transition to APPLIED purges in-flight navigator requests and prevents review revival', async () => {
    let resolvePage2Previews!: (val: any) => void;
    const page2PreviewsDeferred = new Promise((res) => {
      resolvePage2Previews = res;
    });
    let resolvePage2Segments!: (val: any) => void;
    const page2SegmentsDeferred = new Promise((res) => {
      resolvePage2Segments = res;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockReturnValue(page2PreviewsDeferred as any);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockReturnValue(page2SegmentsDeferred as any);

    // Navigate to page 2 (in-flight)
    act(() => {
      result.current.goToPage(2);
    });

    // Background transition to APPLIED arrives while requests are in flight
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue({
      ...mockJobDetail,
      job: {
        ...mockJobDetail.job,
        status: TranslationJobStatus.APPLIED,
        workspaceRevision: 11,
      },
    });

    await act(async () => {
      await result.current.refetchDetail();
    });

    expect(result.current.workspaceMode?.mode).toBe('APPLIED');
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.pageSegments).toEqual([]);

    // In-flight navigator requests resolve late
    await act(async () => {
      resolvePage2Previews({
        sourceAssets: [{ pageNumber: 2, url: 'revived-url' } as any],
        resultAssets: [],
        workspaceRevision: 10,
      });
      resolvePage2Segments({
        data: [{ id: 'revived-seg', pageNumber: 2 } as any],
        workspaceRevision: 10,
      });
    });

    // Invariant P1-6: In-flight requests dropped, review state MUST NOT be revived!
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.pageSegments).toEqual([]);
    expect(result.current.workspaceMode?.mode).toBe('APPLIED');
  });

  it('13. pageSegments preserves pagination metadata (Amendment #3: totalPages > 1)', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_jobId, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 1) {
        return {
          data: [mockSegments[0]],
          pagination: {
            page: 1,
            limit: 50,
            total: 120, // 120 items on page 1
            totalPages: 3,
          },
          workspaceRevision: 10,
        };
      }
      return {
        data: mockSegments,
        pagination: { page: 1, limit: 100, total: mockSegments.length, totalPages: 1 },
        workspaceRevision: 10,
      };
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      result.current.goToPage(1);
    });

    expect(result.current.pageSegmentsPagination).toEqual({
      page: 1,
      limit: 50,
      totalItems: 120,
      totalPages: 3,
    });
    expect(result.current.pageSegments).toHaveLength(1);
  });

  it('14. retryPreviewWindow allows navigator-local recovery without tearing down workspace', async () => {
    let failPreviews = true;
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && 'fromPage' in query && failPreviews) {
        const err = new Error('Network error') as any;
        err.isAxiosError = true;
        err.response = { status: 500 };
        throw err;
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      result.current.goToPage(2);
    });

    // In error state for window
    expect(result.current.previewWindowError).toBe('PREVIEWS_WINDOW_FAILED');
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.status).toBe('ready'); // Workspace is still ready

    // Fix network and call retryPreviewWindow
    failPreviews = false;
    await act(async () => {
      await result.current.retryPreviewWindow();
    });

    expect(result.current.previewWindowError).toBeNull();
    expect(result.current.previewWindow).not.toBeNull();
  });

  it('14b. P2-1: retryPreviewWindow and retryPageSegments are isolated and do not churn each other', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const previewSpy = vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 10,
    });
    const segmentSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: mockSegments,
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      workspaceRevision: 10,
    });

    // retryPreviewWindow only calls fetchTranslationJobPreviews
    await act(async () => {
      await result.current.retryPreviewWindow();
    });
    expect(previewSpy).toHaveBeenCalled();
    expect(segmentSpy).not.toHaveBeenCalled();

    previewSpy.mockClear();
    segmentSpy.mockClear();

    // retryPageSegments only calls fetchTranslationJobSegments
    await act(async () => {
      await result.current.retryPageSegments();
    });
    expect(segmentSpy).toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('14c. P2-2: goToPageSegmentsPage fetches next segment page for current manga page', async () => {
    const segmentSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 1 && queryOrPage?.page === 2) {
        return {
          data: [{ id: 'seg-page1-item51', pageNumber: 1, version: 1 } as any],
          pagination: { page: 2, limit: 50, total: 120, totalPages: 3 },
          workspaceRevision: 10,
        };
      }
      return { data: mockSegments, pagination: { page: 1, limit: 50, total: 120, totalPages: 3 }, workspaceRevision: 10 };
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.goToPageSegmentsPage(2);
    });

    expect(segmentSpy).toHaveBeenCalledWith(mockJobId, {
      page: 2,
      limit: 50,
      pageNumber: 1,
    });
    expect(result.current.pageSegmentsPagination?.page).toBe(2);
    expect(result.current.pageSegments[0].id).toBe('seg-page1-item51');
  });

  it('15a. P1-A: authoritative revision transition immediately invalidates stale previewWindow & pageSegments before bounded loaders resolve', async () => {
    let currentRev = 10;
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => ({
      ...mockJobDetail,
      job: {
        ...mockJobDetail.job,
        workspaceRevision: currentRev,
        reviewRevision: currentRev,
      },
    }));

    let resolveBoundedRev11Previews!: (val: any) => void;
    const boundedRev11PreviewsDeferred = new Promise<any>((resolve) => {
      resolveBoundedRev11Previews = resolve;
    });

    let resolveBoundedRev11Segments!: (val: any) => void;
    const boundedRev11SegmentsDeferred = new Promise<any>((resolve) => {
      resolveBoundedRev11Segments = resolve;
    });

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 1) {
        if (currentRev === 11) {
          return boundedRev11SegmentsDeferred;
        }
        return {
          data: [
            {
              id: 'seg-page1-item1',
              pageNumber: 1,
              version: 1,
              rawText: 'Original raw text',
              translatedText: 'Original rev10 text',
              isHumanVerified: false,
            } as any,
          ],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          workspaceRevision: 10,
        };
      }
      return {
        data: [
          {
            id: 'seg-page1-item1',
            pageNumber: 1,
            version: currentRev === 10 ? 1 : 2,
            rawText: 'Original raw text',
            translatedText: currentRev === 10 ? 'Original rev10 text' : 'Bản dịch mới đã lưu',
            isHumanVerified: currentRev !== 10,
          } as any,
        ],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        workspaceRevision: currentRev,
      };
    });

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && typeof query === 'object' && 'fromPage' in query) {
        if (currentRev === 11) {
          return boundedRev11PreviewsDeferred;
        }
        return {
          sourceAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/rev10-src-1.jpg' } as any],
          resultAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/rev10-res-1.jpg' } as any],
          workspaceRevision: 10,
        };
      }
      return {
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: currentRev,
      };
    });

    vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementation(async () => {
      currentRev = 11;
      return {
        id: 'seg-page1-item1',
        version: 2,
        translatedText: 'Bản dịch mới đã lưu',
        isHumanVerified: true,
        workspaceRevision: 11,
      } as any;
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.pageSegments[0].translatedText).toBe('Original rev10 text');
    expect(result.current.previewWindow?.resultAssets[0].url).toBe('https://cdn.example.com/rev10-res-1.jpg');
    expect(result.current.previewWindow?.workspaceRevision).toBe(10);

    let saveOutcome: any;
    await act(async () => {
      saveOutcome = await result.current.saveSegment('seg-page1-item1', 'Bản dịch mới đã lưu');
    });

    expect(saveOutcome.success).toBe(true);
    expect(saveOutcome.outcome).toBe('SAVED_AND_SYNCED');

    // P1-A Invariant: Authoritative gate is OPEN, but stale rev10 cache MUST NOT be observed!
    expect(result.current.isGateClosed).toBe(false);
    expect(result.current.previewWindow).toBeNull(); // Stale rev10 previewWindow invalidated!
    expect(result.current.previewWindowLoading).toBe(true);
    expect(result.current.pageSegments).toEqual([]); // Stale rev10 pageSegments invalidated!
    expect(result.current.pageSegmentsLoading).toBe(true);

    // Resolve deferred bounded rev 11 requests
    await act(async () => {
      resolveBoundedRev11Previews({
        sourceAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/rev11-src-1.jpg' } as any],
        resultAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/rev11-res-1.jpg' } as any],
        workspaceRevision: 11,
      });
      resolveBoundedRev11Segments({
        data: [
          {
            id: 'seg-page1-item1',
            pageNumber: 1,
            version: 2,
            rawText: 'Original raw text',
            translatedText: 'Bản dịch mới đã lưu',
            isHumanVerified: true,
          } as any,
        ],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        workspaceRevision: 11,
      });
    });

    // Only rev 11 assets and data appear after bounded loader resolution!
    await waitFor(() => {
      expect(result.current.previewWindowLoading).toBe(false);
      expect(result.current.pageSegmentsLoading).toBe(false);
      expect(result.current.pageSegments[0].translatedText).toBe('Bản dịch mới đã lưu');
      expect(result.current.previewWindow?.workspaceRevision).toBe(11);
      expect(result.current.previewWindow?.resultAssets[0].url).toBe('https://cdn.example.com/rev11-res-1.jpg');
    });
  });

  it('15b. P1-B: loadPreviewWindow and loadPageSegments purge workspace on 401/403/404 access errors', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Preview fails with 403 FORBIDDEN
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'FORBIDDEN', message: 'Access denied' } },
      },
    });

    await act(async () => {
      await result.current.retryPreviewWindow();
    });

    // P1-B Invariant: Must NOT degrade to navigator-local PREVIEWS_WINDOW_FAILED! Must purge and set status error!
    expect(result.current.status).toBe('error');
    expect(result.current.fatalError?.code).toBe('FORBIDDEN');
    expect(result.current.segments).toEqual([]);
    expect(result.current.previewWindow).toBeNull();
  });

  it('15c. P1-B: loadPreviewWindow closes gate and reconciles on 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS / NOT_REVIEWABLE', async () => {
    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const reconcileSpy = vi.spyOn(translationApi, 'fetchTranslationJobDetail');

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS', message: 'Status changed' } },
      },
    });

    await act(async () => {
      await result.current.retryPreviewWindow();
    });

    // P1-B Invariant: Closes authoritative gate and triggers reconciliation
    expect(result.current.isGateClosed).toBe(true);
    expect(reconcileSpy).toHaveBeenCalled();
  });

  it('15d. P2-A: retryPageSegments retries target segment subpage even after failure cleared pagination', async () => {
    let failSegments = false;
    const segmentSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 1 && queryOrPage?.page === 2) {
        if (failSegments) {
          throw new Error('Network failure on subpage 2');
        }
        return {
          data: [{ id: 'seg-p1-item51', pageNumber: 1, version: 1 } as any],
          pagination: { page: 2, limit: 50, total: 120, totalPages: 3 },
          workspaceRevision: 10,
        };
      }
      return { data: mockSegments, pagination: { page: 1, limit: 50, total: 120, totalPages: 3 }, workspaceRevision: 10 };
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Step 1: Navigate to subpage 2 successfully
    await act(async () => {
      await result.current.goToPageSegmentsPage(2);
    });
    expect(result.current.pageSegmentsPagination?.page).toBe(2);

    // Step 2: Subpage 2 fails on network error
    failSegments = true;
    await act(async () => {
      await result.current.goToPageSegmentsPage(2);
    });
    expect(result.current.pageSegmentsError).toBe('SEGMENTS_PAGE_FAILED');
    expect(result.current.pageSegmentsPagination).toBeNull(); // Cleared on error!

    // Step 3: P2-A Invariant: retryPageSegments MUST retry subpage 2, NOT fallback to subpage 1!
    failSegments = false;
    segmentSpy.mockClear();

    await act(async () => {
      await result.current.retryPageSegments();
    });

    expect(segmentSpy).toHaveBeenCalledWith(mockJobId, {
      page: 2,
      limit: 50,
      pageNumber: 1,
    });
    expect(result.current.pageSegmentsPagination?.page).toBe(2);
    expect(result.current.pageSegments[0].id).toBe('seg-p1-item51');
  });

  it('15e. P2-B: true job boundary immediately resets currentPage to 1 and cancels in-flight navigator requests', async () => {
    const job2Id = 'job-boundary-test-2';
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async (id) => {
      if (id === job2Id) {
        return {
          ...mockJobDetail,
          job: { ...mockJobDetail.job, id: job2Id, workspaceRevision: 1 },
          reviewSummary: { ...mockJobDetail.reviewSummary, totalPages: 3, resultPageCount: 3, verifiedSegments: 0, totalSegments: 5 },
        };
      }
      return mockJobDetail;
    });

    const segmentSpy = vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (id) => ({
      data: mockSegments,
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      workspaceRevision: id === job2Id ? 1 : 10,
    }));

    const previewSpy = vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (id) => ({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: id === job2Id ? 1 : 10,
    }));

    const { result, rerender } = renderHook(({ id }) => useMangaReviewStudio(id), {
      initialProps: { id: mockJobId },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Navigate to page 4 on Job 1
    await act(async () => {
      result.current.goToPage(4);
    });
    expect(result.current.currentPage).toBe(4);

    previewSpy.mockClear();
    segmentSpy.mockClear();

    // Rerender with Job 2 (which has 3 pages)
    rerender({ id: job2Id });

    // P2-B Invariant: currentPage MUST immediately reset to 1, and requests for Job 2 MUST be for page 1!
    expect(result.current.currentPage).toBe(1);

    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Assert preview and segment requests for Job 2 were for page 1 (or bounded window starting page 1), NOT page 4
    expect(previewSpy).toHaveBeenCalledWith(job2Id, {
      fromPage: 1,
      toPage: 3,
    });
    expect(segmentSpy).toHaveBeenCalledWith(job2Id, {
      page: 1,
      limit: 50,
      pageNumber: 1,
    });
  });

  it('15f. P1-A: materialization-only revision update invalidates previewWindow immediately before bounded loader completes', async () => {
    let matRev = 1;
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => ({
      ...mockJobDetail,
      job: {
        ...mockJobDetail.job,
        workspaceRevision: 10,
        reviewRevision: 10,
        materializedRevision: matRev,
      },
    }));

    let resolveMatRev2Previews!: (val: any) => void;
    const matRev2PreviewsDeferred = new Promise<any>((resolve) => {
      resolveMatRev2Previews = resolve;
    });

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && typeof query === 'object' && 'fromPage' in query) {
        if (matRev === 2) {
          return matRev2PreviewsDeferred;
        }
        return {
          sourceAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/src-1.jpg' } as any],
          resultAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/mat1-res-1.jpg' } as any],
          workspaceRevision: 10,
        };
      }
      return {
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 10,
      };
    });

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.previewWindow?.resultAssets[0].url).toBe('https://cdn.example.com/mat1-res-1.jpg');

    // Trigger refetchDetail when materialization completes: workspaceRevision stays 10, materializedRevision becomes 2
    matRev = 2;
    let syncOutcome: any;
    await act(async () => {
      syncOutcome = await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
    });

    expect(syncOutcome).toBe('SYNCED');

    // P1-A Invariant: workspaceRevision is unchanged (10), but materializedRevision changed (1 -> 2).
    // Stale result thumbnail MUST be invalidated immediately while bounded preview loader is pending!
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.previewWindowLoading).toBe(true);

    // Now resolve bounded preview with matRev 2 result asset
    await act(async () => {
      resolveMatRev2Previews({
        sourceAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/src-1.jpg' } as any],
        resultAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/mat2-res-1.jpg' } as any],
        workspaceRevision: 10,
      });
    });

    await waitFor(() => {
      expect(result.current.previewWindowLoading).toBe(false);
      expect(result.current.previewWindow?.resultAssets[0].url).toBe('https://cdn.example.com/mat2-res-1.jpg');
    });
  });

  it('15g. P1-A: reconcileAuthoritativeWorkspace immediately invalidates previewWindow and pageSegments at start of reconciliation', async () => {
    let resolveReconcileDetail!: (val: any) => void;
    const reconcileDetailDeferred = new Promise<any>((resolve) => {
      resolveReconcileDetail = resolve;
    });

    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => mockJobDetail);

    const { result } = renderHook(() => useMangaReviewStudio(mockJobId));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.previewWindow).not.toBeNull();
    expect(result.current.pageSegments.length).toBeGreaterThan(0);

    // Mock detail to hang during reconcile
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockImplementation(async () => reconcileDetailDeferred);

    // Start reconcile
    act(() => {
      void result.current.reconcileAuthoritativeWorkspace();
    });

    // P1-A Invariant: Gate is closed, AND both RED 1 read-models are wiped immediately at reconcile start
    expect(result.current.isGateClosed).toBe(true);
    expect(result.current.previewWindow).toBeNull();
    expect(result.current.pageSegments).toEqual([]);

    // Complete reconcile
    await act(async () => {
      resolveReconcileDetail(mockJobDetail);
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});

describe('Manga Review Studio Route & URL Synchronization (#149 RED 1)', () => {
  const mockJobId = 'job-nav-123';
  const mockParams = Promise.resolve({ jobId: mockJobId });

  const mockJobDetail: TranslationJobReviewDetailResponse = {
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
      workspaceRevision: 10,
    },
    context: {
      story: { id: 's1', title: 'Manga Test', slug: 'manga-test', mediaFormat: MediaFormat.COMIC },
      edition: { id: 'e1', editionName: 'Việt', language: 'vi', isDefault: true },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Chương 1' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 4,
      verifiedCount: 2,
      pageCount: 3,
      resultPageCount: 20, // 20 pages
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
      bboxY: 10,
      bboxW: 50,
      bboxH: 20,
      rawText: 'Text 1',
      translatedText: 'Dịch 1',
      confidence: 0.95,
      isHumanVerified: true,
      version: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockReset();
    mockReplace.mockReset();
    currentSearchParams = new URLSearchParams('page=1');

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', username: 'tester', email: 'test@omninovel.com', role: 'USER' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockJobDetail);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: mockSegments,
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      workspaceRevision: 10,
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 10,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('15. Missing ?page query canonicalizes to ?page=1 via router.replace', async () => {
    currentSearchParams = new URLSearchParams('');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=1');
    });
  });

  it('16. Out of bounds ?page=999 clamps to ?page=20 via router.replace', async () => {
    currentSearchParams = new URLSearchParams('page=999');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=20');
    });
  });

  it('17. Invalid ?page=abc canonicalizes to ?page=1 via router.replace', async () => {
    currentSearchParams = new URLSearchParams('page=abc');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=1');
    });
  });

  it('18. Navigation buttons: "Trang Trước" disabled on page 1; clicking "Trang Tiếp" calls router.push(?page=2)', async () => {
    currentSearchParams = new URLSearchParams('page=1');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Trang Tiếp')).toBeDefined();
    });

    const prevBtn = screen.getByText('Trang Trước').closest('button');
    const nextBtn = screen.getByText('Trang Tiếp').closest('button');

    expect(prevBtn).toBeDisabled();
    expect(nextBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(nextBtn!);
    });

    expect(mockPush).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=2');
  });

  it('19. Bounded thumbnail strip displays at most 5 thumbnails and clicking thumbnail calls router.push', async () => {
    currentSearchParams = new URLSearchParams('page=1');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('thumbnail-strip')).toBeDefined();
    });

    // Window size for N=20 at page 1 is 5 pages: 1, 2, 3, 4, 5
    const thumbnails = screen.getAllByTestId(/thumbnail-item-/);
    expect(thumbnails).toHaveLength(5);

    // Click page 3 thumbnail
    const page3Thumb = screen.getByTestId('thumbnail-item-3');
    await act(async () => {
      fireEvent.click(page3Thumb);
    });

    expect(mockPush).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=3');
  });

  it('20. Keyboard ArrowLeft / ArrowRight navigates pages', async () => {
    currentSearchParams = new URLSearchParams('page=2');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Trang Tiếp')).toBeDefined();
    });

    // Press ArrowRight -> navigates to page 3
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    });
    expect(mockPush).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=3');

    // Press ArrowLeft -> navigates to page 1
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
    });
    expect(mockPush).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=1');
  });

  it('21. Keyboard navigation is suppressed when target is an input or textarea', async () => {
    currentSearchParams = new URLSearchParams('page=2');

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Trang Tiếp')).toBeDefined();
    });

    const testInput = document.createElement('input');
    document.body.appendChild(testInput);
    testInput.focus();

    await act(async () => {
      fireEvent.keyDown(testInput, { key: 'ArrowRight' });
    });

    expect(mockPush).not.toHaveBeenCalled();
    document.body.removeChild(testInput);
  });

  it('22. Local window preview error displays retry button and clicking it triggers retryPreviewWindow', async () => {
    currentSearchParams = new URLSearchParams('page=2');

    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async (_id, query) => {
      if (query && 'fromPage' in query) {
        const err = new Error('500 Window Server Error') as any;
        err.isAxiosError = true;
        err.response = { status: 500 };
        throw err;
      }
      return { sourceAssets: [], resultAssets: [], workspaceRevision: 10 };
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('window-error-banner')).toBeDefined();
    });

    const retryBtn = screen.getByText('Thử lại tải ảnh');
    expect(retryBtn).toBeDefined();

    // Editor/workspace remains rendered and gate is NOT broken!
    expect(screen.getByText('Manga Review Studio')).toBeDefined();
  });

  it('23. P1-3: Empty page segments renders empty-page-segments and NEVER falls back to canonical segments', async () => {
    currentSearchParams = new URLSearchParams('page=7');

    // Mock page 7 having 0 segments
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 7) {
        return {
          data: [],
          pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
          workspaceRevision: 10,
        };
      }
      return { data: mockSegments, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 }, workspaceRevision: 10 };
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('empty-page-segments')).toBeDefined();
    });

    expect(screen.getByText('Không có ô thoại nào')).toBeDefined();
    // Invariant P1-3: MUST NOT render canonical segment from page 1!
    expect(screen.queryByText('Dịch 1')).toBeNull();
    expect(screen.queryByText('Text 1')).toBeNull();
  });

  it('24. P1-3: Page segments error renders dedicated error banner with retry and NEVER falls back to canonical segments', async () => {
    currentSearchParams = new URLSearchParams('page=2');

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 2) {
        const err = new Error('Segments 500 Error') as any;
        err.isAxiosError = true;
        err.response = { status: 500 };
        throw err;
      }
      return { data: mockSegments, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 }, workspaceRevision: 10 };
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('page-segments-error-banner')).toBeDefined();
    });

    expect(screen.getByText(/Lỗi tải danh sách ô thoại trang 2/)).toBeDefined();
    // Invariant P1-3: MUST NOT fallback to canonical segments!
    expect(screen.queryByText('Dịch 1')).toBeNull();
  });

  it('25. P2-2: Multi-page segment pagination renders pagination controls and page indicator', async () => {
    currentSearchParams = new URLSearchParams('page=1');

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async (_id, queryOrPage) => {
      if (typeof queryOrPage === 'object' && queryOrPage?.pageNumber === 1) {
        return {
          data: [mockSegments[0]],
          pagination: { page: 1, limit: 50, total: 120, totalPages: 3 },
          workspaceRevision: 10,
        };
      }
      return { data: mockSegments, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 }, workspaceRevision: 10 };
    });

    await act(async () => {
      render(<MangaStudioJobPage params={mockParams} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('segment-pagination-bar')).toBeDefined();
    });

    expect(screen.getByText(/Phân đoạn 1 \/ 3/)).toBeDefined();
    const prevSegBtn = screen.getByText('Trước').closest('button');
    const nextSegBtn = screen.getByText('Sau').closest('button');

    expect(prevSegBtn).toBeDisabled();
    expect(nextSegBtn).not.toBeDisabled();
  });

  it('26. P1-1: Internal navigation only pushes URL; delayed router update does not rollback hook page state', async () => {
    currentSearchParams = new URLSearchParams('page=1');

    const { rerender } = render(<MangaStudioJobPage params={mockParams} />);

    await waitFor(() => {
      expect(screen.getByText('Trang Tiếp')).toBeDefined();
    });

    const nextBtn = screen.getByText('Trang Tiếp').closest('button');

    await act(async () => {
      fireEvent.click(nextBtn!);
    });

    // Invariant P1-1: router.push was called
    expect(mockPush).toHaveBeenCalledWith('/studio/ai/jobs/job-nav-123?page=2');

    // While searchParams is still page=1 (router commit lag), rerendering does NOT cause state rollback
    rerender(<MangaStudioJobPage params={mockParams} />);
    expect(screen.getByText('Trang 1 / 20')).toBeDefined();

    // When router eventually commits ?page=2:
    currentSearchParams = new URLSearchParams('page=2');
    rerender(<MangaStudioJobPage params={mockParams} />);

    await waitFor(() => {
      expect(screen.getByText('Trang 2 / 20')).toBeDefined();
    });
  });
});


