import {
  SyncDomain,
  SyncOperation,
  MutationExecutionStatus,
  MutationResultItem,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  indexedDbClient,
  LocalPendingMutation,
  LocalQuarantinedMutation,
  QuarantineRejectionStatus,
  CausalTriageProof,
  assertValidScope,
  InvalidDeltaPayloadError,
  isValidRevisionString,
  RecordTransientFailureOptions,
  TransientFailureResult,
  RETRYABLE_QUARANTINE_REJECTION_STATUSES,
} from '../storage/indexed-db-client';

export class ScopeTransitioningError extends Error {
  constructor(message: string = 'Cannot execute mutation queue operation while identity is transitioning.') {
    super(message);
    this.name = 'ScopeTransitioningError';
  }
}

export class ScopeMismatchError extends Error {
  constructor(expected: string, received: string) {
    super(`Scope mismatch in MutationQueue: expected "${expected}", received "${received}".`);
    this.name = 'ScopeMismatchError';
  }
}

export class StaleBatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleBatchRejectedError';
  }
}

export class RequeueProhibitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequeueProhibitedError';
  }
}

export class AuthoritativePullTriggerError extends Error {
  constructor(
    message: string,
    public readonly scope: string,
    public readonly originalCause?: unknown
  ) {
    super(message);
    this.name = 'AuthoritativePullTriggerError';
  }
}

/**
 * Batch Lifecycle States for strict concurrency control (Step 4a.2 — P0-12).
 */
export type BatchLifecycleState = 'ACTIVE' | 'PROCESSING' | 'SETTLED' | 'RELEASED' | 'FAILED';

export interface BatchLifecycleRecord {
  state: BatchLifecycleState;
  intent?: 'RECEIPT' | 'NETWORK_FAILURE';
  claimedAt?: number;
  completedAt?: number;
  error?: Error;
  reconciliationRequired?: boolean;
  reconciliationSettled?: boolean;
}

export type ClaimResult =
  | { success: true }
  | { success: false; reason: 'ALREADY_PROCESSING' | 'ALREADY_SETTLED' | 'ALREADY_RELEASED' | 'STALE_SCOPE_OR_GEN' };

/**
 * Interface for authoritative identity state provider (e.g. ActiveScopeCoordinator)
 */
export interface IdentityStateProvider {
  getActiveScope: () => string | null;
  isTransitioning: () => boolean;
  canMutateUserState: () => boolean;
}

export interface SettableIdentityStateProvider extends IdentityStateProvider {
  setScope: (scope: string | null) => void;
  setTransitioning: (transitioning: boolean) => void;
  setCanMutate: (canMutate: boolean) => void;
}

/**
 * Creates an identity provider for testing or stable sessions.
 */
export function createStaticIdentityProvider(scope: string): SettableIdentityStateProvider {
  let currentScope: string | null = scope;
  let transitioning = false;
  let canMutate = true;
  return {
    getActiveScope: () => currentScope,
    isTransitioning: () => transitioning,
    canMutateUserState: () => canMutate,
    setScope: (s: string | null) => {
      currentScope = s;
    },
    setTransitioning: (t: boolean) => {
      transitioning = t;
    },
    setCanMutate: (c: boolean) => {
      canMutate = c;
    },
  };
}

export interface InFlightOwner {
  ownerScope: string;
  scopeGeneration: number;
  batchId: string;
}

export interface PreparedPushBatch {
  batchId: string;
  ownerScope: string;
  scopeGeneration: number;
  createdAt: number;
  mutations: LocalPendingMutation[];
}

export interface MutationQueueOptions {
  ownerScope: string;
  identityStateProvider: IdentityStateProvider;
  dbClient?: IndexedDbClient;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffFactor?: number;
  isScopeTransitioning?: () => boolean;
  onAuthoritativeDeltaPullRequired?: (scope: string) => void | Promise<void>;
  onReplicaEvicted?: (scope: string, domain: SyncDomain, entityId: string) => void;
  onMutationQuarantined?: (scope: string, mutation: LocalQuarantinedMutation) => void;
  maxSettledBatches?: number;
}

export interface BatchProcessingSummary {
  ownerScope: string;
  processedCount: number;
  appliedCount: number;
  deduplicatedCount: number;
  tombstoneEvictedCount: number;
  staleQuarantinedCount: number;
  unsupportedCount: number;
  conflictMergedCount: number;
  transientRetryCount: number;
}

export interface QueueStatusReport {
  ownerScope: string;
  scopeGeneration: number;
  pendingCount: number;
  inFlightCount: number;
  quarantinedCount: number;
  inBackoffCount: number;
}

/**
 * MutationQueue (Phase 7C.3 — Step 4 Remediated)
 *
 * Implements client-side mutation queuing and quarantine triaging with strict invariants:
 * 1. Mutation Identity: Strictly preserves mutationId, payload, baseServerRevision, and causal metadata.
 * 2. Scope Isolation & Generation Guard (P0-04 Remediation):
 *    - Each prepared batch is immutable and tagged with `ownerScope` and `scopeGeneration`.
 *    - `processServerBatchResults` strictly rejects stale responses that arrive after `setActiveScope()`.
 *    - Asynchronous boundaries check scope generation before every IndexedDB write to prevent cross-account contamination.
 * 3. Causal Triage & Requeue Protection (P0-05 Remediation):
 *    - Requeue of `REJECTED_TOMBSTONE` is permanently prohibited (prevents resurrection).
 *    - Requeue of `REJECTED_STALE` or `HTTP_410_GONE` requires explicit approved causal proof.
 * 4. Fail-Closed Identity Transition Authority (P0-06 Remediation):
 *    - Integrates with `IdentityStateProvider` to guarantee fail-closed rejection when identity is TRANSITIONING.
 * 5. Persistent Retry Backoff (P1 Remediation):
 *    - Persists `nextRetryAt` and `retryCount` directly to IndexedDB so backoff survives page reloads.
 * 6. Atomic Tombstone Eviction (P1 Remediation):
 *    - Replica eviction and pending mutation deletion run inside a single atomic IndexedDB transaction.
 * 7. Worker Authority:
 *    - No autonomous background network push loop exists in Step 4.
 */
export class MutationQueue {
  private ownerScope: string;
  private scopeGeneration: number = 0;
  private readonly dbClient: IndexedDbClient;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly identityStateProvider: IdentityStateProvider;
  private readonly isScopeTransitioningFn?: () => boolean;
  private readonly onAuthoritativeDeltaPullRequired?: (scope: string) => void | Promise<void>;
  private readonly onReplicaEvicted?: (scope: string, domain: SyncDomain, entityId: string) => void;
  private readonly onMutationQuarantined?: (scope: string, mutation: LocalQuarantinedMutation) => void;

  /**
   * Generation-scoped & Batch-scoped in-flight mutation map [mutationId -> InFlightOwner] (P0-09).
   * Prevents late callbacks from previous generations or different batches from clearing in-flight locks.
   */
  private readonly inFlightMap: Map<string, InFlightOwner> = new Map();

  /**
   * Tracks batch lifecycle states for concurrency claim & settlement (Step 4a.2 — P0-12).
   */
  private readonly batchLifecycle: Map<string, BatchLifecycleRecord> = new Map();
  private readonly settledBatches: Set<string> = new Set();
  private readonly settledBatchQueue: string[] = [];
  private readonly maxSettledBatches: number;

  /**
   * Tracks batches that have completed terminal mutation writes for CONFLICT_MERGED
   * but their authoritative delta pull trigger has not yet completed successfully.
   */
  private readonly pendingReconciliationBatches: Set<string> = new Set();

  constructor(options: MutationQueueOptions) {
    assertValidScope(options.ownerScope);
    if (!options.identityStateProvider) {
      throw new ScopeTransitioningError('MutationQueue requires an authoritative IdentityStateProvider.');
    }
    this.ownerScope = options.ownerScope;
    this.identityStateProvider = options.identityStateProvider;
    this.dbClient = options.dbClient || indexedDbClient;
    this.maxRetries = options.maxRetries ?? 5;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.isScopeTransitioningFn = options.isScopeTransitioning;
    this.onAuthoritativeDeltaPullRequired = options.onAuthoritativeDeltaPullRequired;
    this.onReplicaEvicted = options.onReplicaEvicted;
    this.onMutationQuarantined = options.onMutationQuarantined;
    this.maxSettledBatches = options.maxSettledBatches ?? 500;
  }

  // ==================== BATCH OWNERSHIP & LIFECYCLE STATE MACHINE ====================

  /**
   * Synchronously claims processing rights for a batch before any async await (P0-12).
   * Guarantees mutual exclusion between concurrent receipts and network failure handlers.
   */
  private tryClaimBatchProcessing(
    batch: PreparedPushBatch,
    intent: 'RECEIPT' | 'NETWORK_FAILURE'
  ): ClaimResult {
    if (batch.ownerScope !== this.ownerScope || batch.scopeGeneration !== this.scopeGeneration) {
      return { success: false, reason: 'STALE_SCOPE_OR_GEN' };
    }

    if (this.settledBatches.has(batch.batchId)) {
      return { success: false, reason: 'ALREADY_SETTLED' };
    }

    const record = this.batchLifecycle.get(batch.batchId);
    if (record) {
      if (record.state === 'SETTLED') {
        return { success: false, reason: 'ALREADY_SETTLED' };
      }
      if (record.state === 'RELEASED') {
        return { success: false, reason: 'ALREADY_RELEASED' };
      }
      if (record.state === 'PROCESSING') {
        return { success: false, reason: 'ALREADY_PROCESSING' };
      }
    }

    // Synchronously claim PROCESSING before any await
    this.batchLifecycle.set(batch.batchId, {
      ...record,
      state: 'PROCESSING',
      intent,
      claimedAt: Date.now(),
    });
    return { success: true };
  }

  private hasInFlightMutationsForBatch(batchId: string): boolean {
    for (const token of this.inFlightMap.values()) {
      if (token.batchId === batchId) {
        return true;
      }
    }
    return false;
  }

  private markBatchSettled(batchId: string): void {
    const record = this.batchLifecycle.get(batchId);
    const hasUnresolvedReconciliation = Boolean(
      (record?.reconciliationRequired && !record?.reconciliationSettled) ||
      this.pendingReconciliationBatches.has(batchId)
    );

    if (hasUnresolvedReconciliation) {
      // Settlement is blocked until reconciliation obligation is fulfilled!
      // Keep state as FAILED to allow reconciliation retry via retryBatchReconciliation or processServerBatchResults
      if (record) {
        record.state = 'FAILED';
        record.error =
          record.error ||
          new Error(`Batch "${batchId}" completed mutation processing but has pending authoritative reconciliation.`);
      }
      return;
    }

    if (this.hasInFlightMutationsForBatch(batchId)) {
      // Settlement is blocked while batch still owns uncommitted in-flight mutations (P0 edge-case / RT-39)
      if (record) {
        record.state = 'FAILED';
        record.error =
          record.error ||
          new Error(`Batch "${batchId}" cannot be settled while owning unfinished in-flight mutations.`);
      }
      return;
    }

    if (record) {
      record.state = 'SETTLED';
      record.completedAt = Date.now();
    } else {
      this.batchLifecycle.set(batchId, { state: 'SETTLED', completedAt: Date.now() });
    }

    if (!this.settledBatches.has(batchId)) {
      this.settledBatches.add(batchId);
      this.settledBatchQueue.push(batchId);
      if (this.settledBatchQueue.length > this.maxSettledBatches) {
        const oldest = this.settledBatchQueue.shift();
        if (oldest) {
          this.settledBatches.delete(oldest);
          this.batchLifecycle.delete(oldest);
        }
      }
    }
  }

  private markBatchFailed(batchId: string, error: Error): void {
    const record = this.batchLifecycle.get(batchId);
    if (record) {
      record.state = 'FAILED';
      record.error = error;
    } else {
      this.batchLifecycle.set(batchId, { state: 'FAILED', error });
    }
  }

  /**
   * Recovers a failed batch by releasing all its uncommitted in-flight mutations,
   * allowing subsequent preparePushBatch() calls to pick them up into a new batch.
   * Committed mutations remain permanently committed and are never replayed.
   */
  recoverFailedBatch(batch: PreparedPushBatch): void {
    this.releaseInFlight(batch);
  }

  private isBatchOwner(
    batch: { ownerScope: string; scopeGeneration: number; batchId: string },
    mutationId: string
  ): boolean {
    const currentOwner = this.inFlightMap.get(mutationId);
    if (!currentOwner) return false;
    return (
      currentOwner.ownerScope === batch.ownerScope &&
      currentOwner.scopeGeneration === batch.scopeGeneration &&
      currentOwner.batchId === batch.batchId
    );
  }

  private assertBatchOwnership(
    batch: { ownerScope: string; scopeGeneration: number; batchId: string },
    mutationId: string
  ): void {
    if (!this.isBatchOwner(batch, mutationId)) {
      throw new StaleBatchRejectedError(
        `Batch ownership mismatch for mutation "${mutationId}": batch "${batch.batchId}" (scope "${batch.ownerScope}", gen ${batch.scopeGeneration}) does not own this mutation.`
      );
    }
  }

  private releaseOwnedMutation(
    batch: { ownerScope: string; scopeGeneration: number; batchId: string },
    mutationId: string
  ): boolean {
    if (this.isBatchOwner(batch, mutationId)) {
      this.inFlightMap.delete(mutationId);
      return true;
    }
    return false;
  }

  // ==================== SCOPE & LIFECYCLE MANAGEMENT ====================

  /**
   * Switches the active account scope.
   * Increments scopeGeneration to immediately invalidate any in-flight asynchronous operations or stale batches.
   * Clears in-flight tracking, lifecycle state, and settled batch tracking for the previous scope.
   */
  setActiveScope(newScope: string): void {
    assertValidScope(newScope);
    if (this.ownerScope === newScope) {
      return;
    }
    this.scopeGeneration++;
    this.inFlightMap.clear();
    this.batchLifecycle.clear();
    this.settledBatches.clear();
    this.settledBatchQueue.length = 0;
    this.pendingReconciliationBatches.clear();
    this.ownerScope = newScope;
  }

  getActiveScope(): string {
    return this.ownerScope;
  }

  getScopeGeneration(): number {
    return this.scopeGeneration;
  }

  /**
   * Authoritative Boundary Assertion (Step 4a — P0-07):
   * Validates queue identity and authority at every asynchronous admission and completion boundary:
   * - Expected scope match
   * - Generation mismatch guard (invalidates operations across account transitions or A -> B -> A cycles)
   * - IdentityStateProvider checks: not transitioning, authorized to mutate, and matches active scope
   * - Custom transition guard
   */
  private assertAuthorityAtBoundary(expectedScope?: string, expectedGeneration?: number): void {
    if (expectedScope && expectedScope !== this.ownerScope) {
      throw new ScopeMismatchError(this.ownerScope, expectedScope);
    }

    if (expectedGeneration !== undefined && expectedGeneration !== this.scopeGeneration) {
      throw new StaleBatchRejectedError(
        `Authority revoked due to generation mismatch: expected gen ${expectedGeneration}, current gen ${this.scopeGeneration}.`
      );
    }

    // 1. Authoritative IdentityStateProvider check (Fail-closed)
    if (!this.identityStateProvider) {
      throw new ScopeTransitioningError('MutationQueue requires an authoritative IdentityStateProvider.');
    }

    if (this.identityStateProvider.isTransitioning()) {
      throw new ScopeTransitioningError('Cannot execute mutation queue operation while identity is transitioning.');
    }

    if (!this.identityStateProvider.canMutateUserState()) {
      throw new ScopeTransitioningError(
        'Cannot execute mutation queue operation: active scope is not authorized to mutate user state.'
      );
    }

    const providerScope = this.identityStateProvider.getActiveScope();
    if (!providerScope || providerScope !== this.ownerScope) {
      throw new ScopeMismatchError(this.ownerScope, providerScope ?? 'null');
    }

    // 2. Custom callback check
    if (this.isScopeTransitioningFn && this.isScopeTransitioningFn()) {
      throw new ScopeTransitioningError('Cannot execute mutation queue operation while identity is transitioning.');
    }
  }

  /**
   * Legacy alias: Delegates to assertAuthorityAtBoundary for backwards compatibility within class.
   */
  private assertSafeExecution(scopeToCheck?: string): void {
    this.assertAuthorityAtBoundary(scopeToCheck);
  }

  // ==================== QUEUE INGESTION & READ OPERATIONS ====================

  /**
   * Enqueues a pending mutation.
   * Enforces scope isolation, mutation immutability, and pre-transaction admission guard.
   */
  async enqueue(mutation: LocalPendingMutation): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(mutation.ownerScope, currentGen);

    await this.dbClient.enqueuePendingMutation(mutation, {
      checkAdmission: () => {
        this.assertAuthorityAtBoundary(mutation.ownerScope, currentGen);
      },
    });
  }

  /**
   * Retrieves pending mutations for the active scope, ordered chronologically.
   */
  async getPendingMutations(limit: number = 100): Promise<LocalPendingMutation[]> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    return this.dbClient.getPendingMutations(currentScope, limit);
  }

  /**
   * Retrieves quarantined mutations for the active scope, ordered by rejection time descending.
   */
  async getQuarantinedMutations(): Promise<LocalQuarantinedMutation[]> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    return this.dbClient.getQuarantinedMutations(currentScope);
  }

  // ==================== PUSH BATCH PREPARATION ====================

  /**
   * Prepares a batch of mutations to be pushed to the Core API.
   * Filters out mutations currently in-flight or waiting in backoff (persisted in DB).
   * Returns a PreparedPushBatch with immutable snapshot of ownerScope and scopeGeneration.
   *
   * P1-D Atomic Convergence:
   * - Never relies on an earlier TX's `minActiveRevision` snapshot (`watermarkSweep`) or unlocked
   *   `getPendingMutations` results for final batch admission.
   * - Re-verifies live `pending_mutations` against the LATEST `sync_meta.minActiveRevision` inside ONE
   *   atomic IndexedDB readwrite transaction (`selectEligiblePendingBatchAtomic`), moving any stale
   *   mutations (< latest `minActiveRevision`) to `quarantined_mutations` with full payload preservation.
   *
   * Pre-Dispatch Guard Specification for Future Step 5.2d (Network Dispatcher Not Implemented Yet):
   * - Note: No HTTP sender / network transport dispatcher exists in Step 5.2c; network dispatch is
   *   NOT protected by this method alone after `PreparedPushBatch` is returned.
   * - Before Step 5.2d dispatches `POST /api/v1/sync/mutations/batch`, the network dispatcher MUST:
   *   1. Re-verify active Web Locks Tab Leader lease (`leaderSignal`) and `IdentityStateProvider`
   *      `(batch.ownerScope, batch.scopeGeneration)` authority; if revoked, abort dispatch and
   *      call `releaseInFlight(batch)` without deleting offline pending data.
   *   2. Run an atomic pre-dispatch IDB revalidation against the latest `sync_meta.minActiveRevision`
   *      and live `pending_mutations`, atomically quarantining any item whose `baseServerRevision < latestMinActiveRevision`
   *      (preserving user payload) and excluding non-pending items rather than dispatching stale wire payloads.
   *   3. Hold the Tab Leader lock across dispatch -> receipt ingest and rely on Core API `BASE_REVISION_EXPIRED`
   *      (`REJECTED_STALE`) on receipt for any watermark advance occurring after the HTTP request leaves the browser.
   *
   * Crucial Invariant: Strictly preserves mutationId, payload, and baseServerRevision.
   */
  async preparePushBatch(options?: {
    limit?: number;
    now?: number;
    leaderSignal?: AbortSignal;
  }): Promise<PreparedPushBatch> {
    const currentScope = this.ownerScope;
    const currentGeneration = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGeneration);

    const limit = options?.limit ?? 50;
    const now = options?.now ?? Date.now();
    const batchId = `batch-${now}-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`;

    const emptyBatch: PreparedPushBatch = {
      batchId,
      ownerScope: currentScope,
      scopeGeneration: currentGeneration,
      createdAt: now,
      mutations: [],
    };

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    const collectActiveInFlightIds = (): Set<string> => {
      const ids = new Set<string>();
      for (const [mId, owner] of this.inFlightMap.entries()) {
        if (owner.ownerScope === currentScope && owner.scopeGeneration === currentGeneration) {
          ids.add(mId);
        }
      }
      return ids;
    };

    const emitQuarantinedEvents = (quarantinedList: LocalQuarantinedMutation[]) => {
      if (
        quarantinedList.length === 0 ||
        this.ownerScope !== currentScope ||
        this.scopeGeneration !== currentGeneration ||
        options?.leaderSignal?.aborted
      ) {
        return;
      }
      for (const quarantinedItem of quarantinedList) {
        try {
          this.assertAuthorityAtBoundary(currentScope, currentGeneration);
          if (options?.leaderSignal?.aborted) break;
          this.onMutationQuarantined?.(currentScope, quarantinedItem);
        } catch {
          break;
        }
      }
    };

    const isLeaderAbortedError = (err: unknown): boolean =>
      Boolean(options?.leaderSignal?.aborted) ||
      (err instanceof Error && err.message === 'Leader signal aborted during preparePushBatch.');

    const checkPrepAdmission = () => {
      this.assertAuthorityAtBoundary(currentScope, currentGeneration);
      if (options?.leaderSignal?.aborted) {
        throw new Error('Leader signal aborted during preparePushBatch.');
      }
    };

    let watermarkSweep;
    try {
      watermarkSweep = await this.dbClient.quarantineStalePendingMutationsByWatermark(
        currentScope,
        {
          excludeMutationIds: collectActiveInFlightIds(),
          checkAdmission: checkPrepAdmission,
        }
      );
    } catch (err) {
      if (
        isLeaderAbortedError(err) ||
        err instanceof ScopeTransitioningError ||
        err instanceof ScopeMismatchError ||
        err instanceof StaleBatchRejectedError
      ) {
        return emptyBatch;
      }
      throw err;
    }

    emitQuarantinedEvents(watermarkSweep.quarantinedMutations);

    try {
      this.assertAuthorityAtBoundary(currentScope, currentGeneration);
    } catch {
      return emptyBatch;
    }

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    // Preserve pre-selection snapshot read boundary (supports P0-06/race await hooks)
    await this.dbClient.getPendingMutations(currentScope, limit * 2);

    // Asynchronous boundary check: ensure scope, generation, and authority haven't changed during getPendingMutations
    try {
      this.assertAuthorityAtBoundary(currentScope, currentGeneration);
    } catch {
      return emptyBatch;
    }

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    // Atomic Re-verification & Selection against LATEST sync_meta.minActiveRevision in ONE readwrite tx (P1-D)
    let atomicSelection;
    try {
      atomicSelection = await this.dbClient.selectEligiblePendingBatchAtomic(currentScope, {
        limit,
        now,
        excludeMutationIds: collectActiveInFlightIds(),
        checkAdmission: checkPrepAdmission,
      });
    } catch (err) {
      if (
        isLeaderAbortedError(err) ||
        err instanceof ScopeTransitioningError ||
        err instanceof ScopeMismatchError ||
        err instanceof StaleBatchRejectedError
      ) {
        return emptyBatch;
      }
      throw err;
    }

    emitQuarantinedEvents(atomicSelection.quarantinedMutations);

    try {
      this.assertAuthorityAtBoundary(currentScope, currentGeneration);
    } catch {
      return emptyBatch;
    }

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    const selected: LocalPendingMutation[] = [];

    for (const item of atomicSelection.selectedMutations) {
      if (this.inFlightMap.has(item.mutationId)) {
        continue;
      }
      if (selected.length >= limit) {
        break;
      }

      this.inFlightMap.set(item.mutationId, {
        ownerScope: currentScope,
        scopeGeneration: currentGeneration,
        batchId,
      });
      selected.push(item);
    }

    if (selected.length > 0) {
      this.batchLifecycle.set(batchId, { state: 'ACTIVE' });
    }

    return {
      batchId,
      ownerScope: currentScope,
      scopeGeneration: currentGeneration,
      createdAt: now,
      mutations: selected,
    };
  }

  /**
   * Releases in-flight status for a batch of mutations (P0-09 Generation & Batch Isolated).
   * Strictly requires a PreparedPushBatch and only releases mutations owned by that exact batch.
   */
  releaseInFlight(batch: PreparedPushBatch): void {
    if (!batch || !Array.isArray(batch.mutations)) return;
    for (const m of batch.mutations) {
      this.releaseOwnedMutation(batch, m.mutationId);
    }
    const record = this.batchLifecycle.get(batch.batchId);
    if (record && record.state !== 'SETTLED' && record.state !== 'FAILED') {
      record.state = 'RELEASED';
    } else if (!record) {
      this.batchLifecycle.set(batch.batchId, { state: 'RELEASED' });
    }
  }

  getBatchLifecycle(batchId: string): BatchLifecycleRecord | undefined {
    return this.batchLifecycle.get(batchId);
  }

  hasPendingReconciliation(batchId: string): boolean {
    return this.pendingReconciliationBatches.has(batchId);
  }

  /**
   * Checks whether the batch still owns uncommitted in-flight mutations (RT-39).
   */
  hasUnfinishedMutations(batch: PreparedPushBatch): boolean {
    if (!batch || !Array.isArray(batch.mutations)) return false;
    return batch.mutations.some((m) => this.isBatchOwner(batch, m.mutationId));
  }

  /**
   * Verifies if a specific mutation is still owned in-flight by the given batch.
   */
  isMutationInFlightForBatch(batch: PreparedPushBatch, mutationId: string): boolean {
    return this.isBatchOwner(batch, mutationId);
  }

  /**
   * Explicitly retries authoritative reconciliation for a failed batch
   * without re-processing already committed terminal mutations.
   */
  async retryBatchReconciliation(batch: PreparedPushBatch): Promise<void> {
    const { ownerScope: batchOwnerScope, scopeGeneration: batchScopeGeneration } = batch;
    if (batchOwnerScope !== this.ownerScope || batchScopeGeneration !== this.scopeGeneration) {
      throw new StaleBatchRejectedError(
        `Cannot retry reconciliation for stale batch: scope "${batchOwnerScope}" (gen ${batchScopeGeneration}), active "${this.ownerScope}" (gen ${this.scopeGeneration}).`
      );
    }

    // Precondition 1: Verify batch actually has pending reconciliation requirement
    const record = this.batchLifecycle.get(batch.batchId);
    const hasPending =
      this.pendingReconciliationBatches.has(batch.batchId) ||
      Boolean(record?.reconciliationRequired && !record?.reconciliationSettled);
    if (!hasPending) {
      throw new Error(
        `Cannot retry reconciliation for batch "${batch.batchId}": no pending authoritative reconciliation requirement found.`
      );
    }

    // Precondition 2: Verify onAuthoritativeDeltaPullRequired callback is configured
    if (!this.onAuthoritativeDeltaPullRequired) {
      throw new AuthoritativePullTriggerError(
        `Cannot retry reconciliation for scope "${batchOwnerScope}": onAuthoritativeDeltaPullRequired callback is not configured.`,
        batchOwnerScope
      );
    }

    const claim = this.tryClaimBatchProcessing(batch, 'RECEIPT');
    if (!claim.success) {
      return;
    }

    try {
      this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
      await this.onAuthoritativeDeltaPullRequired(batchOwnerScope);
      this.pendingReconciliationBatches.delete(batch.batchId);
      const activeRecord = this.batchLifecycle.get(batch.batchId);
      if (activeRecord) {
        activeRecord.reconciliationRequired = false;
        activeRecord.reconciliationSettled = true;
      }

      // Invariant (RT-39): Do NOT mark batch SETTLED if it still owns unfinished in-flight mutations.
      // Revert state to FAILED to retain a clean resume/recovery path (via processServerBatchResults or recoverFailedBatch).
      if (this.hasUnfinishedMutations(batch)) {
        if (activeRecord) {
          activeRecord.state = 'FAILED';
          activeRecord.error =
            activeRecord.error ||
            new Error(
              `Authoritative reconciliation succeeded for batch "${batch.batchId}", but batch still owns unfinished in-flight mutations.`
            );
        }
        return;
      }

      this.markBatchSettled(batch.batchId);
    } catch (err) {
      this.pendingReconciliationBatches.add(batch.batchId);
      const activeRecord = this.batchLifecycle.get(batch.batchId);
      if (activeRecord) {
        activeRecord.reconciliationRequired = true;
        activeRecord.reconciliationSettled = false;
      }
      this.markBatchFailed(batch.batchId, err as Error);
      throw new AuthoritativePullTriggerError(
        `Failed to retry authoritative delta pull for scope "${batchOwnerScope}": ${(err as Error)?.message || err}`,
        batchOwnerScope,
        err
      );
    }
  }

  // ==================== SERVER RECEIPT & RESPONSE PROCESSING ====================

  /**
   * Processes receipt results from POST /api/v1/sync/mutations/batch.
   *
   * Strict Invariant Enforcement (P0-04 Remediation & P0-12 Concurrency):
   * - Stale Batch Guard: Rejects batch if batch.ownerScope or batch.scopeGeneration does not match
   *   the queue's active state. Old responses NEVER mutate a newly switched account!
   * - Synchronous Processing Claim: Claims PROCESSING state before any await to prevent race with
   *   concurrent receipts or failure handlers.
   * - Asynchronous Boundary Verification: Re-checks scope, generation, and batch ownership before EVERY IndexedDB write.
   * - Atomic Tombstone Eviction: Uses evictReplicaAndRemovePending to atomically evict replica and remove pending mutation.
   * - Callback Error Propagation (P1-04): Throws AuthoritativePullTriggerError on callback failure; does NOT swallow.
   */
  async processServerBatchResults(params: {
    results: MutationResultItem[];
    batch: PreparedPushBatch;
    leaderSignal?: AbortSignal;
  }): Promise<BatchProcessingSummary> {
    const { results, batch, leaderSignal } = params;
    const { ownerScope: batchOwnerScope, scopeGeneration: batchScopeGeneration, mutations: batchMutations } = batch;

    // 1. Stale Batch Guard (P0-04 & P0-09 Invariant): Never mutate state or release in-flight state of new generation!
    if (batchOwnerScope !== this.ownerScope || batchScopeGeneration !== this.scopeGeneration) {
      throw new StaleBatchRejectedError(
        `Stale batch rejected: batch belongs to scope "${batchOwnerScope}" (gen ${batchScopeGeneration}), ` +
        `but active queue is at scope "${this.ownerScope}" (gen ${this.scopeGeneration}). Operation aborted to prevent cross-account contamination.`
      );
    }

    // 2. Synchronous Processing Claim (P0-12):
    // Claims processing rights synchronously BEFORE first await to prevent concurrent callback execution.
    const claim = this.tryClaimBatchProcessing(batch, 'RECEIPT');
    if (!claim.success) {
      return {
        ownerScope: batchOwnerScope,
        processedCount: 0,
        appliedCount: 0,
        deduplicatedCount: 0,
        tombstoneEvictedCount: 0,
        staleQuarantinedCount: 0,
        unsupportedCount: 0,
        conflictMergedCount: 0,
        transientRetryCount: 0,
      };
    }

    try {
      // 3. Validate individual mutation scope integrity
      for (const m of batchMutations) {
        if (m.ownerScope !== batchOwnerScope) {
          this.releaseInFlight(batch);
          throw new ScopeMismatchError(batchOwnerScope, m.ownerScope);
        }
      }

      this.assertSafeExecution(batchOwnerScope);

      if (leaderSignal?.aborted) {
        this.releaseInFlight(batch);
        throw new Error('Leader signal aborted while processing server batch results.');
      }

      const summary: BatchProcessingSummary = {
        ownerScope: batchOwnerScope,
        processedCount: batchMutations.length,
        appliedCount: 0,
        deduplicatedCount: 0,
        tombstoneEvictedCount: 0,
        staleQuarantinedCount: 0,
        unsupportedCount: 0,
        conflictMergedCount: 0,
        transientRetryCount: 0,
      };

      const resultMap = new Map<string, MutationResultItem>();
      for (const r of results) {
        resultMap.set(r.mutationId, r);
      }

      const existingRecord = this.batchLifecycle.get(batch.batchId);
      let deltaPullNeeded = Boolean(
        (existingRecord?.reconciliationRequired && !existingRecord?.reconciliationSettled) ||
        this.pendingReconciliationBatches.has(batch.batchId)
      );

      for (const mutation of batchMutations) {
        // Asynchronous Boundary Guard: Re-verify scope, generation, and authority before EACH operation
        this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);

        if (leaderSignal?.aborted) {
          this.releaseInFlight(batch);
          throw new Error('Leader signal aborted while processing server batch results.');
        }

        // Ownership Guard (P0-09B): If this batch no longer owns the mutation, skip!
        if (!this.isBatchOwner(batch, mutation.mutationId)) {
          continue;
        }

        const res = resultMap.get(mutation.mutationId);

        if (!res) {
          // Missing from server response: treat as transient network omission, apply persistent retry backoff
          await this.handleTransientFailure(
            batch,
            mutation,
            new Error('Missing result item in server batch response.')
          );
          summary.transientRetryCount++;
          continue;
        }

        switch (res.status) {
          case 'APPLIED':
            await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.appliedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            break;

          case 'DEDUPLICATED':
            await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.deduplicatedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            break;

          case 'REJECTED_TOMBSTONE': {
            // Anti-Tombstone Resurrection: ATOMIC eviction of replica and deletion of pending mutation
            await this.dbClient.evictReplicaAndRemovePending(
              batchOwnerScope,
              mutation.domain,
              mutation.entityId,
              mutation.mutationId,
              mutation.payload,
              {
                checkAdmission: () => {
                  this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                  this.assertBatchOwnership(batch, mutation.mutationId);
                },
              }
            );
            summary.tombstoneEvictedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            // Post-commit callback safety (Section 5)
            if (this.ownerScope === batchOwnerScope && this.scopeGeneration === batchScopeGeneration) {
              try {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.onReplicaEvicted?.(batchOwnerScope, mutation.domain, mutation.entityId);
              } catch {
                // Authority revoked after commit; do not emit stale callback
              }
            }
            break;
          }

          case 'REJECTED_STALE': {
            // Invariant: Do NOT rebase or replay. Quarantine atomically for triage with full metadata.
            const quarantined: LocalQuarantinedMutation = {
              ownerScope: batchOwnerScope,
              mutationId: mutation.mutationId,
              clientId: mutation.clientId,
              domain: mutation.domain,
              entityId: mutation.entityId,
              operation: mutation.operation,
              baseServerRevision: mutation.baseServerRevision,
              payload: mutation.payload,
              rejectionReason: res.reason || res.message || 'REJECTED_STALE',
              rejectionStatus: 'REJECTED_STALE',
              rejectedAt: new Date().toISOString(),
              triageStatus: 'PENDING',
              originalCreatedAt: mutation.createdAt,
            };
            await this.dbClient.quarantineMutation(quarantined, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.staleQuarantinedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            // Post-commit callback safety (Section 5)
            if (this.ownerScope === batchOwnerScope && this.scopeGeneration === batchScopeGeneration) {
              try {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.onMutationQuarantined?.(batchOwnerScope, quarantined);
              } catch {
                // Authority revoked after commit; do not emit stale callback
              }
            }
            break;
          }

          case 'CONFLICT_MERGED': {
            // Invariant: Response has no resolvedPayload. Remove pending and trigger authoritative delta pull.
            await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.conflictMergedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            deltaPullNeeded = true;
            // Record reconciliation requirement immediately upon successful CONFLICT_MERGED commit
            this.pendingReconciliationBatches.add(batch.batchId);
            const record = this.batchLifecycle.get(batch.batchId);
            if (record) {
              record.reconciliationRequired = true;
              record.reconciliationSettled = false;
            }
            break;
          }

          case 'DOMAIN_NOT_SUPPORTED': {
            // Invariant: Do not retry infinitely. Quarantine for diagnosis.
            const quarantined: LocalQuarantinedMutation = {
              ownerScope: batchOwnerScope,
              mutationId: mutation.mutationId,
              clientId: mutation.clientId,
              domain: mutation.domain,
              entityId: mutation.entityId,
              operation: mutation.operation,
              baseServerRevision: mutation.baseServerRevision,
              payload: mutation.payload,
              rejectionReason: res.reason || res.message || 'DOMAIN_NOT_SUPPORTED',
              rejectionStatus: 'DOMAIN_NOT_SUPPORTED',
              rejectedAt: new Date().toISOString(),
              triageStatus: 'PENDING',
              originalCreatedAt: mutation.createdAt,
            };
            await this.dbClient.quarantineMutation(quarantined, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.unsupportedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            if (this.ownerScope === batchOwnerScope && this.scopeGeneration === batchScopeGeneration) {
              try {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.onMutationQuarantined?.(batchOwnerScope, quarantined);
              } catch {
                // Authority revoked after commit
              }
            }
            break;
          }

          default: {
            // Unrecognized status: safe fallback to quarantine
            const fallbackQuarantined: LocalQuarantinedMutation = {
              ownerScope: batchOwnerScope,
              mutationId: mutation.mutationId,
              clientId: mutation.clientId,
              domain: mutation.domain,
              entityId: mutation.entityId,
              operation: mutation.operation,
              baseServerRevision: mutation.baseServerRevision,
              payload: mutation.payload,
              rejectionReason: `UNRECOGNIZED_STATUS: ${(res as any).status}`,
              rejectionStatus: 'MANUAL',
              rejectedAt: new Date().toISOString(),
              triageStatus: 'PENDING',
              originalCreatedAt: mutation.createdAt,
            };
            await this.dbClient.quarantineMutation(fallbackQuarantined, {
              checkAdmission: () => {
                this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
                this.assertBatchOwnership(batch, mutation.mutationId);
              },
            });
            summary.unsupportedCount++;
            this.releaseOwnedMutation(batch, mutation.mutationId);
            break;
          }
        }
      }

      // P1-04 & Blocker P0: Authoritative Delta Pull Trigger & Recovery Semantics
      if (deltaPullNeeded) {
        if (!this.onAuthoritativeDeltaPullRequired) {
          this.pendingReconciliationBatches.add(batch.batchId);
          const record = this.batchLifecycle.get(batch.batchId);
          if (record) {
            record.reconciliationRequired = true;
            record.reconciliationSettled = false;
          }
          throw new AuthoritativePullTriggerError(
            `Authoritative delta pull required for scope "${batchOwnerScope}" after CONFLICT_MERGED, but no handler is configured.`,
            batchOwnerScope
          );
        }

        let isAuthorityValid = false;
        try {
          this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
          isAuthorityValid = true;
        } catch {
          // Authority was revoked before invocation: intentional cancellation - do NOT run callback
          isAuthorityValid = false;
        }

        if (isAuthorityValid) {
          try {
            await this.onAuthoritativeDeltaPullRequired(batchOwnerScope);
            this.pendingReconciliationBatches.delete(batch.batchId);
            const record = this.batchLifecycle.get(batch.batchId);
            if (record) {
              record.reconciliationRequired = false;
              record.reconciliationSettled = true;
            }
          } catch (callbackErr) {
            this.pendingReconciliationBatches.add(batch.batchId);
            const record = this.batchLifecycle.get(batch.batchId);
            if (record) {
              record.reconciliationRequired = true;
              record.reconciliationSettled = false;
            }
            throw new AuthoritativePullTriggerError(
              `Failed to trigger authoritative delta pull for scope "${batchOwnerScope}": ${(callbackErr as Error)?.message || callbackErr}`,
              batchOwnerScope,
              callbackErr
            );
          }
        }
      }

      this.markBatchSettled(batch.batchId);
      return summary;
    } catch (err) {
      this.markBatchFailed(batch.batchId, err as Error);
      throw err;
    }
  }

  // ==================== NETWORK & TRANSIENT FAILURE HANDLING ====================

  /**
   * Handles network timeout or connection failure for an in-flight batch.
   * Strictly preserves mutation identity (mutationId, payload, baseServerRevision intact).
   * Increments retryCount and persists exponential backoff (nextRetryAt) directly to IndexedDB.
   * Quarantines mutations that exceed maxRetries.
   */
  async handleNetworkFailure(
    batch: PreparedPushBatch,
    error: Error
  ): Promise<void> {
    const { ownerScope: batchOwnerScope, scopeGeneration: batchScopeGeneration, mutations: batchMutations } = batch;

    // Stale Batch Check: Do NOT release in-flight state of new generation!
    if (batchOwnerScope !== this.ownerScope || batchScopeGeneration !== this.scopeGeneration) {
      return;
    }

    const claim = this.tryClaimBatchProcessing(batch, 'NETWORK_FAILURE');
    if (!claim.success) {
      return;
    }

    try {
      this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);

      for (const mutation of batchMutations) {
        // Re-check authority before each mutation retry
        if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
          return;
        }
        this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
        await this.handleTransientFailure(batch, mutation, error);
      }

      this.markBatchSettled(batch.batchId);
    } catch (err) {
      this.markBatchFailed(batch.batchId, err as Error);
      throw err;
    }
  }

  /**
   * Handles transient failure for a single mutation using the atomic DAL primitive recordTransientFailureAtomic.
   * Eliminates read-then-write lost updates and ensures single-transaction retry vs quarantine decisions.
   *
   * Strict Batch Ownership (P0-11):
   * Requires a valid PreparedPushBatch. If the batch does not own the mutation, immediately no-ops.
   */
  private async handleTransientFailure(
    batch: PreparedPushBatch,
    mutation: LocalPendingMutation,
    error: Error
  ): Promise<void> {
    const { ownerScope: batchOwnerScope, scopeGeneration: batchScopeGeneration } = batch;

    // 1. Strict batch ownership check (P0-11):
    // If this batch does NOT own the mutation, under NO circumstances should it retry or quarantine.
    if (!this.isBatchOwner(batch, mutation.mutationId)) {
      return;
    }

    // 2. Pre-transaction authority admission check
    if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
      return;
    }

    // 3. Atomic failure coordination in single IDB transaction (P1-01)
    const result = await this.dbClient.recordTransientFailureAtomic(
      batchOwnerScope,
      mutation.mutationId,
      {
        maxRetries: this.maxRetries,
        initialBackoffMs: this.initialBackoffMs,
        maxBackoffMs: this.maxBackoffMs,
        backoffFactor: this.backoffFactor,
        failureReason: error.message,
        checkAdmission: () => {
          this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
          this.assertBatchOwnership(batch, mutation.mutationId);
        },
      }
    );

    // 4. Release in-flight ownership ONLY after DAL operation completes
    this.releaseOwnedMutation(batch, mutation.mutationId);

    // 5. Post-transaction authority guard before firing side effects / callbacks
    if (result.outcome === 'QUARANTINED' && result.quarantinedMutation) {
      if (this.ownerScope === batchOwnerScope && this.scopeGeneration === batchScopeGeneration) {
        try {
          this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
          this.onMutationQuarantined?.(batchOwnerScope, result.quarantinedMutation);
        } catch {
          // Authority revoked after transaction committed; omit callback
        }
      }
    }
  }

  // ==================== QUARANTINE TRIAGE OPERATIONS ====================

  /**
   * Manually moves a pending mutation to quarantine using direct composite key lookup.
   * Avoids scanning or pagination limits.
   */
  async quarantine(mutationId: string, reason: string): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);

    const owner = this.inFlightMap.get(mutationId);
    if (owner && owner.ownerScope === currentScope && owner.scopeGeneration === currentGen) {
      this.inFlightMap.delete(mutationId);
    }

    const quarantined = await this.dbClient.quarantinePendingMutationByKey(
      currentScope,
      mutationId,
      reason,
      'MANUAL',
      {
        checkAdmission: () => {
          this.assertAuthorityAtBoundary(currentScope, currentGen);
        },
      }
    );

    if (this.ownerScope === currentScope && this.scopeGeneration === currentGen && quarantined) {
      try {
        this.assertAuthorityAtBoundary(currentScope, currentGen);
        this.onMutationQuarantined?.(currentScope, quarantined);
      } catch {
        // Authority revoked after commit; do not emit stale callback
      }
    }
  }

  /**
   * Requeues a quarantined mutation back to pending_mutations in a single atomic transaction.
   * Strictly preserves exact mutationId, payload, and baseServerRevision.
   * Resets retryCount to 0 and clears nextRetryAt.
   *
   * Invariant Enforcement:
   * - P1-A / P1-C: DISCARDED and APPROVED triageStatus are strictly terminal (cannot requeue old mutationId,
   *   even if triageProof.triageApproved=true). Non-PENDING triageStatus fails closed.
   * - P0-05 / P1-C: Prohibits REJECTED_TOMBSTONE, REJECTED_STALE, HTTP_410_GONE, and non-retryable rejections;
   *   only PENDING + EXCEEDED_MAX_RETRIES / MANUAL may be requeued.
   * - Guards are re-verified inside IndexedDbClient.requeueQuarantinedMutation's readwrite transaction.
   */
  async requeue(mutationId: string, _triageProof?: CausalTriageProof): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);

    const quarantined = await this.dbClient.getQuarantinedMutation(currentScope, mutationId);
    if (!quarantined) {
      throw new Error(`Quarantined mutation "${mutationId}" not found for scope "${currentScope}".`);
    }

    this.assertAuthorityAtBoundary(currentScope, currentGen);

    if (quarantined.triageStatus === 'DISCARDED') {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": mutation triageStatus is DISCARDED (terminal user decision).`
      );
    }

    if (quarantined.triageStatus === 'APPROVED') {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": mutation triageStatus is APPROVED (terminal; Step 6 triage requires creating a brand-new replacement mutationId).`
      );
    }

    if (quarantined.triageStatus !== 'PENDING') {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": non-PENDING triageStatus "${String(quarantined.triageStatus)}" is not requeueable.`
      );
    }

    if (quarantined.rejectionStatus === 'REJECTED_TOMBSTONE') {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": mutation was REJECTED_TOMBSTONE because the entity was deleted on server. Replaying would violate anti-resurrection invariant.`
      );
    }

    if (
      quarantined.rejectionStatus === 'REJECTED_STALE' ||
      quarantined.rejectionStatus === 'HTTP_410_GONE'
    ) {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": Requeuing ${quarantined.rejectionStatus} mutations is locked until Step 6 Causal Triage Engine is implemented.`
      );
    }

    if (
      !quarantined.rejectionStatus ||
      !RETRYABLE_QUARANTINE_REJECTION_STATUSES.has(quarantined.rejectionStatus)
    ) {
      throw new RequeueProhibitedError(
        `Cannot requeue mutation "${mutationId}": rejectionStatus "${String(quarantined.rejectionStatus)}" is non-retryable. Only retryable rejections (EXCEEDED_MAX_RETRIES, MANUAL) under PENDING triageStatus may be requeued.`
      );
    }

    if (!isValidRevisionString(quarantined.baseServerRevision)) {
      throw new InvalidDeltaPayloadError(
        `Invalid baseServerRevision on quarantined mutation "${mutationId}": "${quarantined.baseServerRevision}".`
      );
    }

    const syncMeta = await this.dbClient.getSyncMeta(currentScope);
    this.assertAuthorityAtBoundary(currentScope, currentGen);

    if (syncMeta?.minActiveRevision !== undefined && syncMeta?.minActiveRevision !== null) {
      if (!isValidRevisionString(syncMeta.minActiveRevision)) {
        throw new InvalidDeltaPayloadError(
          `Invalid minActiveRevision during requeue for scope "${currentScope}": "${syncMeta.minActiveRevision}".`
        );
      }
      const minActiveRev = BigInt(syncMeta.minActiveRevision);
      if (minActiveRev > 0n && BigInt(quarantined.baseServerRevision) < minActiveRev) {
        throw new RequeueProhibitedError(
          `Cannot requeue mutation "${mutationId}": baseServerRevision "${quarantined.baseServerRevision}" is older than minActiveRevision "${syncMeta.minActiveRevision}".`
        );
      }
    }

    try {
      await this.dbClient.requeueQuarantinedMutation(currentScope, mutationId, _triageProof, {
        checkAdmission: () => {
          this.assertAuthorityAtBoundary(currentScope, currentGen);
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('REQUEUE_PROHIBITED:')) {
        throw new RequeueProhibitedError(err.message);
      }
      throw err;
    }
  }

  /**
   * Deletes a quarantined mutation.
   */
  async deleteQuarantined(mutationId: string): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    await this.dbClient.deleteQuarantinedMutation(currentScope, mutationId, {
      checkAdmission: () => {
        this.assertAuthorityAtBoundary(currentScope, currentGen);
      },
    });
  }

  /**
   * Clears all quarantined mutations for the active scope.
   */
  async clearQuarantined(): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    await this.dbClient.clearQuarantinedMutations(currentScope, {
      checkAdmission: () => {
        this.assertAuthorityAtBoundary(currentScope, currentGen);
      },
    });
  }

  // ==================== QUEUE STATUS & DIAGNOSTICS ====================

  /**
   * Returns high-level diagnostic status of the queue.
   */
  async getStatus(): Promise<QueueStatusReport> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);

    const pending = await this.dbClient.getPendingMutations(currentScope, 1000);
    const quarantined = await this.dbClient.getQuarantinedMutations(currentScope);
    const now = Date.now();

    let inBackoffCount = 0;
    for (const p of pending) {
      if (p.nextRetryAt && p.nextRetryAt > now) {
        inBackoffCount++;
      }
    }

    return {
      ownerScope: currentScope,
      scopeGeneration: currentGen,
      pendingCount: pending.length,
      inFlightCount: this.inFlightMap.size,
      quarantinedCount: quarantined.length,
      inBackoffCount,
    };
  }
}
