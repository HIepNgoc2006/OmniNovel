'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import {
  fetchTranslationJobDetail,
  fetchTranslationJobSegments,
  updateTranslationSegment,
  parseApiError,
  ParsedApiError,
} from '../api/translation';
import { useAuth } from '../auth/auth-context';
import {
  NovelReviewBlock,
  NovelWorkspaceModeResult,
  getNovelStudioWorkspaceMode,
  sortNovelSegmentsDeterministic,
  groupSegmentsByAnchorBlock,
  buildUpdateSegmentPayload,
} from './novel-studio-policy';
import { validateSegmentTopology } from './novel-segment-policy';

export interface UseNovelReviewStudioOptions {
  initialJobDetail?: TranslationJobReviewDetailResponse | null;
  onJobDetailChange?: (detail: TranslationJobReviewDetailResponse | null) => void;
}

export interface UseNovelReviewStudioReturn {
  status: 'initializing' | 'auth_required' | 'loading' | 'ready' | 'error';
  jobDetail: TranslationJobReviewDetailResponse | null;
  error: ParsedApiError | null;
  segments: TranslationSegmentDto[];
  blocks: NovelReviewBlock[];
  workspaceMode: NovelWorkspaceModeResult | null;
  segmentsLoading: boolean;
  segmentsError: string | null;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;
  refetchDetail: () => Promise<TranslationJobReviewDetailResponse | null>;
  refetchSegments: () => Promise<void>;
  updateJobDetail: (detail: TranslationJobReviewDetailResponse | null) => void;
  // Segment edits & OCC states
  drafts: Record<string, string>;
  savingSegmentIds: Record<string, boolean>;
  conflictStates: Record<string, string>;
  errorStates: Record<string, string>;
  setSegmentDraft: (segmentId: string, text: string) => void;
  discardSegmentDraft: (segmentId: string) => void;
  saveSegment: (segmentId: string) => Promise<boolean | TranslationSegmentDto>;
  toggleVerification: (segmentId: string) => Promise<boolean | TranslationSegmentDto>;
}

export function useNovelReviewStudio(
  jobId: string,
  options?: UseNovelReviewStudioOptions,
): UseNovelReviewStudioReturn {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<
    'initializing' | 'auth_required' | 'loading' | 'ready' | 'error'
  >('initializing');
  const [jobDetail, setJobDetail] =
    useState<TranslationJobReviewDetailResponse | null>(null);
  const [error, setError] = useState<ParsedApiError | null>(null);
  const [segments, setSegments] = useState<TranslationSegmentDto[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const [savingSegmentIds, setSavingSegmentIds] = useState<
    Record<string, boolean>
  >({});
  const [conflictStates, setConflictStates] = useState<Record<string, string>>(
    {},
  );
  const [errorStates, setErrorStates] = useState<Record<string, string>>({});

  const activeJobIdRef = useRef(jobId);
  const loadSeqRef = useRef(0);
  const initialDetailConsumedRef = useRef(false);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    activeJobIdRef.current = jobId;
  }, [jobId]);

  const workspaceMode = useMemo<NovelWorkspaceModeResult | null>(() => {
    if (!jobDetail) return null;
    return getNovelStudioWorkspaceMode({
      jobStatus: jobDetail.job.status,
      mediaFormat: jobDetail.context.story.mediaFormat,
    });
  }, [jobDetail]);

  const blocks = useMemo(() => {
    return groupSegmentsByAnchorBlock(segments);
  }, [segments]);

  // Progressive Exhaustive Paginated Segments Loader
  const loadAllSegments = useCallback(
    async (targetJobId: string, currentSeq: number) => {
      setSegmentsLoading(true);
      setSegmentsError(null);

      try {
        let currentPage = 1;
        let totalPages = 1;
        const accumulatedSegments: TranslationSegmentDto[] = [];
        const PAGE_LIMIT = 200; // Limit <= 200 per #155

        while (currentPage <= totalPages) {
          const response = await fetchTranslationJobSegments(targetJobId, {
            page: currentPage,
            limit: PAGE_LIMIT,
          });

          if (
            activeJobIdRef.current !== targetJobId ||
            loadSeqRef.current !== currentSeq
          ) {
            return;
          }

          accumulatedSegments.push(...response.data);
          totalPages = response.pagination?.totalPages ?? 1;
          currentPage++;
        }

        const sorted = sortNovelSegmentsDeterministic(accumulatedSegments);
        setSegments(sorted);
        setSegmentsLoading(false);
      } catch (err) {
        if (
          activeJobIdRef.current !== targetJobId ||
          loadSeqRef.current !== currentSeq
        ) {
          return;
        }
        setSegmentsError(
          parseApiError(err).message ||
            'Không thể tải danh sách phân đoạn tiểu thuyết.',
        );
        setSegmentsLoading(false);
      }
    },
    [],
  );

  const loadJobData = useCallback(async () => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    const currentSeq = ++loadSeqRef.current;
    const currentJob = activeJobIdRef.current;

    setStatus('loading');
    setError(null);

    try {
      let detail: TranslationJobReviewDetailResponse;
      if (
        options?.initialJobDetail &&
        options.initialJobDetail.job.id === currentJob &&
        !initialDetailConsumedRef.current
      ) {
        initialDetailConsumedRef.current = true;
        detail = options.initialJobDetail;
      } else {
        detail = await fetchTranslationJobDetail(currentJob);
      }

      if (
        activeJobIdRef.current !== currentJob ||
        loadSeqRef.current !== currentSeq
      ) {
        return;
      }

      setJobDetail(detail);
      setStatus('ready');
      optionsRef.current?.onJobDetailChange?.(detail);

      const mode = getNovelStudioWorkspaceMode({
        jobStatus: detail.job.status,
        mediaFormat: detail.context.story.mediaFormat,
      });

      if (mode.mode === 'REVIEWABLE') {
        void loadAllSegments(currentJob, currentSeq);
      } else {
        setSegments([]);
      }
    } catch (err) {
      if (
        activeJobIdRef.current !== currentJob ||
        loadSeqRef.current !== currentSeq
      ) {
        return;
      }
      const parsed = parseApiError(err);
      setError(parsed);
      setStatus('error');
    }
  }, [authLoading, isAuthenticated, loadAllSegments, options?.initialJobDetail]);

  useEffect(() => {
    void loadJobData();
  }, [loadJobData]);

  const refetchDetail = useCallback(async () => {
    const currentJob = activeJobIdRef.current;
    try {
      const detail = await fetchTranslationJobDetail(currentJob);
      setJobDetail(detail);
      optionsRef.current?.onJobDetailChange?.(detail);
      return detail;
    } catch {
      return null;
    }
  }, []);

  const refetchSegments = useCallback(async () => {
    const currentSeq = ++loadSeqRef.current;
    await loadAllSegments(activeJobIdRef.current, currentSeq);
  }, [loadAllSegments]);

  const updateJobDetail = useCallback(
    (detail: TranslationJobReviewDetailResponse | null) => {
      setJobDetail(detail);
      optionsRef.current?.onJobDetailChange?.(detail);
    },
    [],
  );

  const setSegmentDraft = useCallback((segmentId: string, text: string) => {
    setDrafts((prev) => ({ ...prev, [segmentId]: text }));
    setErrorStates((prev) => {
      if (!prev[segmentId]) return prev;
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    setConflictStates((prev) => {
      if (!prev[segmentId]) return prev;
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
  }, []);

  const discardSegmentDraft = useCallback((segmentId: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    setErrorStates((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    setConflictStates((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
  }, []);

  const saveSegment = useCallback(
    async (segmentId: string): Promise<boolean | TranslationSegmentDto> => {
      const seg = segmentsRef.current.find((s) => s.id === segmentId);
      if (!seg) return false;

      const draft = draftsRef.current[segmentId];
      if (draft === undefined || draft === (seg.translatedText ?? '')) {
        return false;
      }

      // 1. Client UX gate validation
      const validation = validateSegmentTopology(seg.rawText, draft, {
        segmentId: seg.id,
        anchorBlockId: seg.anchorBlockId ?? undefined,
      });

      if (!validation.valid) {
        setErrorStates((prev) => ({
          ...prev,
          [segmentId]: validation.error || 'Cấu trúc thẻ bảo vệ không hợp lệ.',
        }));
        return false;
      }

      // 2. Build OCC payload (only translatedText and expectedVersion)
      const payload = buildUpdateSegmentPayload({
        expectedVersion: seg.version,
        translatedText: draft,
        isHumanVerified: false,
      });

      setSavingSegmentIds((prev) => ({ ...prev, [segmentId]: true }));
      setErrorStates((prev) => {
        const next = { ...prev };
        delete next[segmentId];
        return next;
      });
      setConflictStates((prev) => {
        const next = { ...prev };
        delete next[segmentId];
        return next;
      });

      try {
        const updated = await updateTranslationSegment(
          activeJobIdRef.current,
          segmentId,
          payload,
        );

        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? updated : s)),
        );
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[segmentId];
          return next;
        });

        // Sync reviewSummary verifiedCount if verification state changed
        setJobDetail((prev) => {
          if (!prev) return prev;
          const wasVerified = seg.isHumanVerified;
          const isVerified = updated.isHumanVerified;
          const verifiedDiff =
            isVerified === wasVerified ? 0 : isVerified ? 1 : -1;
          return {
            ...prev,
            reviewSummary: {
              ...prev.reviewSummary,
              verifiedCount: Math.max(
                0,
                prev.reviewSummary.verifiedCount + verifiedDiff,
              ),
            },
          };
        });

        return updated;
      } catch (err: any) {
        const parsed = parseApiError(err);
        if (parsed.code === 'VERSION_CONFLICT' || parsed.status === 409) {
          setConflictStates((prev) => ({
            ...prev,
            [segmentId]:
              parsed.message ||
              'Xung đột phiên bản (409): Dữ liệu trên server đã được cập nhật.',
          }));
        } else if (
          parsed.code === 'ANCHOR_TOPOLOGY_VIOLATION' ||
          parsed.status === 400
        ) {
          setErrorStates((prev) => ({
            ...prev,
            [segmentId]:
              parsed.message || 'Lỗi cấu trúc thẻ bảo vệ từ server authoritative',
          }));
        } else {
          setErrorStates((prev) => ({
            ...prev,
            [segmentId]: parsed.message || 'Lỗi khi lưu phân đoạn dịch.',
          }));
        }
        return false;
      } finally {
        setSavingSegmentIds((prev) => ({ ...prev, [segmentId]: false }));
      }
    },
    [segments, drafts],
  );

  const toggleVerification = useCallback(
    async (segmentId: string): Promise<boolean | TranslationSegmentDto> => {
      const seg = segmentsRef.current.find((s) => s.id === segmentId);
      if (!seg) return false;

      const nextVerified = !seg.isHumanVerified;
      const payload = {
        expectedVersion: seg.version,
        isHumanVerified: nextVerified,
      };

      setSavingSegmentIds((prev) => ({ ...prev, [segmentId]: true }));
      try {
        const updated = await updateTranslationSegment(
          activeJobIdRef.current,
          segmentId,
          payload,
        );

        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? updated : s)),
        );

        setJobDetail((prev) => {
          if (!prev) return prev;
          const verifiedDiff = nextVerified ? 1 : -1;
          return {
            ...prev,
            reviewSummary: {
              ...prev.reviewSummary,
              verifiedCount: Math.max(
                0,
                prev.reviewSummary.verifiedCount + verifiedDiff,
              ),
            },
          };
        });

        return updated;
      } catch (err) {
        const parsed = parseApiError(err);
        if (parsed.code === 'VERSION_CONFLICT' || parsed.status === 409) {
          setConflictStates((prev) => ({
            ...prev,
            [segmentId]: parsed.message || 'Xung đột phiên bản (409).',
          }));
        } else {
          setErrorStates((prev) => ({
            ...prev,
            [segmentId]:
              parsed.message || 'Không thể thay đổi trạng thái duyệt.',
          }));
        }
        return false;
      } finally {
        setSavingSegmentIds((prev) => ({ ...prev, [segmentId]: false }));
      }
    },
    [segments],
  );

  return {
    status,
    jobDetail,
    error,
    segments,
    blocks,
    workspaceMode,
    segmentsLoading,
    segmentsError,
    selectedSegmentId,
    setSelectedSegmentId,
    refetchDetail,
    refetchSegments,
    updateJobDetail,
    drafts,
    savingSegmentIds,
    conflictStates,
    errorStates,
    setSegmentDraft,
    discardSegmentDraft,
    saveSegment,
    toggleVerification,
  };
}
