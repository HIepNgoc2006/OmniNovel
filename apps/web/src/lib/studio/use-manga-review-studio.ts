import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobPreviewsResponse,
  TranslationJobSegmentsResponse,
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
  isValidWorkspaceRevision,
  WorkspaceModeResult,
  MaterializationFreshnessResult,
} from './manga-studio-policy';
import {
  SegmentCommitState,
  WorkspaceSyncState,
  SaveSegmentReason,
  ConflictState,
  SaveSegmentResult,
  PendingUnknownMutation,
  buildSaveSegmentResult,
} from './studio-types';
import { useAuth } from '../auth/auth-context';

export type {
  ConflictState,
  SaveSegmentResult,
  PendingUnknownMutation,
  SaveSegmentOutcome,
} from './studio-types';
export { buildSaveSegmentResult } from './studio-types';

export interface SaveSegmentOptions {
  isHumanVerified?: boolean;
  baseVersion?: number;
}

export type ReconciliationOutcome =
  | 'SYNCED'
  | 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
  | 'SCOPE_INVALIDATED'
  | 'STATE_CHANGED'
  | 'RECONCILIATION_REQUIRED'
  | 'FAILED'
  | 'ACCESS_REVOKED';

export type SegmentsSyncStatus = 'SYNCED' | 'STALE' | 'FAILED';

export interface AuthoritativeSyncProof {
  generation: number;
  jobId: string;
  userId: string | null;
  revision: number;
  seq: number;
  outcome: 'REVIEW_SYNCED' | 'STATE_CHANGED';
}

export interface UseMangaReviewStudioReturn {
  status: 'initializing' | 'auth_required' | 'loading' | 'ready' | 'error';
  jobDetail: TranslationJobReviewDetailResponse | null;
  segments: TranslationSegmentDto[];
  segmentsSyncStatus: SegmentsSyncStatus;
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
  pendingUnknownMutations: Record<string, PendingUnknownMutation>;
  clearConflict: (segmentId?: string) => void;
  replaceConflictStates: (
    updater:
      | Record<string, ConflictState>
      | ((prev: Record<string, ConflictState>) => Record<string, ConflictState>),
  ) => void;
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
  clearOperationError: (
    scope?:
      | 'latest'
      | 'materialization'
      | 'segments'
      | 'previews'
      | { segmentId: string }
      | unknown,
  ) => void;
  refetchDetail: (options?: {
    requirement?: 'BEST_EFFORT' | 'AUTHORITATIVE_REQUIRED';
  }) => Promise<ReconciliationOutcome>;
  reconcileAuthoritativeWorkspace: () => Promise<void>;
  retry: () => Promise<void>;
}

const MAX_COHERENCE_RECONCILE_ATTEMPTS = 2;

export function useMangaReviewStudio(jobId: string): UseMangaReviewStudioReturn {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [status, setStatus] = useState<
    'initializing' | 'auth_required' | 'loading' | 'ready' | 'error'
  >('initializing');
  const [jobDetail, setJobDetail] =
    useState<TranslationJobReviewDetailResponse | null>(null);
  const [segments, setSegments] = useState<TranslationSegmentDto[]>([]);
  const segmentsRef = useRef<TranslationSegmentDto[]>([]);

  const replaceSegments = useCallback(
    (
      updater:
        | TranslationSegmentDto[]
        | ((prev: TranslationSegmentDto[]) => TranslationSegmentDto[]),
    ) => {
      const next =
        typeof updater === 'function' ? updater(segmentsRef.current) : updater;
      segmentsRef.current = next;
      setSegments(next);
    },
    [],
  );
  const [segmentsSyncStatus, setSegmentsSyncStatus] =
    useState<SegmentsSyncStatus>('SYNCED');
  const [previews, setPreviews] =
    useState<TranslationJobPreviewsResponse | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

  // Synchronous State / Ref Mirrors
  const [conflictStates, setConflictStates] = useState<Record<string, ConflictState>>({});
  const conflictStatesRef = useRef<Record<string, ConflictState>>({});

  const [pendingUnknownMutations, setPendingUnknownMutations] = useState<
    Record<string, PendingUnknownMutation>
  >({});
  const pendingUnknownMutationsRef = useRef<Record<string, PendingUnknownMutation>>({});

  const [materializationState, setMaterializationState] = useState<{
    status: MaterializationRequestStatus;
    targetRevision: number;
  } | null>(null);
  const [isMaterializing, setIsMaterializing] = useState<boolean>(false);
  const [fatalError, setFatalError] = useState<ParsedApiError | null>(null);
  const [operationError, setOperationError] = useState<ParsedApiError | null>(null);
  const [overrideWorkspaceMode, setOverrideWorkspaceMode] =
    useState<WorkspaceModeResult | null>(null);
  const overrideWorkspaceModeRef = useRef<WorkspaceModeResult | null>(null);
  const [authoritativeSyncError, setAuthoritativeSyncError] =
    useState<boolean>(false);
  const authoritativeSyncErrorRef = useRef<boolean>(false);
  const authoritativeProofRef = useRef<AuthoritativeSyncProof | null>(null);

  const replaceAuthoritativeGate = useCallback(
    (error: boolean, mode: WorkspaceModeResult | null) => {
      authoritativeSyncErrorRef.current = error;
      overrideWorkspaceModeRef.current = mode;
      // Implementation Lock 2: If gate is closed (error is true or mode is RECONCILIATION_REQUIRED),
      // invalidate/clear authoritativeProofRef so stale proof cannot bypass the closed gate!
      if (error || mode?.mode === 'RECONCILIATION_REQUIRED') {
        authoritativeProofRef.current = null;
      }
      setAuthoritativeSyncError(error);
      setOverrideWorkspaceMode(mode);
    },
    [],
  );

  // Canonical mirror mutation helpers
  const replaceConflictStates = useCallback(
    (
      updater:
        | Record<string, ConflictState>
        | ((prev: Record<string, ConflictState>) => Record<string, ConflictState>),
    ) => {
      const next =
        typeof updater === 'function' ? updater(conflictStatesRef.current) : updater;
      conflictStatesRef.current = next;
      setConflictStates(next);
    },
    [],
  );

  const replacePendingUnknownMutations = useCallback(
    (
      updater:
        | Record<string, PendingUnknownMutation>
        | ((
            prev: Record<string, PendingUnknownMutation>,
          ) => Record<string, PendingUnknownMutation>),
    ) => {
      const next =
        typeof updater === 'function'
          ? updater(pendingUnknownMutationsRef.current)
          : updater;
      pendingUnknownMutationsRef.current = next;
      setPendingUnknownMutations(next);
    },
    [],
  );

  // Scoped Operation Errors: Prevent unrelated successes from clearing each other's errors
  const segmentErrorsRef = useRef<Record<string, ParsedApiError>>({});
  const materializationErrorRef = useRef<ParsedApiError | null>(null);
  const segmentsSyncErrorRef = useRef<ParsedApiError | null>(null);
  const previewsSyncErrorRef = useRef<ParsedApiError | null>(null);
  const latestOperationErrorRef = useRef<ParsedApiError | null>(null);
  const selectedSegmentIdRef = useRef<string | null>(null);

  const recomputeOperationError = useCallback(() => {
    const selId = selectedSegmentIdRef.current;
    if (selId && segmentErrorsRef.current[selId]) {
      setOperationError(segmentErrorsRef.current[selId]);
      return;
    }
    const latest = latestOperationErrorRef.current;
    if (
      latest &&
      (Object.values(segmentErrorsRef.current).includes(latest) ||
        materializationErrorRef.current === latest ||
        segmentsSyncErrorRef.current === latest ||
        previewsSyncErrorRef.current === latest)
    ) {
      setOperationError(latest);
      return;
    }
    const err =
      Object.values(segmentErrorsRef.current)[0] ||
      materializationErrorRef.current ||
      segmentsSyncErrorRef.current ||
      previewsSyncErrorRef.current ||
      null;
    setOperationError(err);
  }, []);

  useEffect(() => {
    selectedSegmentIdRef.current = selectedSegmentId;
    recomputeOperationError();
  }, [selectedSegmentId, recomputeOperationError]);

  const setSegmentSaveError = useCallback(
    (segmentId: string, err: ParsedApiError) => {
      segmentErrorsRef.current[segmentId] = err;
      latestOperationErrorRef.current = err;
      recomputeOperationError();
    },
    [recomputeOperationError],
  );

  const clearSegmentSaveError = useCallback(
    (segmentId: string) => {
      if (segmentErrorsRef.current[segmentId]) {
        delete segmentErrorsRef.current[segmentId];
        recomputeOperationError();
      }
    },
    [recomputeOperationError],
  );

  const setMaterializationError = useCallback(
    (err: ParsedApiError) => {
      materializationErrorRef.current = err;
      latestOperationErrorRef.current = err;
      recomputeOperationError();
    },
    [recomputeOperationError],
  );

  const clearMaterializationError = useCallback(() => {
    if (materializationErrorRef.current) {
      materializationErrorRef.current = null;
      recomputeOperationError();
    }
  }, [recomputeOperationError]);

  const setSegmentsSyncError = useCallback(
    (err: ParsedApiError) => {
      segmentsSyncErrorRef.current = err;
      latestOperationErrorRef.current = err;
      recomputeOperationError();
    },
    [recomputeOperationError],
  );

  const clearSegmentsSyncError = useCallback(() => {
    if (segmentsSyncErrorRef.current) {
      segmentsSyncErrorRef.current = null;
      recomputeOperationError();
    }
  }, [recomputeOperationError]);

  const setPreviewsSyncError = useCallback(
    (err: ParsedApiError) => {
      previewsSyncErrorRef.current = err;
      latestOperationErrorRef.current = err;
      recomputeOperationError();
    },
    [recomputeOperationError],
  );

  const clearPreviewsSyncError = useCallback(() => {
    if (previewsSyncErrorRef.current) {
      previewsSyncErrorRef.current = null;
      recomputeOperationError();
    }
  }, [recomputeOperationError]);

  const clearAllErrors = useCallback(() => {
    segmentErrorsRef.current = {};
    materializationErrorRef.current = null;
    segmentsSyncErrorRef.current = null;
    previewsSyncErrorRef.current = null;
    latestOperationErrorRef.current = null;
    setOperationError(null);
  }, []);

  const clearOperationError = useCallback(
    (
      scope?:
        | 'latest'
        | 'materialization'
        | 'segments'
        | 'previews'
        | { segmentId: string }
        | unknown,
    ) => {
      if (typeof scope === 'object' && scope !== null && 'segmentId' in scope) {
        delete segmentErrorsRef.current[(scope as { segmentId: string }).segmentId];
      } else if (scope === 'materialization') {
        materializationErrorRef.current = null;
      } else if (scope === 'segments') {
        segmentsSyncErrorRef.current = null;
      } else if (scope === 'previews') {
        previewsSyncErrorRef.current = null;
      } else {
        // Scoped dismissal for 'latest' or undefined/unknown scope:
        // identify the exact active error and clear directly from its backing channel
        const currentErr = operationError || latestOperationErrorRef.current;
        if (currentErr) {
          if (materializationErrorRef.current === currentErr) {
            materializationErrorRef.current = null;
          }
          if (segmentsSyncErrorRef.current === currentErr) {
            segmentsSyncErrorRef.current = null;
          }
          if (previewsSyncErrorRef.current === currentErr) {
            previewsSyncErrorRef.current = null;
          }
          for (const [id, err] of Object.entries(segmentErrorsRef.current)) {
            if (err === currentErr) {
              delete segmentErrorsRef.current[id];
            }
          }
          if (latestOperationErrorRef.current === currentErr) {
            latestOperationErrorRef.current = null;
          }
        }
      }
      recomputeOperationError();
    },
    [operationError, recomputeOperationError],
  );

  // Invariant Protection: Identity, Session & Sequence Tracking
  const activeJobIdRef = useRef(jobId);
  const generationRef = useRef(0);
  const latestStartedDetailSeqRef = useRef(0);
  const latestAppliedDetailSeqRef = useRef(0);
  const dataLoadSeqRef = useRef(0);
  const materializationSeqRef = useRef(0);
  const materializationInFlightRef = useRef(false);
  const previewReconcileAttemptsRef = useRef(0);
  const lastPreviewConflictRevisionRef = useRef<number | null>(null);

  // Round 5: Canonical SSoT is workspaceRevision
  const latestConfirmedWorkspaceRevisionRef = useRef(0);
  const coherenceReconcileEpochRef = useRef(0);
  const segmentMutationSeqRef = useRef<Record<string, number>>({});
  const userSessionIdRef = useRef<string | null>(user?.id ?? null);
  const reconcileRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const previewMismatchBudgetRef = useRef<{
    jobId: string | null;
    userId: string | null;
    workspaceRevision: number;
    attempts: number;
  }>({
    jobId: null,
    userId: null,
    workspaceRevision: -1,
    attempts: 0,
  });

  const recordPreviewMismatch = useCallback(
    (targetJob: string, targetUser: string | null, targetRev: number): number => {
      const budget = previewMismatchBudgetRef.current;
      if (
        budget.jobId !== targetJob ||
        budget.userId !== targetUser ||
        budget.workspaceRevision !== targetRev
      ) {
        previewMismatchBudgetRef.current = {
          jobId: targetJob,
          userId: targetUser,
          workspaceRevision: targetRev,
          attempts: 1,
        };
        return 1;
      }
      budget.attempts += 1;
      return budget.attempts;
    },
    [],
  );

  const resetPreviewMismatchBudget = useCallback(
    (targetJob?: string, targetUser?: string | null, targetRev?: number) => {
      if (typeof targetRev === 'number') {
        previewMismatchBudgetRef.current = {
          jobId: targetJob ?? null,
          userId: targetUser ?? null,
          workspaceRevision: targetRev,
          attempts: 0,
        };
      } else {
        previewMismatchBudgetRef.current = {
          jobId: null,
          userId: null,
          workspaceRevision: -1,
          attempts: 0,
        };
      }
    },
    [],
  );

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

  // Invariant P1-1: Separate server-owned state reset from user drafts preservation
  const resetServerOwnedState = useCallback(
    (preserveDrafts: boolean = true) => {
      setJobDetail(null);
      replaceSegments([]);
      setSegmentsSyncStatus('SYNCED');
      setPreviews(null);
      setSelectedSegmentId(null);
      if (!preserveDrafts) {
        replaceConflictStates({});
        replacePendingUnknownMutations({});
        resetPreviewMismatchBudget();
      }
      setMaterializationState(null);
      materializationInFlightRef.current = false;
      setIsMaterializing(false);
      setFatalError(null);
      clearAllErrors();
      replaceAuthoritativeGate(false, null);
      authoritativeProofRef.current = null;
      setCurrentPage(1);
      previewReconcileAttemptsRef.current = 0;
      lastPreviewConflictRevisionRef.current = null;
      latestConfirmedWorkspaceRevisionRef.current = 0;
      latestAppliedDetailSeqRef.current = 0;
      coherenceReconcileEpochRef.current = 0;
    },
    [
      clearAllErrors,
      replaceSegments,
      replaceConflictStates,
      replacePendingUnknownMutations,
      replaceAuthoritativeGate,
      resetPreviewMismatchBudget,
    ],
  );

  const resetState = useCallback(() => {
    resetServerOwnedState(false);
  }, [resetServerOwnedState]);

  // Invariant P1-2: Clear review cache on mode transitions with draft security lifecycle
  const clearReviewOnlyState = useCallback(
    (preserveDrafts: boolean = true) => {
      dataLoadSeqRef.current++;
      materializationSeqRef.current++;
      materializationInFlightRef.current = false;
      setIsMaterializing(false);
      setPreviews(null);
      replaceSegments([]);
      setSegmentsSyncStatus('SYNCED');
      setSelectedSegmentId(null);
      if (!preserveDrafts) {
        replaceConflictStates({});
        replacePendingUnknownMutations({});
        resetPreviewMismatchBudget();
      }
      setMaterializationState(null);
      setCurrentPage(1);
      previewReconcileAttemptsRef.current = 0;
      lastPreviewConflictRevisionRef.current = null;
    },
    [
      replaceSegments,
      replaceConflictStates,
      replacePendingUnknownMutations,
      resetPreviewMismatchBudget,
    ],
  );

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
      replaceAuthoritativeGate(false, null);
      authoritativeProofRef.current = null;
      setFatalError(parsedErr);
      setStatus('error');
    },
    [resetState, replaceAuthoritativeGate],
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

  // Round 5: 5 Exhaustive Cases to resolve pending unknown mutations
  const resolvePendingUnknownMutations = useCallback(
    (
      currentSegments: TranslationSegmentDto[],
      detailWorkspaceRev: number,
      segmentsWorkspaceRev: number,
    ): boolean => {
      if (
        !isValidWorkspaceRevision(detailWorkspaceRev) ||
        !isValidWorkspaceRevision(segmentsWorkspaceRev) ||
        detailWorkspaceRev !== segmentsWorkspaceRev
      ) {
        return true;
      }

      const pendingMap = pendingUnknownMutationsRef.current;
      const pendingKeys = Object.keys(pendingMap);
      if (pendingKeys.length === 0) return true;

      for (const segId of pendingKeys) {
        const pending = pendingMap[segId];
        if (!pending) continue;

        const serverSeg = currentSegments.find((s) => s.id === segId);

        // Case 4: SEGMENT_REMOVED (Orphan Lock)
        if (!serverSeg) {
          replacePendingUnknownMutations((prev) => {
            const next = { ...prev };
            delete next[segId];
            return next;
          });
          replaceConflictStates((prev) => ({
            ...prev,
            [segId]: {
              kind: 'SEGMENT_REMOVED',
              segmentId: segId,
              draftText: pending.attemptedText,
              draftVerification: pending.attemptedVerification,
              retryBlocked: true,
            },
          }));
          continue;
        }

        // Case 5: INVALID_VERSION_ORDER (Backend version regression / corrupted DB order)
        if (
          typeof serverSeg.version === 'number' &&
          typeof pending.expectedVersion === 'number' &&
          serverSeg.version < pending.expectedVersion
        ) {
          replaceAuthoritativeGate(true, {
            mode: 'RECONCILIATION_REQUIRED',
            canPreview: false,
            canEdit: false,
            canMaterialize: false,
            message:
              'Phiên bản phân đoạn trên máy chủ không hợp lệ (nhỏ hơn phiên bản dự kiến).',
          });
          setFatalError({
            code: 'STATE_DESYNCHRONIZED',
            message:
              'Phát hiện dữ liệu phân đoạn bị thoái lui phiên bản trên máy chủ. Vui lòng làm mới trang.',
          });
          setStatus('error');
          return false;
        }

        // Case 2: EFFECT_PRESENT (Mutation committed on server, desired effect present)
        const isEffectPresent =
          typeof serverSeg.version === 'number' &&
          typeof pending.expectedVersion === 'number' &&
          serverSeg.version > pending.expectedVersion &&
          serverSeg.translatedText === pending.attemptedText &&
          (typeof pending.attemptedVerification !== 'boolean' ||
            serverSeg.isHumanVerified === pending.attemptedVerification);

        if (isEffectPresent) {
          replacePendingUnknownMutations((prev) => {
            const next = { ...prev };
            delete next[segId];
            return next;
          });
          replaceConflictStates((prev) => {
            if (!prev[segId]) return prev;
            const next = { ...prev };
            delete next[segId];
            return next;
          });
          clearSegmentSaveError(segId);
          continue;
        }

        // Case 1: EFFECT_NOT_PRESENT (Packet loss before server DB commit)
        if (serverSeg.version === pending.expectedVersion) {
          replacePendingUnknownMutations((prev) => {
            const next = { ...prev };
            delete next[segId];
            return next;
          });
          replaceConflictStates((prev) => ({
            ...prev,
            [segId]: {
              kind: 'UNCOMMITTED_DRAFT',
              segmentId: segId,
              currentVersion: serverSeg.version,
              expectedVersion: pending.expectedVersion,
              draftText: pending.attemptedText,
              draftVerification: pending.attemptedVerification,
              retryBlocked: false,
            },
          }));
          clearSegmentSaveError(segId);
          continue;
        }

        // Case 3: COMMIT_UNKNOWN_CONFLICT (Overwritten by concurrent writer)
        if (
          typeof serverSeg.version === 'number' &&
          typeof pending.expectedVersion === 'number' &&
          serverSeg.version > pending.expectedVersion &&
          !isEffectPresent
        ) {
          replacePendingUnknownMutations((prev) => {
            const next = { ...prev };
            delete next[segId];
            return next;
          });
          replaceConflictStates((prev) => ({
            ...prev,
            [segId]: {
              kind: 'COMMIT_UNKNOWN_CONFLICT',
              segmentId: segId,
              currentVersion: serverSeg.version,
              expectedVersion: pending.expectedVersion,
              draftText: pending.attemptedText,
              draftVerification: pending.attemptedVerification,
              retryBlocked: false,
            },
          }));
          clearSegmentSaveError(segId);
        }
      }
      return true;
    },
    [
      replacePendingUnknownMutations,
      replaceConflictStates,
      clearSegmentSaveError,
      replaceAuthoritativeGate,
    ],
  );

  const loadJobData = useCallback(
    async (explicitGen?: number, explicitJob?: string) => {
      if (authLoading || !isAuthenticated) {
        setStatus('auth_required');
        return;
      }

      const currentGen = explicitGen ?? generationRef.current;
      const currentJob = explicitJob ?? activeJobIdRef.current;
      const detailSeq = ++latestStartedDetailSeqRef.current;

      setStatus('loading');
      setFatalError(null);

      try {
        const detail = await fetchTranslationJobDetail(currentJob);

        // Scope Identity Guard: Must validate identity before comparing revision!
        if (!isRequestCurrent(currentGen, currentJob)) {
          return;
        }

        // Fail-closed token validation: Reject negative / non-integer revision
        if (!isValidWorkspaceRevision(detail.job.workspaceRevision)) {
          setFatalError({
            code: 'INVALID_WORKSPACE_REVISION',
            message: 'Phiên bản không gian làm việc máy chủ trả về không hợp lệ.',
          });
          setStatus('error');
          return;
        }

        // Monotonic SSoT guard: Reject older snapshots
        if (
          detail.job.workspaceRevision < latestConfirmedWorkspaceRevisionRef.current
        ) {
          return;
        }

        // Sequence tie-break ONLY when revisions are equal
        if (
          detail.job.workspaceRevision ===
            latestConfirmedWorkspaceRevisionRef.current &&
          detailSeq < latestAppliedDetailSeqRef.current
        ) {
          return;
        }

        if (
          detail.job.workspaceRevision >
          latestConfirmedWorkspaceRevisionRef.current
        ) {
          latestConfirmedWorkspaceRevisionRef.current =
            detail.job.workspaceRevision;
          latestAppliedDetailSeqRef.current = detailSeq;
          authoritativeProofRef.current = null;
        } else {
          latestAppliedDetailSeqRef.current = Math.max(
            latestAppliedDetailSeqRef.current,
            detailSeq,
          );
          authoritativeProofRef.current = null;
        }

        setJobDetail(detail);

        const modeResult = getMangaStudioWorkspaceMode({
          jobStatus: detail.job.status,
          mediaFormat: detail.context.story.mediaFormat,
          resultPageCount: detail.reviewSummary?.resultPageCount,
        });

        if (modeResult.mode === 'REVIEWABLE') {
          // P1 Implementation Lock: Only assign dataLoadSeq AFTER detail wins revision ordering!
          const dataLoadSeq = ++dataLoadSeqRef.current;
          setSegmentsSyncStatus('STALE');
          try {
            const segRes = await fetchTranslationJobSegments(currentJob, 1, 100);
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }

            // Invariant: Exact child/detail coherence check
            if (
              !isValidWorkspaceRevision(segRes.workspaceRevision) ||
              segRes.workspaceRevision !== detail.job.workspaceRevision
            ) {
              if (
                coherenceReconcileEpochRef.current < MAX_COHERENCE_RECONCILE_ATTEMPTS
              ) {
                coherenceReconcileEpochRef.current++;
                await reconcileRef.current();
              } else {
                replaceAuthoritativeGate(true, {
                  mode: 'RECONCILIATION_REQUIRED',
                  canPreview: false,
                  canEdit: false,
                  canMaterialize: false,
                  message:
                    'Không thể đồng bộ trạng thái nhất quán giữa chi tiết và danh sách phân đoạn.',
                });
              }
              return;
            }

            // Coherent cycle succeeded: Reset breaker budget
            coherenceReconcileEpochRef.current = 0;
            replaceSegments(segRes.data || []);
            setSegmentsSyncStatus('SYNCED');
            clearSegmentsSyncError();

            // Resolve any pending unknown mutations against coherent segments
            const isResolvedOk = resolvePendingUnknownMutations(
              segRes.data || [],
              detail.job.workspaceRevision,
              segRes.workspaceRevision,
            );
            if (!isResolvedOk || authoritativeSyncErrorRef.current) {
              return;
            }

            if (modeResult.canPreview) {
              try {
                const prevRes = await fetchTranslationJobPreviews(currentJob, {
                  pageNumber: 1,
                });
                if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                  return;
                }

                // Invariant: Exact child/detail coherence check for previews
                if (
                  !isValidWorkspaceRevision(prevRes.workspaceRevision) ||
                  prevRes.workspaceRevision !== detail.job.workspaceRevision
                ) {
                  const attempts = recordPreviewMismatch(
                    currentJob,
                    user?.id ?? null,
                    detail.job.workspaceRevision,
                  );

                  if (attempts < MAX_COHERENCE_RECONCILE_ATTEMPTS) {
                    await reconcileRef.current();
                  } else {
                    replaceAuthoritativeGate(true, {
                      mode: 'RECONCILIATION_REQUIRED',
                      canPreview: false,
                      canEdit: false,
                      canMaterialize: false,
                      message:
                        'Không thể đồng bộ trạng thái nhất quán giữa chi tiết và bản xem trước.',
                    });
                  }
                  return;
                }

                resetPreviewMismatchBudget(
                  currentJob,
                  user?.id ?? null,
                  detail.job.workspaceRevision,
                );
                lastPreviewConflictRevisionRef.current = null;
                setPreviews(prevRes);
                clearPreviewsSyncError();
                replaceAuthoritativeGate(false, null);

                // Implementation Lock 2: Proof is recorded as FINAL STEP after all are coherent!
                authoritativeProofRef.current = {
                  generation: currentGen,
                  jobId: currentJob,
                  userId: user?.id ?? null,
                  revision: detail.job.workspaceRevision,
                  seq: detailSeq,
                  outcome: 'REVIEW_SYNCED',
                };
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
                  const currentRev = detail.job.reviewRevision;
                  if (lastPreviewConflictRevisionRef.current !== currentRev) {
                    lastPreviewConflictRevisionRef.current = currentRev;
                    previewReconcileAttemptsRef.current = 0;
                  }
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

                // Full Coherence Lock: Preview 500 / network error on initial/reload load locks workspace fail-closed!
                replaceAuthoritativeGate(true, {
                  mode: 'RECONCILIATION_REQUIRED',
                  canPreview: false,
                  canEdit: false,
                  canMaterialize: false,
                  message:
                    'Không thể đồng bộ bản xem trước từ máy chủ. Không gian làm việc bị khóa để bảo vệ dữ liệu.',
                });
                setPreviewsSyncError(parsed);
                setStatus('ready');
                return;
              }
            } else {
              // Non-previewable reviewable state: proof recorded after segments!
              replaceAuthoritativeGate(false, null);
              authoritativeProofRef.current = {
                generation: currentGen,
                jobId: currentJob,
                userId: user?.id ?? null,
                revision: detail.job.workspaceRevision,
                seq: detailSeq,
                outcome: 'REVIEW_SYNCED',
              };
            }
          } catch (segErr) {
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return;
            }
            const parsed = parseApiError(segErr);
            if (isJobAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
              return;
            }
            setSegmentsSyncStatus('FAILED');
            setSegmentsSyncError({
              code: 'SEGMENTS_SYNC_FAILED',
              message:
                'Không thể đồng bộ danh sách phân đoạn mới nhất từ máy chủ.',
            });
            replaceAuthoritativeGate(true, {
              mode: 'RECONCILIATION_REQUIRED',
              canPreview: false,
              canEdit: false,
              canMaterialize: false,
              message:
                'Không thể đồng bộ danh sách phân đoạn từ máy chủ. Không gian làm việc bị khóa để bảo vệ dữ liệu.',
            });
          }
        } else {
          // Non-reviewable mode transition
          const isTerminalOrApplied =
            modeResult.mode === 'APPLIED' || modeResult.mode === 'TERMINAL_STATE';
          clearReviewOnlyState(!isTerminalOrApplied);

          if (
            isTerminalOrApplied ||
            modeResult.mode === 'PIPELINE_MONITOR' ||
            modeResult.mode === 'UNSUPPORTED_FORMAT'
          ) {
            authoritativeProofRef.current = {
              generation: currentGen,
              jobId: currentJob,
              userId: user?.id ?? null,
              revision: detail.job.workspaceRevision,
              seq: detailSeq,
              outcome: 'STATE_CHANGED',
            };
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
          setJobDetail(null);
          replaceSegments([]);
          setPreviews(null);
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
      replaceSegments,
      clearSegmentsSyncError,
      setSegmentsSyncError,
      clearPreviewsSyncError,
      setPreviewsSyncError,
      resolvePendingUnknownMutations,
      replaceAuthoritativeGate,
      recordPreviewMismatch,
      resetPreviewMismatchBudget,
      clearReviewOnlyState,
      user?.id,
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
      replaceConflictStates((prev) => {
        if (!prev[idToClear]) return prev;
        const next = { ...prev };
        delete next[idToClear];
        return next;
      });
      clearSegmentSaveError(idToClear);
    },
    [selectedSegmentId, replaceConflictStates, clearSegmentSaveError],
  );

  const reconcileAuthoritativeWorkspace = useCallback(async () => {
    const newGen = ++generationRef.current;
    dataLoadSeqRef.current++;
    latestStartedDetailSeqRef.current++;
    materializationSeqRef.current++;
    materializationInFlightRef.current = false;
    const currentJob = activeJobIdRef.current;

    setJobDetail(null);
    replaceSegments([]);
    setSegmentsSyncStatus('SYNCED');
    setPreviews(null);
    setSelectedSegmentId(null);
    // Invariant: Do NOT wipe user-owned conflictStates here! Keep drafts until authoritative state verifies workspace.
    replaceAuthoritativeGate(false, null);
    authoritativeProofRef.current = null;
    setFatalError(null);
    clearOperationError();
    setMaterializationState(null);
    setIsMaterializing(false);
    setCurrentPage(1);
    latestConfirmedWorkspaceRevisionRef.current = 0;
    latestAppliedDetailSeqRef.current = 0;

    await loadJobData(newGen, currentJob);
  }, [loadJobData, clearOperationError, replaceAuthoritativeGate, replaceSegments]);

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
    // Invariant P1-1: Preserve user drafts and pending unknown mutations across user retries!
    resetServerOwnedState(true);
    await loadJobData(newGen, currentJob);
  }, [resetServerOwnedState, loadJobData]);

  const refetchDetail = useCallback(
    async (options?: {
      requirement?: 'BEST_EFFORT' | 'AUTHORITATIVE_REQUIRED';
    }): Promise<ReconciliationOutcome> => {
      if (status === 'error') {
        return 'FAILED';
      }

      const currentGen = generationRef.current;
      const currentJob = activeJobIdRef.current;
      const detailSeq = ++latestStartedDetailSeqRef.current;

      try {
        const detail = await fetchTranslationJobDetail(currentJob);

        // Scope Identity Guard: Scope must match before comparing revision
        if (!isRequestCurrent(currentGen, currentJob)) {
          return 'SCOPE_INVALIDATED';
        }

        // Fail-closed token validation
        if (!isValidWorkspaceRevision(detail.job.workspaceRevision)) {
          setFatalError({
            code: 'INVALID_WORKSPACE_REVISION',
            message: 'Phiên bản không gian làm việc máy chủ trả về không hợp lệ.',
          });
          setStatus('error');
          if (options?.requirement === 'AUTHORITATIVE_REQUIRED') {
            replaceAuthoritativeGate(true, {
              mode: 'RECONCILIATION_REQUIRED',
              canPreview: false,
              canEdit: false,
              canMaterialize: false,
              message: 'Phiên bản không gian làm việc máy chủ trả về không hợp lệ.',
            });
          }
          return 'FAILED';
        }

        // Monotonic server token guards: Chronological SSoT is workspaceRevision!
        const isStaleRevision =
          detail.job.workspaceRevision <
          latestConfirmedWorkspaceRevisionRef.current;
        const isTieBreakSuperseded =
          detail.job.workspaceRevision ===
            latestConfirmedWorkspaceRevisionRef.current &&
          detailSeq < latestAppliedDetailSeqRef.current;

        if (isStaleRevision || isTieBreakSuperseded) {
          // Implementation Lock 2: If gate is closed, stale proof CANNOT bypass gate!
          const isGateClosed =
            authoritativeSyncErrorRef.current ||
            overrideWorkspaceModeRef.current?.mode === 'RECONCILIATION_REQUIRED';

          if (isGateClosed) {
            return 'RECONCILIATION_REQUIRED';
          }

          const proof = authoritativeProofRef.current;
          const hasValidProof =
            proof &&
            proof.generation === currentGen &&
            proof.jobId === currentJob &&
            proof.userId === (user?.id ?? null) &&
            proof.revision === latestConfirmedWorkspaceRevisionRef.current &&
            (proof.revision > detail.job.workspaceRevision ||
              (proof.revision === detail.job.workspaceRevision &&
                proof.seq >= detailSeq));

          if (hasValidProof) {
            return proof.outcome === 'REVIEW_SYNCED'
              ? 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
              : 'STATE_CHANGED';
          }
          return 'RECONCILIATION_REQUIRED';
        }

        if (
          detail.job.workspaceRevision >
          latestConfirmedWorkspaceRevisionRef.current
        ) {
          latestConfirmedWorkspaceRevisionRef.current =
            detail.job.workspaceRevision;
          latestAppliedDetailSeqRef.current = detailSeq;
          authoritativeProofRef.current = null;
        } else {
          latestAppliedDetailSeqRef.current = Math.max(
            latestAppliedDetailSeqRef.current,
            detailSeq,
          );
          authoritativeProofRef.current = null;
        }

        const reviewRevisionChanged =
          jobDetail &&
          jobDetail.job.reviewRevision !== detail.job.reviewRevision;
        const materializedRevisionChanged =
          jobDetail &&
          jobDetail.job.materializedRevision !== detail.job.materializedRevision;
        const workspaceRevisionChanged =
          jobDetail &&
          jobDetail.job.workspaceRevision !== detail.job.workspaceRevision;
        const statusChanged =
          jobDetail && jobDetail.job.status !== detail.job.status;

        if (
          reviewRevisionChanged ||
          materializedRevisionChanged ||
          workspaceRevisionChanged ||
          statusChanged
        ) {
          setPreviews(null);
        }

        if (reviewRevisionChanged || workspaceRevisionChanged || statusChanged) {
          replaceSegments([]);
        }

        setJobDetail(detail);

        const newMode = getMangaStudioWorkspaceMode({
          jobStatus: detail.job.status,
          mediaFormat: detail.context.story.mediaFormat,
          resultPageCount: detail.reviewSummary?.resultPageCount,
        });

        if (newMode.mode === 'REVIEWABLE') {
          // P1: Only assign dataLoadSeq AFTER detail wins revision ordering!
          const dataLoadSeq = ++dataLoadSeqRef.current;
          setSegmentsSyncStatus('STALE');

          try {
            const segRes = await fetchTranslationJobSegments(currentJob, 1, 100);
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return 'SCOPE_INVALIDATED';
            }

            // Invariant: Exact child/detail coherence check
            if (
              !isValidWorkspaceRevision(segRes.workspaceRevision) ||
              segRes.workspaceRevision !== detail.job.workspaceRevision
            ) {
              if (
                coherenceReconcileEpochRef.current <
                MAX_COHERENCE_RECONCILE_ATTEMPTS
              ) {
                coherenceReconcileEpochRef.current++;
                return await refetchDetail(options);
              } else {
                replaceAuthoritativeGate(true, {
                  mode: 'RECONCILIATION_REQUIRED',
                  canPreview: false,
                  canEdit: false,
                  canMaterialize: false,
                  message:
                    'Không thể đồng bộ trạng thái nhất quán giữa chi tiết và danh sách phân đoạn.',
                });
                return 'RECONCILIATION_REQUIRED';
              }
            }

            // Coherent sync cycle succeeded!
            coherenceReconcileEpochRef.current = 0;
            replaceSegments(segRes.data || []);
            setSegmentsSyncStatus('SYNCED');
            clearSegmentsSyncError();

            // Resolve pending unknown mutations
            const isResolvedOk = resolvePendingUnknownMutations(
              segRes.data || [],
              detail.job.workspaceRevision,
              segRes.workspaceRevision,
            );
            if (!isResolvedOk || authoritativeSyncErrorRef.current) {
              return 'RECONCILIATION_REQUIRED';
            }

            if (newMode.canPreview) {
              try {
                const prevRes = await fetchTranslationJobPreviews(currentJob, {
                  pageNumber: 1,
                });
                if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                  return 'SCOPE_INVALIDATED';
                }

                if (
                  !isValidWorkspaceRevision(prevRes.workspaceRevision) ||
                  prevRes.workspaceRevision !== detail.job.workspaceRevision
                ) {
                  const attempts = recordPreviewMismatch(
                    currentJob,
                    user?.id ?? null,
                    detail.job.workspaceRevision,
                  );

                  if (attempts >= MAX_COHERENCE_RECONCILE_ATTEMPTS) {
                    replaceAuthoritativeGate(true, {
                      mode: 'RECONCILIATION_REQUIRED',
                      canPreview: false,
                      canEdit: false,
                      canMaterialize: false,
                      message:
                        'Không thể đồng bộ trạng thái nhất quán giữa chi tiết và bản xem trước.',
                    });
                  }
                  return 'RECONCILIATION_REQUIRED';
                }

                resetPreviewMismatchBudget(
                  currentJob,
                  user?.id ?? null,
                  detail.job.workspaceRevision,
                );
                lastPreviewConflictRevisionRef.current = null;
                setPreviews(prevRes);
                clearPreviewsSyncError();
                replaceAuthoritativeGate(false, null);

                // Implementation Lock 2: Proof is recorded as FINAL STEP after all are coherent!
                authoritativeProofRef.current = {
                  generation: currentGen,
                  jobId: currentJob,
                  userId: user?.id ?? null,
                  revision: detail.job.workspaceRevision,
                  seq: detailSeq,
                  outcome: 'REVIEW_SYNCED',
                };

                return 'SYNCED';
              } catch (prevErr) {
                if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
                  return 'SCOPE_INVALIDATED';
                }
                const parsed = parseApiError(prevErr);
                if (isJobAccessError(parsed)) {
                  purgeOnAccessError(parsed, currentGen, currentJob);
                  return 'ACCESS_REVOKED';
                }

                if (
                  parsed.code === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS' ||
                  parsed.code === 'NOT_REVIEWABLE'
                ) {
                  const currentRev = detail.job.reviewRevision;
                  if (lastPreviewConflictRevisionRef.current !== currentRev) {
                    lastPreviewConflictRevisionRef.current = currentRev;
                    previewReconcileAttemptsRef.current = 0;
                  }
                  if (previewReconcileAttemptsRef.current < 2) {
                    previewReconcileAttemptsRef.current++;
                    await reconcileRef.current();
                    return 'STATE_CHANGED';
                  } else {
                    setFatalError({
                      code: 'STATE_DESYNCHRONIZED',
                      message:
                        'Trạng thái dữ liệu giữa chi tiết job và bản xem trước không nhất quán từ máy chủ. Vui lòng tải lại trang.',
                    });
                    return 'FAILED';
                  }
                }

                setPreviewsSyncError({
                  code: 'PREVIEWS_SYNC_FAILED',
                  message: 'Không thể đồng bộ bản xem trước từ máy chủ.',
                });

                if (options?.requirement === 'AUTHORITATIVE_REQUIRED') {
                  replaceAuthoritativeGate(true, {
                    mode: 'RECONCILIATION_REQUIRED',
                    canPreview: false,
                    canEdit: false,
                    canMaterialize: false,
                    message:
                      'Không thể đồng bộ bản xem trước từ máy chủ. Không gian làm việc bị khóa để bảo vệ dữ liệu.',
                  });
                  return 'FAILED';
                }

                return 'RECONCILIATION_REQUIRED';
              }
            } else {
              // Non-previewable reviewable state: proof recorded after segments!
              replaceAuthoritativeGate(false, null);
              authoritativeProofRef.current = {
                generation: currentGen,
                jobId: currentJob,
                userId: user?.id ?? null,
                revision: detail.job.workspaceRevision,
                seq: detailSeq,
                outcome: 'REVIEW_SYNCED',
              };

              return 'SYNCED';
            }
          } catch (err) {
            if (!isChildRequestCurrent(currentGen, currentJob, dataLoadSeq)) {
              return 'SCOPE_INVALIDATED';
            }
            const parsed = parseApiError(err);
            if (isJobAccessError(parsed)) {
              purgeOnAccessError(parsed, currentGen, currentJob);
              return 'ACCESS_REVOKED';
            }
            setSegmentsSyncStatus('FAILED');
            setSegmentsSyncError({
              code: 'SEGMENTS_SYNC_FAILED',
              message:
                'Không thể đồng bộ danh sách phân đoạn mới nhất từ máy chủ.',
            });
            if (options?.requirement === 'AUTHORITATIVE_REQUIRED') {
              replaceAuthoritativeGate(true, {
                mode: 'RECONCILIATION_REQUIRED',
                canPreview: false,
                canEdit: false,
                canMaterialize: false,
                message:
                  'Không thể đồng bộ danh sách phân đoạn từ máy chủ. Không gian làm việc bị khóa để bảo vệ dữ liệu.',
              });
            }
            return 'FAILED';
          }
        } else {
          // Non-reviewable state handling:
          const isTerminalOrApplied =
            newMode.mode === 'APPLIED' || newMode.mode === 'TERMINAL_STATE';
          clearReviewOnlyState(!isTerminalOrApplied);

          if (
            isTerminalOrApplied ||
            newMode.mode === 'PIPELINE_MONITOR' ||
            newMode.mode === 'UNSUPPORTED_FORMAT'
          ) {
            authoritativeProofRef.current = {
              generation: currentGen,
              jobId: currentJob,
              userId: user?.id ?? null,
              revision: detail.job.workspaceRevision,
              seq: detailSeq,
              outcome: 'STATE_CHANGED',
            };
            replaceAuthoritativeGate(false, null);
            return 'STATE_CHANGED';
          }

          if (newMode.mode === 'COUNT_UNAVAILABLE') {
            return 'RECONCILIATION_REQUIRED';
          }

          return 'STATE_CHANGED';
        }
      } catch (err) {
        if (!isRequestCurrent(currentGen, currentJob)) {
          return 'SCOPE_INVALIDATED';
        }

        const isGateClosed =
          authoritativeSyncErrorRef.current ||
          overrideWorkspaceModeRef.current?.mode === 'RECONCILIATION_REQUIRED';

        if (!isGateClosed && detailSeq < latestAppliedDetailSeqRef.current) {
          const proof = authoritativeProofRef.current;
          const hasValidProof =
            proof &&
            proof.generation === currentGen &&
            proof.jobId === currentJob &&
            proof.userId === (user?.id ?? null) &&
            proof.revision === latestConfirmedWorkspaceRevisionRef.current &&
            proof.seq >= detailSeq;

          if (hasValidProof) {
            return proof.outcome === 'REVIEW_SYNCED'
              ? 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
              : 'STATE_CHANGED';
          }
        }

        const parsed = parseApiError(err);
        if (isJobAccessError(parsed)) {
          purgeOnAccessError(parsed, currentGen, currentJob);
          return 'ACCESS_REVOKED';
        }

        if (options?.requirement === 'AUTHORITATIVE_REQUIRED') {
          replaceAuthoritativeGate(true, {
            mode: 'RECONCILIATION_REQUIRED',
            canPreview: false,
            canEdit: false,
            canMaterialize: false,
            message:
              'Không thể đồng bộ chi tiết job từ máy chủ. Không gian làm việc bị khóa để bảo vệ dữ liệu.',
          });
        } else {
          console.warn('Failed to refetch job detail:', err);
        }
        return 'FAILED';
      }
    },
    [
      status,
      isRequestCurrent,
      isChildRequestCurrent,
      isJobAccessError,
      purgeOnAccessError,
      jobDetail,
      replaceSegments,
      clearReviewOnlyState,
      clearSegmentsSyncError,
      clearPreviewsSyncError,
      resolvePendingUnknownMutations,
      replaceAuthoritativeGate,
      recordPreviewMismatch,
      resetPreviewMismatchBudget,
      user?.id,
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

      // In-hook fail-closed: If pending unknown mutation exists, REJECT IMMEDIATELY with 0 network calls!
      if (pendingUnknownMutationsRef.current[segmentId]) {
        return buildSaveSegmentResult('UNKNOWN', 'RECONCILIATION_REQUIRED', {
          reason: 'PENDING_UNKNOWN_MUTATION',
          error: {
            code: 'PENDING_MUTATION_IN_PROGRESS',
            message:
              'Phân đoạn này đang chờ xác thực kết quả lưu trước đó từ máy chủ.',
          },
        });
      }

      // In-hook fail-closed: If orphan locked (retryBlocked), REJECT IMMEDIATELY with 0 network calls!
      if (conflictStatesRef.current[segmentId]?.retryBlocked) {
        return buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED', {
          reason: 'SEGMENT_REMOVED',
          conflict: conflictStatesRef.current[segmentId],
          error: {
            code: 'SEGMENT_REMOVED',
            message:
              'Phân đoạn này đã bị xóa trên máy chủ và bị khóa thử lại.',
          },
        });
      }

      // In-hook fail-closed: If VERSION_CONFLICT exists, reject retry unless reconciled to newer version AND baseVersion exact-matches local authoritative version!
      const existingConflict = conflictStatesRef.current[segmentId];
      if (existingConflict?.kind === 'VERSION_CONFLICT') {
        const serverLocal = segmentsRef.current.find((s) => s.id === segmentId);
        const isReconciledNewer =
          serverLocal &&
          typeof serverLocal.version === 'number' &&
          typeof existingConflict.expectedVersion === 'number' &&
          serverLocal.version > existingConflict.expectedVersion;

        const isExactBaseVersion =
          serverLocal &&
          typeof serverLocal.version === 'number' &&
          (options?.baseVersion ?? serverLocal.version) === serverLocal.version;

        const isSafeRetry = isReconciledNewer && isExactBaseVersion;

        if (!isSafeRetry) {
          return buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED', {
            reason: 'VERSION_CONFLICT',
            conflict: existingConflict,
            error: {
              code: 'VERSION_CONFLICT_PENDING_RECONCILIATION',
              message:
                'Phân đoạn này đang chờ đồng bộ lại phiên bản mới từ máy chủ trước khi có thể lưu.',
            },
          });
        }
      }

      if (
        authoritativeSyncErrorRef.current ||
        overrideWorkspaceModeRef.current?.mode === 'RECONCILIATION_REQUIRED' ||
        !workspaceMode ||
        !workspaceMode.canEdit
      ) {
        const isRecon =
          authoritativeSyncErrorRef.current ||
          overrideWorkspaceModeRef.current?.mode === 'RECONCILIATION_REQUIRED';
        return buildSaveSegmentResult(
          'REJECTED',
          isRecon ? 'RECONCILIATION_REQUIRED' : 'STATE_CHANGED',
          {
            error: isRecon
              ? {
                  code: 'RECONCILIATION_REQUIRED',
                  message:
                    'Không gian làm việc đang yêu cầu đồng bộ lại với máy chủ. Thao tác lưu bị chặn để bảo vệ dữ liệu.',
                }
              : undefined,
          },
        );
      }

      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) {
        return buildSaveSegmentResult('REJECTED', 'SYNCED', {
          reason: 'NOT_FOUND',
        });
      }

      const expectedVersion = options?.baseVersion ?? segment.version;
      const payload: UpdateTranslationSegmentRequest = {
        translatedText: text,
        expectedVersion,
      };

      if (typeof options?.isHumanVerified === 'boolean') {
        payload.isHumanVerified = options.isHumanVerified;
      }

      // Generate monotonic per-segment operationId
      const mutationSeq = (segmentMutationSeqRef.current[segmentId] || 0) + 1;
      segmentMutationSeqRef.current[segmentId] = mutationSeq;
      const isCurrent = () =>
        segmentMutationSeqRef.current[segmentId] === mutationSeq;

      try {
        const updated = await updateTranslationSegment(
          targetJob,
          segmentId,
          payload,
        );

        if (!isRequestCurrent(currentGen, targetJob)) {
          return buildSaveSegmentResult('COMMITTED', 'STATE_CHANGED');
        }

        // Sequence guard: If this mutation was superseded by a newer mutation on the same segment,
        // do not mutate local state or trigger side effects!
        if (!isCurrent()) {
          return buildSaveSegmentResult('COMMITTED', 'STATE_CHANGED');
        }

        // Monotonic segment version rule: Never replace local version N with response version < N
        // Sequence-guarded by isCurrent()
        replaceSegments((prev) =>
          prev.map((s) => {
            if (s.id !== segmentId) return s;
            if (
              typeof s.version === 'number' &&
              typeof updated.version === 'number' &&
              updated.version < s.version
            ) {
              return s;
            }
            return { ...s, ...updated };
          }),
        );

        // Clear conflict state if this is still the latest operation
        replaceConflictStates((prev) => {
          if (!prev[segmentId]) return prev;
          const next = { ...prev };
          delete next[segmentId];
          return next;
        });

        // P1-5: Sequence guard clearSegmentSaveError with isCurrent()!
        clearSegmentSaveError(segmentId);

        const syncOutcome = await refetchDetail({
          requirement: 'AUTHORITATIVE_REQUIRED',
        });

        if (syncOutcome === 'ACCESS_REVOKED') {
          return buildSaveSegmentResult('COMMITTED', 'ACCESS_REVOKED', {
            reason: 'ACCESS_REVOKED',
          });
        }
        if (
          syncOutcome === 'SCOPE_INVALIDATED' ||
          syncOutcome === 'STATE_CHANGED'
        ) {
          return buildSaveSegmentResult('COMMITTED', 'STATE_CHANGED');
        }
        if (
          syncOutcome === 'SYNCED' ||
          syncOutcome === 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
        ) {
          return buildSaveSegmentResult('COMMITTED', 'SYNCED');
        }

        return buildSaveSegmentResult('COMMITTED', 'RECONCILIATION_REQUIRED');
      } catch (err) {
        if (!isRequestCurrent(currentGen, targetJob)) {
          return buildSaveSegmentResult('UNKNOWN', 'STATE_CHANGED');
        }

        const parsed = parseApiError(err);
        if (isAuthOrPermissionError(parsed)) {
          purgeOnAccessError(parsed, currentGen, targetJob);
          return buildSaveSegmentResult('REJECTED', 'ACCESS_REVOKED', {
            reason: 'ACCESS_REVOKED',
            error: parsed,
          });
        }

        // Ambiguous segment 404 handling
        if (parsed.status === 404 || parsed.code === 'NOT_FOUND') {
          const provisionalDraftText = text;
          const provisionalDraftVerification = options?.isHumanVerified;
          if (isCurrent()) {
            setSegmentSaveError(segmentId, parsed);
            if (selectedSegmentId === segmentId) {
              setSelectedSegmentId(null);
            }
          }

          const syncOutcome = await refetchDetail({
            requirement: 'AUTHORITATIVE_REQUIRED',
          });

          // Implementation Lock 4: If mutation is no longer current, DO NOT alter any per-segment state!
          if (!isCurrent()) {
            return buildSaveSegmentResult('REJECTED', 'STATE_CHANGED', {
              reason: 'SUPERSEDED_BY_NEWER_MUTATION',
            });
          }

          if (syncOutcome === 'ACCESS_REVOKED') {
            return buildSaveSegmentResult('REJECTED', 'ACCESS_REVOKED', {
              reason: 'ACCESS_REVOKED',
              error: parsed,
            });
          }

          if (syncOutcome === 'STATE_CHANGED') {
            return buildSaveSegmentResult('REJECTED', 'STATE_CHANGED', {
              error: parsed,
            });
          }

          if (
            syncOutcome !== 'SYNCED' &&
            syncOutcome !== 'SUPERSEDED_BY_SUCCESSFUL_SYNC'
          ) {
            return buildSaveSegmentResult(
              'REJECTED',
              'RECONCILIATION_REQUIRED',
              {
                reason: 'NOT_FOUND',
                error: parsed,
              },
            );
          }

          // Authoritative sync established! Inspect authoritative segments
          const serverSeg = segmentsRef.current.find((s) => s.id === segmentId);
          if (!serverSeg) {
            // Segment truly absent on server: confirm orphan lock
            if (selectedSegmentId === segmentId) {
              setSelectedSegmentId(null);
            }
            replaceSegments((prev) => prev.filter((s) => s.id !== segmentId));

            const orphanConflict: ConflictState = {
              kind: 'SEGMENT_REMOVED',
              segmentId,
              draftText: provisionalDraftText,
              draftVerification: provisionalDraftVerification,
              retryBlocked: true,
            };
            replaceConflictStates((prev) => ({
              ...prev,
              [segmentId]: orphanConflict,
            }));
            setSegmentSaveError(segmentId, parsed);

            return buildSaveSegmentResult('REJECTED', 'SYNCED', {
              reason: 'NOT_FOUND',
              conflict: orphanConflict,
              error: parsed,
            });
          }

          // Segment still present on server: do NOT orphan lock, allow retry!
          replaceConflictStates((prev) => {
            if (!prev[segmentId]) return prev;
            const next = { ...prev };
            delete next[segmentId];
            return next;
          });

          return buildSaveSegmentResult('REJECTED', 'SYNCED', {
            reason: 'NOT_FOUND',
            error: parsed,
          });
        }

        const conflict = classifyConflictError(err);

        // P1-4 & P1-5: 409 VERSION_CONFLICT
        if (conflict.type === 'VERSION_CONFLICT') {
          let newConflict: ConflictState | undefined;
          if (isCurrent()) {
            newConflict = {
              kind: 'VERSION_CONFLICT',
              segmentId,
              currentVersion: conflict.currentVersion,
              expectedVersion: conflict.expectedVersion,
              draftText: text,
              draftVerification: options?.isHumanVerified,
              retryBlocked: false,
            };
            replaceConflictStates((prev) => ({
              ...prev,
              [segmentId]: newConflict!,
            }));
            // P1-5: Guard setSegmentSaveError with isCurrent()!
            setSegmentSaveError(segmentId, parsed);
          }

          // Trigger authoritative reconciliation in background to fetch authoritative segments
          refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' }).catch(() => {});

          // Invariant P1-4: 409 means expectedVersion != currentVersion -> workspaceState is RECONCILIATION_REQUIRED!
          return buildSaveSegmentResult('REJECTED', 'RECONCILIATION_REQUIRED', {
            reason: 'VERSION_CONFLICT',
            conflict: newConflict,
            error: parsed,
          });
        }

        if (
          conflict.type === 'NOT_REVIEWABLE' ||
          conflict.type === 'REVISION_INVARIANT_VIOLATION' ||
          conflict.type === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS'
        ) {
          if (isCurrent()) {
            setSegmentSaveError(segmentId, parsed);
          }
          await reconcileAuthoritativeWorkspace();
          return buildSaveSegmentResult('REJECTED', 'STATE_CHANGED', {
            error: parsed,
          });
        }

        // P1-6: Deterministic 4xx rejection (e.g. 400 Bad Request, 422 Unprocessable Entity, ANCHOR_TOPOLOGY_VIOLATION)
        // Happens BEFORE database commit on backend -> REJECTED + VALIDATION, NEVER create PendingUnknownMutation!
        const isDeterministic4xx =
          parsed.status === 400 ||
          parsed.status === 422 ||
          parsed.code === 'ANCHOR_TOPOLOGY_VIOLATION' ||
          parsed.code === 'VALIDATION_FAILED' ||
          parsed.code === 'BAD_REQUEST';

        if (isDeterministic4xx) {
          if (isCurrent()) {
            setSegmentSaveError(segmentId, parsed);
          }
          return buildSaveSegmentResult('REJECTED', 'SYNCED', {
            reason: 'VALIDATION',
            backendCode: parsed.code,
            error: parsed,
          });
        }

        // True Network / Timeout / 5xx Server Failure: Outcome unknown on server!
        if (isCurrent()) {
          replacePendingUnknownMutations((prev) => ({
            ...prev,
            [segmentId]: {
              segmentId,
              operationId: mutationSeq,
              attemptedText: text,
              attemptedVerification: options?.isHumanVerified,
              expectedVersion,
            },
          }));
          setSegmentSaveError(segmentId, parsed);
        }

        return buildSaveSegmentResult('UNKNOWN', 'RECONCILIATION_REQUIRED', {
          reason: 'NETWORK',
          error: parsed,
        });
      }
    },
    [
      segments,
      workspaceMode,
      selectedSegmentId,
      isRequestCurrent,
      isAuthOrPermissionError,
      refetchDetail,
      purgeOnAccessError,
      reconcileAuthoritativeWorkspace,
      clearSegmentSaveError,
      setSegmentSaveError,
      replaceSegments,
      replaceConflictStates,
      replacePendingUnknownMutations,
    ],
  );

  const triggerMaterialization =
    useCallback(async (): Promise<MaterializationRequestResponse | null> => {
      const currentGen = generationRef.current;
      const targetJob = activeJobIdRef.current;

      // Fail-closed gate: Materialization is ONLY allowed when workspace is REVIEWABLE AND freshness is STALE!
      if (
        materializationInFlightRef.current ||
        !workspaceMode ||
        !workspaceMode.canMaterialize ||
        freshness.status !== 'STALE'
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

        setMaterializationState({
          status: res.status,
          targetRevision: res.targetRevision,
        });
        clearMaterializationError();

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

        setMaterializationError(parsed);
        return null;
      } finally {
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
      freshness.status,
      isRequestCurrent,
      isJobAccessError,
      refetchDetail,
      purgeOnAccessError,
      reconcileAuthoritativeWorkspace,
      clearMaterializationError,
      setMaterializationError,
    ]);

  const activeMaterializationStatus: MaterializationRequestStatus | null =
    materializationState &&
    jobDetail &&
    materializationState.targetRevision === jobDetail.job.reviewRevision
      ? materializationState.status
      : null;

  return {
    status,
    jobDetail,
    segments,
    segmentsSyncStatus,
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
    pendingUnknownMutations,
    clearConflict,
    replaceConflictStates,
    saveSegment,
    triggerMaterialization,
    materializationStatus: activeMaterializationStatus,
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
