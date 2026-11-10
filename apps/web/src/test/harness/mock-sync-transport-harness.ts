import {
  SyncDomain,
  SyncOperation,
  ClientMutation,
  MutationResultItem,
  SyncChangesResponse,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  LocalSyncMeta,
  LocalQuarantinedMutation,
  GLOBAL_HISTORY_SENTINEL,
  isValidRevisionString,
} from '../../lib/storage/indexed-db-client';
import {
  MutationQueue,
  PreparedPushBatch,
  createStaticIdentityProvider,
} from '../../lib/sync/mutation-queue';
import { TabLeaderElection } from '../../lib/sync/tab-leader-election';
import {
  WIRE_GLOBAL_HISTORY_ENTITY_ID,
  WireMutationBatchRequest,
  WireMutationBatchResponse,
  WireSyncRevisionExpiredErrorResponse,
} from '../fixtures/step-52d-contract-fixtures';

/**
 * Deterministic In-Memory Web Locks Manager
 */
export class InMemoryLockManager implements LockManager {
  private queues: Map<string, Array<() => Promise<void>>> = new Map();
  private heldLocks: Set<string> = new Set();

  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>
  ): Promise<T> {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;

    if (!this.heldLocks.has(name)) {
      this.heldLocks.add(name);
      try {
        return (await cb({ name, mode: 'exclusive' } as any)) as T;
      } finally {
        this.heldLocks.delete(name);
        this.processNext(name);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) || [];
      queue.push(async () => {
        this.heldLocks.add(name);
        try {
          const result = (await cb({ name, mode: 'exclusive' } as any)) as T;
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.heldLocks.delete(name);
          this.processNext(name);
        }
      });
      this.queues.set(name, queue);
    });
  }

  private processNext(name: string) {
    const queue = this.queues.get(name);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      queueMicrotask(() => {
        next();
      });
    }
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: Array.from(this.heldLocks).map((name) => ({ name, mode: 'exclusive' })),
      pending: [],
    };
  }
}

/**
 * Mock HTTP Transport Server for Isolated Sync Testing
 */
export class MockSyncTransportServer {
  private queuedChanges: Array<SyncChangesResponse | WireSyncRevisionExpiredErrorResponse | Error> = [];
  private queuedBatchResults: Array<WireMutationBatchResponse | Error> = [];
  public dispatchedBatches: Array<{
    scope: string;
    body: WireMutationBatchRequest;
    headers?: Record<string, string>;
  }> = [];
  public requestedChangesUrls: string[] = [];

  public interceptBeforeDispatch?: () => Promise<void>;
  public interceptInFlight?: () => Promise<void>;
  public artificialDelayMs = 0;

  queueChangesResponse(res: SyncChangesResponse | WireSyncRevisionExpiredErrorResponse | Error): void {
    this.queuedChanges.push(res);
  }

  queueBatchResponse(res: WireMutationBatchResponse | Error): void {
    this.queuedBatchResults.push(res);
  }

  async simulateFetchChanges(url: string): Promise<SyncChangesResponse | WireSyncRevisionExpiredErrorResponse> {
    this.requestedChangesUrls.push(url);

    if (this.interceptBeforeDispatch) {
      await this.interceptBeforeDispatch();
    }

    if (this.artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.artificialDelayMs));
    }

    if (this.interceptInFlight) {
      await this.interceptInFlight();
    }

    const next = this.queuedChanges.shift();
    if (!next) {
      throw new Error(`MockSyncTransportServer: No queued changes response for URL: ${url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async simulatePostMutations(
    scope: string,
    body: WireMutationBatchRequest,
    headers?: Record<string, string>
  ): Promise<WireMutationBatchResponse> {
    this.dispatchedBatches.push({ scope, body, headers });

    if (this.interceptBeforeDispatch) {
      await this.interceptBeforeDispatch();
    }

    if (this.artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.artificialDelayMs));
    }

    if (this.interceptInFlight) {
      await this.interceptInFlight();
    }

    const next = this.queuedBatchResults.shift();
    if (!next) {
      throw new Error('MockSyncTransportServer: No queued batch result response');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

/**
 * Account Scope Guard
 * Rejects non-account scopes (e.g. guest:*) fail-closed.
 */
export function assertValidAccountScope(scope: string): void {
  if (!scope || typeof scope !== 'string' || !scope.startsWith('account:') || scope.slice(8).trim() === '') {
    throw new Error(`ACCOUNT_SCOPE_REQUIRED: Scope "${scope}" is not a valid authenticated account scope.`);
  }
}

export interface ReconcilerCycleResult {
  pulledPagesCount: number;
  pushedMutationsCount: number;
  needsBootstrap: boolean;
  bootstrapReason?: string;
  quarantinedStaleCount: number;
  unknownOutcomeBatches: string[];
}

/**
 * Step 5.2d Mock Protocol Adapter & Reconciler Harness
 * Implements the corrected transport contracts in Task A and tests scenarios in Task B.
 */
export class MockStep52dReconciler {
  public ownerScope: string;
  public scopeGeneration: number;
  public needsBootstrap = false;
  public bootstrapReason?: string;
  public unknownOutcomeBatches: Set<string> = new Set();

  constructor(
    private readonly config: {
      ownerScope: string;
      dbClient: IndexedDbClient;
      mutationQueue: MutationQueue;
      tabLeader: TabLeaderElection;
      server: MockSyncTransportServer;
      onBootstrapRequired?: (reason: string) => void;
    }
  ) {
    this.ownerScope = config.ownerScope;
    this.scopeGeneration = 1;
  }

  setScope(newScope: string): void {
    assertValidAccountScope(newScope);
    this.ownerScope = newScope;
    this.scopeGeneration++;
  }

  private checkLeaderAuthority(leaderSignal?: AbortSignal): void {
    if (leaderSignal?.aborted || !this.config.tabLeader.getState().isLeader) {
      throw new Error('LEADER_REVOKED: Tab is not authoritative leader.');
    }
  }

  /**
   * Pull Delta Changes Cycle
   */
  async pullDeltaChanges(options?: {
    limit?: number;
    leaderSignal?: AbortSignal;
  }): Promise<{ appliedPages: number; needsBootstrap: boolean }> {
    assertValidAccountScope(this.ownerScope);
    this.checkLeaderAuthority(options?.leaderSignal);

    const limit = options?.limit ?? 50;
    let appliedPages = 0;

    while (true) {
      this.checkLeaderAuthority(options?.leaderSignal);

      const meta = await this.config.dbClient.getSyncMeta(this.ownerScope);
      const checkpoint = meta?.lastSyncedServerRevision ?? '0';

      const url = `/api/v1/sync/changes?after=${encodeURIComponent(checkpoint)}&limit=${limit}`;
      const response = await this.config.server.simulateFetchChanges(url);

      // Check if server returned 410 SYNC_REVISION_EXPIRED
      if ('statusCode' in response && response.statusCode === 410) {
        this.needsBootstrap = true;
        this.bootstrapReason = response.error.code;
        this.config.onBootstrapRequired?.(response.error.code);
        // Invariant: Do NOT erase checkpoint immediately on 410! Hand off to Step 6.
        return { appliedPages, needsBootstrap: true };
      }

      const deltaPage = response as SyncChangesResponse;

      // Re-verify leader lease before IDB commit
      this.checkLeaderAuthority(options?.leaderSignal);

      // Ingest delta page atomically
      await this.config.dbClient.applyAuthoritativeDeltaPage({
        ownerScope: this.ownerScope,
        expectedCheckpoint: checkpoint,
        page: deltaPage,
        checkAdmission: () => {
          this.checkLeaderAuthority(options?.leaderSignal);
        },
      });

      appliedPages++;

      if (!deltaPage.hasMore || !deltaPage.nextRevision) {
        break;
      }
    }

    return { appliedPages, needsBootstrap: false };
  }

  /**
   * Push Pending Mutations Cycle
   */
  async pushPendingMutations(options?: {
    limit?: number;
    leaderSignal?: AbortSignal;
    _testHookAfterPrepareBatch?: () => Promise<void>;
  }): Promise<{ pushedCount: number; quarantinedStaleCount: number }> {
    assertValidAccountScope(this.ownerScope);
    this.checkLeaderAuthority(options?.leaderSignal);

    const scopeAtStart = this.ownerScope;
    const genAtStart = this.scopeGeneration;

    // 1. Prepare batch via MutationQueue
    const batch = await this.config.mutationQueue.preparePushBatch({
      limit: options?.limit,
      leaderSignal: options?.leaderSignal,
    });

    if (options?._testHookAfterPrepareBatch) {
      await options._testHookAfterPrepareBatch();
    }

    if (batch.mutations.length === 0) {
      return { pushedCount: 0, quarantinedStaleCount: 0 };
    }

    // 2. Pre-Dispatch Guard: Check against live sync_meta.minActiveRevision in IDB
    const meta = await this.config.dbClient.getSyncMeta(this.ownerScope);
    const minActive = meta?.minActiveRevision ?? '0';

    const eligibleMutations: ClientMutation[] = [];
    let quarantinedStaleCount = 0;

    for (const m of batch.mutations) {
      if (BigInt(m.baseServerRevision) < BigInt(minActive)) {
        // Stale mutation: Quarantine immediately before HTTP dispatch, preserve user payload
        await this.config.dbClient.quarantineMutation({
          ownerScope: this.ownerScope,
          mutationId: m.mutationId,
          clientId: m.clientId,
          domain: m.domain,
          entityId: m.entityId,
          operation: m.operation,
          baseServerRevision: m.baseServerRevision,
          payload: m.payload,
          rejectionReason: 'WATERMARK_ADVANCED_PRE_DISPATCH',
          rejectionStatus: 'REJECTED_STALE',
          rejectedAt: new Date().toISOString(),
          triageStatus: 'PENDING',
          originalCreatedAt: m.createdAt,
        });
        await this.config.dbClient.deletePendingMutation(this.ownerScope, m.mutationId);
        this.config.mutationQueue.releaseInFlight(batch);
        quarantinedStaleCount++;
      } else {
        // Canonical wire entityId for global HISTORY delete
        const wireEntityId =
          m.domain === SyncDomain.HISTORY &&
          (m.entityId === 'all' || m.entityId === GLOBAL_HISTORY_SENTINEL)
            ? WIRE_GLOBAL_HISTORY_ENTITY_ID
            : m.entityId;

        eligibleMutations.push({
          clientId: m.clientId,
          mutationId: m.mutationId,
          domain: m.domain,
          entityId: wireEntityId,
          operation: m.operation,
          baseServerRevision: m.baseServerRevision,
          payload: m.payload,
          clientCreatedAt: new Date(m.createdAt).toISOString(),
        });
      }
    }

    if (eligibleMutations.length === 0) {
      return { pushedCount: 0, quarantinedStaleCount };
    }

    // 3. Dispatch to HTTP Server (WITHOUT batch Idempotency-Key header assumption)
    let wireResponse: WireMutationBatchResponse;
    try {
      this.checkLeaderAuthority(options?.leaderSignal);

      wireResponse = await this.config.server.simulatePostMutations(
        this.ownerScope,
        { mutations: eligibleMutations },
        { Authorization: `Bearer mock_token_for_${this.ownerScope}` }
      );
    } catch (networkOrLeaderError: any) {
      // POST left browser or network dropped -> Unknown outcome!
      // Invariant: Do NOT delete pending data! Keep mutationId intact for identical retry.
      this.unknownOutcomeBatches.add(batch.batchId);
      this.config.mutationQueue.releaseInFlight(batch);
      throw networkOrLeaderError;
    }

    // 4. Post-response authority check: Verify tab is STILL authoritative leader for the SAME scope
    if (this.ownerScope !== scopeAtStart || this.scopeGeneration !== genAtStart || options?.leaderSignal?.aborted) {
      // Scope switched or leader revoked while response was returning!
      // Drop response to avoid cross-account or non-leader state corruption.
      this.unknownOutcomeBatches.add(batch.batchId);
      this.config.mutationQueue.releaseInFlight(batch);
      return { pushedCount: 0, quarantinedStaleCount };
    }

    // 5. Commit batch results atomically via MutationQueue.processServerBatchResults
    await this.config.mutationQueue.processServerBatchResults({
      batch,
      results: wireResponse.results,
    });

    return { pushedCount: eligibleMutations.length, quarantinedStaleCount };
  }
}
