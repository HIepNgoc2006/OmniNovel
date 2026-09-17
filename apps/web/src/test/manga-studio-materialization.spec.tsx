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
import {
  evaluateMaterializationPollOutcome,
  getMaterializationCtaProps,
  MAX_MATERIALIZATION_POLL_ATTEMPTS,
  MATERIALIZATION_POLL_BACKOFF_MS,
  INITIAL_MATERIALIZATION_LIFECYCLE_STATE,
} from '../lib/studio/manga-studio-policy';
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

describe('Manga Review Studio Materialization Lifecycle (#149 RED 5, #157)', () => {
  const mockJobId = 'job-comic-red5';

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
        title: 'Chapter 1',
      },
      project: {
        id: 'proj-1',
        sourceLanguage: 'ja',
        targetLanguage: 'vi',
      },
      sourceVersion: {
        id: 'v1',
        versionNumber: 1,
      },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 2,
      verifiedCount: 1,
      pageCount: 3,
      resultPageCount: 3,
      blockCount: null,
    },
  };

  const mockStaleJobDetail: TranslationJobReviewDetailResponse = {
    ...mockComicJobDetail,
    job: {
      ...mockComicJobDetail.job,
      reviewRevision: 2,
      materializedRevision: 1,
      workspaceRevision: 2,
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
      bboxX: 10,
      bboxY: 40,
      bboxW: 50,
      bboxH: 20,
      rawText: 'さようなら',
      translatedText: 'Tạm biệt',
      confidence: 0.9,
      isHumanVerified: false,
      version: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', username: 'testuser', email: 'test@omninovel.com', role: 'USER' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(mockStaleJobDetail);
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockImplementation(async () => {
      const currentDetail = await translationApi.fetchTranslationJobDetail(mockJobId);
      return {
        data: mockSegments,
        pagination: { total: 2, page: 1, limit: 50, totalPages: 1 },
        workspaceRevision: currentDetail.job.workspaceRevision,
      };
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockImplementation(async () => {
      const currentDetail = await translationApi.fetchTranslationJobDetail(mockJobId);
      return {
        sourceAssets: [
          {
            kind: 'SOURCE_REVIEW',
            pageNumber: 1,
            width: 800,
            height: 1200,
            url: 'https://cdn.example.com/source-1.png',
          },
        ],
        resultAssets: [
          {
            kind: 'RESULT',
            pageNumber: 1,
            width: 800,
            height: 1200,
            url: `https://cdn.example.com/result-v${currentDetail.job.workspaceRevision}-1.png`,
          },
        ],
        workspaceRevision: currentDetail.job.workspaceRevision,
      };
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================
  // 1. Pure Policy Unit Tests
  // ==========================================
  describe('Pure Policy: evaluateMaterializationPollOutcome', () => {
    it('returns ERROR on revision invariant violation', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 1,
        materializedRevision: 2, // Violation!
        targetRevision: 1,
        pollAttempts: 1,
      });

      expect(outcome.phase).toBe('ERROR');
      expect(outcome.isComplete).toBe(false);
    });

    it('returns STOPPED if job status is no longer READY_FOR_REVIEW', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.FAILED,
        reviewRevision: 2,
        materializedRevision: 1,
        targetRevision: 2,
        pollAttempts: 1,
      });

      expect(outcome.phase).toBe('STOPPED');
    });

    it('returns SUPERSEDED if reviewRevision > targetRevision (Lock C)', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 3, // Advanced on server
        materializedRevision: 1,
        targetRevision: 2, // Pinned session target
        pollAttempts: 2,
      });

      expect(outcome.phase).toBe('SUPERSEDED');
      expect(outcome.isSuperseded).toBe(true);
    });

    it('returns REFRESHING if materializedRevision === targetRevision === reviewRevision (Lock B)', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 2, // Authoritative proof!
        targetRevision: 2,
        pollAttempts: 3,
      });

      expect(outcome.phase).toBe('REFRESHING');
      expect(outcome.isComplete).toBe(true);
    });

    it('returns UNCONFIRMED if poll budget is exhausted without completion', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        targetRevision: 2,
        pollAttempts: MAX_MATERIALIZATION_POLL_ATTEMPTS,
      });

      expect(outcome.phase).toBe('UNCONFIRMED');
      expect(outcome.isExhausted).toBe(true);
    });

    it('returns TRACKING while render is in progress and budget remains', () => {
      const outcome = evaluateMaterializationPollOutcome({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        targetRevision: 2,
        pollAttempts: 1,
      });

      expect(outcome.phase).toBe('TRACKING');
      expect(outcome.isComplete).toBe(false);
      expect(outcome.isSuperseded).toBe(false);
    });
  });

  describe('Pure Policy: getMaterializationCtaProps', () => {
    it('disables CTA when workspace cannot materialize', () => {
      const props = getMaterializationCtaProps({
        lifecycleState: INITIAL_MATERIALIZATION_LIFECYCLE_STATE,
        freshness: { isFresh: false, needsMaterialize: true, status: 'STALE' },
        canMaterialize: false,
      });

      expect(props.disabled).toBe(true);
      expect(props.actionType).toBe('NONE');
    });

    it('returns loading state for SUBMITTING, TRACKING, and REFRESHING', () => {
      const trackingProps = getMaterializationCtaProps({
        lifecycleState: {
          phase: 'TRACKING',
          targetRevision: 2,
          requestStatus: 'ENQUEUED',
          pollAttempts: 1,
          lastError: null,
        },
        freshness: { isFresh: false, needsMaterialize: true, status: 'STALE' },
        canMaterialize: true,
      });

      expect(trackingProps.isLoading).toBe(true);
      expect(trackingProps.disabled).toBe(true);
      expect(trackingProps.label).toContain('2');
    });

    it('enables TRIGGER for SUPERSEDED phase with explanatory message', () => {
      const props = getMaterializationCtaProps({
        lifecycleState: {
          phase: 'SUPERSEDED',
          targetRevision: 2,
          requestStatus: 'ENQUEUED',
          pollAttempts: 2,
          lastError: null,
        },
        freshness: { isFresh: false, needsMaterialize: true, status: 'STALE' },
        canMaterialize: true,
      });

      expect(props.disabled).toBe(false);
      expect(props.actionType).toBe('TRIGGER');
      expect(props.label).toContain('Kết xuất lại');
      expect(props.helperMessage).toBeDefined();
    });

    it('enables RECHECK for UNCONFIRMED phase with dedicated action', () => {
      const props = getMaterializationCtaProps({
        lifecycleState: {
          phase: 'UNCONFIRMED',
          targetRevision: 2,
          requestStatus: 'ENQUEUED',
          pollAttempts: 10,
          lastError: null,
        },
        freshness: { isFresh: false, needsMaterialize: true, status: 'STALE' },
        canMaterialize: true,
      });

      expect(props.disabled).toBe(false);
      expect(props.actionType).toBe('RECHECK');
      expect(props.label).toContain('Kiểm tra lại');
      expect(props.helperMessage).toBeDefined();
    });

    it('shows completed badge for FRESH phase', () => {
      const props = getMaterializationCtaProps({
        lifecycleState: {
          phase: 'FRESH',
          targetRevision: 2,
          requestStatus: 'ENQUEUED',
          pollAttempts: 3,
          lastError: null,
        },
        freshness: { isFresh: true, needsMaterialize: false, status: 'FRESH' },
        canMaterialize: true,
      });

      expect(props.disabled).toBe(true);
      expect(props.icon).toBe('CHECK');
      expect(props.label).toContain('Đã Đồng Bộ');
    });
  });

  // ==========================================
  // 2. Hook Integration Tests
  // ==========================================
  describe('Hook Integration: Materialization Lifecycle & Polling', () => {
    it('Lock A & B: POST enqueues -> stays TRACKING -> polls -> proves completion -> FRESH', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.freshness.status).toBe('STALE');
      expect(result.current.materializationLifecycle.phase).toBe('IDLE');

      // Trigger materialization
      let reqPromise: any;
      act(() => {
        reqPromise = result.current.triggerMaterialization();
      });

      // While HTTP POST is resolving, phase is SUBMITTING and isMaterializing is true
      expect(result.current.materializationLifecycle.phase).toBe('SUBMITTING');
      expect(result.current.isMaterializing).toBe(true);

      await act(async () => {
        await reqPromise;
      });

      // Lock A: ENQUEUED !== COMPLETED! UI remains in TRACKING, isMaterializing is STILL true!
      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');
      expect(result.current.materializationLifecycle.targetRevision).toBe(2);
      expect(result.current.isMaterializing).toBe(true);
      expect(result.current.materializationStatus).toBe('ENQUEUED');

      // Polling step 1: server detail still shows materializedRevision = 1
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[0]);
      });

      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');
      expect(result.current.materializationLifecycle.pollAttempts).toBe(1);

      // Polling step 2: server detail proves completion (Lock B)!
      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3, // Backend atomically advanced workspaceRevision
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[1]);
      });

      // Reconciled to FRESH!
      expect(result.current.materializationLifecycle.phase).toBe('FRESH');
      expect(result.current.isMaterializing).toBe(false);
      expect(result.current.jobDetail?.job.materializedRevision).toBe(2);
    });

    it('Lock C: target revision immutable - newer reviewRevision supersedes in-flight session', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');

      // Server detail returns reviewRevision 3 (user or collaborator edited)
      const supersededJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          reviewRevision: 3,
          materializedRevision: 1,
          workspaceRevision: 4,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(supersededJobDetail);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[0]);
      });

      // Transitions to SUPERSEDED, halting polling loop
      expect(result.current.materializationLifecycle.phase).toBe('SUPERSEDED');
      expect(result.current.isMaterializing).toBe(false);
    });

    it('Amendment 2: UNCONFIRMED allows recheckMaterialization without re-posting', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      // Exhaust all poll attempts
      for (let i = 0; i < MAX_MATERIALIZATION_POLL_ATTEMPTS; i++) {
        vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[i] ?? 5000);
        });
      }

      expect(result.current.materializationLifecycle.phase).toBe('UNCONFIRMED');
      expect(result.current.isMaterializing).toBe(false);

      // Triggering materialization is BLOCKED in UNCONFIRMED
      const blockedRes = await act(async () => {
        return await result.current.triggerMaterialization();
      });
      expect(blockedRes).toBeNull();
      expect(translationApi.requestJobMaterialization).toHaveBeenCalledTimes(1);

      // Dedicated recheck action checks detail and proves completion
      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);

      await act(async () => {
        await result.current.recheckMaterialization();
      });

      // Still only 1 POST call was ever made!
      expect(translationApi.requestJobMaterialization).toHaveBeenCalledTimes(1);
      expect(result.current.materializationLifecycle.phase).toBe('FRESH');
    });

    it('ALREADY_FRESH bypasses polling and immediately updates to FRESH', async () => {
      // Hook starts with STALE job detail
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);

      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3,
        },
      };

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ALREADY_FRESH',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.freshness.status).toBe('STALE');

      // Subsequent refetchDetail will fetch completedJobDetail
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationLifecycle.phase).toBe('FRESH');
      expect(result.current.isMaterializing).toBe(false);
      expect(result.current.jobDetail?.job.materializedRevision).toBe(2);
    });

    it('Mutation during TRACKING does not cancel session until server confirms revision', async () => {
      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');

      // User initiates segment edit while tracking
      vi.spyOn(translationApi, 'updateTranslationSegment').mockImplementation(
        () => new Promise(() => {}), // In-flight PATCH
      );

      act(() => {
        void result.current.saveSegment('seg-2', 'Chỉnh sửa mới');
      });

      // Invariant: In-flight mutation does NOT cancel tracking immediately
      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');
      expect(result.current.isMaterializing).toBe(true);
    });

    it('Poll completion proof transitions to ERROR and does NOT transition to FRESH when preview reconciliation fails (Lock D failure guard)', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      expect(result.current.materializationLifecycle.phase).toBe('TRACKING');

      // Server detail proves completion (revisions match)
      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);

      // But preview fetch fails or is rejected during refetchDetail!
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue(
        new Error('Network failure while fetching preview assets'),
      );

      // Advance timer to trigger poll step
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[0] + 50);
      });

      // Crucial: Must transition to ERROR, NEVER to FRESH when Lock D fails!
      expect(result.current.materializationLifecycle.phase).toBe('ERROR');
      expect(result.current.materializationLifecycle.phase).not.toBe('FRESH');
      expect(result.current.isMaterializing).toBe(false);
      expect(result.current.materializationLifecycle.lastError).toBeDefined();
    });

    it('ALREADY_FRESH transitions to ERROR and does NOT transition to FRESH when authoritative reconciliation fails', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);

      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3,
        },
      };

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ALREADY_FRESH',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);
      // Preview reconciliation fails
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue(
        new Error('Preview API 500 error'),
      );

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      // Must be ERROR, not FRESH
      expect(result.current.materializationLifecycle.phase).toBe('ERROR');
      expect(result.current.materializationLifecycle.phase).not.toBe('FRESH');
      expect(result.current.isMaterializing).toBe(false);
      expect(result.current.materializationLifecycle.lastError).toBeDefined();
    });

    it('recheckMaterialization transitions to ERROR when preview reconciliation fails', async () => {
      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValueOnce(mockStaleJobDetail);

      vi.spyOn(translationApi, 'requestJobMaterialization').mockResolvedValue({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      const { result } = renderHook(() => useMangaReviewStudio(mockJobId));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        await result.current.triggerMaterialization();
      });

      // Exhaust polling budget to enter UNCONFIRMED
      for (let i = 0; i < MAX_MATERIALIZATION_POLL_ATTEMPTS; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MATERIALIZATION_POLL_BACKOFF_MS[i] + 50);
        });
      }

      expect(result.current.materializationLifecycle.phase).toBe('UNCONFIRMED');

      const completedJobDetail: TranslationJobReviewDetailResponse = {
        ...mockStaleJobDetail,
        job: {
          ...mockStaleJobDetail.job,
          materializedRevision: 2,
          reviewRevision: 2,
          workspaceRevision: 3,
        },
      };

      vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(completedJobDetail);
      vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockRejectedValue(
        new Error('Previews unavailable'),
      );

      let recheckSuccess = true;
      await act(async () => {
        recheckSuccess = await result.current.recheckMaterialization();
      });

      expect(recheckSuccess).toBe(false);
      expect(result.current.materializationLifecycle.phase).toBe('ERROR');
      expect(result.current.materializationLifecycle.phase).not.toBe('FRESH');
      expect(result.current.isMaterializing).toBe(false);
    });
  });
});
