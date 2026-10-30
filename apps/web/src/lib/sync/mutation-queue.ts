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
  RecordTransientFailureOptions,
  TransientFailureResult,
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
   * Generation-scoped in-flight mutation map [mutationId -> scopeGeneration] (P0-08).
   * Prevents late callbacks from previous generations from clearing in-flight locks of newer generations.
   */
  private readonly inFlightMap: Map<string, number> = new Map();

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
  }

  // ==================== SCOPE & LIFECYCLE MANAGEMENT ====================

  /**
   * Switches the active account scope.
   * Increments scopeGeneration to immediately invalidate any in-flight asynchronous operations or stale batches.
   * Clears in-flight tracking for the previous scope.
   */
  setActiveScope(newScope: string): void {
    assertValidScope(newScope);
    if (this.ownerScope === newScope) {
      return;
    }
    this.scopeGeneration++;
    this.inFlightMap.clear();
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

    const emptyBatch: PreparedPushBatch = {
      batchId: `batch-${now}-${Math.random().toString(36).slice(2, 8)}`,
      ownerScope: currentScope,
      scopeGeneration: currentGeneration,
      createdAt: now,
      mutations: [],
    };

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    const pending = await this.dbClient.getPendingMutations(currentScope, limit * 2);

    // Asynchronous boundary check: ensure scope, generation, and authority haven't changed during getPendingMutations
    try {
      this.assertAuthorityAtBoundary(currentScope, currentGeneration);
    } catch {
      return emptyBatch;
    }

    if (options?.leaderSignal?.aborted) {
      return emptyBatch;
    }

    const selected: LocalPendingMutation[] = [];

    for (const item of pending) {
      if (selected.length >= limit) {
        break;
      }
      if (this.inFlightMap.has(item.mutationId)) {
        continue;
      }
      // Persistent Backoff Invariant: item.nextRetryAt stored in IndexedDB
      if (item.nextRetryAt && item.nextRetryAt > now) {
        continue;
      }

      this.inFlightMap.set(item.mutationId, currentGeneration);
      selected.push(item);
    }

    return {
      batchId: `batch-${now}-${Math.random().toString(36).slice(2, 8)}`,
      ownerScope: currentScope,
      scopeGeneration: currentGeneration,
      createdAt: now,
      mutations: selected,
    };
  }

  /**
   * Releases in-flight status for a batch of mutations (P0-08 Generation Isolated).
   */
  releaseInFlight(batchOrIds: PreparedPushBatch | LocalPendingMutation[] | string[]): void {
    if ('mutations' in batchOrIds && Array.isArray(batchOrIds.mutations)) {
      const batchGen = batchOrIds.scopeGeneration;
      for (const m of batchOrIds.mutations) {
        if (this.inFlightMap.get(m.mutationId) === batchGen) {
          this.inFlightMap.delete(m.mutationId);
        }
      }
    } else if (Array.isArray(batchOrIds)) {
      for (const item of batchOrIds) {
        const id = typeof item === 'string' ? item : item.mutationId;
        if (this.inFlightMap.get(id) === this.scopeGeneration) {
          this.inFlightMap.delete(id);
        }
      }
    }
  }

  // ==================== SERVER RECEIPT & RESPONSE PROCESSING ====================

  /**
   * Processes receipt results from POST /api/v1/sync/mutations/batch.
   *
   * Strict Invariant Enforcement (P0-04 Remediation):
   * - Stale Batch Guard: Rejects batch if batch.ownerScope or batch.scopeGeneration does not match
   *   the queue's active state. Old responses NEVER mutate a newly switched account!
   * - Asynchronous Boundary Verification: Re-checks scope and generation before EVERY IndexedDB write.
   * - Atomic Tombstone Eviction: Uses evictReplicaAndRemovePending to atomically evict replica and remove pending mutation.
   */
  async processServerBatchResults(params: {
    results: MutationResultItem[];
    batch: PreparedPushBatch;
    leaderSignal?: AbortSignal;
  }): Promise<BatchProcessingSummary> {
    const { results, batch, leaderSignal } = params;
    const { ownerScope: batchOwnerScope, scopeGeneration: batchScopeGeneration, mutations: batchMutations } = batch;

    // 1. Stale Batch Guard (P0-04 Invariant)
    if (batchOwnerScope !== this.ownerScope || batchScopeGeneration !== this.scopeGeneration) {
      this.releaseInFlight(batchMutations);
      throw new StaleBatchRejectedError(
        `Stale batch rejected: batch belongs to scope "${batchOwnerScope}" (gen ${batchScopeGeneration}), ` +
        `but active queue is at scope "${this.ownerScope}" (gen ${this.scopeGeneration}). Operation aborted to prevent cross-account contamination.`
      );
    }

    // 2. Validate individual mutation scope integrity
    for (const m of batchMutations) {
      if (m.ownerScope !== batchOwnerScope) {
        this.releaseInFlight(batchMutations);
        throw new ScopeMismatchError(batchOwnerScope, m.ownerScope);
      }
    }

    this.assertSafeExecution(batchOwnerScope);

    if (leaderSignal?.aborted) {
      this.releaseInFlight(batchMutations);
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

    let deltaPullNeeded = false;

    for (const mutation of batchMutations) {
      // Asynchronous Boundary Guard: Re-verify scope, generation, and authority before EACH operation
      this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);

      if (leaderSignal?.aborted) {
        this.releaseInFlight(batchMutations);
        throw new Error('Leader signal aborted while processing server batch results.');
      }

      if (this.inFlightMap.get(mutation.mutationId) === batchScopeGeneration) {
        this.inFlightMap.delete(mutation.mutationId);
      }
      const res = resultMap.get(mutation.mutationId);

      if (!res) {
        // Missing from server response: treat as transient network omission, apply persistent retry backoff
        await this.handleTransientFailure(
          batchOwnerScope,
          batchScopeGeneration,
          mutation,
          new Error('Missing result item in server batch response.')
        );
        summary.transientRetryCount++;
        continue;
      }

      switch (res.status) {
        case 'APPLIED':
          await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId);
          summary.appliedCount++;
          break;

        case 'DEDUPLICATED':
          await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId);
          summary.deduplicatedCount++;
          break;

        case 'REJECTED_TOMBSTONE': {
          // Anti-Tombstone Resurrection: ATOMIC eviction of replica and deletion of pending mutation
          await this.dbClient.evictReplicaAndRemovePending(
            batchOwnerScope,
            mutation.domain,
            mutation.entityId,
            mutation.mutationId,
            mutation.payload
          );
          summary.tombstoneEvictedCount++;
          this.onReplicaEvicted?.(batchOwnerScope, mutation.domain, mutation.entityId);
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
          await this.dbClient.quarantineMutation(quarantined);
          summary.staleQuarantinedCount++;
          this.onMutationQuarantined?.(batchOwnerScope, quarantined);
          break;
        }

        case 'CONFLICT_MERGED': {
          // Invariant: Response has no resolvedPayload. Remove pending and trigger authoritative delta pull.
          await this.dbClient.deletePendingMutation(batchOwnerScope, mutation.mutationId);
          summary.conflictMergedCount++;
          deltaPullNeeded = true;
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
          await this.dbClient.quarantineMutation(quarantined);
          summary.unsupportedCount++;
          this.onMutationQuarantined?.(batchOwnerScope, quarantined);
          break;
        }

        default:
          // Unrecognized status: safe fallback to quarantine
          await this.dbClient.quarantineMutation({
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
          });
          summary.unsupportedCount++;
          break;
      }
    }

    if (deltaPullNeeded && this.onAuthoritativeDeltaPullRequired) {
      await this.onAuthoritativeDeltaPullRequired(batchOwnerScope);
    }

    return summary;
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

    // Stale Batch Check
    if (batchOwnerScope !== this.ownerScope || batchScopeGeneration !== this.scopeGeneration) {
      this.releaseInFlight(batchMutations);
      return;
    }

    this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);

    for (const mutation of batchMutations) {
      // Re-check authority before each mutation retry
      if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
        this.releaseInFlight(batchMutations);
        return;
      }
      this.assertAuthorityAtBoundary(batchOwnerScope, batchScopeGeneration);
      await this.handleTransientFailure(batchOwnerScope, batchScopeGeneration, mutation, error);
    }
  }

  /**
   * Handles transient failure for a single mutation using the atomic DAL primitive recordTransientFailureAtomic.
   * Eliminates read-then-write lost updates and ensures single-transaction retry vs quarantine decisions.
   */
  private async handleTransientFailure(
    batchOwnerScope: string,
    batchScopeGeneration: number,
    mutation: LocalPendingMutation,
    error: Error
  ): Promise<void> {
    // 1. Generation-aware in-flight release
    if (this.inFlightMap.get(mutation.mutationId) === batchScopeGeneration) {
      this.inFlightMap.delete(mutation.mutationId);
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
        },
      }
    );

    // 4. Post-transaction authority guard before firing side effects / callbacks
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

    if (this.inFlightMap.get(mutationId) === currentGen) {
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
      this.onMutationQuarantined?.(currentScope, quarantined);
    }
  }

  /**
   * Requeues a quarantined mutation back to pending_mutations in a single atomic transaction.
   * Strictly preserves exact mutationId, payload, and baseServerRevision.
   * Resets retryCount to 0 and clears nextRetryAt.
   *
   * Invariant Enforcement (P0-05 Remediation):
   * - Prohibits requeue of REJECTED_TOMBSTONE mutations.
   * - Prohibits requeue of REJECTED_STALE or HTTP_410 mutations without approved causal proof.
   */
  async requeue(mutationId: string, triageProof?: CausalTriageProof): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);

    const quarantined = await this.dbClient.getQuarantinedMutation(currentScope, mutationId);
    if (!quarantined) {
      throw new Error(`Quarantined mutation "${mutationId}" not found for scope "${currentScope}".`);
    }

    this.assertAuthorityAtBoundary(currentScope, currentGen);

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

    await this.dbClient.requeueQuarantinedMutation(currentScope, mutationId, triageProof, {
      checkAdmission: () => {
        this.assertAuthorityAtBoundary(currentScope, currentGen);
      },
    });
  }

  /**
   * Deletes a quarantined mutation.
   */
  async deleteQuarantined(mutationId: string): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    await this.dbClient.deleteQuarantinedMutation(currentScope, mutationId);
  }

  /**
   * Clears all quarantined mutations for the active scope.
   */
  async clearQuarantined(): Promise<void> {
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.assertAuthorityAtBoundary(currentScope, currentGen);
    await this.dbClient.clearQuarantinedMutations(currentScope);
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
