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
  | 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
  | 'FAILED'
  | 'ACCESS_REVOKED';

export type SaveSegmentOutcome =
  | 'SAVED_AND_SYNCED'
  | 'SAVED_SYNC_FAILED'
  | 'VERSION_CONFLICT'
  | 'STATE_CHANGED'
  | 'ACCESS_REVOKED'
  | 'FAILED_BEFORE_COMMIT';

export interface SaveSegmentResult {
  success: boolean;
  outcome: SaveSegmentOutcome;
  conflict?: ConflictState;
  error?: ParsedApiError;
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
  conflictStates: Record<string, ConflictState>;
  clearConflict: (segmentId?: string) => void;
  saveSegment: (
    segmentId: string,
    text: string,
    options?: SaveSegmentOptions,
  ) => Promise<SaveSegmentResult>;
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
  const latestStartedDetailSeqRef = useRef(0);
  const latestAppliedDetailSeqRef = useRef(0);
  const dataLoadSeqRef = useRef(0);
  const materializationSeqRef = useRef(0);
  const materializationInFlightRef = useRef(false);
  const previewReconcileAttemptsRef = useRef(0);
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
    materializationInFlightRef.current = false;
    setIsMaterializing(false);
    setFatalError(null);
    setOperationError(null);
    setOverrideWorkspaceMode(null);
    setCurrentPage(1);
    setAuthoritativeSyncError(false);
    previewReconcileAttemptsRef.current = 0;
    latestConfirmedRevisionRef.current = 0;
  }, []);

  const clearReviewOnlyState = useCallback(() => {
    dataLoadSeqRef.current++;
    materializationSeqRef.current++;
    materializationInFlightRef.current = false;
    setIsMaterializing(false);
    setPreviews(null);
    setSegments([]);
    setSelectedSegmentId(null);
    setConflictStates({});
    setMaterializationStatus(null);
    setCurrentPage(1);
  }, []);

  const purgeOnAccessError = useCallback(
    (parsedErr: ParsedApiError, targetGen?: number, targetJob?: string) => {
      if (targetGen !== undefined && targetGen !== generationRef.current) {
        return;
      }
      if (targetJob !== undefined && targetJob !== activeJobIdRef.current) {
        return;
      }

      generationRef.current++;
      dataLoadSeqRef.current++;
      latestStartedDetailSeqRef.current++;
      materializationSeqRef.current++;
      materializationInFlightRef.current = false;

      resetState();
      setFatalError(parsedErr);
      setStatus('error');
    },
    [resetState],
  );

  const isAuthOrPermissionError = useCallback((err: ParsedApiError): boolean => {
    return (
      err.status === 401 ||
      err.status === 403 ||
      err.code === 'FORBIDDEN' ||
      err.code === 'UNAUTHORIZED'
    );
  }, []);

  const isJobNotFoundError = useCallback((err: ParsedApiError): boolean => {
    return err.status === 404 || err.code === 'NOT_FOUND';
  }, []);

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
      const detailSeq = ++latestStartedDetailSeqRef.current;
      const dataLoadSeq = ++dataLoadSeqRef.current;

      setStatus('loading');
      setFatalError(null);

      try {
        const detail = await fetchTranslationJobDetail(currentJob);
        if (!isRequestCurrent(currentGen, currentJob)) {
          return;
        }
        if (detailSeq < latestAppliedDetailSeqRef.current) {
          return;
        }

        latestAppliedDetailSeqRef.current = Math.max(
          latestAppliedDetailSeqRef.current,
          detailSeq,
        );
        latestConfirmedRevisionRef.current = Math.max(
          latestConfirmedRevisionRef.current,
          detail.job.reviewRevision,
        );

        setJobDetail(detail);

        const modeResult = getMangaStudioWorkspaceMode({
          jobStatus: detail.job.status,
          mediaFormat: detail.context.story.mediaFormat,
          resultPageCount: detail.reviewSummary?.resultPageCount,
        });

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
            if (isJobAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
              return;
            }
            throw segErr;
          }
        }

        if (modeResult.canPreview) {
          try {
            const prevRes = await fetchTranslationJobPreviews(currentJob, {
              pageNumber: 1,
            });
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            previewReconcileAttemptsRef.current = 0;
            setPreviews(prevRes);
          } catch (prevErr) {
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            const parsed = parseApiError(prevErr);
            if (isJobAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
              return;
            }
            if (
              parsed.code === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' ||
              parsed.code === 'NOT_REVIEWABLE'
            ) {
              if (previewReconcileAttemptsRef.current < 2) {
                previewReconcileAttemptsRef.current++;
                await reconcileRef.current();
              } else {
                setFatalError({
                  code: 'STATE_DESYNCHRONIZED',
                  message:
                    'Trạng thái dữ liệu giữa chi tiết job và bản xem trước không nhất quán từ máy chủ. Vui lòng tải lại trang.',
                });
                setStatus('error');
              }
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
        if (!isRequestCurrent(currentGen, currentJob)) {
          return;
        }
        if (detailSeq < latestAppliedDetailSeqRef.current) {
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
      isChildRequestCurrent,
      isJobAccessError,
      purgeOnAccessError,
      resetState,
    ],
  );

  useEffect(() => {
    activeJobIdRef.current = jobId;
    userSessionIdRef.current = user?.id ?? null;
    generationRef.current++;
    dataLoadSeqRef.current++;
    latestStartedDetailSeqRef.current++;
    materializationSeqRef.current++;
    materializationInFlightRef.current = false;
    resetState();

    if (authLoading || !isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    loadJobData();
  }, [jobId, user?.id, authLoading, isAuthenticated, resetState, loadJobData]);

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
    latestStartedDetailSeqRef.current++;
    materializationSeqRef.current++;
    materializationInFlightRef.current = false;
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
    latestStartedDetailSeqRef.current++;
    materializationSeqRef.current++;
    materializationInFlightRef.current = false;
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
      const detailSeq = ++latestStartedDetailSeqRef.current;

      try {
        const detail = await fetchTranslationJobDetail(currentJob);

        if (!isRequestCurrent(currentGen, currentJob)) {
          return 'SUPERSEDED_BY_SUCCESSFUL_SYNC';
        }

        // Drop response only if a NEWER request has ALREADY successfully applied
        if (detailSeq < latestAppliedDetailSeqRef.current) {
          return 'SUPERSEDED_BY_SUCCESSFUL_SYNC';
        }

        if (detail.job.reviewRevision < latestConfirmedRevisionRef.current) {
          return 'SUPERSEDED_BY_SUCCESSFUL_SYNC';
        }

        latestConfirmedRevisionRef.current = Math.max(
          latestConfirmedRevisionRef.current,
          detail.job.reviewRevision,
        );

        latestAppliedDetailSeqRef.current = Math.max(
          latestAppliedDetailSeqRef.current,
          detailSeq,
        );

        const reviewRevisionChanged =
          jobDetail && jobDetail.job.reviewRevision !== detail.job.reviewRevision;
        const materializedRevisionChanged =
          jobDetail &&
          jobDetail.job.materializedRevision !== detail.job.materializedRevision;
        const statusChanged =
          jobDetail && jobDetail.job.status !== detail.job.status;

        if (reviewRevisionChanged || materializedRevisionChanged || statusChanged) {
          setPreviews(null);
        }

        if (reviewRevisionChanged || statusChanged) {
          setSegments([]);
        }

        setJobDetail(detail);
        setOverrideWorkspaceMode(null);
        setAuthoritativeSyncError(false);

        const newMode = getMangaStudioWorkspaceMode({
          jobStatus: detail.job.status,
          mediaFormat: detail.context.story.mediaFormat,
          resultPageCount: detail.reviewSummary?.resultPageCount,
        });

        if (newMode.mode === 'REVIEWABLE') {
          const dataLoadSeq = ++dataLoadSeqRef.current;

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
              } else {
                setOperationError({
                  code: 'SEGMENTS_SYNC_FAILED',
                  message:
                    'Không thể đồng bộ danh sách phân đoạn mới nhất từ máy chủ.',
                });
              }
            });

          fetchTranslationJobPreviews(currentJob, { pageNumber: 1 })
            .then((prevRes) => {
              if (isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                previewReconcileAttemptsRef.current = 0;
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
                if (previewReconcileAttemptsRef.current < 2) {
                  previewReconcileAttemptsRef.current++;
                  await reconcileRef.current();
                } else {
                  setFatalError({
                    code: 'STATE_DESYNCHRONIZED',
                    message:
                      'Trạng thái dữ liệu giữa chi tiết job và bản xem trước không nhất quán từ máy chủ. Vui lòng tải lại trang.',
                  });
                  setStatus('error');
                }
                return;
              }
            });
        } else {
          clearReviewOnlyState();
        }

        return 'SYNCED';
      } catch (err) {
        if (!isRequestCurrent(currentGen, currentJob)) {
          return 'SUPERSEDED_BY_SUCCESSFUL_SYNC';
        }

        // Drop error only if a NEWER request has ALREADY successfully applied
        if (detailSeq < latestAppliedDetailSeqRef.current) {
          return 'SUPERSEDED_BY_SUCCESSFUL_SYNC';
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
      isRequestCurrent,
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
    ): Promise<SaveSegmentResult> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      if (!workspaceMode || !workspaceMode.canEdit) {
        return {
          success: false,
          outcome: 'STATE_CHANGED',
        };
      }

      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) {
        return {
          success: false,
          outcome: 'FAILED_BEFORE_COMMIT',
        };
      }

      const expectedVersion = options?.baseVersion ?? segment.version;
      const payload: UpdateTranslationSegmentRequest = {
        translatedText: text,
        expectedVersion,
      };

      if (typeof options?.isHumanVerified === 'boolean') {
        payload.isHumanVerified = options.isHumanVerified;
      }

      const mutationSeq = (segmentMutationSeqRef.current[segmentId] || 0) + 1;
      segmentMutationSeqRef.current[segmentId] = mutationSeq;

      try {
        const updated = await updateTranslationSegment(targetJob, segmentId, payload);

        if (!isRequestCurrent(currentGen, targetJob)) {
          return {
            success: false,
            outcome: 'STATE_CHANGED',
          };
        }

        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, ...updated } : s)),
        );

        setConflictStates((prev) => {
          if (!prev[segmentId]) return prev;
          if (segmentMutationSeqRef.current[segmentId] !== mutationSeq) return prev;
          const next = { ...prev };
          delete next[segmentId];
          return next;
        });

        clearOperationError();

        const syncOutcome = await refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
        if (syncOutcome === 'FAILED') {
          return {
            success: false,
            outcome: 'SAVED_SYNC_FAILED',
          };
        }
        if (syncOutcome === 'ACCESS_REVOKED') {
          return {
            success: false,
            outcome: 'ACCESS_REVOKED',
          };
        }

        return {
          success: true,
          outcome: 'SAVED_AND_SYNCED',
        };
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob)) {
          return {
            success: false,
            outcome: 'STATE_CHANGED',
          };
        }

        const parsed = parseApiError(err);
        if (isAuthOrPermissionError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return {
            success: false,
            outcome: 'ACCESS_REVOKED',
            error: parsed,
          };
        }

        // Targeted segment-local 404: Do NOT perform full destructive reconcile which wipes unrelated drafts!
        if (parsed.status === 404 || parsed.code === 'NOT_FOUND') {
          setSegments((prev) => prev.filter((s) => s.id !== segmentId));
          setConflictStates((prev) => {
            if (!prev[segmentId]) return prev;
            const next = { ...prev };
            delete next[segmentId];
            return next;
          });
          setOperationError(parsed);
          await refetchDetail({ requirement: 'BEST_EFFORT' });

          return {
            success: false,
            outcome: 'FAILED_BEFORE_COMMIT',
            error: parsed,
          };
        }

        const conflict = classifyConflictError(err);

        if (conflict.type === 'VERSION_CONFLICT') {
          const newConflict: ConflictState = {
            segmentId,
            currentVersion: conflict.currentVersion,
            expectedVersion: conflict.expectedVersion,
            draftText: text,
          };

          if (segmentMutationSeqRef.current[segmentId] === mutationSeq) {
            setConflictStates((prev) => ({
              ...prev,
              [segmentId]: newConflict,
            }));
          }

          return {
            success: false,
            outcome: 'VERSION_CONFLICT',
            conflict: newConflict,
            error: parsed,
          };
        } else if (
          conflict.type === 'NOT_REVIEWABLE' ||
          conflict.type === 'REVISION_INVARIANT_VIOLATION' ||
          conflict.type === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS'
        ) {
          await reconcileAuthoritativeWorkspace();
          return {
            success: false,
            outcome: 'STATE_CHANGED',
            error: parsed,
          };
        } else {
          setOperationError(parsed);
          return {
            success: false,
            outcome: 'FAILED_BEFORE_COMMIT',
            error: parsed,
          };
        }
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
      clearOperationError,
    ],
  );

  const triggerMaterialization =
    useCallback(async (): Promise<MaterializationRequestResponse | null> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      // Atomic synchronous check against double-submits in the same JS tick
      if (
        materializationInFlightRef.current ||
        !workspaceMode ||
        !workspaceMode.canMaterialize
      ) {
        return null;
      }

      materializationInFlightRef.current = true;
      setIsMaterializing(true);
      const matSeq = ++materializationSeqRef.current;

      try {
        const res = await requestJobMaterialization(targetJob);

        if (
          !isRequestCurrent(currentGen, targetJob) ||
          matSeq < materializationSeqRef.current
        ) {
          return null;
        }

        setMaterializationStatus(res.status);
        clearOperationError();

        if (res.status === 'ALREADY_FRESH') {
          await refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' });
        }

        return res;
      } catch (err) {
        if (
          !isRequestCurrent(currentGen, targetJob) ||
          matSeq < materializationSeqRef.current
        ) {
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
        // Operation token guard: ONLY reset if this operation is still active for this job/generation
        if (
          generationRef.current === currentGen &&
          activeJobIdRef.current === targetJob &&
          materializationSeqRef.current === matSeq
        ) {
          materializationInFlightRef.current = false;
          setIsMaterializing(false);
        }
      }
    }, [
      workspaceMode,
      isRequestCurrent,
      isJobAccessError,
      refetchDetail,
      purgeOnAccessError,
      reconcileAuthoritativeWorkspace,
      clearOperationError,
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
    conflictStates,
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
