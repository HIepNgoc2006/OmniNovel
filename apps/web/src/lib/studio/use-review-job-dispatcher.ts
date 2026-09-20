'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TranslationJobReviewDetailResponse,
  MediaFormat,
} from '@omninovel/shared';
import {
  fetchTranslationJobDetail,
  parseApiError,
  ParsedApiError,
} from '../api/translation';
import { useAuth } from '../auth/auth-context';

export type ReviewDispatcherStatus =
  | 'initializing'
  | 'auth_required'
  | 'loading'
  | 'ready'
  | 'error';

export interface UseReviewJobDispatcherReturn {
  status: ReviewDispatcherStatus;
  jobDetail: TranslationJobReviewDetailResponse | null;
  error: ParsedApiError | null;
  mediaFormat: MediaFormat | null;
  isSupportedFormat: boolean;
  refetchDetail: () => Promise<TranslationJobReviewDetailResponse | null>;
  updateJobDetail: (detail: TranslationJobReviewDetailResponse | null) => void;
}

export function useReviewJobDispatcher(
  jobId: string,
): UseReviewJobDispatcherReturn {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<ReviewDispatcherStatus>('initializing');
  const [jobDetail, setJobDetail] =
    useState<TranslationJobReviewDetailResponse | null>(null);
  const [error, setError] = useState<ParsedApiError | null>(null);
  const activeJobIdRef = useRef(jobId);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    activeJobIdRef.current = jobId;
  }, [jobId]);

  const loadAuthoritativeDetail = useCallback(async () => {
    if (authLoading) return null;
    if (!isAuthenticated) {
      setStatus('auth_required');
      return null;
    }

    const currentSeq = ++loadSeqRef.current;
    const currentJob = activeJobIdRef.current;

    setStatus('loading');
    setError(null);

    try {
      const detail = await fetchTranslationJobDetail(currentJob);
      if (
        activeJobIdRef.current !== currentJob ||
        currentSeq !== loadSeqRef.current
      ) {
        return null;
      }
      setJobDetail(detail);
      setStatus('ready');
      return detail;
    } catch (err) {
      if (
        activeJobIdRef.current !== currentJob ||
        currentSeq !== loadSeqRef.current
      ) {
        return null;
      }
      const parsed = parseApiError(err);
      setError(parsed);
      setStatus('error');
      return null;
    }
  }, [authLoading, isAuthenticated]);

  useEffect(() => {
    if (authLoading) {
      setStatus('initializing');
      return;
    }
    if (!isAuthenticated) {
      setStatus('auth_required');
      return;
    }
    void loadAuthoritativeDetail();
  }, [authLoading, isAuthenticated, jobId, loadAuthoritativeDetail]);

  const updateJobDetail = useCallback(
    (detail: TranslationJobReviewDetailResponse | null) => {
      setJobDetail(detail);
    },
    [],
  );

  const rawFormat = jobDetail?.context?.story?.mediaFormat;
  const mediaFormat =
    rawFormat === MediaFormat.COMIC || rawFormat === MediaFormat.NOVEL
      ? rawFormat
      : null;
  const isSupportedFormat = mediaFormat !== null;

  return {
    status,
    jobDetail,
    error,
    mediaFormat,
    isSupportedFormat,
    refetchDetail: loadAuthoritativeDetail,
    updateJobDetail,
  };
}
