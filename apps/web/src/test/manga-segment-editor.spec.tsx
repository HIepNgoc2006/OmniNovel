import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import {
  isDraftDirty,
  resolveDisplayDraft,
  canSaveSegment,
  formatOcrConfidence,
  canToggleVerification,
  resolveActionMatrixState,
  isImeComposing,
  isEditableTarget,
  shouldHandleStudioVerificationHotkey,
  findNextSegmentIndex,
  findPrevSegmentIndex,
  findNextUnverifiedIndex,
} from '../lib/studio/manga-segment-editor-policy';
import {
  MangaSegmentEditor,
  MangaSegmentEditorProps,
} from '../components/studio/manga-segment-editor';
import {
  useMangaReviewStudio,
  ConflictState,
  ParsedApiError,
} from '../lib/studio/use-manga-review-studio';
import * as translationApi from '../lib/api/translation';

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

vi.mock('../lib/auth/auth-context', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'user-1', email: 'tester@example.com' },
    isAuthenticated: true,
    isLoading: false,
  })),
}));

describe('Manga Segment Editor (Phase 4D RED 3 #149)', () => {
  const mockSegment: TranslationSegmentDto = {
    id: 'seg-101',
    jobId: 'job-1',
    pageNumber: 1,
    anchorBlockId: null,
    sortOrder: 3,
    bboxX: 100,
    bboxY: 200,
    bboxW: 300,
    bboxH: 150,
    rawText: 'こんにちは世界！',
    translatedText: 'Xin chào thế giới!',
    confidence: 0.954,
    isHumanVerified: false,
    version: 2,
  };

  describe('1. Pure Policy Functions', () => {
    it('isDraftDirty detects changes and ignores harmless outer whitespace', () => {
      expect(isDraftDirty('Hello', 'Hello')).toBe(false);
      expect(isDraftDirty('Hello', 'Hello ')).toBe(false);
      expect(isDraftDirty('Hello', '  Hello')).toBe(false);
      expect(isDraftDirty('Hello', 'Hello World')).toBe(true);
      expect(isDraftDirty(null, 'Some text')).toBe(true);
      expect(isDraftDirty(undefined, '')).toBe(false);
    });

    it('resolveDisplayDraft prioritizes local draft over canonical text', () => {
      const drafts: Record<string, string> = {
        'seg-101': 'Draft translation in memory',
      };
      // When draft exists for segmentId: returns draft
      expect(resolveDisplayDraft('Server text', drafts, 'seg-101')).toBe(
        'Draft translation in memory',
      );
      // When draft does not exist: returns canonical text
      expect(resolveDisplayDraft('Server text', drafts, 'seg-other')).toBe(
        'Server text',
      );
      // When canonical text is nullish: returns empty string fallback
      expect(resolveDisplayDraft(null, {}, 'seg-other')).toBe('');
    });

    it('canSaveSegment enforces strict save prerequisites', () => {
      const baseParams = {
        isDirty: true,
        canEdit: true,
        isGateClosed: false,
        isSaving: false,
        hasPendingMutation: false,
        isRetryBlocked: false,
      };

      // Happy path: all conditions met -> true
      expect(canSaveSegment(baseParams)).toBe(true);

      // Not dirty -> false
      expect(canSaveSegment({ ...baseParams, isDirty: false })).toBe(false);

      // canEdit is false (e.g. APPLIED, FAILED, CANCELED) -> false
      expect(canSaveSegment({ ...baseParams, canEdit: false })).toBe(false);

      // isGateClosed is true (RECONCILIATION_REQUIRED) -> false
      expect(canSaveSegment({ ...baseParams, isGateClosed: true })).toBe(false);

      // In flight save -> false
      expect(canSaveSegment({ ...baseParams, isSaving: true })).toBe(false);

      // Pending unknown mutation (awaiting network reconciliation) -> false
      expect(
        canSaveSegment({ ...baseParams, hasPendingMutation: true }),
      ).toBe(false);

      // Orphan / retryBlocked segment -> false
      expect(canSaveSegment({ ...baseParams, isRetryBlocked: true })).toBe(
        false,
      );
    });

    it('formatOcrConfidence formats scores into rounded percentages', () => {
      expect(formatOcrConfidence(0.954)).toBe('95%');
      expect(formatOcrConfidence(0.999)).toBe('100%');
      expect(formatOcrConfidence(0.0)).toBe('0%');
      expect(formatOcrConfidence(null)).toBeNull();
      expect(formatOcrConfidence(undefined)).toBeNull();
      expect(formatOcrConfidence(-0.5)).toBeNull();
    });
  });

  describe('2. Component UI & State Machine', () => {
    it('renders placeholder empty state when no segment is selected', () => {
      render(
        <MangaSegmentEditor
          segment={null}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByTestId('segment-editor-empty')).toBeInTheDocument();
      expect(screen.getByText('Chưa Chọn Ô Thoại')).toBeInTheDocument();
    });

    it('renders selected segment metadata and read-only raw text', () => {
      render(
        <MangaSegmentEditor
          segment={mockSegment}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByTestId('segment-editor-container')).toBeInTheDocument();
      expect(screen.getByText('Ô #3')).toBeInTheDocument();
      expect(screen.getByText('Trang 1')).toBeInTheDocument();
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('OCR: 95%')).toBeInTheDocument();

      const rawTextEl = screen.getByTestId('segment-raw-text');
      expect(rawTextEl).toHaveTextContent('こんにちは世界！');
    });

    it('draft isolation: typing in textarea triggers onDraftChange without mutating canonical segment', () => {
      const onDraftChangeSpy = vi.fn();
      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản nháp đang gõ dở"
          onDraftChange={onDraftChangeSpy}
          onDiscardDraft={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      const textarea = screen.getByTestId('segment-translation-textarea');
      expect(textarea).toHaveValue('Bản nháp đang gõ dở');

      fireEvent.change(textarea, { target: { value: 'Bản nháp đã sửa' } });
      expect(onDraftChangeSpy).toHaveBeenCalledWith(
        'seg-101',
        'Bản nháp đã sửa',
      );

      // Canonical segment object is immutable
      expect(mockSegment.translatedText).toBe('Xin chào thế giới!');
    });

    it('shows dirty badge and discard button when text differs from canonical', () => {
      const onDiscardDraftSpy = vi.fn();
      const { rerender } = render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Xin chào thế giới!"
          onDraftChange={vi.fn()}
          onDiscardDraft={onDiscardDraftSpy}
          onSave={vi.fn()}
        />,
      );

      // Clean state: Synced badge, no discard button
      expect(screen.getByTestId('badge-synced')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-discard-draft')).not.toBeInTheDocument();

      // Dirty state
      rerender(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch đã chỉnh sửa"
          onDraftChange={vi.fn()}
          onDiscardDraft={onDiscardDraftSpy}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByTestId('badge-dirty')).toBeInTheDocument();
      const discardBtn = screen.getByTestId('btn-discard-draft');
      expect(discardBtn).toBeInTheDocument();

      fireEvent.click(discardBtn);
      expect(onDiscardDraftSpy).toHaveBeenCalledWith('seg-101');
    });

    it('save button is disabled when not dirty, and enabled when dirty and canEdit', () => {
      const onSaveSpy = vi.fn();
      const { rerender } = render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Xin chào thế giới!"
          canEdit={true}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={onSaveSpy}
        />,
      );

      const saveBtn = screen.getByTestId('btn-save-segment');
      expect(saveBtn).toBeDisabled();

      // Make dirty
      rerender(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch mới cần lưu"
          canEdit={true}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={onSaveSpy}
        />,
      );

      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSaveSpy).toHaveBeenCalledWith('seg-101', 'Bản dịch mới cần lưu');
    });

    it('save button and textarea are locked when canEdit is false (e.g. APPLIED or TERMINAL)', () => {
      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch mới"
          canEdit={false}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      const textarea = screen.getByTestId('segment-translation-textarea');
      expect(textarea).toBeDisabled();
      const saveBtn = screen.getByTestId('btn-save-segment');
      expect(saveBtn).toBeDisabled();
      expect(screen.getByText('Chế độ chỉ đọc')).toBeInTheDocument();
    });

    it('Ctrl+Enter / Cmd+Enter triggers onSave when canSave is true', () => {
      const onSaveSpy = vi.fn();
      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch mới phím tắt"
          canEdit={true}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={onSaveSpy}
        />,
      );

      const textarea = screen.getByTestId('segment-translation-textarea');
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(onSaveSpy).toHaveBeenCalledTimes(1);
      expect(onSaveSpy).toHaveBeenCalledWith(
        'seg-101',
        'Bản dịch mới phím tắt',
      );
    });

    it('displays loading spinner when isSaving is true and disables actions', () => {
      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Đang lưu"
          canEdit={true}
          isSaving={true}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      const saveBtn = screen.getByTestId('btn-save-segment');
      expect(saveBtn).toBeDisabled();
      expect(screen.getByText('Đang lưu...')).toBeInTheDocument();
      expect(screen.getByTestId('segment-translation-textarea')).toBeDisabled();
    });
  });

  describe('3. Concurrency OCC (409 VERSION_CONFLICT) & Error Handling', () => {
    it('renders OCC conflict banner preserving user draft on 409 VERSION_CONFLICT', () => {
      const onDiscardDraftSpy = vi.fn();
      const onClearConflictSpy = vi.fn();
      const conflict: ConflictState = {
        kind: 'VERSION_CONFLICT',
        segmentId: 'seg-101',
        currentVersion: 3,
        expectedVersion: 2,
        draftText: 'Bản dịch do user gõ',
        retryBlocked: false,
      };

      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch do user gõ"
          conflictState={conflict}
          onDraftChange={vi.fn()}
          onDiscardDraft={onDiscardDraftSpy}
          onSave={vi.fn()}
          onClearConflict={onClearConflictSpy}
        />,
      );

      expect(
        screen.getByTestId('editor-occ-conflict-banner'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Máy chủ đã được cập nhật lên v3 \(bạn đang chỉnh sửa dựa trên v2\)/),
      ).toBeInTheDocument();

      // User draft remains visible in textarea
      expect(screen.getByTestId('segment-translation-textarea')).toHaveValue(
        'Bản dịch do user gõ',
      );

      // Invariant P2: If onLoadServerVersion is not provided, destructive fallback is completely prevented
      expect(screen.queryByTestId('btn-load-server-version')).not.toBeInTheDocument();
      expect(onDiscardDraftSpy).not.toHaveBeenCalled();
      expect(onClearConflictSpy).not.toHaveBeenCalled();
    });

    it('btn-load-server-version calls onLoadServerVersion, disables inputs/actions, and displays loading spinner while syncing', async () => {
      let resolveSync: () => void;
      const syncPromise = new Promise<void>((resolve) => {
        resolveSync = resolve;
      });
      const onLoadServerVersionSpy = vi.fn().mockReturnValue(syncPromise);
      const onDiscardDraftSpy = vi.fn();

      const conflict: ConflictState = {
        kind: 'VERSION_CONFLICT',
        segmentId: 'seg-101',
        currentVersion: 3,
        expectedVersion: 2,
        retryBlocked: false,
      };

      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch do user gõ"
          conflictState={conflict}
          onDraftChange={vi.fn()}
          onDiscardDraft={onDiscardDraftSpy}
          onSave={vi.fn()}
          onLoadServerVersion={onLoadServerVersionSpy}
        />,
      );

      const loadServerBtn = screen.getByTestId('btn-load-server-version');
      const textarea = screen.getByTestId('segment-translation-textarea');
      const keepDraftBtn = screen.getByTestId('btn-keep-draft');
      const discardBtn = screen.getByTestId('btn-discard-draft');

      expect(loadServerBtn).toBeEnabled();
      expect(textarea).toBeEnabled();

      fireEvent.click(loadServerBtn);

      expect(onLoadServerVersionSpy).toHaveBeenCalledWith('seg-101');
      expect(screen.getByText('Đang nạp...')).toBeInTheDocument();
      expect(loadServerBtn).toBeDisabled();
      // Invariant P1-2: Textarea, keep-draft, and discard are disabled during sync
      expect(textarea).toBeDisabled();
      expect(keepDraftBtn).toBeDisabled();
      expect(discardBtn).toBeDisabled();
      // Invariant P2: Component NEVER executes destructive discard on its own
      expect(onDiscardDraftSpy).not.toHaveBeenCalled();

      await act(async () => {
        resolveSync!();
        await syncPromise;
      });

      expect(screen.queryByText('Đang nạp...')).not.toBeInTheDocument();
      expect(textarea).toBeEnabled();
    });

    it('action keep draft clears conflict notification without discarding user draft', () => {
      const onDiscardDraftSpy = vi.fn();
      const onClearConflictSpy = vi.fn();
      const conflict: ConflictState = {
        kind: 'VERSION_CONFLICT',
        segmentId: 'seg-101',
        currentVersion: 3,
        expectedVersion: 2,
        retryBlocked: false,
      };

      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch của tôi"
          conflictState={conflict}
          onDraftChange={vi.fn()}
          onDiscardDraft={onDiscardDraftSpy}
          onSave={vi.fn()}
          onClearConflict={onClearConflictSpy}
        />,
      );

      const keepDraftBtn = screen.getByTestId('btn-keep-draft');
      fireEvent.click(keepDraftBtn);
      expect(onClearConflictSpy).toHaveBeenCalledWith('seg-101');
      expect(onDiscardDraftSpy).not.toHaveBeenCalled();
    });

    it('renders orphan banner and blocks save when segment was removed on server', () => {
      const onSaveSpy = vi.fn();
      const conflict: ConflictState = {
        kind: 'SEGMENT_REMOVED',
        segmentId: 'seg-101',
        retryBlocked: true,
      };

      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch ô bị xóa"
          conflictState={conflict}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={onSaveSpy}
        />,
      );

      expect(
        screen.getByTestId('editor-segment-removed-banner'),
      ).toBeInTheDocument();
      expect(screen.getByText('Phân đoạn đã bị xóa')).toBeInTheDocument();

      // Save button is strictly disabled because isRetryBlocked is true
      const saveBtn = screen.getByTestId('btn-save-segment');
      expect(saveBtn).toBeDisabled();
    });

    it('renders save error banner with retry action on network / server error', () => {
      const onSaveSpy = vi.fn();
      const error: ParsedApiError = {
        code: 'NETWORK_TIMEOUT',
        message: 'Kết nối máy chủ bị gián đoạn',
        status: 0,
      };

      render(
        <MangaSegmentEditor
          segment={mockSegment}
          draftText="Bản dịch lỗi mạng"
          saveError={error}
          onDraftChange={vi.fn()}
          onDiscardDraft={vi.fn()}
          onSave={onSaveSpy}
        />,
      );

      expect(screen.getByTestId('editor-save-error-banner')).toBeInTheDocument();
      expect(
        screen.getByText('Kết nối máy chủ bị gián đoạn'),
      ).toBeInTheDocument();

      const retryBtn = screen.getByTestId('btn-retry-save');
      fireEvent.click(retryBtn);
      expect(onSaveSpy).toHaveBeenCalledWith('seg-101', 'Bản dịch lỗi mạng');
    });
  });

  describe('4. Hook Draft Management & Invariants (RED 3)', () => {
    const mockDetail: TranslationJobReviewDetailResponse = {
      job: {
        id: 'job-1',
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
        story: { id: 's1', title: 'Manga Test', slug: 'manga-test', mediaFormat: MediaFormat.COMIC },
        edition: { id: 'e1', editionName: 'Việt', language: 'vi', isDefault: true },
        chapter: { id: 'c1', chapterNumber: '1.00', title: 'Chương 1' },
        project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
        sourceVersion: { id: 'v1', versionNumber: 1 },
        targetVersion: null,
      },
      reviewSummary: {
        segmentCount: 1,
        verifiedCount: 0,
        pageCount: 3,
        resultPageCount: 3,
        blockCount: null,
      },
      permissions: {
        canApply: true,
      },
    };

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue(mockDetail);
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [mockSegment],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });
      vi.mocked(translationApi.fetchTranslationJobPreviews).mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 1,
      });
    });

    it('draft is user-owned by segmentId and survives page navigation without silent discard', async () => {
      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User types a draft for seg-101
      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản nháp trang 1');
      });
      expect(result.current.drafts['seg-101']).toBe('Bản nháp trang 1');

      // User navigates to page 2
      await act(async () => {
        result.current.goToPage(2);
      });
      expect(result.current.currentPage).toBe(2);

      // Invariant: Draft must NOT be silently discarded on page change!
      expect(result.current.drafts['seg-101']).toBe('Bản nháp trang 1');
    });

    it('authoritative refetch / reconcile does NOT overwrite user draft', async () => {
      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản nháp người dùng');
      });

      // Server returns updated segment text on background sync
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, translatedText: 'Văn bản mới từ server' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      await act(async () => {
        await result.current.refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
      });

      // Invariant: User draft survives authoritative refetch intact!
      expect(result.current.drafts['seg-101']).toBe('Bản nháp người dùng');
    });

    it('successful saveSegment commits update and clears draft from memory when authoritative sync is coherent', async () => {
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: 'Bản dịch hoàn tất',
        version: 3,
      });
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, translatedText: 'Bản dịch hoàn tất', version: 3 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản dịch hoàn tất');
      });
      expect(result.current.drafts['seg-101']).toBe('Bản dịch hoàn tất');

      await act(async () => {
        const saveRes = await result.current.saveSegment('seg-101', 'Bản dịch hoàn tất', {
          baseVersion: 2,
        });
        expect(saveRes.outcome).toBe('SAVED_AND_SYNCED');
      });

      // Draft is discarded on coherent authoritative save
      expect(result.current.drafts['seg-101']).toBeUndefined();
    });

    it('P1-1: PATCH 200 + authoritative refetch FAILED preserves user draft', async () => {
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: 'Bản dịch mới của user',
        version: 3,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản dịch mới của user');
      });

      // Subsequent refetchDetail fails
      vi.mocked(translationApi.fetchTranslationJobDetail).mockRejectedValueOnce(
        new Error('Network timeout during refetch'),
      );

      let saveRes: any;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-101', 'Bản dịch mới của user', {
          baseVersion: 2,
        });
      });

      expect(saveRes.commitState).toBe('COMMITTED');
      expect(saveRes.workspaceState).toBe('RECONCILIATION_REQUIRED');
      // Invariant P1-1: User draft MUST NOT be cleared on reconcile failure!
      expect(result.current.drafts['seg-101']).toBe('Bản dịch mới của user');
    });

    it('P1-1: PATCH 200 + STATE_CHANGED preserves user draft in reviewable workspace', async () => {
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: 'Bản dịch user',
        version: 3,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản dịch user');
      });

      // Server returns updated detail with revision mismatch (transient STATE_CHANGED)
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce({
        ...mockDetail,
        job: {
          ...mockDetail.job,
          workspaceRevision: 99,
          reviewRevision: 99,
        },
      });
      // Segments has old revision, triggering coherence mismatch -> STATE_CHANGED
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValueOnce({
        data: [{ ...mockSegment }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 50, // Mismatches detail workspaceRevision 99
      });

      let saveRes: any;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-101', 'Bản dịch user', {
          baseVersion: 2,
        });
      });

      expect(saveRes.commitState).toBe('COMMITTED');
      // Invariant: Draft is preserved!
      expect(result.current.drafts['seg-101']).toBe('Bản dịch user');
    });

    it('P1-1: Current-scope 401/403 purges drafts via access security lifecycle', async () => {
      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Nháp bảo mật');
      });
      expect(result.current.drafts['seg-101']).toBe('Nháp bảo mật');

      // Attempt save which receives 401 Unauthorized
      const authErr: any = new Error('Unauthorized');
      authErr.isAxiosError = true;
      authErr.response = {
        status: 401,
        data: { error: { code: 'UNAUTHORIZED', message: 'Phiên đăng nhập hết hạn' } },
      };
      vi.mocked(translationApi.updateTranslationSegment).mockRejectedValueOnce(authErr);

      await act(async () => {
        await result.current.saveSegment('seg-101', 'Nháp bảo mật', { baseVersion: 2 });
      });

      // Security invariant: 401 triggers purgeOnAccessError, which wipes all drafts
      expect(result.current.drafts['seg-101']).toBeUndefined();
    });

    it('P1-1: Post-PATCH refetch discovers terminal state (APPLIED) and purges drafts', async () => {
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: 'Nháp trước khi apply',
        version: 3,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Nháp trước khi apply');
      });

      // Refetch returns job transitioned to APPLIED
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValueOnce({
        ...mockDetail,
        job: {
          ...mockDetail.job,
          status: TranslationJobStatus.APPLIED,
          workspaceRevision: 2,
          reviewRevision: 2,
        },
      });

      await act(async () => {
        await result.current.saveSegment('seg-101', 'Nháp trước khi apply', { baseVersion: 2 });
      });

      // Invariant: Terminal/applied state purges drafts
      expect(result.current.drafts['seg-101']).toBeUndefined();
    });

    it('P1-2: Empty-string draft can be discarded and clears back to canonical text', async () => {
      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // User clears the entire textarea: draft is ""
      act(() => {
        result.current.setSegmentDraft('seg-101', '');
      });
      expect(result.current.drafts['seg-101']).toBe('');

      // User clicks "Hủy thay đổi" (discardSegmentDraft)
      act(() => {
        result.current.discardSegmentDraft('seg-101');
      });

      // Invariant P1-2: hasOwnProperty check ensures "" draft is deleted
      expect(result.current.drafts['seg-101']).toBeUndefined();
      expect(resolveDisplayDraft(mockSegment.translatedText, result.current.drafts, 'seg-101')).toBe(
        mockSegment.translatedText,
      );
    });

    it('P1-2: Empty-string draft is successfully deleted from drafts upon coherent save', async () => {
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: '',
        version: 3,
      });
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, translatedText: '', version: 3 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 1,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', '');
      });
      expect(result.current.drafts['seg-101']).toBe('');

      await act(async () => {
        const saveRes = await result.current.saveSegment('seg-101', '', { baseVersion: 2 });
        expect(saveRes.outcome).toBe('SAVED_AND_SYNCED');
      });

      // Invariant P1-2: Draft key is deleted, not stuck as ""
      expect(Object.prototype.hasOwnProperty.call(result.current.drafts, 'seg-101')).toBe(false);
    });

    it('P2-1: savingSegmentIds sequence guard prevents premature clearance on race A/B', async () => {
      let resolveSaveA: (val: any) => void;
      const saveAPromise = new Promise((resolve) => {
        resolveSaveA = resolve;
      });
      let resolveSaveB: (val: any) => void;
      const saveBPromise = new Promise((resolve) => {
        resolveSaveB = resolve;
      });

      vi.mocked(translationApi.updateTranslationSegment)
        .mockReturnValueOnce(saveAPromise as any)
        .mockReturnValueOnce(saveBPromise as any);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      let pA: Promise<any>;
      let pB: Promise<any>;

      // Save A starts (mutationSeq 1)
      act(() => {
        pA = result.current.saveSegment('seg-101', 'Text A', { baseVersion: 2 });
      });
      expect(result.current.savingSegmentIds['seg-101']).toBe(true);

      // Save B starts quickly after (mutationSeq 2)
      act(() => {
        pB = result.current.saveSegment('seg-101', 'Text B', { baseVersion: 2 });
      });
      expect(result.current.savingSegmentIds['seg-101']).toBe(true);

      // Save A completes first
      await act(async () => {
        resolveSaveA!({ ...mockSegment, translatedText: 'Text A', version: 3 });
        await pA;
      });

      // Invariant P2-1: Save A's finally MUST NOT delete saving flag while Save B is still in-flight!
      expect(result.current.savingSegmentIds['seg-101']).toBe(true);

      // Save B completes
      await act(async () => {
        resolveSaveB!({ ...mockSegment, translatedText: 'Text B', version: 4 });
        await pB;
      });

      // Now saving flag is safely cleared
      expect(result.current.savingSegmentIds['seg-101']).toBeFalsy();
    });

    it('P2: segmentSaveErrors provides scoped error isolation per segment', async () => {
      const serverErr: any = new Error('Server 500');
      serverErr.isAxiosError = true;
      serverErr.response = {
        status: 500,
        data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Lỗi máy chủ lưu seg-101' } },
      };
      vi.mocked(translationApi.updateTranslationSegment).mockRejectedValueOnce(serverErr);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      await act(async () => {
        await result.current.saveSegment('seg-101', 'Failed text', { baseVersion: 2 });
      });

      // Error is isolated to seg-101
      expect(result.current.segmentSaveErrors['seg-101']).toBeDefined();
      expect(result.current.segmentSaveErrors['seg-101']?.code).toBe('INTERNAL_SERVER_ERROR');
      // Other segment does NOT inherit the error
      expect(result.current.segmentSaveErrors['seg-other']).toBeUndefined();
    });

    it('P2-Conflict: loadServerVersion safely reconciles without premature draft discard', async () => {
      const conflictErr: any = new Error('Version conflict');
      conflictErr.isAxiosError = true;
      conflictErr.response = {
        status: 409,
        data: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Conflict',
            meta: { currentVersion: 3, expectedVersion: 2 },
          },
        },
      };
      vi.mocked(translationApi.updateTranslationSegment).mockRejectedValue(conflictErr);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản nháp của tôi');
      });

      await act(async () => {
        await result.current.saveSegment('seg-101', 'Bản nháp của tôi', { baseVersion: 2 });
      });
      expect(result.current.conflictStates['seg-101']?.kind).toBe('VERSION_CONFLICT');

      // Scenario A: Server sync fails or returns stale version -> loadServerVersion returns false, preserves draft & conflict
      vi.mocked(translationApi.fetchTranslationJobDetail).mockRejectedValueOnce(new Error('Sync failed'));

      let loadOk = false;
      await act(async () => {
        loadOk = await result.current.loadServerVersion('seg-101');
      });
      expect(loadOk).toBe(false);
      expect(result.current.drafts['seg-101']).toBe('Bản nháp của tôi');
      expect(result.current.conflictStates['seg-101']).toBeDefined();

      // Scenario B: Server sync succeeds with version >= 3 -> loadServerVersion returns true, discards draft & clears conflict
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue({
        ...mockDetail,
        job: {
          ...mockDetail.job,
          workspaceRevision: 2,
          reviewRevision: 2,
        },
      });
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, version: 3, translatedText: 'Text mới từ máy chủ' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.mocked(translationApi.fetchTranslationJobPreviews).mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      await act(async () => {
        loadOk = await result.current.loadServerVersion('seg-101');
      });
      expect(loadOk).toBe(true);
      // Now draft is safely discarded and conflict cleared
      expect(result.current.drafts['seg-101']).toBeUndefined();
      expect(result.current.conflictStates['seg-101']).toBeUndefined();
    });

    it('P1-1: Mutation-level coherence mismatch (A/v3 committed but authoritative GET returns B/v4) preserves draft and returns RECONCILIATION_REQUIRED', async () => {
      // Writer A commits Text A with version 3
      vi.mocked(translationApi.updateTranslationSegment).mockResolvedValue({
        ...mockSegment,
        translatedText: 'Text A',
        version: 3,
      });

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Text A');
      });

      // While post-save refetch runs, another writer commits Text B with version 4
      // Authoritative workspace is coherent at rev 2, but authSeg has Text B / v4
      vi.mocked(translationApi.fetchTranslationJobDetail).mockResolvedValue({
        ...mockDetail,
        job: {
          ...mockDetail.job,
          workspaceRevision: 2,
          reviewRevision: 2,
        },
      });
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, translatedText: 'Text B', version: 4 }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.mocked(translationApi.fetchTranslationJobPreviews).mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let saveRes: any;
      await act(async () => {
        saveRes = await result.current.saveSegment('seg-101', 'Text A', { baseVersion: 2 });
      });

      // Invariant P1-1:
      // Authoritative workspace refetch was SYNCED, but mutation-level coherence failed (Text A != Text B).
      // Draft A MUST be preserved, workspaceState = RECONCILIATION_REQUIRED, outcome != SAVED_AND_SYNCED
      expect(result.current.drafts['seg-101']).toBe('Text A');
      expect(saveRes.commitState).toBe('COMMITTED');
      expect(saveRes.workspaceState).toBe('RECONCILIATION_REQUIRED');
      expect(saveRes.success).toBe(false);
      expect(saveRes.outcome).not.toBe('SAVED_AND_SYNCED');
      expect(saveRes.outcome).toBe('SAVED_SYNC_FAILED');
    });

    it('P1-2: loadServerVersion with in-flight draft edit preserves new draft D2 and returns false', async () => {
      const conflictErr: any = new Error('Version conflict');
      conflictErr.isAxiosError = true;
      conflictErr.response = {
        status: 409,
        data: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Conflict',
            meta: { currentVersion: 3, expectedVersion: 2 },
          },
        },
      };
      vi.mocked(translationApi.updateTranslationSegment).mockRejectedValue(conflictErr);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      // 1. Initial draft D1 and conflict state
      act(() => {
        result.current.setSegmentDraft('seg-101', 'Draft D1');
      });
      await act(async () => {
        await result.current.saveSegment('seg-101', 'Draft D1', { baseVersion: 2 });
      });
      expect(result.current.conflictStates['seg-101']?.kind).toBe('VERSION_CONFLICT');

      // 2. User clicks "Nạp bản mới từ máy chủ" -> loadServerVersion begins with deferred refetch
      let resolveDetail: (val: any) => void;
      const deferredDetail = new Promise((resolve) => {
        resolveDetail = resolve;
      });
      vi.mocked(translationApi.fetchTranslationJobDetail).mockReturnValueOnce(deferredDetail as any);

      let loadPromise: Promise<boolean>;
      act(() => {
        loadPromise = result.current.loadServerVersion('seg-101');
      });

      // 3. While sync is pending in-flight, user edits draft to D2
      act(() => {
        result.current.setSegmentDraft('seg-101', 'Draft D2');
      });
      expect(result.current.drafts['seg-101']).toBe('Draft D2');

      // 4. Server sync completes successfully with version 3
      vi.mocked(translationApi.fetchTranslationJobSegments).mockResolvedValue({
        data: [{ ...mockSegment, version: 3, translatedText: 'Text v3 từ server' }],
        pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: 2,
      });
      vi.mocked(translationApi.fetchTranslationJobPreviews).mockResolvedValue({
        sourceAssets: [],
        resultAssets: [],
        workspaceRevision: 2,
      });

      let loadOk: boolean = true;
      await act(async () => {
        resolveDetail!({
          ...mockDetail,
          job: {
            ...mockDetail.job,
            workspaceRevision: 2,
            reviewRevision: 2,
          },
        });
        loadOk = await loadPromise;
      });

      // Invariant P1-2:
      // Token mismatch detected! loadServerVersion must return false and NOT discard Draft D2!
      expect(loadOk).toBe(false);
      expect(result.current.drafts['seg-101']).toBe('Draft D2');
    });

    it('409 VERSION_CONFLICT preserves user draft and sets conflict metadata', async () => {
      const conflictErr: any = new Error('Version conflict');
      conflictErr.isAxiosError = true;
      conflictErr.response = {
        status: 409,
        data: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Segment has been modified by another editor',
            meta: { currentVersion: 3, expectedVersion: 2 },
          },
        },
      };
      vi.mocked(translationApi.updateTranslationSegment).mockRejectedValue(conflictErr);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      act(() => {
        result.current.setSegmentDraft('seg-101', 'Bản dịch xung đột của tôi');
      });

      await act(async () => {
        const saveRes = await result.current.saveSegment('seg-101', 'Bản dịch xung đột của tôi', {
          baseVersion: 2,
        });
        expect(saveRes.outcome).toBe('VERSION_CONFLICT');
      });

      // Invariant: Draft must NOT be erased on 409!
      expect(result.current.drafts['seg-101']).toBe('Bản dịch xung đột của tôi');
      expect(result.current.conflictStates['seg-101']?.kind).toBe('VERSION_CONFLICT');
      expect(result.current.conflictStates['seg-101']?.currentVersion).toBe(3);
    });

    it('savingSegmentIds tracks per-segment in-flight save state', async () => {
      let resolvePromise: (val: any) => void;
      const delayedSave = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      vi.mocked(translationApi.updateTranslationSegment).mockReturnValue(delayedSave as any);

      const { result } = renderHook(() => useMangaReviewStudio('job-1'));
      await waitFor(() => expect(result.current.status).toBe('ready'));

      expect(result.current.savingSegmentIds['seg-101']).toBeFalsy();

      let savePromise: Promise<any>;
      act(() => {
        savePromise = result.current.saveSegment('seg-101', 'Text', { baseVersion: 2 });
      });

      // In flight: savingSegmentIds['seg-101'] is true
      expect(result.current.savingSegmentIds['seg-101']).toBe(true);

      await act(async () => {
        resolvePromise!({ ...mockSegment, version: 3 });
        await savePromise;
      });

      // Completed: savingSegmentIds['seg-101'] is false / undefined
      expect(result.current.savingSegmentIds['seg-101']).toBeFalsy();
    });
  });

  describe('4. RED 4: Verification Interactions, Action Matrix & Bounded Traversal', () => {
    describe('Policy Rules', () => {
      it('canToggleVerification confirms dirty drafts remain verification-eligible via atomic mutation', () => {
        const baseParams = {
          isDirty: false,
          canEdit: true,
          isGateClosed: false,
          isSaving: false,
          isVerifying: false,
          hasPendingMutation: false,
          isRetryBlocked: false,
          hasConflict: false,
        };

        expect(canToggleVerification(baseParams)).toBe(true);
        // Dirty draft can still be verified (atomic save & verify)
        expect(canToggleVerification({ ...baseParams, isDirty: true })).toBe(true);
        // Locked if saving or verifying
        expect(canToggleVerification({ ...baseParams, isSaving: true })).toBe(false);
        expect(canToggleVerification({ ...baseParams, isVerifying: true })).toBe(false);
        // Locked if gate closed or canEdit false
        expect(canToggleVerification({ ...baseParams, canEdit: false })).toBe(false);
        expect(canToggleVerification({ ...baseParams, isGateClosed: true })).toBe(false);
        // Locked if conflict or pending mutation
        expect(canToggleVerification({ ...baseParams, hasConflict: true })).toBe(false);
        expect(canToggleVerification({ ...baseParams, hasPendingMutation: true })).toBe(false);
      });

      it('resolveActionMatrixState resolves 4 distinct states correctly', () => {
        const base = {
          isDirty: false,
          isHumanVerified: false,
          canEdit: true,
          isGateClosed: false,
          isSaving: false,
          isVerifying: false,
          hasPendingMutation: false,
          isRetryBlocked: false,
          hasConflict: false,
        };

        expect(resolveActionMatrixState(base)).toBe('UNVERIFIED_CLEAN');
        expect(resolveActionMatrixState({ ...base, isHumanVerified: true })).toBe('VERIFIED_CLEAN');
        expect(resolveActionMatrixState({ ...base, isDirty: true })).toBe('UNVERIFIED_DIRTY');
        expect(resolveActionMatrixState({ ...base, isDirty: true, isHumanVerified: true })).toBe('VERIFIED_DIRTY');
        expect(resolveActionMatrixState({ ...base, canEdit: false })).toBe('MUTATION_BLOCKED');
        expect(resolveActionMatrixState({ ...base, isSaving: true })).toBe('MUTATION_BLOCKED');
        expect(resolveActionMatrixState({ ...base, isVerifying: true })).toBe('MUTATION_BLOCKED');
        expect(resolveActionMatrixState({ ...base, hasConflict: true })).toBe('MUTATION_BLOCKED');
      });

      it('bounded traversal helpers clamp correctly to bounds without auto-wrap', () => {
        // Next: clamped to totalSegments - 1
        expect(findNextSegmentIndex(0, 5)).toBe(1);
        expect(findNextSegmentIndex(4, 5)).toBe(4);
        expect(findNextSegmentIndex(-1, 5)).toBe(0);

        // Prev: clamped to 0
        expect(findPrevSegmentIndex(4, 5)).toBe(3);
        expect(findPrevSegmentIndex(0, 5)).toBe(0);

        // Next unverified: finds next index with isHumanVerified === false
        const segments = [
          { isHumanVerified: true },
          { isHumanVerified: true },
          { isHumanVerified: false },
          { isHumanVerified: true },
        ];
        // When currentIndex < 0: scans from 0 and finds first unverified
        expect(findNextUnverifiedIndex(-1, segments)).toBe(2);
        expect(findNextUnverifiedIndex(0, segments)).toBe(2);
        expect(findNextUnverifiedIndex(1, segments)).toBe(2);
        // When already at or past index 2: does NOT wrap around, clamps to current index
        expect(findNextUnverifiedIndex(2, segments)).toBe(2);
        expect(findNextUnverifiedIndex(3, segments)).toBe(3);
      });

      it('IME composition and editable target guards work as expected', () => {
        expect(isImeComposing({ isComposing: true } as any)).toBe(true);
        expect(isImeComposing({ isComposing: false, keyCode: 229 } as any)).toBe(true);
        expect(isImeComposing({ isComposing: false, keyCode: 86 } as any)).toBe(false);

        // Verification hotkey evaluator
        expect(
          shouldHandleStudioVerificationHotkey({
            key: 'v',
            altKey: true,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            isComposing: false,
          } as any),
        ).toBe(true);

        // Single 'v' inside editable target is suppressed
        const inputEl = document.createElement('input');
        expect(isEditableTarget(inputEl)).toBe(true);
        expect(
          shouldHandleStudioVerificationHotkey({
            key: 'v',
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            isComposing: false,
            target: inputEl,
          } as any),
        ).toBe(false);
      });
    });

    describe('UI Controls & Interactions', () => {
      it('renders badge-unverified when segment is not verified, and badge-verified when verified', () => {
        const { rerender } = render(
          <MangaSegmentEditor
            segment={{ ...mockSegment, isHumanVerified: false }}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
          />,
        );

        expect(screen.getByTestId('badge-unverified')).toBeInTheDocument();
        expect(screen.getByText('Chưa xác minh')).toBeInTheDocument();
        expect(screen.getByTestId('btn-toggle-verify')).toHaveTextContent('Duyệt');

        rerender(
          <MangaSegmentEditor
            segment={{ ...mockSegment, isHumanVerified: true }}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
          />,
        );

        expect(screen.getByTestId('badge-verified')).toBeInTheDocument();
        expect(screen.getByText('Đã xác minh')).toBeInTheDocument();
        expect(screen.getByTestId('btn-toggle-verify')).toHaveTextContent('Bỏ duyệt');
      });

      it('renders "Lưu & Duyệt" and enables btn-toggle-verify when draft is dirty on unverified segment', () => {
        const toggleSpy = vi.fn();
        render(
          <MangaSegmentEditor
            segment={mockSegment}
            draftText="Bản nháp chưa lưu"
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
            onToggleVerification={toggleSpy}
          />,
        );

        const verifyBtn = screen.getByTestId('btn-toggle-verify');
        expect(verifyBtn).not.toBeDisabled();
        expect(verifyBtn).toHaveTextContent('Lưu & Duyệt');
        fireEvent.click(verifyBtn);
        expect(toggleSpy).toHaveBeenCalledWith('seg-101');
      });

      it('renders "Lưu & Bỏ duyệt" when draft is dirty on verified segment', () => {
        render(
          <MangaSegmentEditor
            segment={{ ...mockSegment, isHumanVerified: true }}
            draftText="Bản nháp đã sửa"
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
          />,
        );

        const verifyBtn = screen.getByTestId('btn-toggle-verify');
        expect(verifyBtn).not.toBeDisabled();
        expect(verifyBtn).toHaveTextContent('Lưu & Bỏ duyệt');
      });

      it('calls onToggleVerification when clicking btn-toggle-verify on clean segment', () => {
        const toggleSpy = vi.fn();
        render(
          <MangaSegmentEditor
            segment={mockSegment}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
            onToggleVerification={toggleSpy}
          />,
        );

        const verifyBtn = screen.getByTestId('btn-toggle-verify');
        expect(verifyBtn).not.toBeDisabled();
        expect(verifyBtn).toHaveTextContent('Duyệt');
        fireEvent.click(verifyBtn);
        expect(toggleSpy).toHaveBeenCalledWith('seg-101');
      });

      it('traversal buttons render and trigger traversal callbacks', () => {
        const onPrevSpy = vi.fn();
        const onNextSpy = vi.fn();
        const onNextUnverifiedSpy = vi.fn();

        render(
          <MangaSegmentEditor
            segment={mockSegment}
            hasPrevSegment={true}
            hasNextSegment={true}
            hasNextUnverified={true}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
            onPrevSegment={onPrevSpy}
            onNextSegment={onNextSpy}
            onNextUnverified={onNextUnverifiedSpy}
          />,
        );

        const prevBtn = screen.getByTestId('btn-prev-segment');
        const nextBtn = screen.getByTestId('btn-next-segment');
        const nextUnverifiedBtn = screen.getByTestId('btn-next-unverified');

        expect(prevBtn).not.toBeDisabled();
        expect(nextBtn).not.toBeDisabled();
        expect(nextUnverifiedBtn).not.toBeDisabled();

        fireEvent.click(prevBtn);
        expect(onPrevSpy).toHaveBeenCalledTimes(1);

        fireEvent.click(nextBtn);
        expect(onNextSpy).toHaveBeenCalledTimes(1);

        fireEvent.click(nextUnverifiedBtn);
        expect(onNextUnverifiedSpy).toHaveBeenCalledTimes(1);
      });

      it('disables traversal buttons when flags are false', () => {
        render(
          <MangaSegmentEditor
            segment={mockSegment}
            hasPrevSegment={false}
            hasNextSegment={false}
            hasNextUnverified={false}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
          />,
        );

        expect(screen.getByTestId('btn-prev-segment')).toBeDisabled();
        expect(screen.getByTestId('btn-next-segment')).toBeDisabled();
        expect(screen.getByTestId('btn-next-unverified')).toBeDisabled();
      });

      it('global hotkeys (J, K, U, Alt+V) trigger corresponding callbacks', () => {
        const onToggleSpy = vi.fn();
        const onPrevSpy = vi.fn();
        const onNextSpy = vi.fn();
        const onNextUnverifiedSpy = vi.fn();

        render(
          <MangaSegmentEditor
            segment={mockSegment}
            hasPrevSegment={true}
            hasNextSegment={true}
            hasNextUnverified={true}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
            onToggleVerification={onToggleSpy}
            onPrevSegment={onPrevSpy}
            onNextSegment={onNextSpy}
            onNextUnverified={onNextUnverifiedSpy}
          />,
        );

        // Alt+V for verify
        fireEvent.keyDown(window, { key: 'v', altKey: true });
        expect(onToggleSpy).toHaveBeenCalledWith('seg-101');

        // J for next
        fireEvent.keyDown(window, { key: 'j' });
        expect(onNextSpy).toHaveBeenCalledTimes(1);

        // K for prev
        fireEvent.keyDown(window, { key: 'k' });
        expect(onPrevSpy).toHaveBeenCalledTimes(1);

        // U for next unverified
        fireEvent.keyDown(window, { key: 'u' });
        expect(onNextUnverifiedSpy).toHaveBeenCalledTimes(1);
      });

      it('suppresses hotkeys when IME is composing', () => {
        const onToggleSpy = vi.fn();
        render(
          <MangaSegmentEditor
            segment={mockSegment}
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={vi.fn()}
            onToggleVerification={onToggleSpy}
          />,
        );

        fireEvent.keyDown(window, { key: 'v', altKey: true, isComposing: true });
        expect(onToggleSpy).not.toHaveBeenCalled();
      });

      it('enforces hotkey precedence in textarea: Ctrl+Shift+Enter triggers verify, Ctrl+Enter triggers save', () => {
        const onSaveSpy = vi.fn();
        const onToggleSpy = vi.fn();

        render(
          <MangaSegmentEditor
            segment={mockSegment}
            draftText="Đoạn văn dịch nháp"
            onDraftChange={vi.fn()}
            onDiscardDraft={vi.fn()}
            onSave={onSaveSpy}
            onToggleVerification={onToggleSpy}
          />,
        );

        const textarea = screen.getByTestId('segment-translation-textarea');

        // Ctrl+Shift+Enter => verify takes precedence, ordinary save must NOT fire
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, shiftKey: true });
        expect(onToggleSpy).toHaveBeenCalledTimes(1);
        expect(onToggleSpy).toHaveBeenCalledWith('seg-101');
        expect(onSaveSpy).not.toHaveBeenCalled();

        // Ctrl+Enter (without shift) => ordinary save fires, verify must NOT fire
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, shiftKey: false });
        expect(onSaveSpy).toHaveBeenCalledTimes(1);
        expect(onSaveSpy).toHaveBeenCalledWith('seg-101', 'Đoạn văn dịch nháp');
        expect(onToggleSpy).toHaveBeenCalledTimes(1); // still 1
      });
    });
  });
});
