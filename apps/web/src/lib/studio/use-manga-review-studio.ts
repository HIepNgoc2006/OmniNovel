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

export type ReconciliationOutcome =
  | 'SYNCED'
  | 'SUPERSEDED_BY_NEWER_SYNC'
  | 'FAILED'
  | 'ACCESS_REVOKED';

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
  clearConflict: (segmentId?: string) => void;
  saveSegment: (
    segmentId: string,
    text: string,
    options?: SaveSegmentOptions,
  ) => Promise<boolean>;
  triggerMaterialization: () => Promise<MaterializationRequestResponse | null>;
  materializationStatus: MaterializationRequestStatus | null;
  isMaterializing: boolean;
  error: ParsedApiError | null;
  fatalError: ParsedApiError | null;
  operationError: ParsedApiError | null;
  clearOperationError: () => void;
  refetchDetail: (options?: {
    requirement?: 'BEST_EFFORT' | 'AUTHORITATIVE_REQUIRED';
  }) => Promise<ReconciliationOutcome>;
  reconcileAuthoritativeWorkspace: () => Promise<void>;
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
  const [conflictStates, setConflictStates] = useState<Record<string, ConflictState>>({});
  const [materializationStatus, setMaterializationStatus] =
    useState<MaterializationRequestStatus | null>(null);
  const [isMaterializing, setIsMaterializing] = useState<boolean>(false);
  const [fatalError, setFatalError] = useState<ParsedApiError | null>(null);
  const [operationError, setOperationError] = useState<ParsedApiError | null>(null);
  const [overrideWorkspaceMode, setOverrideWorkspaceMode] =
    useState<WorkspaceModeResult | null>(null);
  const [authoritativeSyncError, setAuthoritativeSyncError] =
    useState<boolean>(false);

  // Invariant Protection: Identity, Session & Sequence Tracking
  const activeJobIdRef = useRef(jobId);
  const generationRef = useRef(0);
  const latestDetailSeqRef = useRef(0);
  const dataLoadSeqRef = useRef(0);
  const materializationSeqRef = useRef(0);
  const segmentMutationSeqRef = useRef<Record<string, number>>({});
  const latestConfirmedRevisionRef = useRef(0);
  const userSessionIdRef = useRef<string | null>(user?.id ?? null);
  const reconcileRef = useRef<() => Promise<void>>(() => Promise.resolve());

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

  const isDetailRequestCurrent = useCallback(
    (targetGen: number, targetJob: string, targetSeq: number): boolean => {
      return (
        generationRef.current === targetGen &&
        activeJobIdRef.current === targetJob &&
        userSessionIdRef.current === (user?.id ?? null) &&
        latestDetailSeqRef.current === targetSeq
      );
    },
    [user?.id],
  );

  const isChildRequestCurrent = useCallback(
    (targetGen: number, targetJob: string, targetSeq: number): boolean => {
      return (
        generationRef.current === targetGen &&
        activeJobIdRef.current === targetJob &&
        userSessionIdRef.current === (user?.id ?? null) &&
        dataLoadSeqRef.current === targetSeq
      );
    },
    [user?.id],
  );

  const resetState = useCallback(() => {
    setJobDetail(null);
    setSegments([]);
    setPreviews(null);
    setSelectedSegmentId(null);
    setConflictStates({});
    setMaterializationStatus(null);
    setIsMaterializing(false);
    setFatalError(null);
    setOperationError(null);
    setOverrideWorkspaceMode(null);
    setCurrentPage(1);
    setAuthoritativeSyncError(false);
    latestConfirmedRevisionRef.current = 0;
  }, []);

  const clearReviewOnlyState = useCallback(() => {
    dataLoadSeqRef.current++;
    setPreviews(null);
    setSegments([]);
    setSelectedSegmentId(null);
    setConflictStates({});
    setMaterializationStatus(null);
    setCurrentPage(1);
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
      latestDetailSeqRef.current++;

      resetState();
      setFatalError(parsedErr);
      setStatus('error');
    },
    [resetState],
  );

  // 401 / 403: Authentication or authorization failure across any endpoint -> purge
  const isAuthOrPermissionError = useCallback((err: ParsedApiError): boolean => {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.code === 'FORBIDDEN' ||
      err.code === 'UNAUTHORIZED'
    );
  }, []);

  // 404 on Job entity or Job-scoped collection: Job itself or its required story context does not exist
  const isJobNotFoundError = useCallback((err: ParsedApiError): boolean => {
    return err.status === 404 || err.code === 'NOT_FOUND';
  }, []);

  // Job level access error: either 401/403 or 404 on Job-level GET endpoints
  const isJobAccessError = useCallback(
    (err: ParsedApiError): boolean => {
      return isAuthOrPermissionError(err) || isJobNotFoundError(err);
    },
    [isAuthOrPermissionError, isJobNotFoundError],
  );

  const clearOperationError = useCallback(() => {
    setOperationError(null);
  }, []);

  const loadJobData = useCallback(
    async (explicitGen?: number, explicitJob?: string) => {
      if (authLoading || !isAuthenticated) {
        setStatus('auth_required');
        return;
      }

      const currentGen = explicitGen ?? generationRef.current;
      const currentJob = explicitJob ?? activeJobIdRef.current;
      const detailSeq = ++latestDetailSeqRef.current;
      const dataLoadSeq = ++dataLoadSeqRef.current;

      setStatus('loading');
      setFatalError(null);

      try {
        // 1. Fetch Authoritative Job Detail
        const detail = await fetchTranslationJobDetail(currentJob);
        if (!isDetailRequestCurrent(currentGen, currentJob, detailSeq)) {
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

        // 2. Fetch Segments ONLY if reviewable
        if (modeResult.mode === 'REVIEWABLE') {
          try {
            const segRes = await fetchTranslationJobSegments(currentJob, 1, 100);
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            setSegments(segRes.data || []);
          } catch (segErr) {
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            const parsed = parseApiError(segErr);
            // GET segments 404 means job or story not found -> job-level fatal
            if (isJobAccessError(parsed)) {
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
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            setPreviews(prevRes);
          } catch (prevErr) {
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            const parsed = parseApiError(prevErr);
            // GET previews 404 means job or story not found -> job-level fatal
            if (isJobAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
              return;
            }
            if (
              parsed.code === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' ||
              parsed.code === 'NOT_REVIEWABLE'
            ) {
              await reconcileRef.current();
              return;
            }
            console.warn('Initial previews fetch warning:', prevErr);
          }
        }

        if (isRequestCurrent(currentGen, currentJob)) {
          setFatalError(null);
          setStatus('ready');
        }
      } catch (err) {
        if (!isDetailRequestCurrent(currentGen, currentJob, detailSeq)) {
          return;
        }
        const parsedErr = parseApiError(err);
        if (isJobAccessError(parsedErr)) {
          purgeOnAccessError(parsedErr, currentGen, currentJob);
        } else {
          resetState();
          setFatalError(parsedErr);
          setStatus('error');
        }
      }
    },
    [
      authLoading,
      isAuthenticated,
      isRequestCurrent,
      isDetailRequestCurrent,
      isChildRequestCurrent,
      isJobAccessError,
      purgeOnAccessError,
      resetState,
    ],
  );

  // Handle job switch, session change, or auth changes
  useEffect(() => {
    activeJobIdRef.current = jobId;
    userSessionIdRef.current = user?.id ?? null;
    generationRef.current++;
    dataLoadSeqRef.current++;
    latestDetailSeqRef.current++;
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

  const baseFreshness = computeMaterializationFreshness(
    jobDetail?.job.reviewRevision,
    jobDetail?.job.materializedRevision,
  );

  const freshness: MaterializationFreshnessResult = authoritativeSyncError
    ? {
        isFresh: false,
        needsMaterialize: false,
        status: 'UNKNOWN',
        message:
          'Chưa thể đồng bộ phiên bản mới nhất từ máy chủ sau khi lưu. Vui lòng làm mới trang.',
      }
    : baseFreshness;

  const conflictState: ConflictState | null = selectedSegmentId
    ? (conflictStates[selectedSegmentId] ?? null)
    : (Object.values(conflictStates)[0] ?? null);

  const clearConflict = useCallback(
    (targetSegmentId?: string) => {
      const idToClear = targetSegmentId ?? selectedSegmentId;
      if (!idToClear) {
        setConflictStates({});
        return;
      }
      setConflictStates((prev) => {
        if (!prev[idToClear]) return prev;
        const next = { ...prev };
        delete next[idToClear];
        return next;
      });
    },
    [selectedSegmentId],
  );

  const reconcileAuthoritativeWorkspace = useCallback(async () => {
    const newGen = ++generationRef.current;
    dataLoadSeqRef.current++;
    latestDetailSeqRef.current++;
    const currentJob = activeJobIdRef.current;

    setJobDetail(null);
    setSegments([]);
    setPreviews(null);
    setSelectedSegmentId(null);
    setConflictStates({});
    setOverrideWorkspaceMode(null);
    setFatalError(null);
    setOperationError(null);
    setMaterializationStatus(null);
    setIsMaterializing(false);
    setCurrentPage(1);
    setAuthoritativeSyncError(false);
    latestConfirmedRevisionRef.current = 0;

    await loadJobData(newGen, currentJob);
  }, [loadJobData]);

  useEffect(() => {
    reconcileRef.current = reconcileAuthoritativeWorkspace;
  }, [reconcileAuthoritativeWorkspace]);

  const retry = useCallback(async () => {
    const newGen = ++generationRef.current;
    dataLoadSeqRef.current++;
    latestDetailSeqRef.current++;
    const currentJob = activeJobIdRef.current;
    resetState();
    await loadJobData(newGen, currentJob);
  }, [resetState, loadJobData]);

  const refetchDetail = useCallback(
    async (options?: {
      requirement?: 'BEST_EFFORT' | 'AUTHORITATIVE_REQUIRED';
    }): Promise<ReconciliationOutcome> => {
      if (status === 'error') {
        await retry();
        return 'FAILED';
      }

      const currentGen = generationRef.current;
      const currentJob = activeJobIdRef.current;
      const detailSeq = ++latestDetailSeqRef.current;

      try {
        const detail = await fetchTranslationJobDetail(currentJob);

        if (!isDetailRequestCurrent(currentGen, currentJob, detailSeq)) {
          return 'SUPERSEDED_BY_NEWER_SYNC';
        }

        // Invariant: Do not allow an out-of-order older response to downgrade reviewRevision
        if (detail.job.reviewRevision < latestConfirmedRevisionRef.current) {
          return 'SUPERSEDED_BY_NEWER_SYNC';
        }

        latestConfirmedRevisionRef.current = Math.max(
          latestConfirmedRevisionRef.current,
          detail.job.reviewRevision,
        );

        const reviewRevisionChanged =
          jobDetail && jobDetail.job.reviewRevision !== detail.job.reviewRevision;
        const materializedRevisionChanged =
          jobDetail &&
          jobDetail.job.materializedRevision !== detail.job.materializedRevision;
        const statusChanged =
          jobDetail && jobDetail.job.status !== detail.job.status;

        // State Coherence:
        // 1. If reviewRevision or materializedRevision or status changed, clear previews immediately
        // so old preview assets are not rendered with a new revision epoch
        if (reviewRevisionChanged || materializedRevisionChanged || statusChanged) {
          setPreviews(null);
        }

        // 2. If reviewRevision or status changed, clear segments so old segments are not displayed
        // under a new revision epoch if fetching new segments fails
        if (reviewRevisionChanged || statusChanged) {
          setSegments([]);
        }

        setJobDetail(detail);
        setOverrideWorkspaceMode(null);
        setAuthoritativeSyncError(false);

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
              if (isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                setSegments(segRes.data || []);
              }
            })
            .catch((err) => {
              if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) return;
              const parsed = parseApiError(err);
              if (isJobAccessError(parsed)) {
                purgeOnAccessError(parsed, currentGen, currentJob);
              }
            });

          // Fetch previews
          fetchTranslationJobPreviews(currentJob, { pageNumber: 1 })
            .then((prevRes) => {
              if (isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                setPreviews(prevRes);
              }
            })
            .catch(async (err) => {
              if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) return;
              const parsed = parseApiError(err);
              if (isJobAccessError(parsed)) {
                purgeOnAccessError(parsed, currentGen, currentJob);
                return;
              }
              if (
                parsed.code === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' ||
                parsed.code === 'NOT_REVIEWABLE'
              ) {
                await reconcileRef.current();
                return;
              }
            });
        } else {
          // Transition away from REVIEWABLE: clean up all review-only state
          clearReviewOnlyState();
        }

        return 'SYNCED';
      } catch (err) {
        if (!isDetailRequestCurrent(currentGen, currentJob, detailSeq)) {
          return 'SUPERSEDED_BY_NEWER_SYNC';
        }
        const parsed = parseApiError(err);
        if (isJobAccessError(parsed)) {
          purgeOnAccessError(parsed, currentGen, currentJob);
          return 'ACCESS_REVOKED';
        }

        if (options?.requirement === 'AUTHORITATIVE_REQUIRED') {
          setAuthoritativeSyncError(true);
        } else {
          console.warn('Failed to refetch job detail:', err);
        }
        return 'FAILED';
      }
    },
    [
      status,
      retry,
      isDetailRequestCurrent,
      isChildRequestCurrent,
      isJobAccessError,
      purgeOnAccessError,
      jobDetail,
      clearReviewOnlyState,
    ],
  );

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

      const mutationSeq = (segmentMutationSeqRef.current[segmentId] || 0) + 1;
      segmentMutationSeqRef.current[segmentId] = mutationSeq;

      try {
        const updated = await updateTranslationSegment(targetJob, segmentId, payload);

        if (!isRequestCurrent(currentGen, targetJob)) {
          return false;
        }

        // Reconcile local segment state with authoritative response
        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, ...updated } : s)),
        );

        // Clear conflict ONLY for this segment, and ONLY if no newer mutation sequence started for it
        setConflictStates((prev) => {
          if (!prev[segmentId]) return prev;
          if (segmentMutationSeqRef.current[segmentId] !== mutationSeq) return prev;
          const next = { ...prev };
          delete next[segmentId];
          return next;
        });

        // Authoritative reconciliation after mutation
        const syncOutcome = await refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
        if (syncOutcome === 'FAILED' || syncOutcome === 'ACCESS_REVOKED') {
          return false;
        }

        return true;
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob)) {
          return false;
        }

        const parsed = parseApiError(err);
        if (isAuthOrPermissionError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return false;
        }

        // Resource-scoped 404: If segmentId is 404 NOT_FOUND, this segment is missing/deleted,
        // but the job and permission are still valid. Do NOT purge entire workspace!
        if (parsed.status === 404 || parsed.code === 'NOT_FOUND') {
          setOperationError(parsed);
          await reconcileAuthoritativeWorkspace();
          return false;
        }

        const conflict = classifyConflictError(err);

        if (conflict.type === 'VERSION_CONFLICT') {
          if (segmentMutationSeqRef.current[segmentId] === mutationSeq) {
            setConflictStates((prev) => ({
              ...prev,
              [segmentId]: {
                segmentId,
                currentVersion: conflict.currentVersion,
                expectedVersion: conflict.expectedVersion,
                draftText: text,
              },
            }));
          }
        } else if (
          conflict.type === 'NOT_REVIEWABLE' ||
          conflict.type === 'REVISION_INVARIANT_VIOLATION' ||
          conflict.type === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS'
        ) {
          await reconcileAuthoritativeWorkspace();
        } else {
          setOperationError(parsed);
        }

        return false;
      }
    },
    [
      segments,
      workspaceMode,
      isRequestCurrent,
      isAuthOrPermissionError,
      refetchDetail,
      purgeOnAccessError,
      reconcileAuthoritativeWorkspace,
    ],
  );

  const triggerMaterialization =
    useCallback(async (): Promise<MaterializationRequestResponse | null> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      if (isMaterializing || !workspaceMode || !workspaceMode.canMaterialize) {
        return null;
      }

      setIsMaterializing(true);
      const matSeq = ++materializationSeqRef.current;

      try {
        const res = await requestJobMaterialization(targetJob);

        if (!isRequestCurrent(currentGen, targetJob) || matSeq < materializationSeqRef.current) {
          return null;
        }

        setMaterializationStatus(res.status);

        if (res.status === 'ALREADY_FRESH') {
          // Authoritative sync with backend
          await refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
        }

        return res;
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob) || matSeq < materializationSeqRef.current) {
          return null;
        }

        const parsed = parseApiError(err);
        if (isJobAccessError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return null;
        }

        const conflict = classifyConflictError(err);
        if (
          conflict.type === 'NOT_REVIEWABLE' ||
          conflict.type === 'REVISION_INVARIANT_VIOLATION' ||
          conflict.type === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS'
        ) {
          await reconcileAuthoritativeWorkspace();
          return null;
        }

        setOperationError(parsed);
        return null;
      } finally {
        setIsMaterializing(false);
      }
    }, [
      isMaterializing,
      workspaceMode,
      isRequestCurrent,
      isJobAccessError,
      refetchDetail,
      purgeOnAccessError,
      reconcileAuthoritativeWorkspace,
    ]);

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
    isMaterializing,
    error: fatalError,
    fatalError,
    operationError,
    clearOperationError,
    refetchDetail,
    reconcileAuthoritativeWorkspace,
    retry,
  };
}
