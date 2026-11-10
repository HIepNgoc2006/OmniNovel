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
  STORE_QUARANTINED_MUTATIONS,
  LocalSyncMeta,
  LocalPendingMutation,
  LocalQuarantinedMutation,
  GLOBAL_HISTORY_SENTINEL,
  isValidRevisionString,
  InvalidDeltaPayloadError,
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
  WireSyncRevisionExpiredResponse,
  WireHttpResponse,
  ProductionSyncRevisionExpiredBody,
  ProposedB1SyncRevisionExpiredBody,
} from '../fixtures/step-52d-contract-fixtures';

/**
 * Task B: Cross-Scope Authority Error
 * Thrown whenever reconciler scope, tab leader lock, queue scope, or identity generation disagree.
 */
export class ScopeAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeAuthorityError';
  }
}

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
  private queuedChanges: Array<
    | SyncChangesResponse
    | WireSyncRevisionExpiredResponse
    | { statusCode: 410; error: { code: string; message: string; minActiveRevision?: string; currentServerRevision?: string } }
    | Error
  > = [];
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

  queueChangesResponse(
    res:
      | SyncChangesResponse
      | WireSyncRevisionExpiredResponse
      | { statusCode: 410; error: { code: string; message: string; minActiveRevision?: string; currentServerRevision?: string } }
      | Error
  ): void {
    this.queuedChanges.push(res);
  }

  queueBatchResponse(res: WireMutationBatchResponse | Error): void {
    this.queuedBatchResults.push(res);
  }

  async simulateFetchChanges(
    url: string
  ): Promise<
    | SyncChangesResponse
    | WireSyncRevisionExpiredResponse
    | { statusCode: 410; error: { code: string; message: string; minActiveRevision?: string; currentServerRevision?: string } }
  > {
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

/**
 * Task A: Pre-Dispatch Atomic Admission Result
 */
export interface PreDispatchAdmissionResult {
  minActiveRevision: string;
  eligibleMutations: LocalPendingMutation[];
  quarantinedStaleMutations: LocalQuarantinedMutation[];
  quarantinedLegacyMutations: LocalQuarantinedMutation[];
}

export interface PreDispatchAdmissionOptions {
  ownerScope: string;
  batchMutations: LocalPendingMutation[];
  dbClient: IndexedDbClient;
  checkAdmission?: () => void;
  _testHookBeforeCommit?: (tx: IDBTransaction) => void;
}

/**
 * Task A: Atomic Pre-Dispatch Admission Reference Implementation
 * Runs inside a SINGLE IndexedDB readwrite transaction over [STORE_SYNC_META, STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS].
 * Eliminates TOCTOU races between getSyncMeta, pending verification, quarantine, and deletion.
 * On abort/error, rolls back completely, preserving original payload and mutationId in pending_mutations.
 */
export async function admitPreparedBatchPreDispatchAtomic(
  options: PreDispatchAdmissionOptions
): Promise<PreDispatchAdmissionResult> {
  assertValidAccountScope(options.ownerScope);
  const rawDb = await options.dbClient.getDatabase();

  return new Promise<PreDispatchAdmissionResult>((resolve, reject) => {
    let settled = false;
    let tx: IDBTransaction;

    const fail = (err: unknown) => {
      if (!settled) {
        settled = true;
        try {
          tx.abort();
        } catch {
          // ignore already aborted
        }
        reject(err);
      }
    };

    try {
      tx = rawDb.transaction(
        [STORE_SYNC_META, STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS],
        'readwrite'
      );
      const metaStore = tx.objectStore(STORE_SYNC_META);
      const pendingStore = tx.objectStore(STORE_PENDING_MUTATIONS);
      const quarantineStore = tx.objectStore(STORE_QUARANTINED_MUTATIONS);

      let syncMeta: LocalSyncMeta | undefined;
      const loadedPendingMap = new Map<string, LocalPendingMutation>();
      let pendingLoadsRemaining = options.batchMutations.length + 1; // +1 for sync_meta

      const evaluateBatch = () => {
        if (settled) return;
        try {
          if (options.checkAdmission) {
            options.checkAdmission();
          }

          let minActiveRevisionStr = '0';
          if (syncMeta?.minActiveRevision !== undefined && syncMeta?.minActiveRevision !== null) {
            if (!isValidRevisionString(syncMeta.minActiveRevision)) {
              fail(
                new InvalidDeltaPayloadError(
                  `Invalid minActiveRevision during pre-dispatch admission: "${syncMeta.minActiveRevision}".`
                )
              );
              return;
            }
            minActiveRevisionStr = syncMeta.minActiveRevision;
          }

          const minActiveRev = BigInt(minActiveRevisionStr);
          const eligibleMutations: LocalPendingMutation[] = [];
          const quarantinedStaleMutations: LocalQuarantinedMutation[] = [];
          const quarantinedLegacyMutations: LocalQuarantinedMutation[] = [];
          const rejectedAtIso = new Date().toISOString();

          for (const candidate of options.batchMutations) {
            const livePending = loadedPendingMap.get(candidate.mutationId);
            if (!livePending) {
              // Mutation no longer exists in pending store (deleted or already committed)
              continue;
            }

            if (!isValidRevisionString(livePending.baseServerRevision)) {
              fail(
                new InvalidDeltaPayloadError(
                  `Invalid baseServerRevision "${livePending.baseServerRevision}" on pending mutation "${livePending.mutationId}".`
                )
              );
              return;
            }

            // Task C: Disallow just-in-time rewriting of legacy HISTORY entityId='all' under the same mutationId
            if (
              livePending.domain === SyncDomain.HISTORY &&
              livePending.entityId === 'all'
            ) {
              pendingStore.delete([options.ownerScope, livePending.mutationId]);
              const quarantined: LocalQuarantinedMutation = {
                ownerScope: livePending.ownerScope,
                mutationId: livePending.mutationId,
                clientId: livePending.clientId,
                domain: livePending.domain,
                entityId: livePending.entityId,
                operation: livePending.operation,
                baseServerRevision: livePending.baseServerRevision,
                payload: livePending.payload,
                rejectionReason: 'LEGACY_ENTITY_ID_REWRITE_PROHIBITED',
                rejectionStatus: 'MANUAL',
                rejectedAt: rejectedAtIso,
                triageStatus: 'PENDING',
                originalCreatedAt: livePending.createdAt,
              };
              quarantineStore.put(quarantined);
              quarantinedLegacyMutations.push(quarantined);
              continue;
            }

            // Stale watermark check
            if (minActiveRev > 0n && BigInt(livePending.baseServerRevision) < minActiveRev) {
              pendingStore.delete([options.ownerScope, livePending.mutationId]);
              const quarantined: LocalQuarantinedMutation = {
                ownerScope: livePending.ownerScope,
                mutationId: livePending.mutationId,
                clientId: livePending.clientId,
                domain: livePending.domain,
                entityId: livePending.entityId,
                operation: livePending.operation,
                baseServerRevision: livePending.baseServerRevision,
                payload: livePending.payload,
                rejectionReason: 'WATERMARK_ADVANCED_PRE_DISPATCH',
                rejectionStatus: 'REJECTED_STALE',
                rejectedAt: rejectedAtIso,
                triageStatus: 'PENDING',
                originalCreatedAt: livePending.createdAt,
              };
              quarantineStore.put(quarantined);
              quarantinedStaleMutations.push(quarantined);
              continue;
            }

            eligibleMutations.push(livePending);
          }

          if (options._testHookBeforeCommit) {
            options._testHookBeforeCommit(tx);
          }

          result = {
            minActiveRevision: minActiveRevisionStr,
            eligibleMutations,
            quarantinedStaleMutations,
            quarantinedLegacyMutations,
          };
        } catch (err) {
          fail(err);
        }
      };

      let result: PreDispatchAdmissionResult;

      // 1. Load sync_meta
      const metaReq = metaStore.get(options.ownerScope);
      metaReq.onerror = () => fail(metaReq.error || new Error('Failed to load sync_meta'));
      metaReq.onsuccess = () => {
        syncMeta = metaReq.result as LocalSyncMeta | undefined;
        pendingLoadsRemaining -= 1;
        if (pendingLoadsRemaining === 0) evaluateBatch();
      };

      // 2. Load pending items
      if (options.batchMutations.length === 0) {
        // Only sync_meta was needed
      } else {
        for (const candidate of options.batchMutations) {
          const pReq = pendingStore.get([options.ownerScope, candidate.mutationId]);
          pReq.onerror = () => fail(pReq.error || new Error(`Failed to load pending ${candidate.mutationId}`));
          pReq.onsuccess = () => {
            if (pReq.result) {
              loadedPendingMap.set(candidate.mutationId, pReq.result as LocalPendingMutation);
            }
            pendingLoadsRemaining -= 1;
            if (pendingLoadsRemaining === 0) evaluateBatch();
          };
        }
      }

      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      tx.onerror = () => fail(tx.error || new Error('Transaction error during pre-dispatch admission.'));
      tx.onabort = () => fail(tx.error || new Error('Transaction aborted during pre-dispatch admission.'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Step 5.2d Mock Protocol Adapter & Reconciler Harness
 * Implements the corrected transport contracts in Task A-D.
 */
export class MockStep52dReconciler {
  public ownerScope: string;
  public scopeGeneration: number;
  public needsBootstrap = false;
  public bootstrapReason?: string;

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

  /**
   * Task B: Cross-Scope Authority Validation
   * Enforces that Reconciler scope, TabLeaderElection lock ownerScope,
   * MutationQueue ownerScope, and scopeGeneration all agree before dispatch or commit.
   */
  public assertCrossScopeAuthority(expectedScope: string, expectedGen: number, leaderSignal?: AbortSignal): void {
    if (leaderSignal?.aborted) {
      throw new ScopeAuthorityError('LEADER_REVOKED: Leader signal was aborted.');
    }
    const leaderState = this.config.tabLeader.getState();
    if (!leaderState.isLeader) {
      throw new ScopeAuthorityError('LEADER_REVOKED: Tab is not authoritative leader.');
    }
    if (leaderState.ownerScope !== expectedScope) {
      throw new ScopeAuthorityError(
        `SCOPE_MISMATCH: Leader lock is held for "${leaderState.ownerScope}" but requested scope is "${expectedScope}".`
      );
    }
    if (this.config.mutationQueue.getActiveScope() !== expectedScope) {
      throw new ScopeAuthorityError(
        `SCOPE_MISMATCH: MutationQueue activeScope is "${this.config.mutationQueue.getActiveScope()}" but requested scope is "${expectedScope}".`
      );
    }
    if (this.ownerScope !== expectedScope || this.scopeGeneration !== expectedGen) {
      throw new ScopeAuthorityError(
        `SCOPE_MISMATCH: Reconciler scope switched (active: "${this.ownerScope}#${this.scopeGeneration}", expected: "${expectedScope}#${expectedGen}").`
      );
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
    const scopeAtStart = this.ownerScope;
    const genAtStart = this.scopeGeneration;
    this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

    const limit = options?.limit ?? 50;
    let appliedPages = 0;

    while (true) {
      this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

      const meta = await this.config.dbClient.getSyncMeta(this.ownerScope);
      const checkpoint = meta?.lastSyncedServerRevision ?? '0';

      const url = `/api/v1/sync/changes?after=${encodeURIComponent(checkpoint)}&limit=${limit}`;
      let response:
        | SyncChangesResponse
        | WireSyncRevisionExpiredResponse
        | { statusCode: 410; error: { code: string; message: string; minActiveRevision?: string; currentServerRevision?: string } };

      try {
        response = await this.config.server.simulateFetchChanges(url);
      } catch (fetchErr) {
        this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);
        throw fetchErr;
      }

      // Task B: Recheck leader, account scope and generation immediately after every HTTP response,
      // including HTTP 410, BEFORE mutating reconciler state or firing callbacks.
      this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

      // Check if server returned 410 SYNC_REVISION_EXPIRED (Production envelope or proposed B1 envelope)
      if (
        ('httpStatus' in response && response.httpStatus === 410) ||
        ('statusCode' in response && (response as any).statusCode === 410)
      ) {
        this.needsBootstrap = true;
        const code =
          ('body' in response && (response as any).body?.error?.code) ||
          ('error' in response && (response as any).error?.code) ||
          'SYNC_REVISION_EXPIRED';
        this.bootstrapReason = code;
        this.config.onBootstrapRequired?.(code);
        // Invariant: Do NOT erase checkpoint immediately on 410! Hand off to Step 6.
        return { appliedPages, needsBootstrap: true };
      }

      const deltaPage = response as SyncChangesResponse;

      // Re-verify leader lease and cross-scope authority before IDB commit
      this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

      // Ingest delta page atomically
      await this.config.dbClient.applyAuthoritativeDeltaPage({
        ownerScope: this.ownerScope,
        expectedCheckpoint: checkpoint,
        page: deltaPage,
        checkAdmission: () => {
          this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);
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
    _testHookPreDispatchBeforeCommit?: (tx: IDBTransaction) => void;
  }): Promise<{ pushedCount: number; quarantinedStaleCount: number; quarantinedLegacyCount: number }> {
    assertValidAccountScope(this.ownerScope);
    const scopeAtStart = this.ownerScope;
    const genAtStart = this.scopeGeneration;
    this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

    // 1. Prepare batch via MutationQueue
    const batch = await this.config.mutationQueue.preparePushBatch({
      limit: options?.limit,
      leaderSignal: options?.leaderSignal,
    });

    if (options?._testHookAfterPrepareBatch) {
      await options._testHookAfterPrepareBatch();
    }

    if (batch.mutations.length === 0) {
      return { pushedCount: 0, quarantinedStaleCount: 0, quarantinedLegacyCount: 0 };
    }

    // 2. Task A: Atomic Pre-Dispatch Admission Check
    let admission: PreDispatchAdmissionResult;
    try {
      admission = await admitPreparedBatchPreDispatchAtomic({
        ownerScope: scopeAtStart,
        batchMutations: batch.mutations,
        dbClient: this.config.dbClient,
        checkAdmission: () => {
          this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);
        },
        _testHookBeforeCommit: options?._testHookPreDispatchBeforeCommit,
      });
    } catch (admissionErr) {
      // Task A: When pre-dispatch admission fails (e.g. IDB abort/rollback),
      // MUST release in-flight batch ownership so mutations are not permanently stuck!
      // Generational check inside releaseInFlight ensures an old batch cleanup cannot release a newer batch.
      this.config.mutationQueue.releaseInFlight(batch);
      throw admissionErr;
    }

    // Release in-flight lock on any mutations quarantined during atomic pre-dispatch check
    for (const m of admission.quarantinedStaleMutations) {
      (this.config.mutationQueue as any).releaseOwnedMutation(batch, m.mutationId);
    }
    for (const m of admission.quarantinedLegacyMutations) {
      (this.config.mutationQueue as any).releaseOwnedMutation(batch, m.mutationId);
    }

    if (admission.eligibleMutations.length === 0) {
      this.config.mutationQueue.releaseInFlight(batch);
      return {
        pushedCount: 0,
        quarantinedStaleCount: admission.quarantinedStaleMutations.length,
        quarantinedLegacyCount: admission.quarantinedLegacyMutations.length,
      };
    }

    // 3. Task C: Immutable Wire Payload Construction
    // Exact byte-for-byte fidelity: clientId, mutationId, baseServerRevision, entityId, payload
    const wireMutations: ClientMutation[] = admission.eligibleMutations.map((m) => ({
      clientId: m.clientId,
      mutationId: m.mutationId,
      domain: m.domain,
      entityId: m.entityId,
      operation: m.operation,
      baseServerRevision: m.baseServerRevision,
      payload: m.payload,
      clientCreatedAt: new Date(m.createdAt).toISOString(),
    }));

    // 4. Dispatch to HTTP Server (WITHOUT batch Idempotency-Key header assumption)
    let wireResponse: WireMutationBatchResponse;
    try {
      this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);

      wireResponse = await this.config.server.simulatePostMutations(
        scopeAtStart,
        { mutations: wireMutations },
        { Authorization: `Bearer mock_token_for_${scopeAtStart}` }
      );
    } catch (networkOrLeaderError: any) {
      // POST left browser or network dropped -> Unknown outcome!
      // Invariant: Do NOT delete pending data from IndexedDB! Release in-flight so any leader can retry with the SAME mutationId.
      this.config.mutationQueue.releaseInFlight(batch);
      throw networkOrLeaderError;
    }

    // 5. Post-response authority check: Verify tab is STILL authoritative leader for the SAME scope
    try {
      this.assertCrossScopeAuthority(scopeAtStart, genAtStart, options?.leaderSignal);
    } catch (scopeErr) {
      // Scope switched or leader revoked while response was returning!
      // Drop response to avoid cross-account or non-leader state corruption.
      this.config.mutationQueue.releaseInFlight(batch);
      return {
        pushedCount: 0,
        quarantinedStaleCount: admission.quarantinedStaleMutations.length,
        quarantinedLegacyCount: admission.quarantinedLegacyMutations.length,
      };
    }

    // 6. Commit batch results atomically via MutationQueue.processServerBatchResults
    // Create an updated batch matching only the eligible mutations that were actually dispatched
    const dispatchedBatch: PreparedPushBatch = {
      ...batch,
      mutations: admission.eligibleMutations,
    };

    await this.config.mutationQueue.processServerBatchResults({
      batch: dispatchedBatch,
      results: wireResponse.results,
    });

    return {
      pushedCount: wireMutations.length,
      quarantinedStaleCount: admission.quarantinedStaleMutations.length,
      quarantinedLegacyCount: admission.quarantinedLegacyMutations.length,
    };
  }
}
