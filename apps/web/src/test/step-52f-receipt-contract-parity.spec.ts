import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  MutationResultItem,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  LocalPendingMutation,
} from '../lib/storage/indexed-db-client';
import {
  MutationQueue,
  createStaticIdentityProvider,
} from '../lib/sync/mutation-queue';
import { TabLeaderElection } from '../lib/sync/tab-leader-election';
import {
  InMemoryLockManager,
  MockSyncTransportServer,
  MockStep52dReconciler,
  ScopeAuthorityError,
  correlateAndValidateReceipts,
  validateBatchReceiptsStrictFailClosed,
  isValidCanonicalRevisionString,
  ReceiptValidationException,
  MAX_POSTGRES_BIGINT,
} from './harness/mock-sync-transport-harness';
import { WireMutationBatchResponse } from './fixtures/step-52d-contract-fixtures';

/**
 * Step 5.2f: Web / Core API / Mobile Receipt Contract Parity & Fail-Closed Integration Test Suite.
 *
 * Verifies parity with:
 * - Shared ADR-SYNC-07C-v2.2 & Patch Set A (PR #213)
 * - Core API Sync Hub pushMutations contract (PR #212)
 * - Mobile Stage 2A.1 Receipt Integrity & Atomic Settlement Test Suite (Commit 32f1ecb)
 */
describe('Web Step 5.2f Receipt Contract Parity & Fail-Closed Integration', () => {
  let dbClient: IndexedDbClient;
  let lockManager: InMemoryLockManager;
  let transportServer: MockSyncTransportServer;

  beforeEach(async () => {
    dbClient = new IndexedDbClient();
    lockManager = new InMemoryLockManager();
    transportServer = new MockSyncTransportServer();
  });

  afterEach(async () => {
    await dbClient.close();
  });

  async function seedReadySyncMeta(
    scope: string,
    checkpoint: string,
    minActive: string = '0'
  ): Promise<void> {
    const rawDb = await dbClient.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = rawDb.transaction(STORE_SYNC_META, 'readwrite');
      tx.objectStore(STORE_SYNC_META).put({
        ownerScope: scope,
        lastSyncedServerRevision: checkpoint,
        minActiveRevision: minActive,
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'PULL_COMPLETED',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // =========================================================================
  // SECTION 1: CANONICAL BIGINT & ENVELOPE FORMAT INTEGRITY (TASKS 1, 3)
  // =========================================================================
  describe('Section 1: Canonical BIGINT & Envelope Format Integrity', () => {
    it('1.1 validates canonical decimal 64-bit BIGINT revisions [0, 2^63 - 1]', () => {
      // Valid canonical decimal strings
      expect(isValidCanonicalRevisionString('0')).toBe(true);
      expect(isValidCanonicalRevisionString('1')).toBe(true);
      expect(isValidCanonicalRevisionString('10')).toBe(true);
      expect(isValidCanonicalRevisionString('9223372036854775807')).toBe(true); // 2^63 - 1

      // Non-canonical / invalid strings (rejected fail-closed)
      expect(isValidCanonicalRevisionString('-1')).toBe(false); // negative
      expect(isValidCanonicalRevisionString('012')).toBe(false); // leading zero
      expect(isValidCanonicalRevisionString('00')).toBe(false); // leading zero
      expect(isValidCanonicalRevisionString('1.5')).toBe(false); // float
      expect(isValidCanonicalRevisionString('abc')).toBe(false); // non-numeric
      expect(isValidCanonicalRevisionString(' 10 ')).toBe(false); // whitespace
      expect(isValidCanonicalRevisionString('')).toBe(false); // empty
      expect(isValidCanonicalRevisionString(10)).toBe(false); // number primitive
      expect(isValidCanonicalRevisionString(null)).toBe(false); // null
      expect(isValidCanonicalRevisionString(undefined)).toBe(false); // undefined
      expect(isValidCanonicalRevisionString('9223372036854775808')).toBe(false); // overflow > MAX_POSTGRES_BIGINT
      expect(isValidCanonicalRevisionString('99999999999999999999999')).toBe(false); // large overflow
    });

    it('1.2 detects envelope processedCount mismatch and non-canonical newServerRevision', () => {
      const dispatched: LocalPendingMutation[] = [
        {
          ownerScope: 'account:usr-env',
          mutationId: 'mut-1',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'bm-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { storyId: 's1' },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ];

      // Case A: processedCount mismatch (sent 1, server claims 2)
      const resCountMismatch = correlateAndValidateReceipts(
        dispatched,
        [{ mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' }],
        { processedCount: 2, newServerRevision: '11' }
      );
      expect(resCountMismatch.envelopeValidation.isValid).toBe(false);
      expect(resCountMismatch.envelopeValidation.processedCountMatches).toBe(false);
      expect(resCountMismatch.envelopeValidation.violations).toContain(
        'PROCESSED_COUNT_MISMATCH: Sent 1 mutations, but server processedCount is 2.'
      );

      // Case B: Non-canonical newServerRevision (leading zero '011')
      const resRevInvalid = correlateAndValidateReceipts(
        dispatched,
        [{ mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' }],
        { processedCount: 1, newServerRevision: '011' }
      );
      expect(resRevInvalid.envelopeValidation.isValid).toBe(false);
      expect(resRevInvalid.envelopeValidation.serverRevisionValid).toBe(false);
      expect(resRevInvalid.envelopeValidation.violations.some((v) => v.includes('INVALID_SERVER_REVISION'))).toBe(true);

      // Case C: Fully valid canonical envelope
      const resValid = correlateAndValidateReceipts(
        dispatched,
        [{ mutationId: 'mut-1', status: 'APPLIED', assignedRevision: '11' }],
        { processedCount: 1, newServerRevision: '11' }
      );
      expect(resValid.envelopeValidation.isValid).toBe(true);
      expect(resValid.envelopeValidation.processedCountMatches).toBe(true);
      expect(resValid.envelopeValidation.serverRevisionValid).toBe(true);
      expect(resValid.envelopeValidation.violations).toHaveLength(0);
    });

    it('1.3 rejects empty or whitespace mutationId in server receipts', () => {
      const dispatched: LocalPendingMutation[] = [
        {
          ownerScope: 'account:usr-empty-id',
          mutationId: 'mut-valid',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'bm-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { storyId: 's1' },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ];

      const rawReceipts: MutationResultItem[] = [
        { mutationId: '', status: 'APPLIED', assignedRevision: '11' },
        { mutationId: '   ', status: 'APPLIED', assignedRevision: '12' },
        { mutationId: 'mut-valid', status: 'APPLIED', assignedRevision: '11' },
      ];

      const correlation = correlateAndValidateReceipts(dispatched, rawReceipts);
      expect(correlation.validResults).toHaveLength(1);
      expect(correlation.validResults[0].mutationId).toBe('mut-valid');
      expect(correlation.invalidReceipts).toHaveLength(2);
      expect(correlation.invalidReceipts[0].reason).toContain('EMPTY_MUTATION_ID');
      expect(correlation.invalidReceipts[1].reason).toContain('EMPTY_MUTATION_ID');
    });
  });

  // =========================================================================
  // SECTION 2: END-TO-END RECONCILER CONTRACT SETTLEMENT (TASKS 1, 2, 4)
  // =========================================================================
  describe('Section 2: End-to-End Reconciler Contract Settlement', () => {
    it('2.1 settles valid batch with APPLIED and DEDUPLICATED receipts (Mobile Scenario 1 parity)', async () => {
      const scope = 'account:usr-parity-valid';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-applied-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-dedup-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-2',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's2' },
        createdAt: '2026-11-10T08:00:01.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        processedCount: 2,
        newServerRevision: '11',
        results: [
          { mutationId: 'mut-applied-1', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-dedup-1', status: 'DEDUPLICATED', assignedRevision: '10' },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.dispatchedCount).toBe(2);
      expect(res.appliedCount).toBe(1);
      expect(res.deduplicatedCount).toBe(1);
      expect(res.rejectedCount).toBe(0);
      expect(res.transientRetryCount).toBe(0);

      // Pending queue is fully cleared
      expect(await dbClient.getPendingMutation(scope, 'mut-applied-1')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-dedup-1')).toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Envelope validation passed cleanly
      expect(res.correlation?.envelopeValidation.isValid).toBe(true);

      tab.destroy();
    });

    it('2.2 handles partial receipt: settles valid receipt and retains missing in pending (Mobile Scenario 2 comparative)', async () => {
      const scope = 'account:usr-parity-missing';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-complete',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-complete',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's-complete' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-omitted',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-omitted',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's-omitted' },
        createdAt: '2026-11-10T08:00:01.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server only returns receipt for mut-complete
      const wireResponse: WireMutationBatchResponse = {
        processedCount: 1,
        newServerRevision: '11',
        results: [
          { mutationId: 'mut-complete', status: 'APPLIED', assignedRevision: '11' },
        ],
      };
      transportServer.queueBatchResponse(wireResponse);

      const res = await reconciler.pushPendingMutations();

      // Web Policy: Tolerant partial settlement
      expect(res.dispatchedCount).toBe(2);
      expect(res.appliedCount).toBe(1);
      expect(res.transientRetryCount).toBe(1);

      // mut-complete was settled and deleted
      expect(await dbClient.getPendingMutation(scope, 'mut-complete')).toBeNull();

      // mut-omitted was preserved in pending store for exponential backoff retry
      const preserved = await dbClient.getPendingMutation(scope, 'mut-omitted');
      expect(preserved).not.toBeNull();
      expect(preserved?.retryCount).toBe(1);
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Envelope violation was flagged
      expect(res.correlation?.envelopeValidation.isValid).toBe(false);
      expect(res.correlation?.envelopeValidation.receiptCountMatches).toBe(false);
      expect(res.correlation?.missingMutationIds).toEqual(['mut-omitted']);

      // Comparative: Mobile strict validator would throw ReceiptValidationException
      expect(() =>
        validateBatchReceiptsStrictFailClosed(
          [
            { mutationId: 'mut-complete' } as any,
            { mutationId: 'mut-omitted' } as any,
          ],
          wireResponse
        )
      ).toThrowError(/RECEIPT_COUNT_MISMATCH/);

      tab.destroy();
    });

    it('2.3 safely ignores unexpected phantom mutationId (Mobile Scenario 4 comparative)', async () => {
      const scope = 'account:usr-parity-phantom';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-expected',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-expected',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's-exp' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      const wireResponse: WireMutationBatchResponse = {
        processedCount: 2,
        newServerRevision: '11',
        results: [
          { mutationId: 'mut-expected', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-phantom-999', status: 'APPLIED', assignedRevision: '12' },
        ],
      };
      transportServer.queueBatchResponse(wireResponse);

      const res = await reconciler.pushPendingMutations();

      // Web safely settles the expected mutation and ignores phantom
      expect(res.appliedCount).toBe(1);
      expect(await dbClient.getPendingMutation(scope, 'mut-expected')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-phantom-999')).toBeNull();
      expect(res.correlation?.unknownReceipts).toHaveLength(1);
      expect(res.correlation?.unknownReceipts[0].mutationId).toBe('mut-phantom-999');

      // Comparative: Mobile strict validator rejects when an unexpected ID is returned (tested with count=1)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(
          [{ mutationId: 'mut-expected' } as any],
          {
            processedCount: 1,
            newServerRevision: '11',
            results: [{ mutationId: 'mut-phantom-999', status: 'APPLIED', assignedRevision: '12' }],
          }
        )
      ).toThrowError(/UNEXPECTED_MUTATION_ID/);

      tab.destroy();
    });

    it('2.4 detects duplicate receipts as ambiguous, preserves pending for retry (Mobile Scenario 5 comparative)', async () => {
      const scope = 'account:usr-parity-dup';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-dup',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-dup',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 's-dup' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      const wireResponse: WireMutationBatchResponse = {
        results: [
          { mutationId: 'mut-dup', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-dup', status: 'APPLIED', assignedRevision: '12' },
        ],
      };
      transportServer.queueBatchResponse(wireResponse);

      const res = await reconciler.pushPendingMutations();

      // Ambiguous: not settled, preserved in pending store
      expect(res.appliedCount).toBe(0);
      expect(res.transientRetryCount).toBe(1);
      expect(await dbClient.getPendingMutation(scope, 'mut-dup')).not.toBeNull();
      expect(res.correlation?.duplicateReceipts).toHaveLength(1);

      // Comparative: Mobile strict validator rejects with DUPLICATE_RECEIPT (count=2 matching sent=2)
      expect(() =>
        validateBatchReceiptsStrictFailClosed(
          [{ mutationId: 'mut-dup' } as any, { mutationId: 'mut-dup-2' } as any],
          {
            processedCount: 2,
            newServerRevision: '11',
            results: [
              { mutationId: 'mut-dup', status: 'APPLIED', assignedRevision: '11' },
              { mutationId: 'mut-dup', status: 'APPLIED', assignedRevision: '12' },
            ],
          }
        )
      ).toThrowError(/DUPLICATE_RECEIPT/);

      tab.destroy();
    });

    it('2.5 rejects unrecognized receipt status without quarantining (Mobile Scenario 9 parity)', async () => {
      const scope = 'account:usr-parity-unrec';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-alien-status',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-alien',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'alien-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      const wireResponse: WireMutationBatchResponse = {
        results: [
          { mutationId: 'mut-alien-status', status: 'UNKNOWN_BOGUS_STATUS' as any, assignedRevision: '11' },
        ],
      };
      transportServer.queueBatchResponse(wireResponse);

      const res = await reconciler.pushPendingMutations();

      // Invariant: Unrecognized status must NOT quarantine! Preserved in pending store.
      expect(res.appliedCount).toBe(0);
      expect(res.rejectedCount).toBe(0);
      expect(res.transientRetryCount).toBe(1);

      const stillPending = await dbClient.getPendingMutation(scope, 'mut-alien-status');
      expect(stillPending).not.toBeNull();

      // Zero items in quarantined store
      const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-alien-status');
      expect(quarantined).toBeNull();

      // Comparative: Mobile strict validator rejects with UNRECOGNIZED_RECEIPT_STATUS
      expect(() =>
        validateBatchReceiptsStrictFailClosed(
          [{ mutationId: 'mut-alien-status' } as any],
          wireResponse
        )
      ).toThrowError(/UNRECOGNIZED_RECEIPT_STATUS/);

      tab.destroy();
    });

    it('2.6 settles CONFLICT_MERGED and triggers delta pull obligation (Mobile Scenario 10 parity)', async () => {
      const scope = 'account:usr-parity-conflict';
      await seedReadySyncMeta(scope, '10', '0');

      let deltaPullHandled = false;
      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
        onAuthoritativeDeltaPullRequired: async () => {
          deltaPullHandled = true;
        },
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-conflict-1',
        clientId: 'client-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-uuid-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          storyId: 'story-uuid-1',
          chapterId: 'chap-1',
          readingMode: ReadingMode.PAGED,
          pageIndex: 5,
          scrollPosition: 0,
          progressPercentage: 50,
        },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        processedCount: 1,
        newServerRevision: '12',
        results: [
          {
            mutationId: 'mut-conflict-1',
            status: 'CONFLICT_MERGED',
            assignedRevision: '12',
            message: 'Progress conflict resolved with server winner',
          },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      // Settled, removed from pending
      expect(res.rejectedCount).toBe(1); // classified under summary.conflictMergedCount
      expect(res.summary.conflictMergedCount).toBe(1);
      expect(await dbClient.getPendingMutation(scope, 'mut-conflict-1')).toBeNull();

      // Does NOT quarantine
      expect(await dbClient.getQuarantinedMutation(scope, 'mut-conflict-1')).toBeNull();

      // Authoritative delta pull was triggered
      expect(deltaPullHandled).toBe(true);

      tab.destroy();
    });

    it('2.7 evicts replica on REJECTED_TOMBSTONE and preserves anti-resurrection invariant (Mobile Scenario 11 comparison)', async () => {
      const scope = 'account:usr-parity-tombstone';
      await seedReadySyncMeta(scope, '10', '0');

      let replicaEvicted = false;
      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
        onReplicaEvicted: (s, d, e) => {
          replicaEvicted = true;
        },
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-tombstone-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-tomb' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        results: [
          {
            mutationId: 'mut-tombstone-1',
            status: 'REJECTED_TOMBSTONE',
            assignedRevision: null,
            reason: 'TOMBSTONE_CONFLICT',
            message: 'Entity was deleted at server revision 12',
          },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.rejectedCount).toBe(1);
      expect(res.summary.tombstoneEvictedCount).toBe(1);

      // In Web: Deleted atomically from pending store and replica evicted to prevent resurrection
      expect(await dbClient.getPendingMutation(scope, 'mut-tombstone-1')).toBeNull();
      expect(replicaEvicted).toBe(true);

      tab.destroy();
    });

    it('2.8 settles mixed batch (APPLIED + DEDUPLICATED + CONFLICT_MERGED + REJECTED_STALE) atomically (Mobile Scenario 12 parity)', async () => {
      const scope = 'account:usr-parity-mixed';
      await seedReadySyncMeta(scope, '10', '0');

      let deltaPullHandled = false;
      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
        onAuthoritativeDeltaPullRequired: async () => {
          deltaPullHandled = true;
        },
      });

      const mutations = [
        { id: 'm-applied', domain: SyncDomain.BOOKMARK, op: SyncOperation.UPSERT },
        { id: 'm-dedup', domain: SyncDomain.BOOKMARK, op: SyncOperation.UPSERT },
        { id: 'm-conflict', domain: SyncDomain.PROGRESS, op: SyncOperation.UPSERT },
        { id: 'm-stale', domain: SyncDomain.BOOKMARK, op: SyncOperation.UPSERT },
      ];

      for (const m of mutations) {
        await queue.enqueue({
          ownerScope: scope,
          mutationId: m.id,
          clientId: 'client-1',
          domain: m.domain,
          entityId: `entity-${m.id}`,
          operation: m.op,
          baseServerRevision: '10',
          payload: { storyId: m.id },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
      }

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        processedCount: 4,
        newServerRevision: '13',
        results: [
          { mutationId: 'm-applied', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'm-dedup', status: 'DEDUPLICATED', assignedRevision: '10' },
          { mutationId: 'm-conflict', status: 'CONFLICT_MERGED', assignedRevision: '12' },
          { mutationId: 'm-stale', status: 'REJECTED_STALE', assignedRevision: null, reason: 'BASE_REVISION_EXPIRED' },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.dispatchedCount).toBe(4);
      expect(res.appliedCount).toBe(1);
      expect(res.deduplicatedCount).toBe(1);
      expect(res.summary.conflictMergedCount).toBe(1);
      expect(res.summary.staleQuarantinedCount).toBe(1);
      expect(res.transientRetryCount).toBe(0);
      expect(deltaPullHandled).toBe(true);

      // Pending store is completely empty
      for (const m of mutations) {
        expect(await dbClient.getPendingMutation(scope, m.id)).toBeNull();
      }

      // m-stale is in quarantined store
      expect(await dbClient.getQuarantinedMutation(scope, 'm-stale')).not.toBeNull();

      tab.destroy();
    });
  });

  // =========================================================================
  // SECTION 3: WIRE PERMUTATION INVARIANCE & OUT-OF-ORDER RECEIPTS (TASK 4)
  // =========================================================================
  describe('Section 3: Wire Permutation Invariance & Out-of-Order Receipts', () => {
    it('3.1 correlates and settles receipts accurately when server returns them in reverse/shuffled order', async () => {
      const scope = 'account:usr-perm-order';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      // Enqueue mutations in order: A, B, C, D
      const ids = ['mut-order-A', 'mut-order-B', 'mut-order-C', 'mut-order-D'];
      for (const id of ids) {
        await queue.enqueue({
          ownerScope: scope,
          mutationId: id,
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: `bm-${id}`,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { storyId: id },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
      }

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns receipts in REVERSED order: D, C, B, A
      transportServer.queueBatchResponse({
        processedCount: 4,
        newServerRevision: '14',
        results: [
          { mutationId: 'mut-order-D', status: 'APPLIED', assignedRevision: '14' },
          { mutationId: 'mut-order-C', status: 'REJECTED_STALE', assignedRevision: null, reason: 'STALE' },
          { mutationId: 'mut-order-B', status: 'DEDUPLICATED', assignedRevision: '10' },
          { mutationId: 'mut-order-A', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      const res = await reconciler.pushPendingMutations();

      expect(res.dispatchedCount).toBe(4);
      expect(res.appliedCount).toBe(2); // A and D
      expect(res.deduplicatedCount).toBe(1); // B
      expect(res.summary.staleQuarantinedCount).toBe(1); // C

      // All 4 pending mutations are cleared
      for (const id of ids) {
        expect(await dbClient.getPendingMutation(scope, id)).toBeNull();
      }

      // C is in quarantine
      expect(await dbClient.getQuarantinedMutation(scope, 'mut-order-C')).not.toBeNull();

      tab.destroy();
    });
  });

  // =========================================================================
  // SECTION 4: ATOMIC ROLLBACK, CRASH, LOGOUT & LEADER SAFETY (TASK 5)
  // =========================================================================
  describe('Section 4: Atomic Rollback, Crash, Logout & Leader Safety', () => {
    it('4.1 aborts cleanly on scope revocation between network response and settlement commit (Mobile Scenario 15 parity)', async () => {
      const scopeA = 'account:usr-logout-race-a';
      const scopeB = 'account:usr-logout-race-b';
      await seedReadySyncMeta(scopeA, '10', '0');
      await seedReadySyncMeta(scopeB, '10', '0');

      const identityProvider = createStaticIdentityProvider(scopeA);

      const queue = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: identityProvider,
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-logout-race',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-logout-race',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'logout-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scopeA, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-logout-race', status: 'APPLIED', assignedRevision: '11' }],
      });

      // User logs out of Scope A and logs into Scope B before settlement runs
      const res = await reconciler.pushPendingMutations({
        _testHookBeforeProcessResults: async () => {
          identityProvider.setScope(scopeB);
          queue.setActiveScope(scopeB);
          reconciler.setScope(scopeB);
        },
      });

      // 0 mutations applied, 0 cross-account writes
      expect(res.appliedCount).toBe(0);
      expect(await dbClient.getPendingMutation(scopeB, 'mut-logout-race')).toBeNull();

      // Pending mutation in Scope A preserved for when user logs back in
      expect(await dbClient.getPendingMutation(scopeA, 'mut-logout-race')).not.toBeNull();

      // In-flight lease released
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      tab.destroy();
    });

    it('4.2 aborts cleanly when leader lock is lost between network response and settlement commit (Mobile Scenario 16 parity)', async () => {
      const scope = 'account:usr-leader-lost-race';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-leader-lost',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-leader-lost',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'leader-lost-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-leader-lost', status: 'APPLIED', assignedRevision: '11' }],
      });

      const res = await reconciler.pushPendingMutations({
        _testHookBeforeProcessResults: async () => {
          tab.destroy(); // Leader lease lost!
        },
      });

      expect(res.appliedCount).toBe(0);
      expect(await dbClient.getPendingMutation(scope, 'mut-leader-lost')).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);
    });

    it('4.3 preserves FIFO queue and durability after aborted settlement and tab reopen (Mobile Scenario 17 parity)', async () => {
      const scope = 'account:usr-crash-reopen';
      await seedReadySyncMeta(scope, '10', '0');

      // Session 1: Client enqueues 2 mutations
      const queue1 = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue1.enqueue({
        ownerScope: scope,
        mutationId: 'mut-crash-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-crash-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'c1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      await queue1.enqueue({
        ownerScope: scope,
        mutationId: 'mut-crash-2',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-crash-2',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'c2' },
        createdAt: '2026-11-10T08:00:01.000Z',
        retryCount: 0,
      });

      const tab1 = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-1', lockManager });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler1 = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue1,
        tabLeader: tab1,
        server: transportServer,
      });

      // Prepare batch and trigger network failure / tab crash
      transportServer.queueBatchResponse(new Error('Network connection abruptly terminated'));

      await expect(reconciler1.pushPendingMutations()).rejects.toThrowError(
        /Network connection abruptly terminated/
      );

      // Verify in-flight lease was released even on sudden network abort
      expect((await queue1.getStatus()).inFlightCount).toBe(0);

      tab1.destroy();

      // Session 2: Tab reopens fresh with new MutationQueue & Reconciler
      const queue2 = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      const tab2 = new TabLeaderElection({ ownerScope: scope, tabId: 'tab-2', lockManager });
      tab2.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler2 = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue2,
        tabLeader: tab2,
        server: transportServer,
      });

      // Re-dispatch: both mutations are eligible and sent in FIFO order
      transportServer.queueBatchResponse({
        processedCount: 2,
        newServerRevision: '12',
        results: [
          { mutationId: 'mut-crash-1', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-crash-2', status: 'APPLIED', assignedRevision: '12' },
        ],
      });

      const res2 = await reconciler2.pushPendingMutations();

      expect(res2.dispatchedCount).toBe(2);
      expect(res2.appliedCount).toBe(2);

      // Both mutations now safely settled
      expect(await dbClient.getPendingMutation(scope, 'mut-crash-1')).toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-crash-2')).toBeNull();

      tab2.destroy();
    });
  });
});
