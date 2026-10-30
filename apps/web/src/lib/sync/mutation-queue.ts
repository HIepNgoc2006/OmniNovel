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
   * In-flight mutation IDs for current scope to prevent double-pushing concurrently.
   */
  private readonly inFlightSet: Set<string> = new Set();

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
    this.inFlightSet.clear();
    this.ownerScope = newScope;
  }

  getActiveScope(): string {
    return this.ownerScope;
  }

  getScopeGeneration(): number {
    return this.scopeGeneration;
  }

  /**
   * Fail-Closed Assertion: Validates that queue is not transitioning and caller matches active scope.
   */
  private assertSafeExecution(scopeToCheck?: string): void {
    if (scopeToCheck && scopeToCheck !== this.ownerScope) {
      throw new ScopeMismatchError(this.ownerScope, scopeToCheck);
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

  // ==================== QUEUE INGESTION & READ OPERATIONS ====================

  /**
   * Enqueues a pending mutation.
   * Enforces scope isolation and mutation immutability.
   */
  async enqueue(mutation: LocalPendingMutation): Promise<void> {
    this.assertSafeExecution(mutation.ownerScope);
    await this.dbClient.enqueuePendingMutation(mutation);
  }

  /**
   * Retrieves pending mutations for the active scope, ordered chronologically.
   */
  async getPendingMutations(limit: number = 100): Promise<LocalPendingMutation[]> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    return this.dbClient.getPendingMutations(currentScope, limit);
  }

  /**
   * Retrieves quarantined mutations for the active scope, ordered by rejection time descending.
   */
  async getQuarantinedMutations(): Promise<LocalQuarantinedMutation[]> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
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
    this.assertSafeExecution();

    const limit = options?.limit ?? 50;
    const now = options?.now ?? Date.now();
    const currentGeneration = this.scopeGeneration;
    const currentScope = this.ownerScope;

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

    // Asynchronous boundary check: ensure scope, generation, and identity state haven't changed during getPendingMutations
    if (
      this.ownerScope !== currentScope ||
      this.scopeGeneration !== currentGeneration ||
      this.identityStateProvider.isTransitioning() ||
      !this.identityStateProvider.canMutateUserState() ||
      this.identityStateProvider.getActiveScope() !== currentScope
    ) {
      return emptyBatch;
    }

    const selected: LocalPendingMutation[] = [];

    for (const item of pending) {
      if (selected.length >= limit) {
        break;
      }
      if (this.inFlightSet.has(item.mutationId)) {
        continue;
      }
      // Persistent Backoff Invariant: item.nextRetryAt stored in IndexedDB
      if (item.nextRetryAt && item.nextRetryAt > now) {
        continue;
      }

      this.inFlightSet.add(item.mutationId);
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
   * Releases in-flight status for a batch of mutations.
   */
  releaseInFlight(batchOrIds: PreparedPushBatch | LocalPendingMutation[] | string[]): void {
    if ('mutations' in batchOrIds && Array.isArray(batchOrIds.mutations)) {
      for (const m of batchOrIds.mutations) {
        this.inFlightSet.delete(m.mutationId);
      }
    } else if (Array.isArray(batchOrIds)) {
      for (const item of batchOrIds) {
        const id = typeof item === 'string' ? item : item.mutationId;
        this.inFlightSet.delete(id);
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
      // Asynchronous Boundary Guard: Re-verify scope and generation before EACH operation
      if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
        this.releaseInFlight(batchMutations);
        throw new StaleBatchRejectedError(
          `Scope switched mid-batch execution: aborting remaining results for scope "${batchOwnerScope}".`
        );
      }

      this.inFlightSet.delete(mutation.mutationId);
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

    this.assertSafeExecution(batchOwnerScope);

    for (const mutation of batchMutations) {
      // Re-check scope and generation before each mutation retry
      if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
        this.releaseInFlight(batchMutations);
        return;
      }
      await this.handleTransientFailure(batchOwnerScope, batchScopeGeneration, mutation, error);
    }
  }

  private async handleTransientFailure(
    batchOwnerScope: string,
    batchScopeGeneration: number,
    mutation: LocalPendingMutation,
    error: Error
  ): Promise<void> {
    this.inFlightSet.delete(mutation.mutationId);

    // Guard before async boundary
    if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
      return;
    }

    // Atomically read latest retryCount from DB using batchOwnerScope (NOT this.ownerScope)
    const latestItem = await this.dbClient.getPendingMutation(batchOwnerScope, mutation.mutationId);

    // Post-async boundary verification: ensure scope and generation haven't changed while awaiting DB
    if (this.ownerScope !== batchOwnerScope || this.scopeGeneration !== batchScopeGeneration) {
      return;
    }

    const currentRetry = ((latestItem ? latestItem.retryCount : mutation.retryCount) || 0) + 1;

    if (currentRetry >= this.maxRetries) {
      // Exceeded retry limit: atomically quarantine to avoid blocking the queue
      const quarantined: LocalQuarantinedMutation = {
        ownerScope: batchOwnerScope,
        mutationId: mutation.mutationId,
        clientId: mutation.clientId,
        domain: mutation.domain,
        entityId: mutation.entityId,
        operation: mutation.operation,
        baseServerRevision: mutation.baseServerRevision,
        payload: mutation.payload,
        rejectionReason: `EXCEEDED_MAX_RETRIES: ${error.message}`,
        rejectionStatus: 'EXCEEDED_MAX_RETRIES',
        rejectedAt: new Date().toISOString(),
        triageStatus: 'PENDING',
        originalCreatedAt: mutation.createdAt,
      };
      await this.dbClient.quarantineMutation(quarantined);

      if (this.ownerScope === batchOwnerScope && this.scopeGeneration === batchScopeGeneration) {
        this.onMutationQuarantined?.(batchOwnerScope, quarantined);
      }
    } else {
      // Invariant: Persist incremented retryCount and nextRetryAt directly in IndexedDB using batchOwnerScope
      const delay = Math.min(
        this.maxBackoffMs,
        this.initialBackoffMs * Math.pow(this.backoffFactor, currentRetry - 1)
      );
      const nextRetryAt = Date.now() + delay;

      await this.dbClient.updatePendingMutationRetry(
        batchOwnerScope,
        mutation.mutationId,
        currentRetry,
        nextRetryAt
      );
    }
  }

  // ==================== QUARANTINE TRIAGE OPERATIONS ====================

  /**
   * Manually moves a pending mutation to quarantine using direct composite key lookup.
   * Avoids scanning or pagination limits.
   */
  async quarantine(mutationId: string, reason: string): Promise<void> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
    this.inFlightSet.delete(mutationId);

    const quarantined = await this.dbClient.quarantinePendingMutationByKey(
      currentScope,
      mutationId,
      reason,
      'MANUAL'
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
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;

    const quarantined = await this.dbClient.getQuarantinedMutation(currentScope, mutationId);
    if (!quarantined) {
      throw new Error(`Quarantined mutation "${mutationId}" not found for scope "${currentScope}".`);
    }

    if (this.ownerScope !== currentScope || this.scopeGeneration !== currentGen) {
      throw new ScopeTransitioningError('Scope changed while retrieving quarantined mutation.');
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

    await this.dbClient.requeueQuarantinedMutation(currentScope, mutationId, triageProof);
  }

  /**
   * Deletes a quarantined mutation.
   */
  async deleteQuarantined(mutationId: string): Promise<void> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    await this.dbClient.deleteQuarantinedMutation(currentScope, mutationId);
  }

  /**
   * Clears all quarantined mutations for the active scope.
   */
  async clearQuarantined(): Promise<void> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    await this.dbClient.clearQuarantinedMutations(currentScope);
  }

  // ==================== QUEUE STATUS & DIAGNOSTICS ====================

  /**
   * Returns high-level diagnostic status of the queue.
   */
  async getStatus(): Promise<QueueStatusReport> {
    this.assertSafeExecution();
    const currentScope = this.ownerScope;
    const currentGen = this.scopeGeneration;
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
      inFlightCount: this.inFlightSet.size,
      quarantinedCount: quarantined.length,
      inBackoffCount,
    };
  }
}
