import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobPreviewsResponse,
  MaterializationRequestResponse,
  MaterializationRequestStatus,
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
} from './manga-studio-policy';
import { useAuth } from '../auth/auth-context';

export interface ConflictState {
  segmentId: string;
  currentVersion?: number;
  expectedVersion?: number;
  draftText: string;
}

export interface UseMangaReviewStudioReturn {
  status: 'initializing' | 'auth_required' | 'loading' | 'ready' | 'error';
  jobDetail: TranslationJobReviewDetailResponse | null;
  segments: TranslationSegmentDto[];
  previews: TranslationJobPreviewsResponse | null;
  workspaceMode: WorkspaceModeResult | null;
  pageCountInfo: { pageCount: number | null; isAvailable: boolean };
  freshness: { isFresh: boolean; needsMaterialize: boolean };
  currentPage: number;
  setCurrentPage: (page: number) => void;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;
  conflictState: ConflictState | null;
  clearConflict: () => void;
  saveSegment: (segmentId: string, text: string) => Promise<boolean>;
  triggerMaterialization: () => Promise<MaterializationRequestResponse | null>;
  materializationStatus: MaterializationRequestStatus | null;
  error: ParsedApiError | null;
  refetchDetail: () => Promise<void>;
}

export function useMangaReviewStudio(jobId: string): UseMangaReviewStudioReturn {
  const { isAuthenticated, isLoading: authLoading } = useAuth();

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

  // Active Job ID tracker to ensure clean-slate on job switch
  const activeJobIdRef = useRef(jobId);

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
  }, []);

  const loadJobData = useCallback(async () => {
    if (authLoading || !isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    setStatus('loading');
    setError(null);

    try {
      // 1. Fetch Authoritative Job Detail
      const detail = await fetchTranslationJobDetail(jobId);
      if (activeJobIdRef.current !== jobId) return;

      setJobDetail(detail);

      // Determine workspace mode
      const modeResult = getMangaStudioWorkspaceMode(
        detail.job.status,
        detail.context.story.mediaFormat,
      );

      // 2. Fetch Segments if reviewable or monitor
      if (modeResult.mode !== 'UNSUPPORTED_FORMAT') {
        const segRes = await fetchTranslationJobSegments(jobId, 1, 100);
        if (activeJobIdRef.current !== jobId) return;
        setSegments(segRes.data || []);
      }

      // 3. Fetch Previews ONLY if reviewable
      if (modeResult.canPreview) {
        try {
          const prevRes = await fetchTranslationJobPreviews(jobId, {
            pageNumber: 1,
          });
          if (activeJobIdRef.current !== jobId) return;
          setPreviews(prevRes);
        } catch (prevErr) {
          // Non-fatal for initial workspace load, logged for debugging
          console.warn('Initial previews fetch warning:', prevErr);
        }
      }

      setStatus('ready');
    } catch (err) {
      if (activeJobIdRef.current !== jobId) return;
      // Clean slate on error (403/404) to prevent cross-job data leakage
      resetState();
      const parsedErr = parseApiError(err);
      setError(parsedErr);
      setStatus('error');
    }
  }, [jobId, authLoading, isAuthenticated, resetState]);

  // Handle job switch or auth changes
  useEffect(() => {
    activeJobIdRef.current = jobId;
    resetState();

    if (authLoading || !isAuthenticated) {
      setStatus('auth_required');
      return;
    }

    loadJobData();
  }, [jobId, authLoading, isAuthenticated, resetState, loadJobData]);

  // Derived calculations
  const workspaceMode: WorkspaceModeResult | null =
    overrideWorkspaceMode ||
    (jobDetail
      ? getMangaStudioWorkspaceMode(
          jobDetail.job.status,
          jobDetail.context.story.mediaFormat,
        )
      : null);

  const pageCountInfo = computeAuthoritativePageCount(jobDetail?.reviewSummary);

  const freshness = computeMaterializationFreshness(
    jobDetail?.job.reviewRevision ?? 0,
    jobDetail?.job.materializedRevision ?? 0,
  );

  const clearConflict = useCallback(() => {
    setConflictState(null);
  }, []);

  const refetchDetail = useCallback(async () => {
    try {
      const detail = await fetchTranslationJobDetail(jobId);
      if (activeJobIdRef.current === jobId) {
        setJobDetail(detail);
      }
    } catch (err) {
      console.warn('Failed to refetch job detail:', err);
    }
  }, [jobId]);

  const saveSegment = useCallback(
    async (segmentId: string, text: string): Promise<boolean> => {
      // Fail-closed guard: Cannot edit if mode does not allow editing
      if (!workspaceMode || !workspaceMode.canEdit) {
        return false;
      }

      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) {
        return false;
      }

      try {
        const updated = await updateTranslationSegment(jobId, segmentId, {
          translatedText: text,
          isHumanVerified: true,
          expectedVersion: segment.version,
        });

        // Reconcile local segment state with authoritative response
        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, ...updated } : s)),
        );
        setConflictState(null);

        // Reconcile job detail from server to sync reviewRevision
        await refetchDetail();

        return true;
      } catch (err) {
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
          setError(parseApiError(err));
        }

        return false;
      }
    },
    [jobId, segments, workspaceMode, refetchDetail],
  );

  const triggerMaterialization =
    useCallback(async (): Promise<MaterializationRequestResponse | null> => {
      if (!workspaceMode || !workspaceMode.canMaterialize) {
        return null;
      }

      try {
        const res = await requestJobMaterialization(jobId);
        setMaterializationStatus(res.status);

        if (res.status === 'ALREADY_FRESH') {
          // Authoritative sync with backend
          await refetchDetail();
        }

        return res;
      } catch (err) {
        setError(parseApiError(err));
        return null;
      }
    }, [jobId, workspaceMode, refetchDetail]);

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
  };
}
