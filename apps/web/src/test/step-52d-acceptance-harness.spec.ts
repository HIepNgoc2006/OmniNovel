import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  ClientMutation,
  SyncChangeItem,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  LocalSyncMeta,
  LocalPendingMutation,
  CheckpointConflictError,
  ReadyStatusTransitionForbiddenError,
  GLOBAL_HISTORY_SENTINEL,
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
  assertValidAccountScope,
  admitPreparedBatchPreDispatchAtomic,
} from './harness/mock-sync-transport-harness';
import {
  WIRE_GLOBAL_HISTORY_ENTITY_ID,
  createSixDomainSnapshotPagesFixture,
  createDeltaChangesPageFixture,
  createProduction410Response,
  createProposedB1410Response,
  createProduction409Response,
  createProposedB2409Response,
} from './fixtures/step-52d-contract-fixtures';

describe('Web Step 5.2d Mock-Only Acceptance Harness & Contract Corrections', () => {
  let dbClient: IndexedDbClient;
  let lockManager: InMemoryLockManager;
  let transportServer: MockSyncTransportServer;

  beforeEach(async () => {
    // Reset fakeIndexedDB
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    dbClient = new IndexedDbClient();
    lockManager = new InMemoryLockManager();
    transportServer = new MockSyncTransportServer();
  });

  afterEach(() => {
    dbClient.close();
    vi.restoreAllMocks();
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
        authoritativeBaselineStatus: 'READY',
      } as LocalSyncMeta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ==========================================
  // SUITE 1: TAB LEADER & SCOPE ADMISSION
  // ==========================================
  describe('1. Tab Leader & Scope Admission Invariants', () => {
    it('accepts valid account scope and rejects guest:* scope fail-closed', () => {
      expect(() => assertValidAccountScope('account:usr-valid-123')).not.toThrow();
      expect(() => assertValidAccountScope('guest:anon-456')).toThrow(/ACCOUNT_SCOPE_REQUIRED/);
      expect(() => assertValidAccountScope('')).toThrow(/ACCOUNT_SCOPE_REQUIRED/);
    });

    it('enforces Web Locks leader authority: follower tab cannot pull or push', async () => {
      const scope = 'account:usr-lead-1';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      const leaderTab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-leader',
        lockManager,
      });
      leaderTab.start();
      await new Promise((r) => setTimeout(r, 10));

      const followerTab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-follower',
        lockManager,
      });
      followerTab.start();
      await new Promise((r) => setTimeout(r, 10));

      expect(leaderTab.getState().isLeader).toBe(true);
      expect(followerTab.getState().isLeader).toBe(false);

      const followerReconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: followerTab,
        server: transportServer,
      });

      await expect(followerReconciler.pullDeltaChanges()).rejects.toThrow(ScopeAuthorityError);
      await expect(followerReconciler.pushPendingMutations()).rejects.toThrow(ScopeAuthorityError);

      leaderTab.destroy();
      followerTab.destroy();
    });

    it('leader revocation before HTTP dispatch prevents wire request and preserves pending mutations', async () => {
      const scope = 'account:usr-lead-rev-before';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-rev-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-rev-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-rev-1' },
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

      // Revoke leader right before dispatch
      tab.destroy();

      await expect(reconciler.pushPendingMutations()).rejects.toThrow(ScopeAuthorityError);
      expect(transportServer.dispatchedBatches).toHaveLength(0);

      // Pending mutation remains safely in IDB
      expect(await dbClient.getPendingMutation(scope, 'mut-rev-1')).not.toBeNull();
    });

    it('leader revocation while GET response is in-flight drops delta page and avoids IDB commit', async () => {
      const scope = 'account:usr-rev-inflight-get';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
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

      // Revoke leader when GET response is in-flight
      transportServer.interceptInFlight = async () => {
        tab.destroy();
      };

      transportServer.queueChangesResponse({
        currentServerRevision: '11',
        minActiveRevision: '1',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '11',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-dropped',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-dropped', title: 'Should Not Commit' },
            createdAt: '2026-11-10T08:00:00.000Z',
          },
        ],
      });

      await expect(reconciler.pullDeltaChanges()).rejects.toThrow(ScopeAuthorityError);

      // Invariant: Checkpoint remained at 10, bookmark was NOT committed
      const metaAfter = await dbClient.getSyncMeta(scope);
      expect(metaAfter?.lastSyncedServerRevision).toBe('10');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-dropped')).toBeNull();
    });
  });

  // ==========================================
  // SUITE 2: DELTA PAGINATION & REVISION ORDERING
  // ==========================================
  describe('2. Delta Pagination & Revision Ordering', () => {
    it('ingests multiple delta pages sequentially and updates checkpoint monotonically', async () => {
      const scope = 'account:usr-paginated';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
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

      // Page 1: rev 12, hasMore=true, nextRevision=12
      transportServer.queueChangesResponse({
        currentServerRevision: '15',
        minActiveRevision: '1',
        nextRevision: '12',
        hasMore: true,
        changes: [
          {
            revision: '12',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-p1',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-p1', title: 'Page 1' },
            createdAt: '2026-11-10T08:00:00.000Z',
          },
        ],
      });

      // Page 2: rev 13-15, hasMore=false, nextRevision=null
      transportServer.queueChangesResponse({
        currentServerRevision: '15',
        minActiveRevision: '1',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '15',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-p2',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-p2', title: 'Page 2' },
            createdAt: '2026-11-10T08:01:00.000Z',
          },
        ],
      });

      const res = await reconciler.pullDeltaChanges({ limit: 1 });
      expect(res.appliedPages).toBe(2);

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('15');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-p1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-p2')).not.toBeNull();

      tab.destroy();
    });

    it('throws CheckpointConflictError when expectedCheckpoint mismatches actual checkpoint in IDB', async () => {
      const scope = 'account:usr-occ-conflict';
      await seedReadySyncMeta(scope, '100', '50');

      // Attempting to ingest delta page with expectedCheckpoint 90 when DB has 100
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '90', // Mismatch!
          page: {
            currentServerRevision: '105',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [],
          },
        })
      ).rejects.toThrow(CheckpointConflictError);
    });

    it('handles 64-bit BigInt revisions exceeding Number.MAX_SAFE_INTEGER seamlessly', async () => {
      const scope = 'account:usr-bigint-rev';
      const hugeRev1 = '9007199254740995'; // MAX_SAFE_INTEGER + 4
      const hugeRev2 = '9007199254740996';
      await seedReadySyncMeta(scope, hugeRev1, '9007199254740000');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
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

      transportServer.queueChangesResponse({
        currentServerRevision: hugeRev2,
        minActiveRevision: '9007199254740000',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: hugeRev2,
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-huge',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-huge', title: 'Huge Revision' },
            createdAt: '2026-11-10T08:00:00.000Z',
          },
        ],
      });

      const res = await reconciler.pullDeltaChanges();
      expect(res.appliedPages).toBe(1);

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe(hugeRev2);

      tab.destroy();
    });

    it('server CONFLICT_MERGED settles pending mutation with receipt and requires authoritative delta reconciliation', async () => {
      const scope = 'account:usr-conflict-merged';
      await seedReadySyncMeta(scope, '10');

      let deltaReconciliationTriggered = false;
      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
        onAuthoritativeDeltaPullRequired: async () => {
          deltaReconciliationTriggered = true;
        },
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-conflict-merge-1',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-conf',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-conf' },
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
        results: [{ mutationId: 'mut-conflict-merge-1', status: 'CONFLICT_MERGED', assignedRevision: '20' }],
      });

      await reconciler.pushPendingMutations();

      // Settled with terminal receipt
      expect(await dbClient.getPendingMutation(scope, 'mut-conflict-merge-1')).toBeNull();
      const receipt = await dbClient.getMutationTerminalReceipt(scope, 'mut-conflict-merge-1');
      expect(receipt?.status).toBe('CONFLICT_MERGED');
      expect(deltaReconciliationTriggered).toBe(true);

      tab.destroy();
    });
  });

  // ==========================================
  // SUITE 3: TASK A — ATOMIC PRE-DISPATCH ADMISSION
  // ==========================================
  describe('3. Task A — Atomic Pre-Dispatch Admission', () => {
    it('reproduces non-atomic vulnerability: separate transactions with failure injection leave state inconsistent', async () => {
      const scope = 'account:usr-vuln-race';
      await seedReadySyncMeta(scope, '10', '50');

      const rawDb = await dbClient.getDatabase();
      // Put a pending mutation directly
      await new Promise<void>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).put({
          ownerScope: scope,
          mutationId: 'mut-vuln-1',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'bm-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10', // stale because 10 < 50
          payload: { storyId: 'bm-1', title: 'Vulnerable' },
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Simulate non-atomic sequence:
      // Step 1: Read syncMeta (Transaction 1)
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.minActiveRevision).toBe('50');

      // Step 2: Separate Transaction 2 writes quarantine, but simulate crash before step 3 can complete
      let step2Committed = false;
      await new Promise<void>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_QUARANTINED_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_QUARANTINED_MUTATIONS).put({
          ownerScope: scope,
          mutationId: 'mut-vuln-1',
          clientId: 'client-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'bm-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '10',
          payload: { storyId: 'bm-1', title: 'Vulnerable' },
          rejectionReason: 'WATERMARK_ADVANCED_PRE_DISPATCH',
          rejectionStatus: 'REJECTED_STALE',
          rejectedAt: new Date().toISOString(),
          triageStatus: 'PENDING',
          originalCreatedAt: new Date().toISOString(),
        });
        tx.oncomplete = () => {
          step2Committed = true;
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
      expect(step2Committed).toBe(true);

      // Crash / failure happens here BEFORE deletePendingMutation can run!
      // Proof of inconsistency in non-atomic approach:
      const inPending = await dbClient.getPendingMutation(scope, 'mut-vuln-1');
      const inQuarantine = await dbClient.getQuarantinedMutation(scope, 'mut-vuln-1');
      // In non-atomic approach: Mutation exists in BOTH stores simultaneously!
      expect(inPending).not.toBeNull();
      expect(inQuarantine).not.toBeNull();
    });

    it('atomic admission: SINGLE IDB readwrite transaction rolls back cleanly on failure injection, preserving original payload and mutationId in pending', async () => {
      const scope = 'account:usr-atomic-rollback';
      await seedReadySyncMeta(scope, '10', '50');

      const rawDb = await dbClient.getDatabase();
      const originalPayload = { storyId: 'bm-rollback', title: 'Critical Offline Draft' };
      const originalMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-atom-rb',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-rollback',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10', // stale: 10 < 50
        payload: originalPayload,
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      };

      await new Promise<void>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).put(originalMutation);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Execute admitPreparedBatchPreDispatchAtomic with deterministic failure injection right before commit
      await expect(
        admitPreparedBatchPreDispatchAtomic({
          ownerScope: scope,
          batchMutations: [originalMutation],
          dbClient,
          _testHookBeforeCommit: (tx) => {
            // Injected failure: abort transaction
            tx.abort();
          },
        })
      ).rejects.toThrow();

      // Invariant Verification: Transaction rolled back completely!
      // 1. Original pending mutation is 100% intact with original payload and mutationId
      const pendingAfterRollback = await dbClient.getPendingMutation(scope, 'mut-atom-rb');
      expect(pendingAfterRollback).not.toBeNull();
      expect(pendingAfterRollback?.mutationId).toBe('mut-atom-rb');
      expect(pendingAfterRollback?.payload).toEqual(originalPayload);
      expect(pendingAfterRollback?.baseServerRevision).toBe('10');

      // 2. Quarantine store has NO record
      const quarantinedAfterRollback = await dbClient.getQuarantinedMutation(scope, 'mut-atom-rb');
      expect(quarantinedAfterRollback).toBeNull();
    });

    it('atomic admission: successfully commits stale quarantine and pending deletion in one atomic transaction', async () => {
      const scope = 'account:usr-atomic-success';
      await seedReadySyncMeta(scope, '10', '50');

      const originalPayload = { storyId: 'bm-success', title: 'Saved Title' };
      const originalMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-atom-ok',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-success',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10', // 10 < 50 -> stale
        payload: originalPayload,
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      };

      const rawDb = await dbClient.getDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).put(originalMutation);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const res = await admitPreparedBatchPreDispatchAtomic({
        ownerScope: scope,
        batchMutations: [originalMutation],
        dbClient,
      });

      expect(res.eligibleMutations).toHaveLength(0);
      expect(res.quarantinedStaleMutations).toHaveLength(1);

      // Removed from pending
      expect(await dbClient.getPendingMutation(scope, 'mut-atom-ok')).toBeNull();

      // Preserved in quarantine with PENDING triage and full payload
      const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-atom-ok');
      expect(quarantined).not.toBeNull();
      expect(quarantined?.rejectionStatus).toBe('REJECTED_STALE');
      expect(quarantined?.triageStatus).toBe('PENDING');
      expect(quarantined?.payload).toEqual(originalPayload);
    });
  });

  // ==========================================
  // SUITE 4: TASK B — CROSS-SCOPE LEADER BINDING
  // ==========================================
  describe('4. Task B — Cross-Scope Leader Binding', () => {
    it('scope mismatch before dispatch: scope switched A -> B while leader lock still held for A; throws ScopeAuthorityError', async () => {
      const scopeA = 'account:usr-scope-a';
      const scopeB = 'account:usr-scope-b';
      await seedReadySyncMeta(scopeA, '10');
      await seedReadySyncMeta(scopeB, '10');

      const queueA = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });

      const tabA = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-scope',
        lockManager,
      });
      tabA.start();
      await new Promise((r) => setTimeout(r, 10));
      expect(tabA.getState().isLeader).toBe(true);
      expect(tabA.getState().ownerScope).toBe(scopeA);

      // Reconciler is initialized with scopeA, but someone switches reconciler scope to scopeB without updating tabLeader lock
      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queueA,
        tabLeader: tabA,
        server: transportServer,
      });

      reconciler.setScope(scopeB); // Reconciler scope is now scopeB, but tabA owns lock for scopeA

      // Attempting dispatch throws ScopeAuthorityError fail-closed
      await expect(reconciler.pushPendingMutations()).rejects.toThrow(ScopeAuthorityError);
      await expect(reconciler.pullDeltaChanges()).rejects.toThrow(ScopeAuthorityError);

      expect(transportServer.dispatchedBatches).toHaveLength(0);
      tabA.destroy();
    });

    it('scope switch during HTTP request in-flight: response for A is dropped; zero writes into B', async () => {
      const scopeA = 'account:usr-scope-inflight-a';
      const scopeB = 'account:usr-scope-inflight-b';
      await seedReadySyncMeta(scopeA, '10');
      await seedReadySyncMeta(scopeB, '10');

      const queueA = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });

      await queueA.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-a-1',
        clientId: 'client-a',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-a-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-a-1', title: 'Scope A Story' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tabA = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-scope-ab',
        lockManager,
      });
      tabA.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queueA,
        tabLeader: tabA,
        server: transportServer,
      });

      // Hook during in-flight: simulate switching user account to B
      transportServer.interceptInFlight = async () => {
        reconciler.setScope(scopeB);
      };

      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-a-1', status: 'APPLIED', assignedRevision: '11' }],
      });

      const res = await reconciler.pushPendingMutations();
      expect(res.pushedCount).toBe(0);

      // Invariant: Because scope switched mid-flight, response was dropped!
      // Account A's pending mutation is preserved in queue (released, not settled with wrong scope)
      const pendingA = await dbClient.getPendingMutation(scopeA, 'mut-a-1');
      expect(pendingA).not.toBeNull();

      // Account B has zero mutations or receipts
      expect(await dbClient.getPendingMutation(scopeB, 'mut-a-1')).toBeNull();
      expect(await dbClient.getMutationTerminalReceipt(scopeB, 'mut-a-1')).toBeNull();

      tabA.destroy();
    });

    it('scope switch during receipt settlement boundary: drops settlement; zero writes into B with authority granted for A', async () => {
      const scopeA = 'account:usr-scope-settle-a';
      const scopeB = 'account:usr-scope-settle-b';
      await seedReadySyncMeta(scopeA, '10');
      await seedReadySyncMeta(scopeB, '10');

      const queueA = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });

      await queueA.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-settle-1',
        clientId: 'client-a',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-settle-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-settle-1', title: 'Settlement Boundary' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tabA = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-settle',
        lockManager,
      });
      tabA.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queueA,
        tabLeader: tabA,
        server: transportServer,
      });

      // Server returns response successfully
      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-settle-1', status: 'APPLIED', assignedRevision: '11' }],
      });

      // Right after response arrived from simulatePostMutations, switch reconciler scope before settlement commit
      const origSimulate = transportServer.simulatePostMutations.bind(transportServer);
      transportServer.simulatePostMutations = async (scope, body, headers) => {
        const res = await origSimulate(scope, body, headers);
        // Scope switched right as response returns
        reconciler.setScope(scopeB);
        return res;
      };

      const pushRes = await reconciler.pushPendingMutations();
      expect(pushRes.pushedCount).toBe(0);

      // Receipt is NOT written into B or A with mismatched authority
      expect(await dbClient.getMutationTerminalReceipt(scopeB, 'mut-settle-1')).toBeNull();
      // Original mutation remains safe in A's pending store
      expect(await dbClient.getPendingMutation(scopeA, 'mut-settle-1')).not.toBeNull();

      tabA.destroy();
    });

    it('preserves pending data for both Account A and Account B independently', async () => {
      const scopeA = 'account:usr-iso-a';
      const scopeB = 'account:usr-iso-b';
      await seedReadySyncMeta(scopeA, '10');
      await seedReadySyncMeta(scopeB, '10');

      const queueA = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });
      const queueB = new MutationQueue({
        ownerScope: scopeB,
        identityStateProvider: createStaticIdentityProvider(scopeB),
        dbClient,
      });

      await queueA.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-shared-id',
        clientId: 'client-a',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-a',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-a', user: 'Alice' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      await queueB.enqueue({
        ownerScope: scopeB,
        mutationId: 'mut-shared-id', // Same mutationId in different account scope
        clientId: 'client-b',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-b',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-b', user: 'Bob' },
        createdAt: '2026-11-10T08:01:00.000Z',
        retryCount: 0,
      });

      const itemA = await dbClient.getPendingMutation(scopeA, 'mut-shared-id');
      const itemB = await dbClient.getPendingMutation(scopeB, 'mut-shared-id');

      expect(itemA?.payload).toEqual({ storyId: 'bm-a', user: 'Alice' });
      expect(itemB?.payload).toEqual({ storyId: 'bm-b', user: 'Bob' });
    });
  });

  // ==========================================
  // SUITE 5: TASK C — IMMUTABLE WIRE PAYLOAD
  // ==========================================
  describe('5. Task C — Immutable Wire Payload', () => {
    it('prohibits just-in-time rewriting of legacy HISTORY entityId="all"; quarantines legacy mutation without silent morphing', async () => {
      const scope = 'account:usr-legacy-history';
      await seedReadySyncMeta(scope, '10', '0');

      const rawDb = await dbClient.getDatabase();
      // Inject pre-existing legacy mutation with entityId = 'all' into pending_mutations
      await new Promise<void>((resolve, reject) => {
        const tx = rawDb.transaction(STORE_PENDING_MUTATIONS, 'readwrite');
        tx.objectStore(STORE_PENDING_MUTATIONS).put({
          ownerScope: scope,
          mutationId: 'mut-legacy-all',
          clientId: 'client-legacy',
          domain: SyncDomain.HISTORY,
          entityId: 'all', // Legacy non-canonical entityId
          operation: SyncOperation.DELETE,
          baseServerRevision: '10',
          payload: { timestamp: '2026-11-09T00:00:00.000Z' },
          createdAt: '2026-11-09T00:00:00.000Z',
          retryCount: 0,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-legacy',
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

      const res = await reconciler.pushPendingMutations();
      expect(res.pushedCount).toBe(0);
      expect(res.quarantinedLegacyCount).toBe(1);

      // Invariant: ZERO network requests sent with rewritten payload
      expect(transportServer.dispatchedBatches).toHaveLength(0);

      // Legacy mutation is quarantined with explicit reason, preserving user payload
      const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-legacy-all');
      expect(quarantined).not.toBeNull();
      expect(quarantined?.rejectionReason).toBe('LEGACY_ENTITY_ID_REWRITE_PROHIBITED');
      expect(quarantined?.rejectionStatus).toBe('MANUAL');
      expect(quarantined?.entityId).toBe('all'); // Not mutated!

      tab.destroy();
    });

    it('canonical fresh HISTORY mutations use UUID sentinel before enqueue and are sent byte-for-byte immutable', async () => {
      const scope = 'account:usr-fresh-history';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      // Canonical fresh mutation must use WIRE_GLOBAL_HISTORY_ENTITY_ID (UUID sentinel)
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-canonical-hist',
        clientId: 'client-fresh',
        domain: SyncDomain.HISTORY,
        entityId: WIRE_GLOBAL_HISTORY_ENTITY_ID,
        operation: SyncOperation.DELETE,
        baseServerRevision: '10',
        payload: { clearTimestamp: '2026-11-10T08:00:00.000Z' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-canonical',
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
        results: [{ mutationId: 'mut-canonical-hist', status: 'APPLIED', assignedRevision: '11' }],
      });

      const res = await reconciler.pushPendingMutations();
      expect(res.pushedCount).toBe(1);

      const dispatched = transportServer.dispatchedBatches[0].body.mutations[0];
      expect(dispatched.entityId).toBe('00000000-0000-0000-0000-000000000000');
      expect(dispatched.mutationId).toBe('mut-canonical-hist');
      expect(dispatched.baseServerRevision).toBe('10');

      tab.destroy();
    });

    it('asserts exact unchanged clientId, mutationId, baseServerRevision, entityId and payload across retries', async () => {
      const scope = 'account:usr-wire-immutability';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      const originalPayload = { storyId: 'story-exact', note: 'Immutable Note' };
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-exact-1',
        clientId: 'client-exact',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-exact',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: originalPayload,
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-exact',
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

      // Dispatch 1: Fails with network timeout
      transportServer.queueBatchResponse(new Error('TIMEOUT'));
      await expect(reconciler.pushPendingMutations()).rejects.toThrow('TIMEOUT');

      // Dispatch 2: Retries after network recovery
      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-exact-1', status: 'APPLIED', assignedRevision: '12' }],
      });
      await reconciler.pushPendingMutations();

      expect(transportServer.dispatchedBatches).toHaveLength(2);
      const attempt1 = transportServer.dispatchedBatches[0].body.mutations[0];
      const attempt2 = transportServer.dispatchedBatches[1].body.mutations[0];

      // Exact byte-for-byte equality across retries
      expect(attempt1.clientId).toBe(attempt2.clientId);
      expect(attempt1.mutationId).toBe(attempt2.mutationId);
      expect(attempt1.baseServerRevision).toBe(attempt2.baseServerRevision);
      expect(attempt1.entityId).toBe(attempt2.entityId);
      expect(attempt1.payload).toEqual(attempt2.payload);

      tab.destroy();
    });
  });

  // ==========================================
  // SUITE 6: TASK D — UNKNOWN OUTCOME & TOMBSTONE INTENT
  // ==========================================
  describe('6. Task D — Unknown Outcome & Tombstone Intent', () => {
    it('recovers from unknown outcome after destroying reconciler 1: tab 2 acquires lock and retries original mutationId from IndexedDB', async () => {
      const scope = 'account:usr-multi-tab-recovery';
      await seedReadySyncMeta(scope, '10', '0');

      const queue1 = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue1.enqueue({
        ownerScope: scope,
        mutationId: 'mut-durable-rec',
        clientId: 'client-persistent',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-durable',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-durable', note: 'Must Survive Crash' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab1 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));

      let reconciler1: MockStep52dReconciler | null = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue1,
        tabLeader: tab1,
        server: transportServer,
      });

      // Tab 1 dispatches POST, but network drops before response arrives
      transportServer.queueBatchResponse(new Error('NETWORK_TIMEOUT'));
      await expect(reconciler1.pushPendingMutations()).rejects.toThrow('NETWORK_TIMEOUT');

      // Crash Tab 1: Destroy reconciler1 and tab1 leader election instance
      tab1.destroy();
      reconciler1 = null;

      // Tab 2 starts up fresh: It has NO in-memory state of Tab 1!
      const tab2 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-2',
        lockManager,
      });
      tab2.start();
      await new Promise((r) => setTimeout(r, 10));
      expect(tab2.getState().isLeader).toBe(true);

      const queue2 = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      const reconciler2 = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue2,
        tabLeader: tab2,
        server: transportServer,
      });

      // Tab 2 reads IndexedDB durable STORE_PENDING_MUTATIONS
      // Server recognizes identical (clientId, mutationId, payloadHash) and returns DEDUPLICATED
      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-durable-rec', status: 'DEDUPLICATED', assignedRevision: '15' }],
      });

      const res2 = await reconciler2.pushPendingMutations();
      expect(res2.pushedCount).toBe(1);

      // Pending mutation is settled
      expect(await dbClient.getPendingMutation(scope, 'mut-durable-rec')).toBeNull();
      const receipt = await dbClient.getMutationTerminalReceipt(scope, 'mut-durable-rec');
      expect(receipt?.status).toBe('DEDUPLICATED');

      tab2.destroy();
    });

    it('server REJECTED_TOMBSTONE intent analysis: terminal receipt is recorded, but user intent was rejected/evicted, NOT applied', async () => {
      const scope = 'account:usr-tomb-intent';
      await seedReadySyncMeta(scope, '10', '0');

      // User had local bookmark replica
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-tomb',
        title: 'User Unsaved Edit',
        createdAt: '2026-11-10T08:00:00.000Z',
      });

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-tomb-intent',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-tomb', title: 'User Unsaved Edit' },
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
          {
            mutationId: 'mut-tomb-intent',
            status: 'REJECTED_TOMBSTONE',
            assignedRevision: null,
            reason: 'ENTITY_ALREADY_TOMBSTONED',
          },
        ],
      });

      await reconciler.pushPendingMutations();

      // 1. Pending mutation is removed
      expect(await dbClient.getPendingMutation(scope, 'mut-tomb-intent')).toBeNull();

      // 2. Local replica is evicted
      expect(await dbClient.getBookmark(scope, 'story-tomb')).toBeNull();

      // 3. Terminal receipt is durable in sync_meta
      const receipt = await dbClient.getMutationTerminalReceipt(scope, 'mut-tomb-intent');
      expect(receipt).not.toBeNull();
      expect(receipt?.status).toBe('REJECTED_TOMBSTONE');

      // 4. Critical Invariant: Terminal receipt proves server rejection, NOT voluntary user discard!
      expect(receipt?.status).not.toBe('APPLIED');

      tab.destroy();
    });
  });

  // ==========================================
  // SUITE 7: TASK E — WIRE ERROR FIXTURES
  // ==========================================
  describe('7. Task E — Wire Error Fixtures & Compatibility', () => {
    it('handles present production GlobalExceptionFilter HTTP 410 (without metadata in error envelope)', async () => {
      const scope = 'account:usr-prod-410';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
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

      // Production 410 response: Only code, message, requestId, timestamp (minActiveRevision stripped by GlobalExceptionFilter)
      const prod410 = createProduction410Response();
      transportServer.queueChangesResponse(prod410 as any);

      const res = await reconciler.pullDeltaChanges();
      expect(res.needsBootstrap).toBe(true);
      expect(reconciler.needsBootstrap).toBe(true);
      expect(reconciler.bootstrapReason).toBe('SYNC_REVISION_EXPIRED');

      // Invariant: Checkpoint is NOT erased on 410!
      const metaAfter = await dbClient.getSyncMeta(scope);
      expect(metaAfter?.lastSyncedServerRevision).toBe('10');

      tab.destroy();
    });

    it('handles proposed B1 HTTP 410 (with minActiveRevision & currentServerRevision under error.meta)', async () => {
      const scope = 'account:usr-b1-410';
      await seedReadySyncMeta(scope, '10', '0');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
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

      const b1Response = createProposedB1410Response({
        minActiveRevision: '50',
        currentServerRevision: '120',
      });
      transportServer.queueChangesResponse(b1Response as any);

      const res = await reconciler.pullDeltaChanges();
      expect(res.needsBootstrap).toBe(true);
      expect(reconciler.needsBootstrap).toBe(true);
      expect(reconciler.bootstrapReason).toBe('SYNC_REVISION_EXPIRED');

      tab.destroy();
    });

    it('validates present production vs proposed B2 409 SNAPSHOT_INVALIDATED fixtures', () => {
      const prod409 = createProduction409Response();
      expect(prod409.httpStatus).toBe(409);
      expect(prod409.body.error.code).toBe('SNAPSHOT_INVALIDATED');
      expect((prod409.body.error as any).meta).toBeUndefined();

      const b2409 = createProposedB2409Response({
        reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED',
        currentServerRevision: '25',
        minActiveRevision: '5',
        cursorRevision: '15',
      });
      expect(b2409.httpStatus).toBe(409);
      expect(b2409.body.error.code).toBe('SNAPSHOT_INVALIDATED');
      expect(b2409.body.error.meta?.reason).toBe('CURSOR_WATERMARK_UPGRADE_REQUIRED');
      expect(b2409.body.error.meta?.currentServerRevision).toBe('25');
    });

    it('confirms READY-last invariant: Step 5.2d NEVER transitions baseline to READY; locked in DAL', async () => {
      const scope = 'account:usr-ready-lock-check';

      // Step 5.2d DAL explicitly locks direct transition to READY
      await expect(dbClient.setAuthoritativeBaselineStatus(scope, 'READY')).rejects.toThrow(
        ReadyStatusTransitionForbiddenError
      );

      // Callers can only set BOOTSTRAPPING or UNINITIALIZED in Step 5.2
      await dbClient.setAuthoritativeBaselineStatus(scope, 'BOOTSTRAPPING');
      expect(await dbClient.getAuthoritativeBaselineStatus(scope)).toBe('BOOTSTRAPPING');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);
    });

    it('validates six-domain snapshot paginated fixture structure and cursor progression', () => {
      const pages = createSixDomainSnapshotPagesFixture({ snapshotRevision: '15', minActiveRevision: '1' });
      expect(pages).toHaveLength(5);

      const decodeCursor = (cursor: string | null) =>
        cursor ? Buffer.from(cursor.replace('cur_hmac_v1_', ''), 'base64url').toString() : null;

      expect(pages[0].data.bookmarks).toHaveLength(2);
      expect(pages[0].hasMore).toBe(true);
      expect(decodeCursor(pages[0].nextCursor)).toContain('PREFERENCE');

      expect(pages[1].data.preferences).toHaveLength(1);
      expect(pages[1].hasMore).toBe(true);
      expect(decodeCursor(pages[1].nextCursor)).toContain('HISTORY_TOMBSTONE');

      expect(pages[2].data.historyEpochs).toHaveLength(3);
      expect(pages[2].globalHistoryEpoch).toBe(3);
      expect(pages[2].hasMore).toBe(true);

      expect(pages[3].data.tombstones).toHaveLength(2);
      expect(BigInt(pages[3].data.tombstones[0].deletedAtRevision)).toBeGreaterThanOrEqual(1n);

      expect(pages[4].hasMore).toBe(false);
      expect(pages[4].nextCursor).toBeNull();
    });
  });
});
