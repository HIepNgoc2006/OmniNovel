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
  assertValidAccountScope,
} from './harness/mock-sync-transport-harness';
import {
  WIRE_GLOBAL_HISTORY_ENTITY_ID,
  createSixDomainSnapshotPagesFixture,
  createDeltaChangesPageFixture,
  WireSyncRevisionExpiredErrorResponse,
  WireSnapshotInvalidatedErrorResponse,
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

      // Tab 1 becomes leader
      const tab1 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
      });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));
      expect(tab1.getState().isLeader).toBe(true);

      // Tab 2 starts on same scope and is follower
      const tab2 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-2',
        lockManager,
      });
      tab2.start();
      await new Promise((r) => setTimeout(r, 10));
      expect(tab2.getState().isLeader).toBe(false);

      const reconcilerFollower = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab2,
        server: transportServer,
      });

      // Follower attempt to pull must fail immediately
      await expect(reconcilerFollower.pullDeltaChanges()).rejects.toThrow(/LEADER_REVOKED/);
      // Follower attempt to push must fail immediately
      await expect(reconcilerFollower.pushPendingMutations()).rejects.toThrow(/LEADER_REVOKED/);
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
        mutationId: 'mut-rev-before-1',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-1' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      let abortSignal: AbortSignal | null = null;
      const tab1 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
        onRoleChange: (_role, sig) => {
          abortSignal = sig;
        },
      });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab1,
        server: transportServer,
      });

      // Revoke leader before dispatch
      tab1.stepDown();

      await expect(
        reconciler.pushPendingMutations({ leaderSignal: abortSignal ?? undefined })
      ).rejects.toThrow(/LEADER_REVOKED/);

      // Verify ZERO network requests were sent
      expect(transportServer.dispatchedBatches).toHaveLength(0);
      // Verify pending mutation is still intact in IndexedDB
      expect(await dbClient.getPendingMutation(scope, 'mut-rev-before-1')).not.toBeNull();
    });

    it('leader revocation while GET response is in-flight drops response and preserves checkpoint', async () => {
      const scope = 'account:usr-lead-rev-inflight';
      await seedReadySyncMeta(scope, '10');

      let abortSignal: AbortSignal | null = null;
      const tab1 = new TabLeaderElection({
        ownerScope: scope,
        tabId: 'tab-1',
        lockManager,
        onRoleChange: (_role, sig) => {
          abortSignal = sig;
        },
      });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: new MutationQueue({
          ownerScope: scope,
          identityStateProvider: createStaticIdentityProvider(scope),
          dbClient,
        }),
        tabLeader: tab1,
        server: transportServer,
      });

      transportServer.queueChangesResponse(
        createDeltaChangesPageFixture({
          currentServerRevision: '15',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '15',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-15',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-15' },
              createdAt: '2026-11-10T08:05:00.000Z',
            },
          ],
        })
      );

      // Inject leader revocation while GET is in-flight
      transportServer.interceptInFlight = async () => {
        tab1.stepDown();
      };

      await expect(
        reconciler.pullDeltaChanges({ leaderSignal: abortSignal ?? undefined })
      ).rejects.toThrow(/LEADER_REVOKED/);

      // Checkpoint must NOT advance to 15! Remains 10.
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('10');
      // Shadow record must NOT be written
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-15')).toBeNull();
    });

    it('scope switch account A -> B during in-flight HTTP drops response with zero cross-account writes', async () => {
      const scopeA = 'account:usr-switch-a';
      const scopeB = 'account:usr-switch-b';
      await seedReadySyncMeta(scopeA, '10');
      await seedReadySyncMeta(scopeB, '20');

      const queueA = new MutationQueue({
        ownerScope: scopeA,
        identityStateProvider: createStaticIdentityProvider(scopeA),
        dbClient,
      });

      await queueA.enqueue({
        ownerScope: scopeA,
        mutationId: 'mut-scope-a',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-a',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-a' },
        createdAt: '2026-11-10T08:00:00.000Z',
        retryCount: 0,
      });

      const tab1 = new TabLeaderElection({
        ownerScope: scopeA,
        tabId: 'tab-1',
        lockManager,
      });
      tab1.start();
      await new Promise((r) => setTimeout(r, 10));

      const reconciler = new MockStep52dReconciler({
        ownerScope: scopeA,
        dbClient,
        mutationQueue: queueA,
        tabLeader: tab1,
        server: transportServer,
      });

      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-scope-a', status: 'APPLIED', assignedRevision: '15' }],
      });

      // Switch scope from A to B while HTTP response is returning
      transportServer.interceptInFlight = async () => {
        reconciler.setScope(scopeB);
      };

      const result = await reconciler.pushPendingMutations();
      // Pushed count is 0 because response was dropped on scope mismatch
      expect(result.pushedCount).toBe(0);

      // Scope B must be completely untouched
      expect(await dbClient.getBookmark(scopeB, 'story-a')).toBeNull();
      expect(await dbClient.getPendingMutation(scopeB, 'mut-scope-a')).toBeNull();

      // Mutation for Scope A is marked unknown-outcome and retained in pending queue for safe retry
      expect(await dbClient.getPendingMutation(scopeA, 'mut-scope-a')).not.toBeNull();
    });
  });

  // ==========================================
  // SUITE 2: DELTA PULL RECONCILER & CHECKPOINTS
  // ==========================================
  describe('2. Delta Pull Reconciler & Checkpoint Invariants', () => {
    it('paginates delta changes across multiple pages following nextRevision and hasMore', async () => {
      const scope = 'account:usr-delta-paginated';
      await seedReadySyncMeta(scope, '100');

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
        mutationQueue: new MutationQueue({
          ownerScope: scope,
          identityStateProvider: createStaticIdentityProvider(scope),
          dbClient,
        }),
        tabLeader: tab,
        server: transportServer,
      });

      // Page 1: hasMore: true, nextRevision: '105'
      transportServer.queueChangesResponse(
        createDeltaChangesPageFixture({
          currentServerRevision: '110',
          minActiveRevision: '100',
          nextRevision: '105',
          hasMore: true,
          changes: [
            {
              revision: '105',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-page-1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'bm-page-1', title: 'Page 1' },
              createdAt: '2026-11-10T08:00:00.000Z',
            },
          ],
        })
      );

      // Page 2: hasMore: false, nextRevision: null
      transportServer.queueChangesResponse(
        createDeltaChangesPageFixture({
          currentServerRevision: '110',
          minActiveRevision: '100',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '110',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-page-2',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'bm-page-2', title: 'Page 2' },
              createdAt: '2026-11-10T08:01:00.000Z',
            },
          ],
        })
      );

      const pullResult = await reconciler.pullDeltaChanges({ limit: 1 });
      expect(pullResult.appliedPages).toBe(2);
      expect(pullResult.needsBootstrap).toBe(false);

      // Checkpoint advanced to 110
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('110');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-page-1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-page-2')).not.toBeNull();
    });

    it('rejects concurrent OCC expectedCheckpoint mismatch with CheckpointConflictError and rolls back', async () => {
      const scope = 'account:usr-occ-mismatch';
      await seedReadySyncMeta(scope, '100');

      const deltaPage = createDeltaChangesPageFixture({
        currentServerRevision: '105',
        minActiveRevision: '50',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-occ',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-occ' },
            createdAt: '2026-11-10T08:00:00.000Z',
          },
        ],
      });

      // Pass stale expectedCheckpoint '90' while DB is at '100' (and minActive is 50 <= 90)
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '90',
          page: deltaPage,
        })
      ).rejects.toThrow(CheckpointConflictError);

      // DB remains at 100 with zero shadow records created
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('100');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-occ')).toBeNull();
    });

    it('handles HTTP 410 SYNC_REVISION_EXPIRED: flags bootstrap requirement WITHOUT deleting checkpoint or pending data', async () => {
      const scope = 'account:usr-410-expired';
      await seedReadySyncMeta(scope, '50', '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-preserve-410',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-410',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '50',
        payload: { storyId: 'bm-410' },
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

      let bootstrapTriggered = false;
      const reconciler = new MockStep52dReconciler({
        ownerScope: scope,
        dbClient,
        mutationQueue: queue,
        tabLeader: tab,
        server: transportServer,
        onBootstrapRequired: (code) => {
          if (code === 'SYNC_REVISION_EXPIRED') {
            bootstrapTriggered = true;
          }
        },
      });

      // Server returns HTTP 410 (client checkpoint 50 is older than server minActiveRevision 100)
      transportServer.queueChangesResponse({
        statusCode: 410,
        error: {
          code: 'SYNC_REVISION_EXPIRED',
          message: 'Client revision 50 is below minActiveRevision 100',
          currentServerRevision: '150',
          minActiveRevision: '100',
        },
      });

      const result = await reconciler.pullDeltaChanges();
      expect(result.needsBootstrap).toBe(true);
      expect(bootstrapTriggered).toBe(true);

      // Crucial Safety Invariant: Checkpoint '50' is NOT wiped out yet!
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('50');

      // Crucial Safety Invariant: Pending offline mutations are NOT deleted!
      expect(await dbClient.getPendingMutation(scope, 'mut-preserve-410')).not.toBeNull();
    });

    it('supports 64-bit BigInt revisions exceeding Number.MAX_SAFE_INTEGER with exact precision', async () => {
      const scope = 'account:usr-bigint-delta';
      const safePlus1 = '9007199254740992'; // 2^53
      const safePlus2 = '9007199254740993'; // Conflated with safePlus1 in standard JS Number
      const safePlus5 = '9007199254740996';

      await seedReadySyncMeta(scope, safePlus1, safePlus1);

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
        mutationQueue: new MutationQueue({
          ownerScope: scope,
          identityStateProvider: createStaticIdentityProvider(scope),
          dbClient,
        }),
        tabLeader: tab,
        server: transportServer,
      });

      transportServer.queueChangesResponse(
        createDeltaChangesPageFixture({
          currentServerRevision: safePlus5,
          minActiveRevision: safePlus1,
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: safePlus2,
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-bigint',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'bm-bigint' },
              createdAt: '2026-11-10T08:00:00.000Z',
            },
          ],
        })
      );

      const res = await reconciler.pullDeltaChanges();
      expect(res.appliedPages).toBe(1);

      // Verifies exact decimal string preservation without float truncation
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe(safePlus5);
      const shadow = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-bigint');
      expect(shadow?.serverRevision).toBe(safePlus2);
    });
  });

  // ==========================================
  // SUITE 3: WIRE BATCH PUSH & RECEIPT LIFECYCLE
  // ==========================================
  describe('3. Wire Batch Push & Receipt Lifecycle (Task A & B)', () => {
    it('uses canonical UUID sentinel (not "all") on wire for fresh global HISTORY DELETE', async () => {
      const scope = 'account:usr-hist-sentinel';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      // Client enqueues global delete with legacy 'all'
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-hist-del-all',
        clientId: 'tab-1',
        domain: SyncDomain.HISTORY,
        entityId: 'all',
        operation: SyncOperation.DELETE,
        baseServerRevision: '10',
        payload: { storyId: 'all' },
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
        results: [{ mutationId: 'mut-hist-del-all', status: 'APPLIED', assignedRevision: '15' }],
      });

      await reconciler.pushPendingMutations();

      // Assert dispatched wire body uses canonical UUID sentinel
      expect(transportServer.dispatchedBatches).toHaveLength(1);
      const wireMutation = transportServer.dispatchedBatches[0].body.mutations[0];
      expect(wireMutation.entityId).toBe(WIRE_GLOBAL_HISTORY_ENTITY_ID);
      expect(wireMutation.entityId).toBe(GLOBAL_HISTORY_SENTINEL);
      expect(wireMutation.entityId).not.toBe('all');
    });

    it('does NOT assume batch-level Idempotency-Key header; relies on (clientId, mutationId, payloadHash)', async () => {
      const scope = 'account:usr-idempotency-keyless';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-idemp-1',
        clientId: 'client-uuid-alpha',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-1' },
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
        results: [{ mutationId: 'mut-idemp-1', status: 'APPLIED', assignedRevision: '15' }],
      });

      await reconciler.pushPendingMutations();

      expect(transportServer.dispatchedBatches).toHaveLength(1);
      const headers = transportServer.dispatchedBatches[0].headers;
      // Invariant: No batch-level Idempotency-Key header is transmitted
      expect(headers?.['Idempotency-Key']).toBeUndefined();

      // Mutation has immutable clientId and mutationId on wire
      const dispatched = transportServer.dispatchedBatches[0].body.mutations[0];
      expect(dispatched.clientId).toBe('client-uuid-alpha');
      expect(dispatched.mutationId).toBe('mut-idemp-1');
    });

    it('pre-dispatch guard quarantines stale pending mutation before HTTP dispatch, keeping payload', async () => {
      const scope = 'account:usr-pre-dispatch-stale';
      // Step 1: Sync meta minActiveRevision is initially at 20 (allowing base 30 into queue)
      await seedReadySyncMeta(scope, '40', '20');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      // Mutation has baseServerRevision 30 (>= minActiveRevision 20)
      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-stale-pre',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-stale',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '30',
        payload: { storyId: 'bm-stale', title: 'Offline Preserved' },
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

      // Step 2: Concurrent delta update advances minActiveRevision to 50 AFTER batch preparation
      const res = await reconciler.pushPendingMutations({
        _testHookAfterPrepareBatch: async () => {
          await seedReadySyncMeta(scope, '60', '50');
        },
      });
      expect(res.pushedCount).toBe(0);
      expect(res.quarantinedStaleCount).toBe(1);

      // ZERO network requests dispatched
      expect(transportServer.dispatchedBatches).toHaveLength(0);

      // Mutation removed from pending queue
      expect(await dbClient.getPendingMutation(scope, 'mut-stale-pre')).toBeNull();

      // Preserved in quarantined_mutations with full user payload
      const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-stale-pre');
      expect(quarantined).not.toBeNull();
      expect(quarantined?.rejectionReason).toBe('WATERMARK_ADVANCED_PRE_DISPATCH');
      expect(quarantined?.triageStatus).toBe('PENDING');
      expect(quarantined?.payload).toEqual({ storyId: 'bm-stale', title: 'Offline Preserved' });
    });

    it('unknown outcome recovery: POST left browser then connection failed; retries with same mutationId on leader recovery', async () => {
      const scope = 'account:usr-unknown-recovery';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-unknown-1',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-unk',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-unk', title: 'Title Unk' },
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

      // Attempt 1: Network drop after POST was dispatched
      transportServer.queueBatchResponse(new Error('NETWORK_TIMEOUT_CONNECTION_DROPPED'));

      await expect(reconciler.pushPendingMutations()).rejects.toThrow('NETWORK_TIMEOUT_CONNECTION_DROPPED');

      // Mutation remains in pending mutations queue with IDENTICAL mutationId
      const pendingAfterFail = await dbClient.getPendingMutation(scope, 'mut-unknown-1');
      expect(pendingAfterFail).not.toBeNull();
      expect(pendingAfterFail?.mutationId).toBe('mut-unknown-1');

      // Attempt 2: Server receives retry and returns DEDUPLICATED (it had committed attempt 1)
      transportServer.queueBatchResponse({
        results: [{ mutationId: 'mut-unknown-1', status: 'DEDUPLICATED', assignedRevision: '15' }],
      });

      const resRetry = await reconciler.pushPendingMutations();
      expect(resRetry.pushedCount).toBe(1);

      // Settled atomically with durable receipt
      expect(await dbClient.getPendingMutation(scope, 'mut-unknown-1')).toBeNull();
      const receipt = await dbClient.getMutationTerminalReceipt(scope, 'mut-unknown-1');
      expect(receipt?.status).toBe('DEDUPLICATED');
    });

    it('server REJECTED_STALE quarantines mutation with triageStatus=PENDING and preserves user payload', async () => {
      const scope = 'account:usr-server-stale';
      await seedReadySyncMeta(scope, '10');

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-server-stale',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-stale-srv',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-stale-srv', title: 'Server Stale Title' },
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
            mutationId: 'mut-server-stale',
            status: 'REJECTED_STALE',
            assignedRevision: null,
            reason: 'BASE_REVISION_EXPIRED',
          },
        ],
      });

      await reconciler.pushPendingMutations();

      // Removed from pending
      expect(await dbClient.getPendingMutation(scope, 'mut-server-stale')).toBeNull();

      // Quarantined with PENDING triage and preserved payload
      const quarantined = await dbClient.getQuarantinedMutation(scope, 'mut-server-stale');
      expect(quarantined).not.toBeNull();
      expect(quarantined?.triageStatus).toBe('PENDING');
      expect(quarantined?.rejectionReason).toBe('BASE_REVISION_EXPIRED');
      expect(quarantined?.payload).toEqual({ storyId: 'bm-stale-srv', title: 'Server Stale Title' });
    });

    it('server REJECTED_TOMBSTONE writes durable receipt, evicts replica, and does NOT mark user intent as applied', async () => {
      const scope = 'account:usr-rejected-tombstone';
      await seedReadySyncMeta(scope, '10');

      // Seed local bookmark replica
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'bm-tomb-deleted',
        title: 'User Local Bookmark',
        createdAt: '2026-11-10T08:00:00.000Z',
      });

      const queue = new MutationQueue({
        ownerScope: scope,
        identityStateProvider: createStaticIdentityProvider(scope),
        dbClient,
      });

      await queue.enqueue({
        ownerScope: scope,
        mutationId: 'mut-tomb-del',
        clientId: 'tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-tomb-deleted',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'bm-tomb-deleted' },
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

      // Server rejects because entity was already deleted on server (tombstone exists)
      transportServer.queueBatchResponse({
        results: [
          {
            mutationId: 'mut-tomb-del',
            status: 'REJECTED_TOMBSTONE',
            assignedRevision: null,
            reason: 'TOMBSTONE_CONFLICT',
          },
        ],
      });

      await reconciler.pushPendingMutations();

      // 1. Pending mutation deleted
      expect(await dbClient.getPendingMutation(scope, 'mut-tomb-del')).toBeNull();

      // 2. Local replica evicted
      expect(await dbClient.getBookmark(scope, 'bm-tomb-deleted')).toBeNull();

      // 3. Durable receipt recorded in STORE_SYNC_META
      const receipt = await dbClient.getMutationTerminalReceipt(scope, 'mut-tomb-del');
      expect(receipt).not.toBeNull();
      expect(receipt?.status).toBe('REJECTED_TOMBSTONE');

      // 4. Distinction verified: User intent was DISCARDED / NOT applied, despite terminal receipt
      expect(receipt?.status).not.toBe('APPLIED');
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
    });
  });

  // ==========================================
  // SUITE 4: FUTURE B2 / STEP 6 FIXTURES
  // ==========================================
  describe('4. Future B2 / Step 6 Contract Fixtures (Task C)', () => {
    it('validates six-domain snapshot paginated fixture structure and cursor progression', () => {
      const pages = createSixDomainSnapshotPagesFixture({ snapshotRevision: '15', minActiveRevision: '1' });
      expect(pages).toHaveLength(5);

      const decodeCursor = (cursor: string | null) =>
        cursor ? Buffer.from(cursor.replace('cur_hmac_v1_', ''), 'base64url').toString() : null;

      // Page 1: 2 bookmarks, nextCursor points to PREFERENCE
      expect(pages[0].data.bookmarks).toHaveLength(2);
      expect(pages[0].hasMore).toBe(true);
      expect(decodeCursor(pages[0].nextCursor)).toContain('PREFERENCE');

      // Page 2: 1 preference, nextCursor points to HISTORY_TOMBSTONE
      expect(pages[1].data.preferences).toHaveLength(1);
      expect(pages[1].hasMore).toBe(true);
      expect(decodeCursor(pages[1].nextCursor)).toContain('HISTORY_TOMBSTONE');

      // Page 3: 3 historyEpochs, globalHistoryEpoch=3
      expect(pages[2].data.historyEpochs).toHaveLength(3);
      expect(pages[2].globalHistoryEpoch).toBe(3);
      expect(pages[2].hasMore).toBe(true);

      // Page 4: 2 tombstones >= minActiveRevision (1)
      expect(pages[3].data.tombstones).toHaveLength(2);
      expect(BigInt(pages[3].data.tombstones[0].deletedAtRevision)).toBeGreaterThanOrEqual(1n);

      // Page 5: Terminal page hasMore: false, nextCursor: null
      expect(pages[4].hasMore).toBe(false);
      expect(pages[4].nextCursor).toBeNull();
    });

    it('simulates 409 SNAPSHOT_INVALIDATED response fixture for HMAC cursor mrev invalidation', () => {
      const errorResponse: WireSnapshotInvalidatedErrorResponse = {
        statusCode: 409,
        error: {
          code: 'SNAPSHOT_INVALIDATED',
          reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED',
          message: 'Min active revision advanced from 1 to 5 during concurrent GC',
          currentServerRevision: '20',
          minActiveRevision: '5',
          cursorMinActiveRevision: '1',
        },
      };

      expect(errorResponse.statusCode).toBe(409);
      expect(errorResponse.error.code).toBe('SNAPSHOT_INVALIDATED');
      expect(BigInt(errorResponse.error.minActiveRevision)).toBeGreaterThan(
        BigInt(errorResponse.error.cursorMinActiveRevision!)
      );
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
  });
});
