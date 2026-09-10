import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobPreviewsResponse,
  MaterializationRequestResponse,
  MaterializationRequestStatus,
  UpdateTranslationSegmentRequest,
} from '@omninovel/shared';
import {
  fetchTranslationJobDetail,
  fetchTranslationJobSegments,
  fetchTranslationJobPreviews,
  updateTranslationSegment,
  requestJobMaterialization,
  parseApiError,
  ParsedApiError,
} from '../api/translation';
import {
  getMangaStudioWorkspaceMode,
  computeAuthoritativePageCount,
  computeMaterializationFreshness,
  classifyConflictError,
  WorkspaceModeResult,
  MaterializationFreshnessResult,
} from './manga-studio-policy';
import { useAuth } from '../auth/auth-context';

export interface ConflictState {
  segmentId: string;
  currentVersion?: number;
  expectedVersion?: number;
  draftText: string;
}

export interface SaveSegmentOptions {
  isHumanVerified?: boolean;
  baseVersion?: number;
}

export interface UseMangaReviewStudioReturn {
  status: 'initializing' | 'auth_required' | 'loading' | 'ready' | 'error';
  jobDetail: TranslationJobReviewDetailResponse | null;
  segments: TranslationSegmentDto[];
  previews: TranslationJobPreviewsResponse | null;
  workspaceMode: WorkspaceModeResult | null;
  pageCountInfo: { pageCount: number | null; isAvailable: boolean };
  freshness: MaterializationFreshnessResult;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;
  conflictState: ConflictState | null;
  clearConflict: () => void;
  saveSegment: (
    segmentId: string,
    text: string,
    options?: SaveSegmentOptions,
  ) => Promise<boolean>;
  triggerMaterialization: () => Promise<MaterializationRequestResponse | null>;
  materializationStatus: MaterializationRequestStatus | null;
  error: ParsedApiError | null;
  refetchDetail: () => Promise<void>;
  retry: () => Promise<void>;
}

export function useMangaReviewStudio(jobId: string): UseMangaReviewStudioReturn {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [status, setStatus] = useState<
    'initializing' | 'auth_required' | 'loading' | 'ready' | 'error'
  >('initializing');
  const [jobDetail, setJobDetail] =
    useState<TranslationJobReviewDetailResponse | null>(null);
  const [segments, setSegments] = useState<TranslationSegmentDto[]>([]);
  const [previews, setPreviews] =
    useState<TranslationJobPreviewsResponse | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [materializationStatus, setMaterializationStatus] =
    useState<MaterializationRequestStatus | null>(null);
  const [error, setError] = useState<ParsedApiError | null>(null);
  const [overrideWorkspaceMode, setOverrideWorkspaceMode] =
    useState<WorkspaceModeResult | null>(null);

  // Invariant Protection: Identity, Session & Sequence Tracking
  const activeJobIdRef = useRef(jobId);
  const generationRef = useRef(0);
  const latestDetailSeqRef = useRef(0);
  const dataLoadSeqRef = useRef(0);
  const latestConfirmedRevisionRef = useRef(0);
  const userSessionIdRef = useRef<string | null>(user?.id ?? null);

  const isRequestCurrent = useCallback(
    (targetGen: number, targetJob: string): boolean => {
      return (
        generationRef.current === targetGen &&
        activeJobIdRef.current === targetJob &&
        userSessionIdRef.current === (user?.id ?? null)
      );
    },
    [user?.id],
  );

  const resetState = useCallback(() => {
    setJobDetail(null);
    setSegments([]);
    setPreviews(null);
    setSelectedSegmentId(null);
    setConflictState(null);
    setMaterializationStatus(null);
    setError(null);
    setOverrideWorkspaceMode(null);
    setCurrentPage(1);
    latestConfirmedRevisionRef.current = 0;
  }, []);

  const purgeOnAccessError = useCallback(
    (parsedErr: ParsedApiError, targetGen?: number, targetJob?: string) => {
      // Scope validation: Do NOT purge if error is from an older generation or a different job
      if (targetGen !== undefined && targetGen !== generationRef.current) {
        return;
      }
      if (targetJob !== undefined && targetJob !== activeJobIdRef.current) {
        return;
      }

      // Invalidate all pending requests for this generation & sequence
      generationRef.current++;
      dataLoadSeqRef.current++;

      resetState();
      setError(parsedErr);
      setStatus('error');
    },
    [resetState],
  );

  const isAccessError = (err: ParsedApiError): boolean => {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.status === 404 ||
      err.code === 'FORBIDDEN' ||
      err.code === 'NOT_FOUND' ||
      err.code === 'UNAUTHORIZED'
    );
  };

  const loadJobData = useCallback(async () => {
    if (authLoading || !isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    const currentGen = generationRef.current;
    const currentJob = jobId;
    const detailSeq = ++latestDetailSeqRef.current;
    const dataLoadSeq = ++dataLoadSeqRef.current;

    setStatus('loading');
    setError(null);

    try {
      // 1. Fetch Authoritative Job Detail
      const detail = await fetchTranslationJobDetail(currentJob);
      if (!isRequestCurrent(currentGen, currentJob)) {
        return;
      }
      if (detailSeq < latestDetailSeqRef.current) {
        return;
      }

      setJobDetail(detail);
      latestConfirmedRevisionRef.current = Math.max(
        latestConfirmedRevisionRef.current,
        detail.job.reviewRevision,
      );

      // Determine workspace mode based on status, format, and authoritative page count
      const modeResult = getMangaStudioWorkspaceMode({
        jobStatus: detail.job.status,
        mediaFormat: detail.context.story.mediaFormat,
        resultPageCount: detail.reviewSummary?.resultPageCount,
      });

      // 2. Fetch Segments if reviewable or monitor
      if (modeResult.mode !== 'UNSUPPORTED_FORMAT' && modeResult.mode !== 'COUNT_UNAVAILABLE') {
        try {
          const segRes = await fetchTranslationJobSegments(currentJob, 1, 100);
          if (
            !isRequestCurrent(currentGen, currentJob) ||
            dataLoadSeq !== dataLoadSeqRef.current
          ) {
            return;
          }
          setSegments(segRes.data || []);
        } catch (segErr) {
          if (!isRequestCurrent(currentGen, currentJob)) {
            return;
          }
          const parsed = parseApiError(segErr);
          if (isAccessError(parsed)) {
            purgeOnAccessError(parsed, currentGen, currentJob);
            return;
          }
          throw segErr;
        }
      }

      // 3. Fetch Previews ONLY if reviewable
      if (modeResult.canPreview) {
        try {
          const prevRes = await fetchTranslationJobPreviews(currentJob, {
            pageNumber: 1,
          });
          if (
            !isRequestCurrent(currentGen, currentJob) ||
            dataLoadSeq !== dataLoadSeqRef.current
          ) {
            return;
          }
          setPreviews(prevRes);
        } catch (prevErr) {
          if (!isRequestCurrent(currentGen, currentJob)) {
            return;
          }
          const parsed = parseApiError(prevErr);
          if (isAccessError(parsed)) {
            purgeOnAccessError(parsed, currentGen, currentJob);
            return;
          }
          console.warn('Initial previews fetch warning:', prevErr);
        }
      }

      if (isRequestCurrent(currentGen, currentJob)) {
        setError(null);
        setStatus('ready');
      }
    } catch (err) {
      if (!isRequestCurrent(currentGen, currentJob)) {
        return;
      }
      const parsedErr = parseApiError(err);
      purgeOnAccessError(parsedErr, currentGen, currentJob);
    }
  }, [
    jobId,
    authLoading,
    isAuthenticated,
    isRequestCurrent,
    purgeOnAccessError,
  ]);

  // Handle job switch, session change, or auth changes
  useEffect(() => {
    activeJobIdRef.current = jobId;
    userSessionIdRef.current = user?.id ?? null;
    generationRef.current++;
    dataLoadSeqRef.current++;
    resetState();

    if (authLoading || !isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    loadJobData();
  }, [jobId, user?.id, authLoading, isAuthenticated, resetState, loadJobData]);

  // Derived calculations
  const workspaceMode: WorkspaceModeResult | null =
    overrideWorkspaceMode ||
    (jobDetail
      ? getMangaStudioWorkspaceMode({
          jobStatus: jobDetail.job.status,
          mediaFormat: jobDetail.context.story.mediaFormat,
          resultPageCount: jobDetail.reviewSummary?.resultPageCount,
        })
      : null);

  const pageCountInfo = computeAuthoritativePageCount(jobDetail?.reviewSummary);

  const freshness = computeMaterializationFreshness(
    jobDetail?.job.reviewRevision,
    jobDetail?.job.materializedRevision,
  );

  const clearConflict = useCallback(() => {
    setConflictState(null);
  }, []);

  const retry = useCallback(async () => {
    generationRef.current++;
    dataLoadSeqRef.current++;
    resetState();
    await loadJobData();
  }, [resetState, loadJobData]);

  const refetchDetail = useCallback(async () => {
    if (status === 'error') {
      await retry();
      return;
    }

    const currentGen = generationRef.current;
    const currentJob = activeJobIdRef.current;
    const detailSeq = ++latestDetailSeqRef.current;

    try {
      const detail = await fetchTranslationJobDetail(currentJob);

      if (!isRequestCurrent(currentGen, currentJob)) {
        return;
      }
      if (detailSeq < latestDetailSeqRef.current) {
        return;
      }

      // Invariant: Do not allow an out-of-order older response to downgrade reviewRevision
      if (detail.job.reviewRevision < latestConfirmedRevisionRef.current) {
        return;
      }

      latestConfirmedRevisionRef.current = Math.max(
        latestConfirmedRevisionRef.current,
        detail.job.reviewRevision,
      );

      setJobDetail(detail);
      setOverrideWorkspaceMode(null);
      setError(null);

      // Reconcile workspace mode and dynamically coordinate data loading
      const newMode = getMangaStudioWorkspaceMode({
        jobStatus: detail.job.status,
        mediaFormat: detail.context.story.mediaFormat,
        resultPageCount: detail.reviewSummary?.resultPageCount,
      });

      if (newMode.mode === 'REVIEWABLE') {
        const dataLoadSeq = ++dataLoadSeqRef.current;

        // Fetch segments
        fetchTranslationJobSegments(currentJob, 1, 100)
          .then((segRes) => {
            if (
              isRequestCurrent(currentGen, currentJob) &&
              dataLoadSeq === dataLoadSeqRef.current
            ) {
              setSegments(segRes.data || []);
            }
          })
          .catch((err) => {
            if (!isRequestCurrent(currentGen, currentJob)) return;
            const parsed = parseApiError(err);
            if (isAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
            }
          });

        // Fetch previews
        fetchTranslationJobPreviews(currentJob, { pageNumber: 1 })
          .then((prevRes) => {
            if (
              isRequestCurrent(currentGen, currentJob) &&
              dataLoadSeq === dataLoadSeqRef.current
            ) {
              setPreviews(prevRes);
            }
          })
          .catch((err) => {
            if (!isRequestCurrent(currentGen, currentJob)) return;
            const parsed = parseApiError(err);
            if (isAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
            }
          });
      } else {
        // Clean up both preview assets AND segments when leaving reviewable state,
        // and bump dataLoadSeq to drop any in-flight requests from the previous state
        dataLoadSeqRef.current++;
        setPreviews(null);
        setSegments([]);
      }
    } catch (err) {
      if (!isRequestCurrent(currentGen, currentJob)) {
        return;
      }
      const parsed = parseApiError(err);
      if (isAccessError(parsed)) {
        purgeOnAccessError(parsed, currentGen, currentJob);
      } else {
        console.warn('Failed to refetch job detail:', err);
      }
    }
  }, [
    status,
    retry,
    isRequestCurrent,
    purgeOnAccessError,
  ]);

  const saveSegment = useCallback(
    async (
      segmentId: string,
      text: string,
      options?: SaveSegmentOptions,
    ): Promise<boolean> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      // Fail-closed guard: Cannot edit if mode does not allow editing
      if (!workspaceMode || !workspaceMode.canEdit) {
        return false;
      }

      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) {
        return false;
      }

      const expectedVersion = options?.baseVersion ?? segment.version;
      const payload: UpdateTranslationSegmentRequest = {
        translatedText: text,
        expectedVersion,
      };

      // Strict Save Semantics: Only send isHumanVerified when caller explicitly requests it
      if (typeof options?.isHumanVerified === 'boolean') {
        payload.isHumanVerified = options.isHumanVerified;
      }

      try {
        const updated = await updateTranslationSegment(targetJob, segmentId, payload);

        if (!isRequestCurrent(currentGen, targetJob)) {
          return false;
        }

        // Reconcile local segment state with authoritative response
        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, ...updated } : s)),
        );
        setConflictState(null);

        // Reconcile job detail from server to sync reviewRevision
        await refetchDetail();

        return true;
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob)) {
          return false;
        }

        const parsed = parseApiError(err);
        if (isAccessError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return false;
        }

        const conflict = classifyConflictError(err);

        if (conflict.type === 'VERSION_CONFLICT') {
          setConflictState({
            segmentId,
            currentVersion: conflict.currentVersion,
            expectedVersion: conflict.expectedVersion,
            draftText: text,
          });
        } else if (conflict.type === 'NOT_REVIEWABLE') {
          setOverrideWorkspaceMode({
            mode: 'PIPELINE_MONITOR',
            canPreview: false,
            canEdit: false,
            canMaterialize: false,
            message: conflict.message,
          });
        } else {
          setError(parsed);
        }

        return false;
      }
    },
    [segments, workspaceMode, isRequestCurrent, refetchDetail, purgeOnAccessError],
  );

  const triggerMaterialization =
    useCallback(async (): Promise<MaterializationRequestResponse | null> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      if (!workspaceMode || !workspaceMode.canMaterialize) {
        return null;
      }

      try {
        const res = await requestJobMaterialization(targetJob);

        if (!isRequestCurrent(currentGen, targetJob)) {
          return null;
        }

        setMaterializationStatus(res.status);

        if (res.status === 'ALREADY_FRESH') {
          // Authoritative sync with backend
          await refetchDetail();
        }

        return res;
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob)) {
          return null;
        }

        const parsed = parseApiError(err);
        if (isAccessError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return null;
        }

        setError(parsed);
        return null;
      }
    }, [workspaceMode, isRequestCurrent, refetchDetail, purgeOnAccessError]);

  return {
    status,
    jobDetail,
    segments,
    previews,
    workspaceMode,
    pageCountInfo,
    freshness,
    currentPage,
    setCurrentPage,
    selectedSegmentId,
    setSelectedSegmentId,
    conflictState,
    clearConflict,
    saveSegment,
    triggerMaterialization,
    materializationStatus,
    error,
    refetchDetail,
    retry,
  };
}
