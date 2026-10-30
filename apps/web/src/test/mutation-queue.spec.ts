import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  LocalPendingMutation,
  LocalQuarantinedMutation,
  LocalPreference,
  CausalTriageProof,
} from '../lib/storage/indexed-db-client';
import {
  MutationQueue,
  MutationQueueOptions,
  ScopeMismatchError,
  ScopeTransitioningError,
  StaleBatchRejectedError,
  RequeueProhibitedError,
  IdentityStateProvider,
  createStaticIdentityProvider,
  PreparedPushBatch,
} from '../lib/sync/mutation-queue';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
  MutationResultItem,
} from '@omninovel/shared';

describe('Task 7C.3 — Step 4: Mutation Queue & Quarantine Triaging (Remediated)', () => {
  let dbClient: IndexedDbClient;
  const scopeA = 'account:usr-alice';
  const scopeB = 'account:usr-bob';

  beforeEach(async () => {
    // Reset fakeIndexedDB between tests
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
    dbClient = new IndexedDbClient();
  });

  afterEach(() => {
    dbClient.close();
    vi.restoreAllMocks();
  });

  const createTestQueue = (
    options: Partial<MutationQueueOptions> & { ownerScope?: string } = {}
  ): MutationQueue => {
    const scope = options.ownerScope ?? scopeA;
    return new MutationQueue({
      ownerScope: scope,
      identityStateProvider: options.identityStateProvider ?? createStaticIdentityProvider(scope),
      dbClient: options.dbClient ?? dbClient,
      ...options,
    });
  };

  const createDummyMutation = (
    overrides?: Partial<LocalPendingMutation>
  ): LocalPendingMutation => ({
    ownerScope: scopeA,
    mutationId: 'mut-uuid-1111-2222-3333',
    clientId: 'client-device-alpha',
    domain: SyncDomain.BOOKMARK,
    entityId: 'story-101',
    operation: SyncOperation.UPSERT,
    baseServerRevision: '1000',
    payload: { storyId: 'story-101' },
    createdAt: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  });

  describe('1. Mutation Ingestion & Immutability Invariants (P0)', () => {
    it('enqueues a valid mutation preserving all causal metadata, baseServerRevision, and payload', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mutation = createDummyMutation({
        domain: SyncDomain.PROGRESS,
        entityId: 'story-404',
        baseServerRevision: '9876543210123456789',
        payload: {
          storyId: 'story-404',
          chapterId: 'chap-1',
          progressPercentage: 85,
          readingMode: ReadingMode.WEBTOON,
          observedHistoryEpoch: 4,
          forceRewind: false,
        },
      });

      await queue.enqueue(mutation);

      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe(mutation.mutationId);
      expect(pending[0].baseServerRevision).toBe('9876543210123456789');
      expect(pending[0].payload).toEqual(mutation.payload);
      expect(pending[0].domain).toBe(SyncDomain.PROGRESS);
    });

    it('strictly rejects duplicate mutation [ownerScope, mutationId] to enforce mutation immutability', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mutation1 = createDummyMutation({ mutationId: 'mut-dup-1' });
      await queue.enqueue(mutation1);

      // Attempt duplicate mutation with different payload
      const mutation2 = createDummyMutation({
        mutationId: 'mut-dup-1',
        payload: { storyId: 'tampered-payload' },
      });

      await expect(queue.enqueue(mutation2)).rejects.toThrow();

      // Verify the original mutation remained unaltered
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toEqual({ storyId: 'story-101' });
    });

    it('retrieves pending mutations in chronological order', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const m1 = createDummyMutation({
        mutationId: 'mut-seq-1',
        createdAt: '2026-10-30T10:00:00.000Z',
      });
      const m2 = createDummyMutation({
        mutationId: 'mut-seq-2',
        createdAt: '2026-10-30T10:05:00.000Z',
      });
      const m3 = createDummyMutation({
        mutationId: 'mut-seq-3',
        createdAt: '2026-10-30T10:10:00.000Z',
      });

      await queue.enqueue(m2);
      await queue.enqueue(m1);
      await queue.enqueue(m3);

      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(3);
      expect(pending.map((m) => m.mutationId)).toEqual(['mut-seq-1', 'mut-seq-2', 'mut-seq-3']);
    });
  });

  describe('2. Scope Isolation & Identity Transition Guard (P0)', () => {
    it('throws ScopeMismatchError when attempting to enqueue a mutation with mismatched scope', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const foreignMutation = createDummyMutation({ ownerScope: scopeB });

      await expect(queue.enqueue(foreignMutation)).rejects.toThrow(ScopeMismatchError);
    });

    it('refuses queue operations and push preparation while identity is TRANSITIONING', async () => {
      let isTransitioning = false;
      const queue = createTestQueue({
        ownerScope: scopeA,
        isScopeTransitioning: () => isTransitioning,
      });

      const mutation = createDummyMutation({ mutationId: 'mut-trans-1' });
      await queue.enqueue(mutation);

      // Transition begins (e.g. during guest claim or account switch)
      isTransitioning = true;

      await expect(queue.getPendingMutations()).rejects.toThrow(ScopeTransitioningError);
      await expect(queue.preparePushBatch()).rejects.toThrow(ScopeTransitioningError);
      await expect(
        queue.enqueue(createDummyMutation({ mutationId: 'mut-trans-2' }))
      ).rejects.toThrow(ScopeTransitioningError);
      await expect(queue.getQuarantinedMutations()).rejects.toThrow(ScopeTransitioningError);
    });

    it('isolates mutations cleanly between different scopes and resets in-flight on setActiveScope()', async () => {
      const providerA = createStaticIdentityProvider(scopeA);
      const queueA = createTestQueue({ ownerScope: scopeA, identityStateProvider: providerA });
      const queueB = createTestQueue({ ownerScope: scopeB });

      const mutA = createDummyMutation({ ownerScope: scopeA, mutationId: 'mut-scopeA' });
      const mutB = createDummyMutation({ ownerScope: scopeB, mutationId: 'mut-scopeB' });

      await queueA.enqueue(mutA);
      await queueB.enqueue(mutB);

      expect((await queueA.getPendingMutations()).map((m) => m.mutationId)).toEqual(['mut-scopeA']);
      expect((await queueB.getPendingMutations()).map((m) => m.mutationId)).toEqual(['mut-scopeB']);

      // Prepare batch for scopeA: mut-scopeA becomes in-flight
      const batchA = await queueA.preparePushBatch();
      expect(batchA.mutations).toHaveLength(1);

      // Now switch active scope on providerA and queueA to scopeB
      providerA.setScope(scopeB);
      queueA.setActiveScope(scopeB);
      expect(queueA.getActiveScope()).toBe(scopeB);
      expect(queueA.getScopeGeneration()).toBe(1);

      // In-flight tracking was cleared; can now see scopeB items
      const pendingOnSwitchedQueue = await queueA.getPendingMutations();
      expect(pendingOnSwitchedQueue.map((m) => m.mutationId)).toEqual(['mut-scopeB']);
    });
  });

  describe('3. Server Rejection Handling & Anti-Resurrection (P0)', () => {
    it('handles APPLIED and DEDUPLICATED by removing mutations from pending_mutations', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const m1 = createDummyMutation({ mutationId: 'mut-app-1' });
      const m2 = createDummyMutation({ mutationId: 'mut-dedup-1' });

      await queue.enqueue(m1);
      await queue.enqueue(m2);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        { mutationId: 'mut-app-1', status: 'APPLIED', assignedRevision: '1001' },
        { mutationId: 'mut-dedup-1', status: 'DEDUPLICATED', assignedRevision: '1001' },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.appliedCount).toBe(1);
      expect(summary.deduplicatedCount).toBe(1);

      const remaining = await queue.getPendingMutations();
      expect(remaining).toHaveLength(0);
    });

    it('anti-resurrection: evicts local replica from IndexedDB when server reports REJECTED_TOMBSTONE', async () => {
      let evictedDomain: SyncDomain | null = null;
      let evictedEntityId: string | null = null;

      const queue = createTestQueue({
        ownerScope: scopeA,
        onReplicaEvicted: (s, dom, ent) => {
          evictedDomain = dom;
          evictedEntityId = ent;
        },
      });

      // 1. Stage a local bookmark and a local progress record
      await dbClient.putBookmark({
        ownerScope: scopeA,
        storyId: 'story-tombstone-1',
        title: 'Tombstoned Story',
        createdAt: new Date().toISOString(),
      });
      await dbClient.putProgress({
        ownerScope: scopeA,
        storyId: 'story-tombstone-1',
        chapterId: 'chap-1',
        progressPercentage: 50,
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 100,
        updatedAt: new Date().toISOString(),
        deviceTimestamp: Date.now(),
      });

      // Verify they exist locally
      expect(await dbClient.getBookmark(scopeA, 'story-tombstone-1')).not.toBeNull();
      expect(await dbClient.getProgress(scopeA, 'story-tombstone-1')).not.toBeNull();

      // 2. Enqueue bookmark mutation and push
      const bookmarkMutation = createDummyMutation({
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-tombstone-1',
        mutationId: 'mut-tomb-1',
      });
      await queue.enqueue(bookmarkMutation);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        {
          mutationId: 'mut-tomb-1',
          status: 'REJECTED_TOMBSTONE',
          assignedRevision: null,
          reason: 'Story has been deleted on server (tombstoned)',
        },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.tombstoneEvictedCount).toBe(1);

      // Invariant: Local replica MUST be deleted to prevent resurrection!
      expect(await dbClient.getBookmark(scopeA, 'story-tombstone-1')).toBeNull();
      expect(evictedDomain).toBe(SyncDomain.BOOKMARK);
      expect(evictedEntityId).toBe('story-tombstone-1');

      // Mutation is deleted from pending
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(0);
    });

    it('anti-resurrection: evicts history and preference replicas upon REJECTED_TOMBSTONE', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });

      // Stage history and preference
      await dbClient.recordReadingSession(
        {
          ownerScope: scopeA,
          storyId: 'story-hist-1',
          chapterId: 'chap-hist-1',
          progressPercentage: 100,
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 10,
          scrollPosition: 500,
          updatedAt: new Date().toISOString(),
          deviceTimestamp: Date.now(),
        },
        {
          ownerScope: scopeA,
          storyId: 'story-hist-1',
          chapterId: 'chap-hist-1',
          storyTitle: 'Test Story',
          chapterNumber: 1,
          progressPercentage: 100,
          lastReadAt: new Date().toISOString(),
        }
      );
      await dbClient.putPreference({
        ownerScope: scopeA,
        key: 'reader_theme',
        value: 'dark',
        updatedAt: new Date().toISOString(),
      });

      expect(await dbClient.getHistory(scopeA)).toHaveLength(1);
      expect(await dbClient.getPreference(scopeA, 'reader_theme')).not.toBeNull();

      // History mutation tombstone
      const histMutation = createDummyMutation({
        domain: SyncDomain.HISTORY,
        entityId: 'story-hist-1:chap-hist-1',
        mutationId: 'mut-tomb-hist',
        payload: { storyId: 'story-hist-1', chapterId: 'chap-hist-1' },
      });
      // Preference mutation tombstone
      const prefMutation = createDummyMutation({
        domain: SyncDomain.PREFERENCE,
        entityId: 'reader_theme',
        mutationId: 'mut-tomb-pref',
        payload: { key: 'reader_theme' },
      });

      await queue.enqueue(histMutation);
      await queue.enqueue(prefMutation);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        { mutationId: 'mut-tomb-hist', status: 'REJECTED_TOMBSTONE', assignedRevision: null },
        { mutationId: 'mut-tomb-pref', status: 'REJECTED_TOMBSTONE', assignedRevision: null },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.tombstoneEvictedCount).toBe(2);

      // Verify replicas are evicted
      expect(await dbClient.getHistory(scopeA)).toHaveLength(0);
      expect(await dbClient.getPreference(scopeA, 'reader_theme')).toBeNull();
    });

    it('anti-rebase invariant: REJECTED_STALE moves mutation to quarantine without modifying mutationId, payload, or baseServerRevision', async () => {
      let quarantinedEventMutation: LocalQuarantinedMutation | null = null;
      const queue = createTestQueue({
        ownerScope: scopeA,
        onMutationQuarantined: (s, m) => {
          quarantinedEventMutation = m;
        },
      });

      const originalPayload = {
        storyId: 'story-stale-1',
        chapterId: 'chap-stale-1',
        progressPercentage: 75,
        observedHistoryEpoch: 1,
      };

      const mutation = createDummyMutation({
        mutationId: 'mut-stale-p0',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-stale-1',
        baseServerRevision: '500',
        payload: originalPayload,
      });

      await queue.enqueue(mutation);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        {
          mutationId: 'mut-stale-p0',
          status: 'REJECTED_STALE',
          assignedRevision: null,
          reason: 'Causal history epoch mismatch',
        },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.staleQuarantinedCount).toBe(1);

      // Invariant: Removed from pending
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(0);

      // Invariant: Present in quarantined_mutations with EXACT identity preserved!
      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-stale-p0');
      expect(quarantined[0].baseServerRevision).toBe('500'); // NOT re-based!
      expect(quarantined[0].payload).toEqual(originalPayload);
      expect(quarantined[0].rejectionReason).toBe('Causal history epoch mismatch');
      expect(quarantined[0].rejectionStatus).toBe('REJECTED_STALE');

      expect(quarantinedEventMutation).not.toBeNull();
      expect(quarantinedEventMutation!.mutationId).toBe('mut-stale-p0');
    });

    it('CONFLICT_MERGED: triggers authoritative delta pull without inferring local synthetic payload', async () => {
      let deltaPullTriggeredScope: string | null = null;
      const queue = createTestQueue({
        ownerScope: scopeA,
        onAuthoritativeDeltaPullRequired: async (s) => {
          deltaPullTriggeredScope = s;
        },
      });

      const mutation = createDummyMutation({ mutationId: 'mut-conflict-1' });
      await queue.enqueue(mutation);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        {
          mutationId: 'mut-conflict-1',
          status: 'CONFLICT_MERGED',
          assignedRevision: '2005',
          message: 'Server three-way merge resolved',
        },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.conflictMergedCount).toBe(1);
      expect(deltaPullTriggeredScope).toBe(scopeA);

      // Pending mutation removed
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(0);
    });

    it('DOMAIN_NOT_SUPPORTED: quarantines mutation to prevent infinite retry', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mutation = createDummyMutation({
        domain: SyncDomain.FOLLOW,
        mutationId: 'mut-unsupported-1',
      });
      await queue.enqueue(mutation);

      const batch = await queue.preparePushBatch();
      const results: MutationResultItem[] = [
        {
          mutationId: 'mut-unsupported-1',
          status: 'DOMAIN_NOT_SUPPORTED',
          assignedRevision: null,
          reason: 'Domain FOLLOW is not yet enabled on this cluster',
        },
      ];

      const summary = await queue.processServerBatchResults({ results, batch });
      expect(summary.unsupportedCount).toBe(1);

      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(0);

      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-unsupported-1');
      expect(quarantined[0].rejectionReason).toBe('Domain FOLLOW is not yet enabled on this cluster');
      expect(quarantined[0].rejectionStatus).toBe('DOMAIN_NOT_SUPPORTED');
    });
  });

  describe('4. Transaction Rollback & Quarantine Atomicity (P0)', () => {
    it('atomically moves from pending to quarantined in a single IDB transaction via direct key lookup', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mutation = createDummyMutation({ mutationId: 'mut-atomic-q' });
      await queue.enqueue(mutation);

      await queue.quarantine('mut-atomic-q', 'Manual quarantine for audit');

      const pending = await queue.getPendingMutations();
      const quarantined = await queue.getQuarantinedMutations();

      expect(pending).toHaveLength(0);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-atomic-q');
      expect(quarantined[0].rejectionReason).toBe('Manual quarantine for audit');
      expect(quarantined[0].rejectionStatus).toBe('MANUAL');
    });

    it('atomically requeues quarantined mutation back to pending with retryCount=0, preserving exact mutationId and payload', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const originalPayload = { storyId: 'story-requeue-1', notes: 'Important causal data' };
      const mutation = createDummyMutation({
        mutationId: 'mut-requeue-1',
        payload: originalPayload,
        baseServerRevision: '777',
      });
      await queue.enqueue(mutation);
      await queue.quarantine('mut-requeue-1', 'Transient issue');

      // Requeue back to pending
      await queue.requeue('mut-requeue-1');

      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(0);

      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe('mut-requeue-1');
      expect(pending[0].baseServerRevision).toBe('777');
      expect(pending[0].payload).toEqual(originalPayload);
      expect(pending[0].retryCount).toBe(0);
      expect(pending[0].nextRetryAt).toBeUndefined();
    });

    it('rolls back completely without losing mutation if IDB error occurs during quarantine', async () => {
      const spy = vi.spyOn(dbClient, 'quarantinePendingMutationByKey').mockRejectedValueOnce(
        new Error('Simulated IDB transaction crash')
      );

      const queue = createTestQueue({ ownerScope: scopeA });
      const mutation = createDummyMutation({ mutationId: 'mut-crash-test' });
      await queue.enqueue(mutation);

      await expect(queue.quarantine('mut-crash-test', 'Should fail')).rejects.toThrow(
        'Simulated IDB transaction crash'
      );

      // Mutation is NOT lost from pending store
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe('mut-crash-test');

      spy.mockRestore();
    });
  });

  describe('5. Network Timeout, Retry Safety & Backoff (P0)', () => {
    it('preserves mutation identity, payload, and baseServerRevision when network failure triggers retry with backoff', async () => {
      const queue = createTestQueue({
        ownerScope: scopeA,
        maxRetries: 3,
        initialBackoffMs: 1000,
        backoffFactor: 2,
      });

      const mutation = createDummyMutation({
        mutationId: 'mut-net-retry',
        baseServerRevision: '9000',
        payload: { storyId: 'story-9000', progressPercentage: 99 },
      });
      await queue.enqueue(mutation);

      const batch = await queue.preparePushBatch();
      expect(batch.mutations).toHaveLength(1);

      // First network failure
      const netError = new Error('Gateway Timeout 504');
      await queue.handleNetworkFailure(batch, netError);

      // Invariant: In-flight released
      // Pending mutation has incremented retryCount and nextRetryAt, while mutationId, payload, and revision remain intact!
      const pendingAfterFail1 = await queue.getPendingMutations();
      expect(pendingAfterFail1).toHaveLength(1);
      expect(pendingAfterFail1[0].mutationId).toBe('mut-net-retry');
      expect(pendingAfterFail1[0].baseServerRevision).toBe('9000');
      expect(pendingAfterFail1[0].payload).toEqual({ storyId: 'story-9000', progressPercentage: 99 });
      expect(pendingAfterFail1[0].retryCount).toBe(1);
      expect(pendingAfterFail1[0].nextRetryAt).toBeDefined();

      // Immediate preparePushBatch at now should skip it because backoff is active
      const now = Date.now();
      const immediateBatch = await queue.preparePushBatch({ now });
      expect(immediateBatch.mutations).toHaveLength(0);

      // Once backoff passes (e.g. now + 1500ms), it is included again
      const delayedBatch = await queue.preparePushBatch({ now: now + 1500 });
      expect(delayedBatch.mutations).toHaveLength(1);
      expect(delayedBatch.mutations[0].mutationId).toBe('mut-net-retry');

      // Second failure
      await queue.handleNetworkFailure(delayedBatch, netError);
      const pendingAfterFail2 = await queue.getPendingMutations();
      expect(pendingAfterFail2[0].retryCount).toBe(2);

      // Third failure reaches maxRetries (3) -> atomically moved to quarantine!
      const batch3 = await queue.preparePushBatch({ now: now + 5000 });
      await queue.handleNetworkFailure(batch3, netError);

      // Removed from pending
      const finalPending = await queue.getPendingMutations();
      expect(finalPending).toHaveLength(0);

      // Present in quarantine with exact identity intact!
      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-net-retry');
      expect(quarantined[0].baseServerRevision).toBe('9000');
      expect(quarantined[0].payload).toEqual({ storyId: 'story-9000', progressPercentage: 99 });
      expect(quarantined[0].rejectionReason).toContain('EXCEEDED_MAX_RETRIES: Gateway Timeout 504');
      expect(quarantined[0].rejectionStatus).toBe('EXCEEDED_MAX_RETRIES');
    });
  });

  describe('6. Worker Authority & In-Flight Batch Protection', () => {
    it('prevents concurrent double-pushing by tracking in-flight mutation IDs', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-inf-1' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-inf-2' }));

      // First caller prepares batch
      const batch1 = await queue.preparePushBatch({ limit: 1 });
      expect(batch1.mutations).toHaveLength(1);
      expect(batch1.mutations[0].mutationId).toBe('mut-inf-1');

      // Concurrent caller prepares batch: mut-inf-1 is in-flight, so only mut-inf-2 is returned
      const batch2 = await queue.preparePushBatch({ limit: 1 });
      expect(batch2.mutations).toHaveLength(1);
      expect(batch2.mutations[0].mutationId).toBe('mut-inf-2');

      // Third caller: both are in-flight, returns empty
      const batch3 = await queue.preparePushBatch({ limit: 1 });
      expect(batch3.mutations).toHaveLength(0);

      // If network call aborts, release in-flight
      queue.releaseInFlight(batch1);
      const batchAfterRelease = await queue.preparePushBatch({ limit: 1 });
      expect(batchAfterRelease.mutations).toHaveLength(1);
      expect(batchAfterRelease.mutations[0].mutationId).toBe('mut-inf-1');
    });

    it('aborts push preparation and releases in-flight when leaderSignal is aborted', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-abort-1' }));

      const abortController = new AbortController();
      abortController.abort('Tab Leader stepped down');

      // preparePushBatch returns empty immediately when signal is already aborted
      const batch = await queue.preparePushBatch({ leaderSignal: abortController.signal });
      expect(batch.mutations).toHaveLength(0);

      // If signal aborts during processServerBatchResults
      const normalBatch = await queue.preparePushBatch();
      expect(normalBatch.mutations).toHaveLength(1);

      await expect(
        queue.processServerBatchResults({
          results: [],
          batch: normalBatch,
          leaderSignal: abortController.signal,
        })
      ).rejects.toThrow('Leader signal aborted');

      // In-flight tracking was released safely
      const status = await queue.getStatus();
      expect(status.inFlightCount).toBe(0);
    });
  });

  describe('7. Diagnostics & Status Reporting', () => {
    it('accurately computes and returns queue diagnostic status with persisted backoff count', async () => {
      const queue = createTestQueue({
        ownerScope: scopeA,
        maxRetries: 5,
        initialBackoffMs: 5000,
      });

      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-1' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-2' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-3' }));

      // Prepare 1 item into in-flight
      const batch = await queue.preparePushBatch({ limit: 1 });
      expect(batch.mutations).toHaveLength(1);

      // Put 1 item in backoff
      await queue.handleNetworkFailure(batch, new Error('Transient error'));

      // Quarantine 1 item
      await queue.quarantine('mut-stat-2', 'Manual test quarantine');

      const status = await queue.getStatus();
      expect(status.ownerScope).toBe(scopeA);
      expect(status.scopeGeneration).toBe(0);
      expect(status.pendingCount).toBe(2); // mut-stat-1 (backoff), mut-stat-3 (ready)
      expect(status.quarantinedCount).toBe(1); // mut-stat-2
      expect(status.inBackoffCount).toBe(1); // mut-stat-1
      expect(status.inFlightCount).toBe(0);
    });
  });

  describe('8. Stale Batch & Asynchronous Scope Switching Invariants (P0-04 Remediation)', () => {
    it('strictly rejects late server response from Scope A after setActiveScope(B), preventing cross-account corruption', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });

      // Scope A: enqueues a mutation on story-shared-99
      const mutA = createDummyMutation({
        ownerScope: scopeA,
        mutationId: 'mut-alice-1',
        entityId: 'story-shared-99',
      });
      await queue.enqueue(mutA);

      // Prepare batch under Scope A (generation 0)
      const batchA = await queue.preparePushBatch();
      expect(batchA.ownerScope).toBe(scopeA);
      expect(batchA.scopeGeneration).toBe(0);
      expect(batchA.mutations).toHaveLength(1);

      // Scope B: independently has its own local replica and pending mutation with matching entityId and mutationId
      await dbClient.putBookmark({
        ownerScope: scopeB,
        storyId: 'story-shared-99',
        title: "Bob's Bookmark for story-shared-99",
        createdAt: new Date().toISOString(),
      });
      const mutB = createDummyMutation({
        ownerScope: scopeB,
        mutationId: 'mut-alice-1', // Same ID in different scope to test collision isolation
        entityId: 'story-shared-99',
      });
      await dbClient.enqueuePendingMutation(mutB);

      // USER SWITCHES ACCOUNT: Scope A -> Scope B!
      queue.setActiveScope(scopeB);
      expect(queue.getActiveScope()).toBe(scopeB);
      expect(queue.getScopeGeneration()).toBe(1);

      // Late server response for Scope A arrives now!
      const lateResults: MutationResultItem[] = [
        {
          mutationId: 'mut-alice-1',
          status: 'REJECTED_TOMBSTONE',
          assignedRevision: null,
          reason: 'Story deleted on server for Alice',
        },
      ];

      // P0-04 Invariant: Processing late batchA under active scopeB MUST fail and reject!
      await expect(
        queue.processServerBatchResults({ results: lateResults, batch: batchA })
      ).rejects.toThrow(StaleBatchRejectedError);

      // CRITICAL ASSERTION: Scope B's local replica MUST NOT be evicted or touched!
      const bobBookmark = await dbClient.getBookmark(scopeB, 'story-shared-99');
      expect(bobBookmark).not.toBeNull();
      expect(bobBookmark?.title).toBe("Bob's Bookmark for story-shared-99");

      // CRITICAL ASSERTION: Scope B's pending mutation MUST NOT be deleted!
      const bobPending = await dbClient.getPendingMutation(scopeB, 'mut-alice-1');
      expect(bobPending).not.toBeNull();
      expect(bobPending?.ownerScope).toBe(scopeB);

      // Scope A's pending mutation was NOT deleted or corrupted under scope B
      const alicePending = await dbClient.getPendingMutation(scopeA, 'mut-alice-1');
      expect(alicePending).not.toBeNull();
      expect(alicePending?.ownerScope).toBe(scopeA);
    });

    it('strictly rejects stale batch after A -> B -> A account switching sequence due to generation mismatch', async () => {
      const provider = createStaticIdentityProvider(scopeA);
      const queue = createTestQueue({ ownerScope: scopeA, identityStateProvider: provider });
      const mutA = createDummyMutation({ ownerScope: scopeA, mutationId: 'mut-aba-1' });
      await queue.enqueue(mutA);

      // 1. Prepare batch at scope A (generation 0)
      const batchA_gen0 = await queue.preparePushBatch();
      expect(batchA_gen0.scopeGeneration).toBe(0);
      expect(batchA_gen0.ownerScope).toBe(scopeA);

      // 2. Switch to scope B (generation becomes 1)
      provider.setScope(scopeB);
      queue.setActiveScope(scopeB);
      expect(queue.getScopeGeneration()).toBe(1);

      // 3. Switch BACK to scope A (generation becomes 2)
      provider.setScope(scopeA);
      queue.setActiveScope(scopeA);
      expect(queue.getScopeGeneration()).toBe(2);
      expect(queue.getActiveScope()).toBe(scopeA);

      // 4. Stale batch from generation 0 arrives now for scope A!
      const lateResults: MutationResultItem[] = [
        { mutationId: 'mut-aba-1', status: 'APPLIED', assignedRevision: '999' },
      ];

      // MUST REJECT because generation 0 != 2, preventing stale receipt race!
      await expect(
        queue.processServerBatchResults({ results: lateResults, batch: batchA_gen0 })
      ).rejects.toThrow(StaleBatchRejectedError);
    });

    it('does not mutate or retry mutation under new scope if scope switches during handleTransientFailure await', async () => {
      const provider = createStaticIdentityProvider(scopeA);
      const queue = createTestQueue({ ownerScope: scopeA, identityStateProvider: provider });
      const mutA = createDummyMutation({ ownerScope: scopeA, mutationId: 'mut-race-retry-1' });
      await queue.enqueue(mutA);

      const batchA = await queue.preparePushBatch();
      expect(batchA.mutations).toHaveLength(1);

      // Mock dbClient.getPendingMutation to switch scope during the await
      const originalGetPending = dbClient.getPendingMutation.bind(dbClient);
      vi.spyOn(dbClient, 'getPendingMutation').mockImplementationOnce(async (scope, id) => {
        const res = await originalGetPending(scope, id);
        // Switch scope while getPendingMutation is awaiting!
        provider.setScope(scopeB);
        queue.setActiveScope(scopeB);
        return res;
      });

      const updateSpy = vi.spyOn(dbClient, 'updatePendingMutationRetry');
      const quarantineSpy = vi.spyOn(dbClient, 'quarantineMutation');

      await queue.handleNetworkFailure(batchA, new Error('Network dropped'));

      // Invariant: Because scope switched to scopeB mid-await, neither updatePendingMutationRetry nor quarantineMutation was executed on scopeB
      expect(updateSpy).not.toHaveBeenCalledWith(scopeB, expect.anything(), expect.anything(), expect.anything());
      expect(quarantineSpy).not.toHaveBeenCalledWith(expect.objectContaining({ ownerScope: scopeB }));
    });

    it('rejects stale batch if individual mutation ownerScope mismatches batch header', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const tamperedBatch: PreparedPushBatch = {
        batchId: 'batch-tampered-1',
        ownerScope: scopeA,
        scopeGeneration: 0,
        createdAt: Date.now(),
        mutations: [
          createDummyMutation({ ownerScope: scopeB, mutationId: 'mut-tampered-foreign' }),
        ],
      };

      await expect(
        queue.processServerBatchResults({ results: [], batch: tamperedBatch })
      ).rejects.toThrow(ScopeMismatchError);
    });
  });

  describe('9. Causal Triage & Requeue Protection (P0-05 Remediation)', () => {
    it('permanently prohibits requeue of REJECTED_TOMBSTONE mutations to prevent resurrection', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mut = createDummyMutation({ mutationId: 'mut-tomb-perm', entityId: 'story-dead-1' });
      await queue.enqueue(mut);

      // Quarantine with status REJECTED_TOMBSTONE
      await dbClient.quarantineMutation({
        ownerScope: scopeA,
        mutationId: 'mut-tomb-perm',
        clientId: 'client-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-dead-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-dead-1' },
        rejectionReason: 'Authoritative tombstone',
        rejectionStatus: 'REJECTED_TOMBSTONE',
        rejectedAt: new Date().toISOString(),
      });

      // P0-05 Invariant: Requeue MUST be strictly prohibited
      await expect(queue.requeue('mut-tomb-perm')).rejects.toThrow(RequeueProhibitedError);
      await expect(queue.requeue('mut-tomb-perm')).rejects.toThrow(
        /REJECTED_TOMBSTONE.*anti-resurrection/
      );

      // Verify it remained quarantined
      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-tomb-perm');
    });

    it('permanently locks out requeue of REJECTED_STALE and HTTP_410 mutations at Step 4 even with triageApproved: true', async () => {
      const queue = createTestQueue({ ownerScope: scopeA });
      const mut = createDummyMutation({ mutationId: 'mut-stale-gate', entityId: 'story-stale-99' });
      await queue.enqueue(mut);

      const batch = await queue.preparePushBatch();
      await queue.processServerBatchResults({
        results: [{ mutationId: 'mut-stale-gate', status: 'REJECTED_STALE', assignedRevision: null }],
        batch,
      });

      // 1. Requeue without triage proof -> FAILS
      await expect(queue.requeue('mut-stale-gate')).rejects.toThrow(RequeueProhibitedError);

      // 2. Requeue even with triageApproved: true -> STILL FAILS (locked until Step 6 Causal Triage Engine)
      const approvedProof: CausalTriageProof = {
        observedEpoch: 3,
        validatedRevision: '2500',
        triageApproved: true,
        triageReason: 'User resolved conflict against server head snapshot',
      };
      await expect(queue.requeue('mut-stale-gate', approvedProof)).rejects.toThrow(
        RequeueProhibitedError
      );
      await expect(queue.requeue('mut-stale-gate', approvedProof)).rejects.toThrow(
        /locked until Step 6 Causal Triage Engine is implemented/
      );

      // Verify it remained quarantined
      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-stale-gate');

      // Verify direct dbClient call also fails
      await expect(
        dbClient.requeueQuarantinedMutation(scopeA, 'mut-stale-gate', approvedProof)
      ).rejects.toThrow(/locked until Step 6 Causal Triage Engine is implemented/);
    });

    it('allows requeue for transient EXCEEDED_MAX_RETRIES without requiring causal triage', async () => {
      const queue = createTestQueue({ ownerScope: scopeA, maxRetries: 1 });
      const mut = createDummyMutation({ mutationId: 'mut-retry-exhaust' });
      await queue.enqueue(mut);

      const batch = await queue.preparePushBatch();
      await queue.handleNetworkFailure(batch, new Error('Network timeout'));

      // Quarantined due to retry exhaustion
      const quarantined = await queue.getQuarantinedMutations();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].rejectionStatus).toBe('EXCEEDED_MAX_RETRIES');

      // Requeue succeeds without causal proof because it is a transient error
      await queue.requeue('mut-retry-exhaust');

      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe('mut-retry-exhaust');
      expect(pending[0].retryCount).toBe(0);
    });
  });

  describe('10. Fail-Closed Identity State Provider Invariants (P0-06 Remediation)', () => {
    it('fails closed when identityStateProvider is omitted', () => {
      expect(
        () => new MutationQueue({ ownerScope: scopeA, dbClient } as any)
      ).toThrow(ScopeTransitioningError);
    });

    it('fails closed when canMutateUserState returns false', async () => {
      const provider: IdentityStateProvider = {
        getActiveScope: () => scopeA,
        isTransitioning: () => false,
        canMutateUserState: () => false,
      };

      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
        identityStateProvider: provider,
      });

      await expect(queue.preparePushBatch()).rejects.toThrow(ScopeTransitioningError);
      await expect(queue.getPendingMutations()).rejects.toThrow(ScopeTransitioningError);
    });

    it('aborts batch preparation and returns empty batch if identity transitions during preparePushBatch await', async () => {
      let isTransitioning = false;
      const provider: IdentityStateProvider = {
        getActiveScope: () => scopeA,
        isTransitioning: () => isTransitioning,
        canMutateUserState: () => !isTransitioning,
      };

      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
        identityStateProvider: provider,
      });

      await queue.enqueue(createDummyMutation({ mutationId: 'mut-race-trans-1' }));

      // Hook dbClient.getPendingMutations to trigger transition during await
      const originalGetPending = dbClient.getPendingMutations.bind(dbClient);
      vi.spyOn(dbClient, 'getPendingMutations').mockImplementationOnce(async (scope, limit) => {
        const res = await originalGetPending(scope, limit);
        isTransitioning = true; // Identity starts transitioning while DB read is resolving
        return res;
      });

      const batch = await queue.preparePushBatch();
      // Fail-closed: returns empty batch and does not mark mutations in flight
      expect(batch.mutations).toHaveLength(0);
    });

    it('fails closed when identityStateProvider reports TRANSITIONING', async () => {
      let isTransitioning = false;
      let canMutate = true;

      const mockIdentityProvider: IdentityStateProvider = {
        getActiveScope: () => scopeA,
        isTransitioning: () => isTransitioning,
        canMutateUserState: () => canMutate,
      };

      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
        identityStateProvider: mockIdentityProvider,
      });

      // Normal operations work when active
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-id-test-1' }));
      expect((await queue.preparePushBatch()).mutations).toHaveLength(1);

      // Enter TRANSITIONING state
      isTransitioning = true;
      canMutate = false;

      // Fail-closed on all operations
      await expect(queue.preparePushBatch()).rejects.toThrow(ScopeTransitioningError);
      await expect(queue.getPendingMutations()).rejects.toThrow(ScopeTransitioningError);
      await expect(queue.getQuarantinedMutations()).rejects.toThrow(ScopeTransitioningError);
      await expect(
        queue.enqueue(createDummyMutation({ mutationId: 'mut-id-test-2' }))
      ).rejects.toThrow(ScopeTransitioningError);
    });

    it('fails closed when identityStateProvider reports scope mismatch', async () => {
      const mockIdentityProvider: IdentityStateProvider = {
        getActiveScope: () => scopeB, // Provider says scopeB, but queue is at scopeA
        isTransitioning: () => false,
        canMutateUserState: () => true,
      };

      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
        identityStateProvider: mockIdentityProvider,
      });

      await expect(queue.preparePushBatch()).rejects.toThrow(ScopeMismatchError);
    });
  });

  describe('11. Persistent Retry Backoff across Session Reloads (P1 Remediation)', () => {
    it('persists nextRetryAt directly in IndexedDB so backoff survives page reload', async () => {
      const queue1 = createTestQueue({
        ownerScope: scopeA,
        maxRetries: 5,
        initialBackoffMs: 2000,
      });

      const mut = createDummyMutation({ mutationId: 'mut-persist-backoff' });
      await queue1.enqueue(mut);

      const batch1 = await queue1.preparePushBatch();
      expect(batch1.mutations).toHaveLength(1);

      // Network failure triggers backoff
      const beforeFail = Date.now();
      await queue1.handleNetworkFailure(batch1, new Error('Server 500'));

      // Check IndexedDB directly: nextRetryAt must be persisted on the record!
      const storedItem = await dbClient.getPendingMutation(scopeA, 'mut-persist-backoff');
      expect(storedItem).not.toBeNull();
      expect(storedItem?.retryCount).toBe(1);
      expect(storedItem?.nextRetryAt).toBeGreaterThanOrEqual(beforeFail + 1900);

      // SIMULATE PAGE RELOAD: Instantiate a completely new MutationQueue instance with fresh memory state
      const reloadedQueue = createTestQueue({
        ownerScope: scopeA,
        maxRetries: 5,
        initialBackoffMs: 2000,
      });

      // Immediate push preparation at current time must SKIP the mutation because IndexedDB persisted nextRetryAt!
      const immediateBatch = await reloadedQueue.preparePushBatch({ now: beforeFail });
      expect(immediateBatch.mutations).toHaveLength(0);

      // Once nextRetryAt elapses, reloadedQueue includes it
      const afterBackoffBatch = await reloadedQueue.preparePushBatch({ now: beforeFail + 3000 });
      expect(afterBackoffBatch.mutations).toHaveLength(1);
      expect(afterBackoffBatch.mutations[0].mutationId).toBe('mut-persist-backoff');
    });
  });

  describe('12. Atomic Tombstone Eviction and Pending Removal (P1 Remediation)', () => {
    it('atomically evicts replica and removes pending mutation in a single IDB transaction', async () => {
      // Stage bookmark
      await dbClient.putBookmark({
        ownerScope: scopeA,
        storyId: 'story-atomic-tomb',
        title: 'Atomic Tombstone Test',
        createdAt: new Date().toISOString(),
      });
      // Stage pending mutation
      await dbClient.enqueuePendingMutation(
        createDummyMutation({
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-atomic-tomb',
          mutationId: 'mut-atomic-tomb',
        })
      );

      // Execute atomic eviction & removal
      await dbClient.evictReplicaAndRemovePending(
        scopeA,
        SyncDomain.BOOKMARK,
        'story-atomic-tomb',
        'mut-atomic-tomb'
      );

      // Both must be wiped
      expect(await dbClient.getBookmark(scopeA, 'story-atomic-tomb')).toBeNull();
      expect(await dbClient.getPendingMutation(scopeA, 'mut-atomic-tomb')).toBeNull();
    });

    it('atomic primitive: incrementPendingMutationRetryAtomic updates retryCount and nextRetryAt in single transaction', async () => {
      const mut = createDummyMutation({ mutationId: 'mut-atomic-retry', retryCount: 0 });
      await dbClient.enqueuePendingMutation(mut);

      const before = Date.now();
      const res = await dbClient.incrementPendingMutationRetryAtomic(scopeA, 'mut-atomic-retry', 5000);

      expect(res).not.toBeNull();
      expect(res?.retryCount).toBe(1);
      expect(res?.nextRetryAt).toBeGreaterThanOrEqual(before + 4900);

      const updated = await dbClient.getPendingMutation(scopeA, 'mut-atomic-retry');
      expect(updated?.retryCount).toBe(1);
      expect(updated?.nextRetryAt).toBe(res?.nextRetryAt);
    });
  });
});
