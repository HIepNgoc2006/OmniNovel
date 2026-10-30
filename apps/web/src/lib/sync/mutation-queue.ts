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

export interface MutationQueueOptions {
  ownerScope: string;
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
  pendingCount: number;
  inFlightCount: number;
  quarantinedCount: number;
  inBackoffCount: number;
}

/**
 * MutationQueue (Phase 7C.3 — Step 4)
 *
 * Manages the client-side pending mutation queue and quarantine triage.
 * Adheres to 6 strict architectural invariants:
 * 1. Mutation Identity: Strictly preserves mutationId, payload, baseServerRevision, and causal metadata.
 *    NEVER regenerates IDs or re-bases revisions upon retry.
 * 2. Scope Isolation: All read, write, push preparation, quarantine, and triage operations are bound to ownerScope.
 *    Throws ScopeTransitioningError if identity is TRANSITIONING.
 * 3. Server Rejection Handling:
 *    - REJECTED_TOMBSTONE: Evicts local replica data from IndexedDB to prevent resurrection.
 *    - REJECTED_STALE: Quarantines mutation without rebasing or auto-replaying.
 *    - CONFLICT_MERGED: Removes mutation and triggers authoritative delta pull (does not synthesize payload).
 *    - DOMAIN_NOT_SUPPORTED: Quarantines mutation to prevent infinite retry loops.
 * 4. Atomic Transaction: Transfers between pending_mutations and quarantined_mutations atomically in a single IDB transaction.
 * 5. Retry Safety: Applies exponential backoff with retry limit without modifying mutation payload or ID.
 * 6. Worker Authority: Step 4 provides NO autonomous background network polling loop; push orchestration is strictly
 *    gated by the Tab Leader's Web Lock and AbortSignal.
 */
export class MutationQueue {
  private ownerScope: string;
  private readonly dbClient: IndexedDbClient;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly isScopeTransitioningFn?: () => boolean;
  private readonly onAuthoritativeDeltaPullRequired?: (scope: string) => void | Promise<void>;
  private readonly onReplicaEvicted?: (scope: string, domain: SyncDomain, entityId: string) => void;
  private readonly onMutationQuarantined?: (scope: string, mutation: LocalQuarantinedMutation) => void;

  /**
   * Tracks in-flight mutation IDs to prevent double-pushing concurrently.
   */
  private readonly inFlightSet: Set<string> = new Set();

  /**
   * In-memory backoff map: mutationId -> nextAllowedRetryTimestamp
   */
  private readonly retryBackoffMap: Map<string, number> = new Map();

  constructor(options: MutationQueueOptions) {
    assertValidScope(options.ownerScope);
    this.ownerScope = options.ownerScope;
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
   * Cleans up in-flight set and backoff tracking for the previous scope.
   */
  setActiveScope(newScope: string): void {
    assertValidScope(newScope);
    if (this.ownerScope === newScope) {
      return;
    }
    this.inFlightSet.clear();
    this.retryBackoffMap.clear();
    this.ownerScope = newScope;
  }

  getActiveScope(): string {
    return this.ownerScope;
  }

  private assertSafeExecution(scopeToCheck?: string): void {
    if (scopeToCheck && scopeToCheck !== this.ownerScope) {
      throw new ScopeMismatchError(this.ownerScope, scopeToCheck);
    }
    if (this.isScopeTransitioningFn && this.isScopeTransitioningFn()) {
      throw new ScopeTransitioningError();
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
    return this.dbClient.getPendingMutations(this.ownerScope, limit);
  }

  /**
   * Retrieves quarantined mutations for the active scope, ordered by rejection time descending.
   */
  async getQuarantinedMutations(): Promise<LocalQuarantinedMutation[]> {
    this.assertSafeExecution();
    return this.dbClient.getQuarantinedMutations(this.ownerScope);
  }

  // ==================== PUSH BATCH PREPARATION ====================

  /**
   * Prepares a batch of mutations to be pushed to the Core API.
   * Filters out mutations currently in-flight or waiting in backoff.
   * Marks returned mutations as in-flight.
   *
   * Crucial Invariant: Strictly preserves mutationId, payload, and baseServerRevision.
   */
  async preparePushBatch(options?: {
    limit?: number;
    now?: number;
    leaderSignal?: AbortSignal;
  }): Promise<LocalPendingMutation[]> {
    this.assertSafeExecution();

    if (options?.leaderSignal?.aborted) {
      return [];
    }

    const limit = options?.limit ?? 50;
    const now = options?.now ?? Date.now();

    const pending = await this.dbClient.getPendingMutations(this.ownerScope, limit * 2);
    const selected: LocalPendingMutation[] = [];

    for (const item of pending) {
      if (selected.length >= limit) {
        break;
      }
      if (this.inFlightSet.has(item.mutationId)) {
        continue;
      }
      const nextAllowedRetry = this.retryBackoffMap.get(item.mutationId) || 0;
      if (nextAllowedRetry > now) {
        continue;
      }

      this.inFlightSet.add(item.mutationId);
      selected.push(item);
    }

    return selected;
  }

  /**
   * Releases in-flight status for a batch of mutations (e.g. if leader steps down or network aborted).
   */
  releaseInFlight(batchOrIds: LocalPendingMutation[] | string[]): void {
    for (const item of batchOrIds) {
      const id = typeof item === 'string' ? item : item.mutationId;
      this.inFlightSet.delete(id);
    }
  }

  // ==================== SERVER RECEIPT & RESPONSE PROCESSING ====================

  /**
   * Processes receipt results from POST /api/v1/sync/mutations/batch.
   * Implements strict server rejection handling invariants:
   * - APPLIED / DEDUPLICATED: Removes from pending_mutations.
   * - REJECTED_TOMBSTONE: Evicts replica data from local store to prevent resurrection, deletes mutation.
   * - REJECTED_STALE: Quarantines mutation atomically without rebase or replay.
   * - CONFLICT_MERGED: Deletes mutation and triggers authoritative delta pull.
   * - DOMAIN_NOT_SUPPORTED: Quarantines mutation to prevent infinite retry.
   */
  async processServerBatchResults(params: {
    results: MutationResultItem[];
    batch: LocalPendingMutation[];
    leaderSignal?: AbortSignal;
  }): Promise<BatchProcessingSummary> {
    this.assertSafeExecution();

    const { results, batch, leaderSignal } = params;

    if (leaderSignal?.aborted) {
      this.releaseInFlight(batch);
      throw new Error('Leader signal aborted while processing server batch results.');
    }

    const summary: BatchProcessingSummary = {
      ownerScope: this.ownerScope,
      processedCount: batch.length,
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

    for (const mutation of batch) {
      this.inFlightSet.delete(mutation.mutationId);
      const res = resultMap.get(mutation.mutationId);

      if (!res) {
        // Missing from server response: treat as transient network omission, apply retry backoff
        await this.handleTransientFailure(mutation, new Error('Missing result item in server batch response.'));
        summary.transientRetryCount++;
        continue;
      }

      switch (res.status) {
        case 'APPLIED':
          await this.dbClient.deletePendingMutation(this.ownerScope, mutation.mutationId);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.appliedCount++;
          break;

        case 'DEDUPLICATED':
          await this.dbClient.deletePendingMutation(this.ownerScope, mutation.mutationId);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.deduplicatedCount++;
          break;

        case 'REJECTED_TOMBSTONE': {
          // Anti-Tombstone Resurrection: Synchronously evict replica from authoritative state
          await this.dbClient.evictReplicaOnTombstone(
            this.ownerScope,
            mutation.domain,
            mutation.entityId,
            mutation.payload
          );
          await this.dbClient.deletePendingMutation(this.ownerScope, mutation.mutationId);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.tombstoneEvictedCount++;
          this.onReplicaEvicted?.(this.ownerScope, mutation.domain, mutation.entityId);
          break;
        }

        case 'REJECTED_STALE': {
          // Invariant: Do NOT rebase or replay. Quarantine atomically for triage.
          const quarantined: LocalQuarantinedMutation = {
            ownerScope: this.ownerScope,
            mutationId: mutation.mutationId,
            clientId: mutation.clientId,
            domain: mutation.domain,
            entityId: mutation.entityId,
            operation: mutation.operation,
            baseServerRevision: mutation.baseServerRevision,
            payload: mutation.payload,
            rejectionReason: res.reason || res.message || 'REJECTED_STALE',
            rejectedAt: new Date().toISOString(),
            originalCreatedAt: mutation.createdAt,
          };
          await this.dbClient.quarantineMutation(quarantined);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.staleQuarantinedCount++;
          this.onMutationQuarantined?.(this.ownerScope, quarantined);
          break;
        }

        case 'CONFLICT_MERGED': {
          // Invariant: Response has no resolvedPayload. Remove pending and trigger authoritative delta pull.
          await this.dbClient.deletePendingMutation(this.ownerScope, mutation.mutationId);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.conflictMergedCount++;
          deltaPullNeeded = true;
          break;
        }

        case 'DOMAIN_NOT_SUPPORTED': {
          // Invariant: Do not retry infinitely. Quarantine for diagnosis.
          const quarantined: LocalQuarantinedMutation = {
            ownerScope: this.ownerScope,
            mutationId: mutation.mutationId,
            clientId: mutation.clientId,
            domain: mutation.domain,
            entityId: mutation.entityId,
            operation: mutation.operation,
            baseServerRevision: mutation.baseServerRevision,
            payload: mutation.payload,
            rejectionReason: res.reason || res.message || 'DOMAIN_NOT_SUPPORTED',
            rejectedAt: new Date().toISOString(),
            originalCreatedAt: mutation.createdAt,
          };
          await this.dbClient.quarantineMutation(quarantined);
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.unsupportedCount++;
          this.onMutationQuarantined?.(this.ownerScope, quarantined);
          break;
        }

        default:
          // Unrecognized status: safe fallback to quarantine
          await this.dbClient.quarantineMutation({
            ownerScope: this.ownerScope,
            mutationId: mutation.mutationId,
            clientId: mutation.clientId,
            domain: mutation.domain,
            entityId: mutation.entityId,
            operation: mutation.operation,
            baseServerRevision: mutation.baseServerRevision,
            payload: mutation.payload,
            rejectionReason: `UNRECOGNIZED_STATUS: ${(res as any).status}`,
            rejectedAt: new Date().toISOString(),
            originalCreatedAt: mutation.createdAt,
          });
          this.retryBackoffMap.delete(mutation.mutationId);
          summary.unsupportedCount++;
          break;
      }
    }

    if (deltaPullNeeded && this.onAuthoritativeDeltaPullRequired) {
      await this.onAuthoritativeDeltaPullRequired(this.ownerScope);
    }

    return summary;
  }

  // ==================== NETWORK & TRANSIENT FAILURE HANDLING ====================

  /**
   * Handles network timeout or connection failure for an in-flight batch.
   * Strictly preserves mutation identity (mutationId, payload, baseServerRevision intact).
   * Increments retryCount and sets exponential backoff.
   * Quarantines mutations that exceed maxRetries.
   */
  async handleNetworkFailure(batch: LocalPendingMutation[], error: Error): Promise<void> {
    this.assertSafeExecution();
    for (const mutation of batch) {
      await this.handleTransientFailure(mutation, error);
    }
  }

  private async handleTransientFailure(mutation: LocalPendingMutation, error: Error): Promise<void> {
    this.inFlightSet.delete(mutation.mutationId);

    const currentRetry = (mutation.retryCount || 0) + 1;

    if (currentRetry >= this.maxRetries) {
      // Exceeded retry limit: atomically quarantine to avoid blocking the queue
      const quarantined: LocalQuarantinedMutation = {
        ownerScope: this.ownerScope,
        mutationId: mutation.mutationId,
        clientId: mutation.clientId,
        domain: mutation.domain,
        entityId: mutation.entityId,
        operation: mutation.operation,
        baseServerRevision: mutation.baseServerRevision,
        payload: mutation.payload,
        rejectionReason: `EXCEEDED_MAX_RETRIES: ${error.message}`,
        rejectedAt: new Date().toISOString(),
        originalCreatedAt: mutation.createdAt,
      };
      await this.dbClient.quarantineMutation(quarantined);
      this.retryBackoffMap.delete(mutation.mutationId);
      this.onMutationQuarantined?.(this.ownerScope, quarantined);
    } else {
      // Invariant: Persist incremented retryCount strictly without mutating payload or ID
      await this.dbClient.updatePendingMutationRetry(this.ownerScope, mutation.mutationId, currentRetry);

      // Compute exponential backoff with ceiling
      const delay = Math.min(
        this.maxBackoffMs,
        this.initialBackoffMs * Math.pow(this.backoffFactor, currentRetry - 1)
      );
      this.retryBackoffMap.set(mutation.mutationId, Date.now() + delay);
    }
  }

  // ==================== QUARANTINE TRIAGE OPERATIONS ====================

  /**
   * Manually moves a pending mutation to quarantine.
   */
  async quarantine(mutationId: string, reason: string): Promise<void> {
    this.assertSafeExecution();
    this.inFlightSet.delete(mutationId);
    this.retryBackoffMap.delete(mutationId);

    const pending = await this.dbClient.getPendingMutations(this.ownerScope, 500);
    const target = pending.find((m) => m.mutationId === mutationId);
    if (!target) {
      return;
    }

    const quarantined: LocalQuarantinedMutation = {
      ownerScope: this.ownerScope,
      mutationId: target.mutationId,
      clientId: target.clientId,
      domain: target.domain,
      entityId: target.entityId,
      operation: target.operation,
      baseServerRevision: target.baseServerRevision,
      payload: target.payload,
      rejectionReason: reason,
      rejectedAt: new Date().toISOString(),
      originalCreatedAt: target.createdAt,
    };

    await this.dbClient.quarantineMutation(quarantined);
    this.onMutationQuarantined?.(this.ownerScope, quarantined);
  }

  /**
   * Requeues a quarantined mutation back to pending_mutations in a single atomic transaction.
   * Strictly preserves exact mutationId, payload, and baseServerRevision.
   * Resets retryCount to 0.
   */
  async requeue(mutationId: string): Promise<void> {
    this.assertSafeExecution();
    await this.dbClient.requeueQuarantinedMutation(this.ownerScope, mutationId);
    this.retryBackoffMap.delete(mutationId);
  }

  /**
   * Deletes a quarantined mutation.
   */
  async deleteQuarantined(mutationId: string): Promise<void> {
    this.assertSafeExecution();
    await this.dbClient.deleteQuarantinedMutation(this.ownerScope, mutationId);
  }

  /**
   * Clears all quarantined mutations for the active scope.
   */
  async clearQuarantined(): Promise<void> {
    this.assertSafeExecution();
    await this.dbClient.clearQuarantinedMutations(this.ownerScope);
  }

  // ==================== QUEUE STATUS & DIAGNOSTICS ====================

  /**
   * Returns high-level diagnostic status of the queue.
   */
  async getStatus(): Promise<QueueStatusReport> {
    this.assertSafeExecution();
    const pending = await this.dbClient.getPendingMutations(this.ownerScope, 1000);
    const quarantined = await this.dbClient.getQuarantinedMutations(this.ownerScope);
    const now = Date.now();

    let inBackoffCount = 0;
    for (const [id, backoffTime] of this.retryBackoffMap.entries()) {
      if (backoffTime > now && pending.some((p) => p.mutationId === id)) {
        inBackoffCount++;
      }
    }

    return {
      ownerScope: this.ownerScope,
      pendingCount: pending.length,
      inFlightCount: this.inFlightSet.size,
      quarantinedCount: quarantined.length,
      inBackoffCount,
    };
  }
}
