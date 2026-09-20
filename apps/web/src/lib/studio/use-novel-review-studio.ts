'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
} from '@omninovel/shared';
import {
  fetchTranslationJobDetail,
  fetchTranslationJobSegments,
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
} from './novel-studio-policy';

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
  };
}
