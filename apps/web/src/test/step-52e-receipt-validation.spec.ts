import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
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
} from './harness/mock-sync-transport-harness';

describe('Web Step 5.2e Receipt Validation & Reconciler Integration Preflight', () => {
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

  async function seedReadySyncMeta(scope: string, checkpoint: string, minActive: string = '0'): Promise<void> {
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

  // ==========================================
  // 1. COUNT DIFFERENTIATION
  // ==========================================
  describe('1. Explicit Count Differentiation', () => {
    it('distinguishes dispatchedCount, appliedCount, deduplicatedCount, and rejectedCount', async () => {
      const scope = 'account:usr-counts';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      // 4 pending mutations
      const mutations = [
        { id: 'mut-c-applied', domain: SyncDomain.BOOKMARK, entityId: 'bm-app', op: SyncOperation.UPSERT },
        { id: 'mut-c-dedup', domain: SyncDomain.BOOKMARK, entityId: 'bm-dedup', op: SyncOperation.UPSERT },
        { id: 'mut-c-tomb', domain: SyncDomain.BOOKMARK, entityId: 'bm-tomb', op: SyncOperation.UPSERT },
        { id: 'mut-c-stale', domain: SyncDomain.BOOKMARK, entityId: 'bm-stale', op: SyncOperation.UPSERT },
      ];

      for (const m of mutations) {
        await queue.enqueue({
          ownerScope: scope,
          mutationId: m.id,
          clientId: 'client-1',
          domain: m.domain,
          entityId: m.entityId,
          operation: m.op,
          baseServerRevision: '10',
          payload: { storyId: m.id },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
      }

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns mixed results
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-c-applied', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-c-dedup', status: 'DEDUPLICATED', assignedRevision: '11' },
          { mutationId: 'mut-c-tomb', status: 'REJECTED_TOMBSTONE', assignedRevision: '11' },
          { mutationId: 'mut-c-stale', status: 'REJECTED_STALE', assignedRevision: '11' },
        ],
      });

      const result = await reconciler.pushPendingMutations();

      // Differentiated counts assertion
      expect(result.dispatchedCount).toBe(4);
      expect(result.appliedCount).toBe(1);
      expect(result.deduplicatedCount).toBe(1);
      expect(result.rejectedCount).toBe(2); // REJECTED_TOMBSTONE + REJECTED_STALE
      expect(result.transientRetryCount).toBe(0);

      // Verify pending store is completely cleared of all 4 mutations
      for (const m of mutations) {
        expect(await dbClient.getPendingMutation(scope, m.id)).toBeNull();
      }

      // Verify in-flight count is 0
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      tab.destroy();
    });
  });

  // ==========================================
  // 2. UNKNOWN MUTATION ID
  // ==========================================
  describe('2. Unknown mutationId in Receipt', () => {
    it('safely ignores unexpected mutationId without throwing, deleting wrong data, or dropping valid receipts', async () => {
      const scope = 'account:usr-unknown-receipt';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-valid-receipt',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-valid',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'valid' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns receipt for mut-valid-receipt AND an extra phantom mutationId
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-valid-receipt', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-unknown-phantom-999', status: 'APPLIED', assignedRevision: '12' },
        ],
      });

      const result = await reconciler.pushPendingMutations();

      expect(result.dispatchedCount).toBe(1);
      expect(result.appliedCount).toBe(1);
      expect(result.rejectedCount).toBe(0);

      // Valid mutation is settled and removed from pending
      expect(await dbClient.getPendingMutation(scope, 'mut-valid-receipt')).toBeNull();

      // Unknown mutation had zero effect
      expect(await dbClient.getPendingMutation(scope, 'mut-unknown-phantom-999')).toBeNull();

      tab.destroy();
    });
  });

  // ==========================================
  // 3. DUPLICATE RECEIPT
  // ==========================================
  describe('3. Duplicate Receipts in Single Response', () => {
    it('detects duplicate receipts as ambiguous, preserves pending mutation for retry, and applies idempotently on clean retry', async () => {
      const scope = 'account:usr-dup-receipt';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-dup-receipt',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-dup-receipt',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'dup-receipt-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Attempt 1: Server sends duplicate receipts for mut-dup-receipt
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-dup-receipt', status: 'APPLIED', assignedRevision: '11' },
          { mutationId: 'mut-dup-receipt', status: 'APPLIED', assignedRevision: '12' },
        ],
      });

      const res1 = await reconciler.pushPendingMutations();
      expect(res1.dispatchedCount).toBe(1);
      expect(res1.appliedCount).toBe(0);
      expect(res1.transientRetryCount).toBe(1);

      // Invariant: Pending mutation was NOT deleted! In-flight token is released.
      const pendingAfterDup = await dbClient.getPendingMutation(scope, 'mut-dup-receipt');
      expect(pendingAfterDup).not.toBeNull();
      expect(pendingAfterDup?.mutationId).toBe('mut-dup-receipt');
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Attempt 2: Server sends single valid receipt -> retries with same mutationId and settles idempotently
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-dup-receipt', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      const res2 = await reconciler.pushPendingMutations();
      expect(res2.dispatchedCount).toBe(1);
      expect(res2.appliedCount).toBe(1);
      expect(res2.transientRetryCount).toBe(0);

      // Now deleted from pending
      expect(await dbClient.getPendingMutation(scope, 'mut-dup-receipt')).toBeNull();

      tab.destroy();
    });
  });

  // ==========================================
  // 4. MISSING RECEIPT (PARTIAL RESPONSE)
  // ==========================================
  describe('4. Missing Receipt & Partial Response', () => {
    it('applies mutations with valid receipts, preserves pending for missing receipt, and retries missing mutation idempotently', async () => {
      const scope = 'account:usr-missing-receipt';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-has-receipt',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-has',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'has' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-missing-receipt',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-missing',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'missing' },
        createdAt: '2026-11-10T08:00:01.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Attempt 1: Server only returns receipt for mut-has-receipt (mut-missing-receipt is omitted)
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-has-receipt', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      const res1 = await reconciler.pushPendingMutations();
      expect(res1.dispatchedCount).toBe(2);
      expect(res1.appliedCount).toBe(1);
      expect(res1.transientRetryCount).toBe(1);

      // Invariant: mut-has-receipt is deleted, mut-missing-receipt is PRESERVED in pending store
      expect(await dbClient.getPendingMutation(scope, 'mut-has-receipt')).toBeNull();
      const stillPending = await dbClient.getPendingMutation(scope, 'mut-missing-receipt');
      expect(stillPending).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Attempt 2: mut-missing-receipt is retried
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-missing-receipt', status: 'APPLIED', assignedRevision: '12' },
        ],
      });

      const res2 = await reconciler.pushPendingMutations();
      expect(res2.dispatchedCount).toBe(1);
      expect(res2.appliedCount).toBe(1);

      // Both now completed
      expect(await dbClient.getPendingMutation(scope, 'mut-missing-receipt')).toBeNull();

      tab.destroy();
    });
  });

  // ==========================================
  // 5. INVALID STATUS
  // ==========================================
  describe('5. Invalid Receipt Status', () => {
    it('does NOT delete pending mutation when receipt has unknown/invalid status, releases in-flight token, and retries cleanly', async () => {
      const scope = 'account:usr-invalid-status';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-bad-status',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-bad-status',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bad-status' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Attempt 1: Server returns bogus/corrupt status
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-bad-status', status: 'BOGUS_CORRUPT_STATUS' as any, assignedRevision: '11' },
        ],
      });

      const res1 = await reconciler.pushPendingMutations();
      expect(res1.dispatchedCount).toBe(1);
      expect(res1.appliedCount).toBe(0);
      expect(res1.transientRetryCount).toBe(1);

      // Invariant: Pending mutation is preserved!
      const pendingAfterBadStatus = await dbClient.getPendingMutation(scope, 'mut-bad-status');
      expect(pendingAfterBadStatus).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Attempt 2: Server returns valid APPLIED status
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-bad-status', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      const res2 = await reconciler.pushPendingMutations();
      expect(res2.dispatchedCount).toBe(1);
      expect(res2.appliedCount).toBe(1);

      // Settled
      expect(await dbClient.getPendingMutation(scope, 'mut-bad-status')).toBeNull();

      tab.destroy();
    });
  });

  // ==========================================
  // 6. CONTRADICTORY REVISION
  // ==========================================
  describe('6. Contradictory Revision in Receipt', () => {
    it('does NOT delete pending mutation when APPLIED receipt has assignedRevision < baseServerRevision or non-decimal string', async () => {
      const scope = 'account:usr-contra-rev';
      await seedReadySyncMeta(scope, '20', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-contra-rev',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-contra',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '20',
        payload: { storyId: 'contra' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Attempt 1: Server says APPLIED but assignedRevision is '15' (< baseServerRevision '20'!)
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-contra-rev', status: 'APPLIED', assignedRevision: '15' },
        ],
      });

      const res1 = await reconciler.pushPendingMutations();
      expect(res1.dispatchedCount).toBe(1);
      expect(res1.appliedCount).toBe(0);
      expect(res1.transientRetryCount).toBe(1);

      // Invariant: Contradictory revision rejected fail-closed, pending preserved
      expect(await dbClient.getPendingMutation(scope, 'mut-contra-rev')).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);

      // Attempt 2: Server returns non-decimal revision "invalid-rev"
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-contra-rev', status: 'APPLIED', assignedRevision: 'invalid-rev' },
        ],
      });

      const res2 = await reconciler.pushPendingMutations();
      expect(res2.appliedCount).toBe(0);
      expect(res2.transientRetryCount).toBe(1);
      expect(await dbClient.getPendingMutation(scope, 'mut-contra-rev')).not.toBeNull();

      // Attempt 3: Server returns monotonically valid assignedRevision '25'
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-contra-rev', status: 'APPLIED', assignedRevision: '25' },
        ],
      });

      const res3 = await reconciler.pushPendingMutations();
      expect(res3.appliedCount).toBe(1);
      expect(await dbClient.getPendingMutation(scope, 'mut-contra-rev')).toBeNull();

      tab.destroy();
    });
  });

  // ==========================================
  // 7. SCOPE CHANGE OR REVOCATION BEFORE COMMIT
  // ==========================================
  describe('7. Scope Change / Authority Revocation Before Commit', () => {
    it('aborts settlement fail-closed when account is switched before results are committed, preserving pending in both accounts', async () => {
      const scopeA = 'account:usr-commit-race-a';
      const scopeB = 'account:usr-commit-race-b';
      await seedReadySyncMeta(scopeA, '10', '0');
      await seedReadySyncMeta(scopeB, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-commit-race',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-race',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'race-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-1',
        lockManager,
      });
      tab.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
      });

      // Server returns 200 OK with valid receipt
      transportServer.queueBatchResponse({
        results: [
          { mutationId: 'mut-commit-race', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      // Simulate scope switch right before processServerBatchResults runs
      const res = await reconciler.pushPendingMutations({
        _testHookBeforeProcessResults: async () => {
          // User switches to Account B!
          queue.setActiveScope(scopeB);
          reconciler.setScope(scopeB);
        },
      });

      // Result was dropped, 0 applied
      expect(res.appliedCount).toBe(0);

      // Invariant: ZERO mutations written into Scope B
      expect(await dbClient.getPendingMutation(scopeB, 'mut-commit-race')).toBeNull();

      // Invariant: Scope A's pending mutation was NOT deleted!
      expect(await dbClient.getPendingMutation(scopeA, 'mut-commit-race')).not.toBeNull();

      tab.destroy();
    });

    it('aborts settlement fail-closed when leader lock is revoked before results are committed', async () => {
      const scope = 'account:usr-leader-drop-commit';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        initialBackoffMs: 0,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-leader-drop',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-leader-drop',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'leader-drop-data' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
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
          { mutationId: 'mut-leader-drop', status: 'APPLIED', assignedRevision: '11' },
        ],
      });

      // Leader revoked right before commit
      const res = await reconciler.pushPendingMutations({
        _testHookBeforeProcessResults: async () => {
          tab.destroy();
        },
      });

      expect(res.appliedCount).toBe(0);

      // Invariant: Pending mutation was NOT deleted!
      expect(await dbClient.getPendingMutation(scope, 'mut-leader-drop')).not.toBeNull();
      expect((await queue.getStatus()).inFlightCount).toBe(0);
    });
  });
});
