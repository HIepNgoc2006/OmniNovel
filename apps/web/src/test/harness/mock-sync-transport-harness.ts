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
 * Task A: Atomic Pre-Dispatch Admission Wrapper
 * Delegates directly to production IndexedDbClient.admitPreparedBatchPreDispatchAtomic.
 * Runs inside a SINGLE IndexedDB readwrite transaction over [STORE_SYNC_META, STORE_PENDING_MUTATIONS, STORE_QUARANTINED_MUTATIONS].
 * Eliminates TOCTOU races between getSyncMeta, pending verification, quarantine, and deletion.
 * On abort/error, rolls back completely, preserving original payload and mutationId in pending_mutations.
 */
export async function admitPreparedBatchPreDispatchAtomic(
  options: PreDispatchAdmissionOptions
): Promise<PreDispatchAdmissionResult> {
  assertValidAccountScope(options.ownerScope);
  return options.dbClient.admitPreparedBatchPreDispatchAtomic(options.ownerScope, {
    candidates: options.batchMutations,
    checkAdmission: options.checkAdmission,
    _testHookBeforeComplete: options._testHookBeforeCommit,
  });
}

export interface PushPendingMutationsResult {
  pushedCount: number;
  dispatchedCount: number;
  appliedCount: number;
  deduplicatedCount: number;
  rejectedCount: number;
  transientRetryCount: number;
  quarantinedStaleCount: number;
  quarantinedLegacyCount: number;
  summary?: any;
  correlation?: CorrelatedReceipts;
}

export const VALID_RECEIPT_STATUSES = new Set([
  'APPLIED',
  'DEDUPLICATED',
  'REJECTED_TOMBSTONE',
  'REJECTED_STALE',
  'CONFLICT_MERGED',
  'DOMAIN_NOT_SUPPORTED',
]);

export const MAX_POSTGRES_BIGINT = 9223372036854775807n;

/**
 * Validates whether a value is a valid canonical 64-bit signed BIGINT decimal string in [0, 2^63 - 1].
 * Rejects negatives, leading zeroes (except '0'), floats, non-numeric strings, and numbers exceeding PostgreSQL BIGINT max.
 * Parity with Shared PR #213 isValidUnsignedBigIntRevision and Mobile revision_bigint.dart.
 */
export function isValidCanonicalRevisionString(val: unknown): val is string {
  if (typeof val !== 'string' || !/^(0|[1-9]\d*)$/.test(val)) {
    return false;
  }
  try {
    const parsed = BigInt(val);
    return parsed >= 0n && parsed <= MAX_POSTGRES_BIGINT;
  } catch {
    return false;
  }
}

/**
 * Thrown in strict fail-closed batch validation mode when server returns an invalid envelope or corrupted receipts.
 * Direct parity with Mobile Stage 2A.1 ReceiptValidationException.
 */
export class ReceiptValidationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptValidationException';
  }
}

export interface EnvelopeValidationResult {
  isValid: boolean;
  receiptCountMatches: boolean;
  processedCountMatches: boolean;
  serverRevisionValid: boolean;
  violations: string[];
}

export interface CorrelatedReceipts {
  validResults: MutationResultItem[];
  unknownReceipts: MutationResultItem[];
  duplicateReceipts: { mutationId: string; receipts: MutationResultItem[] }[];
  invalidReceipts: { receipt: MutationResultItem; reason: string }[];
  missingMutationIds: string[];
  envelopeValidation: EnvelopeValidationResult;
}

/**
 * Step 5.2f Canonical Wire Receipt Correlation and Causal Validation
 * Filters and correlates wire receipts from server before passing to MutationQueue.
 * Ensures unknown, duplicate, corrupt status, and contradictory revision receipts
 * are rejected fail-closed without mutating or dropping offline pending mutations.
 *
 * Invariant: Preserves per-mutation tolerant settlement by default, while capturing
 * batch envelope and receipt integrity violations in `envelopeValidation`.
 */
export function correlateAndValidateReceipts(
  dispatchedMutations: LocalPendingMutation[],
  rawResults: MutationResultItem[],
  envelope?: { processedCount?: number; newServerRevision?: string }
): CorrelatedReceipts {
  const dispatchedMap = new Map<string, LocalPendingMutation>();
  for (const m of dispatchedMutations) {
    dispatchedMap.set(m.mutationId, m);
  }

  const receiptsByMutationId = new Map<string, MutationResultItem[]>();
  const unknownReceipts: MutationResultItem[] = [];
  const invalidReceipts: { receipt: MutationResultItem; reason: string }[] = [];

  for (const r of rawResults || []) {
    if (!r || typeof r.mutationId !== 'string' || r.mutationId.trim() === '') {
      invalidReceipts.push({
        receipt: r,
        reason: 'EMPTY_MUTATION_ID: Receipt contains an empty or whitespace mutationId.',
      });
      continue;
    }
    const trimmedId = r.mutationId.trim();
    if (!dispatchedMap.has(trimmedId)) {
      unknownReceipts.push(r);
      continue;
    }
    const list = receiptsByMutationId.get(trimmedId) || [];
    list.push(r);
    receiptsByMutationId.set(trimmedId, list);
  }

  const validResults: MutationResultItem[] = [];
  const duplicateReceipts: { mutationId: string; receipts: MutationResultItem[] }[] = [];

  for (const [mutationId, receipts] of receiptsByMutationId.entries()) {
    if (receipts.length > 1) {
      // Duplicate receipts detected for single mutation in single response -> ambiguous, untrusted!
      duplicateReceipts.push({ mutationId, receipts });
      continue;
    }

    const r = receipts[0];
    const mutation = dispatchedMap.get(mutationId)!;

    // 1. Status validity
    if (!VALID_RECEIPT_STATUSES.has(r.status)) {
      invalidReceipts.push({
        receipt: r,
        reason: `Unrecognized or invalid receipt status: "${(r as any).status}"`,
      });
      continue;
    }

    // 2. Revision causal monotonicity & canonical BIGINT format checks
    if (r.status === 'APPLIED') {
      if (!isValidCanonicalRevisionString(r.assignedRevision)) {
        invalidReceipts.push({
          receipt: r,
          reason: `APPLIED receipt missing or non-canonical decimal assignedRevision: "${String(r.assignedRevision)}"`,
        });
        continue;
      }

      if (isValidRevisionString(mutation.baseServerRevision)) {
        if (BigInt(r.assignedRevision) < BigInt(mutation.baseServerRevision)) {
          invalidReceipts.push({
            receipt: r,
            reason: `APPLIED receipt assignedRevision (${r.assignedRevision}) < baseServerRevision (${mutation.baseServerRevision})`,
          });
          continue;
        }
      }
    } else if (r.status === 'DEDUPLICATED') {
      if (r.assignedRevision != null && r.assignedRevision !== '') {
        if (!isValidCanonicalRevisionString(r.assignedRevision)) {
          invalidReceipts.push({
            receipt: r,
            reason: `DEDUPLICATED receipt has non-canonical decimal assignedRevision: "${String(r.assignedRevision)}"`,
          });
          continue;
        }
        if (isValidRevisionString(mutation.baseServerRevision)) {
          if (BigInt(r.assignedRevision) < BigInt(mutation.baseServerRevision)) {
            invalidReceipts.push({
              receipt: r,
              reason: `DEDUPLICATED receipt assignedRevision (${r.assignedRevision}) < baseServerRevision (${mutation.baseServerRevision})`,
            });
            continue;
          }
        }
      }
    } else if (r.status === 'CONFLICT_MERGED') {
      if (r.assignedRevision != null && r.assignedRevision !== '') {
        if (!isValidCanonicalRevisionString(r.assignedRevision)) {
          invalidReceipts.push({
            receipt: r,
            reason: `CONFLICT_MERGED receipt has non-canonical decimal assignedRevision: "${String(r.assignedRevision)}"`,
          });
          continue;
        }
        if (isValidRevisionString(mutation.baseServerRevision)) {
          if (BigInt(r.assignedRevision) < BigInt(mutation.baseServerRevision)) {
            invalidReceipts.push({
              receipt: r,
              reason: `CONFLICT_MERGED receipt assignedRevision (${r.assignedRevision}) < baseServerRevision (${mutation.baseServerRevision})`,
            });
            continue;
          }
        }
      }
    } else {
      // Rejection statuses (REJECTED_TOMBSTONE, REJECTED_STALE, DOMAIN_NOT_SUPPORTED)
      if (r.assignedRevision != null && r.assignedRevision !== '') {
        if (!isValidCanonicalRevisionString(r.assignedRevision)) {
          invalidReceipts.push({
            receipt: r,
            reason: `${r.status} receipt has non-canonical decimal assignedRevision: "${String(r.assignedRevision)}"`,
          });
          continue;
        }
      }
    }

    validResults.push(r);
  }

  const validSet = new Set(validResults.map((r) => r.mutationId));
  const missingMutationIds = dispatchedMutations
    .filter((m) => !validSet.has(m.mutationId))
    .map((m) => m.mutationId);

  // 3. Envelope validation
  const violations: string[] = [];
  const receiptCountMatches = (rawResults || []).length === dispatchedMutations.length;
  if (!receiptCountMatches) {
    violations.push(
      `RECEIPT_COUNT_MISMATCH: Sent ${dispatchedMutations.length} mutations, but server returned ${(rawResults || []).length} receipts.`
    );
  }

  let processedCountMatches = true;
  if (envelope?.processedCount !== undefined) {
    processedCountMatches = envelope.processedCount === dispatchedMutations.length;
    if (!processedCountMatches) {
      violations.push(
        `PROCESSED_COUNT_MISMATCH: Sent ${dispatchedMutations.length} mutations, but server processedCount is ${envelope.processedCount}.`
      );
    }
  }

  let serverRevisionValid = true;
  if (envelope?.newServerRevision !== undefined) {
    serverRevisionValid = isValidCanonicalRevisionString(envelope.newServerRevision);
    if (!serverRevisionValid) {
      violations.push(
        `INVALID_SERVER_REVISION: newServerRevision "${envelope.newServerRevision}" is not a valid 64-bit canonical decimal string.`
      );
    }
  }

  if (unknownReceipts.length > 0) {
    violations.push(
      `UNEXPECTED_MUTATION_ID: Received ${unknownReceipts.length} unexpected receipts not in sent batch.`
    );
  }
  if (duplicateReceipts.length > 0) {
    violations.push(
      `DUPLICATE_RECEIPT: Received duplicate receipts for ${duplicateReceipts.length} mutations.`
    );
  }
  if (invalidReceipts.length > 0) {
    violations.push(
      `INVALID_RECEIPT: Encountered ${invalidReceipts.length} receipts failing validation.`
    );
  }
  if (missingMutationIds.length > 0) {
    violations.push(
      `MISSING_RECEIPTS: Expected receipts for ${dispatchedMutations.length} mutations, but ${missingMutationIds.length} were missing or unvalidated.`
    );
  }

  const envelopeValidation: EnvelopeValidationResult = {
    isValid: violations.length === 0,
    receiptCountMatches,
    processedCountMatches,
    serverRevisionValid,
    violations,
  };

  return {
    validResults,
    unknownReceipts,
    duplicateReceipts,
    invalidReceipts,
    missingMutationIds,
    envelopeValidation,
  };
}

/**
 * Strict whole-batch fail-closed validation function adhering to Mobile Stage 2A.1 SyncReceiptValidator.
 * Throws ReceiptValidationException if ANY envelope or receipt integrity violation occurs.
 */
export function validateBatchReceiptsStrictFailClosed(
  dispatchedMutations: LocalPendingMutation[],
  wireResponse: WireMutationBatchResponse
): void {
  if (wireResponse.newServerRevision !== undefined && !isValidCanonicalRevisionString(wireResponse.newServerRevision)) {
    throw new ReceiptValidationException(
      `INVALID_SERVER_REVISION: newServerRevision "${wireResponse.newServerRevision}" is not a valid 64-bit canonical decimal string.`
    );
  }

  if (wireResponse.results.length !== dispatchedMutations.length) {
    throw new ReceiptValidationException(
      `RECEIPT_COUNT_MISMATCH: Sent ${dispatchedMutations.length} mutations, but server returned ${wireResponse.results.length} receipts.`
    );
  }

  if (wireResponse.processedCount !== undefined && wireResponse.processedCount !== dispatchedMutations.length) {
    throw new ReceiptValidationException(
      `PROCESSED_COUNT_MISMATCH: Sent ${dispatchedMutations.length} mutations, but server processedCount is ${wireResponse.processedCount}.`
    );
  }

  const sentIds = new Set(dispatchedMutations.map((m) => m.mutationId));
  const seenIds = new Set<string>();

  for (const item of wireResponse.results) {
    const mId = item.mutationId?.trim();
    if (!mId) {
      throw new ReceiptValidationException(
        'EMPTY_MUTATION_ID: Receipt contains an empty or whitespace mutationId.'
      );
    }

    if (!sentIds.has(mId)) {
      throw new ReceiptValidationException(
        `UNEXPECTED_MUTATION_ID: Receipt for mutationId "${mId}" was not part of the sent batch.`
      );
    }

    if (seenIds.has(mId)) {
      throw new ReceiptValidationException(
        `DUPLICATE_RECEIPT: Duplicate receipt received for mutationId "${mId}".`
      );
    }
    seenIds.add(mId);

    const status = item.status?.trim().toUpperCase();
    if (!VALID_RECEIPT_STATUSES.has(status)) {
      throw new ReceiptValidationException(
        `UNRECOGNIZED_RECEIPT_STATUS: Status "${status}" for mutationId "${mId}" is not recognized by the protocol.`
      );
    }

    if (status === 'APPLIED' || status === 'DEDUPLICATED') {
      if (item.assignedRevision == null || !isValidCanonicalRevisionString(item.assignedRevision)) {
        throw new ReceiptValidationException(
          `INVALID_ASSIGNED_REVISION: Status "${status}" for mutationId "${mId}" requires a valid canonical decimal assignedRevision, got "${item.assignedRevision}".`
        );
      }
    } else if (item.assignedRevision != null && !isValidCanonicalRevisionString(item.assignedRevision)) {
      throw new ReceiptValidationException(
        `INVALID_ASSIGNED_REVISION: Optional assignedRevision "${item.assignedRevision}" for mutationId "${mId}" is not a valid canonical decimal string.`
      );
    }
  }

  if (seenIds.size !== sentIds.size) {
    throw new ReceiptValidationException(
      `MISSING_RECEIPTS: Expected receipts for ${sentIds.size} mutations, but only received ${seenIds.size}.`
    );
  }
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
    _testHookBeforeProcessResults?: () => Promise<void>;
  }): Promise<PushPendingMutationsResult> {
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
      return {
        pushedCount: 0,
        dispatchedCount: 0,
        appliedCount: 0,
        deduplicatedCount: 0,
        rejectedCount: 0,
        transientRetryCount: 0,
        quarantinedStaleCount: 0,
        quarantinedLegacyCount: 0,
      };
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
      this.config.mutationQueue.releaseOwnedMutation(batch, m.mutationId);
    }
    for (const m of admission.quarantinedLegacyMutations) {
      this.config.mutationQueue.releaseOwnedMutation(batch, m.mutationId);
    }

    if (admission.eligibleMutations.length === 0) {
      this.config.mutationQueue.releaseInFlight(batch);
      return {
        pushedCount: 0,
        dispatchedCount: 0,
        appliedCount: 0,
        deduplicatedCount: 0,
        rejectedCount: 0,
        transientRetryCount: 0,
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

    if (options?._testHookBeforeProcessResults) {
      await options._testHookBeforeProcessResults();
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
        dispatchedCount: wireMutations.length,
        appliedCount: 0,
        deduplicatedCount: 0,
        rejectedCount: 0,
        transientRetryCount: wireMutations.length,
        quarantinedStaleCount: admission.quarantinedStaleMutations.length,
        quarantinedLegacyCount: admission.quarantinedLegacyMutations.length,
      };
    }

    // 6. Correlate and validate wire receipts before passing to MutationQueue
    const correlation = correlateAndValidateReceipts(
      admission.eligibleMutations,
      wireResponse.results,
      wireResponse
    );

    // Create an updated batch matching only the eligible mutations that were actually dispatched
    const dispatchedBatch: PreparedPushBatch = {
      ...batch,
      mutations: admission.eligibleMutations,
    };

    const summary = await this.config.mutationQueue.processServerBatchResults({
      batch: dispatchedBatch,
      results: correlation.validResults,
      leaderSignal: options?.leaderSignal,
    });

    const rejectedCount =
      summary.tombstoneEvictedCount +
      summary.staleQuarantinedCount +
      summary.unsupportedCount +
      summary.conflictMergedCount;

    return {
      pushedCount: wireMutations.length,
      dispatchedCount: wireMutations.length,
      appliedCount: summary.appliedCount,
      deduplicatedCount: summary.deduplicatedCount,
      rejectedCount,
      transientRetryCount: summary.transientRetryCount,
      quarantinedStaleCount: admission.quarantinedStaleMutations.length,
      quarantinedLegacyCount: admission.quarantinedLegacyMutations.length,
      summary,
      correlation,
    };
  }
}
