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
} from '../lib/storage/indexed-db-client';
import {
  MutationQueue,
  ScopeMismatchError,
  ScopeTransitioningError,
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

describe('Task 7C.3 — Step 4: Mutation Queue & Quarantine Triaging', () => {
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      const foreignMutation = createDummyMutation({ ownerScope: scopeB });

      await expect(queue.enqueue(foreignMutation)).rejects.toThrow(ScopeMismatchError);
    });

    it('refuses queue operations and push preparation while identity is TRANSITIONING', async () => {
      let isTransitioning = false;
      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
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
      const queueA = new MutationQueue({ ownerScope: scopeA, dbClient });
      const queueB = new MutationQueue({ ownerScope: scopeB, dbClient });

      const mutA = createDummyMutation({ ownerScope: scopeA, mutationId: 'mut-scopeA' });
      const mutB = createDummyMutation({ ownerScope: scopeB, mutationId: 'mut-scopeB' });

      await queueA.enqueue(mutA);
      await queueB.enqueue(mutB);

      expect((await queueA.getPendingMutations()).map((m) => m.mutationId)).toEqual(['mut-scopeA']);
      expect((await queueB.getPendingMutations()).map((m) => m.mutationId)).toEqual(['mut-scopeB']);

      // Prepare batch for scopeA: mut-scopeA becomes in-flight
      const batchA = await queueA.preparePushBatch();
      expect(batchA).toHaveLength(1);

      // Now switch active scope on queueA to scopeB
      queueA.setActiveScope(scopeB);
      expect(queueA.getActiveScope()).toBe(scopeB);

      // In-flight tracking was cleared; can now see scopeB items
      const pendingOnSwitchedQueue = await queueA.getPendingMutations();
      expect(pendingOnSwitchedQueue.map((m) => m.mutationId)).toEqual(['mut-scopeB']);
    });
  });

  describe('3. Server Rejection Handling & Anti-Resurrection (P0)', () => {
    it('handles APPLIED and DEDUPLICATED by removing mutations from pending_mutations', async () => {
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
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

      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });

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
      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
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

      expect(quarantinedEventMutation).not.toBeNull();
      expect(quarantinedEventMutation!.mutationId).toBe('mut-stale-p0');
    });

    it('CONFLICT_MERGED: triggers authoritative delta pull without inferring local synthetic payload', async () => {
      let deltaPullTriggeredScope: string | null = null;
      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
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
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
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
    });
  });

  describe('4. Transaction Rollback & Quarantine Atomicity (P0)', () => {
    it('atomically moves from pending to quarantined in a single IDB transaction', async () => {
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      const mutation = createDummyMutation({ mutationId: 'mut-atomic-q' });
      await queue.enqueue(mutation);

      await queue.quarantine('mut-atomic-q', 'Manual quarantine for audit');

      const pending = await queue.getPendingMutations();
      const quarantined = await queue.getQuarantinedMutations();

      expect(pending).toHaveLength(0);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].mutationId).toBe('mut-atomic-q');
      expect(quarantined[0].rejectionReason).toBe('Manual quarantine for audit');
    });

    it('atomically requeues quarantined mutation back to pending with retryCount=0, preserving exact mutationId and payload', async () => {
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      const originalPayload = { storyId: 'story-requeue-1', notes: 'Important causal data' };
      const mutation = createDummyMutation({
        mutationId: 'mut-requeue-1',
        payload: originalPayload,
        baseServerRevision: '777',
      });
      await queue.enqueue(mutation);
      await queue.quarantine('mut-requeue-1', 'Stale revision');

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
    });

    it('rolls back completely without losing mutation if IDB error occurs during quarantine', async () => {
      // Simulate IDB transaction abort on quarantineMutation
      const spy = vi.spyOn(dbClient, 'quarantineMutation').mockRejectedValueOnce(new Error('Simulated IDB transaction crash'));

      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      const mutation = createDummyMutation({ mutationId: 'mut-crash-test' });
      await queue.enqueue(mutation);

      await expect(queue.quarantine('mut-crash-test', 'Should fail')).rejects.toThrow('Simulated IDB transaction crash');

      // Mutation is NOT lost from pending store
      const pending = await queue.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutationId).toBe('mut-crash-test');

      spy.mockRestore();
    });
  });

  describe('5. Network Timeout, Retry Safety & Backoff (P0)', () => {
    it('preserves mutation identity, payload, and baseServerRevision when network failure triggers retry with backoff', async () => {
      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
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
      expect(batch).toHaveLength(1);

      // First network failure
      const netError = new Error('Gateway Timeout 504');
      await queue.handleNetworkFailure(batch, netError);

      // Invariant: In-flight released
      // Pending mutation has incremented retryCount, while mutationId, payload, and revision remain intact!
      const pendingAfterFail1 = await queue.getPendingMutations();
      expect(pendingAfterFail1).toHaveLength(1);
      expect(pendingAfterFail1[0].mutationId).toBe('mut-net-retry');
      expect(pendingAfterFail1[0].baseServerRevision).toBe('9000');
      expect(pendingAfterFail1[0].payload).toEqual({ storyId: 'story-9000', progressPercentage: 99 });
      expect(pendingAfterFail1[0].retryCount).toBe(1);

      // Immediate preparePushBatch at now should skip it because backoff is active
      const now = Date.now();
      const immediateBatch = await queue.preparePushBatch({ now });
      expect(immediateBatch).toHaveLength(0);

      // Once backoff passes (e.g. now + 1500ms), it is included again
      const delayedBatch = await queue.preparePushBatch({ now: now + 1500 });
      expect(delayedBatch).toHaveLength(1);
      expect(delayedBatch[0].mutationId).toBe('mut-net-retry');

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
    });
  });

  describe('6. Worker Authority & In-Flight Batch Protection', () => {
    it('prevents concurrent double-pushing by tracking in-flight mutation IDs', async () => {
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-inf-1' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-inf-2' }));

      // First caller prepares batch
      const batch1 = await queue.preparePushBatch({ limit: 1 });
      expect(batch1).toHaveLength(1);
      expect(batch1[0].mutationId).toBe('mut-inf-1');

      // Concurrent caller prepares batch: mut-inf-1 is in-flight, so only mut-inf-2 is returned
      const batch2 = await queue.preparePushBatch({ limit: 1 });
      expect(batch2).toHaveLength(1);
      expect(batch2[0].mutationId).toBe('mut-inf-2');

      // Third caller: both are in-flight, returns empty
      const batch3 = await queue.preparePushBatch({ limit: 1 });
      expect(batch3).toHaveLength(0);

      // If network call aborts, release in-flight
      queue.releaseInFlight(batch1);
      const batchAfterRelease = await queue.preparePushBatch({ limit: 1 });
      expect(batchAfterRelease).toHaveLength(1);
      expect(batchAfterRelease[0].mutationId).toBe('mut-inf-1');
    });

    it('aborts push preparation and releases in-flight when leaderSignal is aborted', async () => {
      const queue = new MutationQueue({ ownerScope: scopeA, dbClient });
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-abort-1' }));

      const abortController = new AbortController();
      abortController.abort('Tab Leader stepped down');

      // preparePushBatch returns empty immediately when signal is already aborted
      const batch = await queue.preparePushBatch({ leaderSignal: abortController.signal });
      expect(batch).toHaveLength(0);

      // If signal aborts during processServerBatchResults
      const normalBatch = await queue.preparePushBatch();
      expect(normalBatch).toHaveLength(1);

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
    it('accurately computes and returns queue diagnostic status', async () => {
      const queue = new MutationQueue({
        ownerScope: scopeA,
        dbClient,
        maxRetries: 5,
        initialBackoffMs: 5000,
      });

      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-1' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-2' }));
      await queue.enqueue(createDummyMutation({ mutationId: 'mut-stat-3' }));

      // Prepare 1 item into in-flight
      const batch = await queue.preparePushBatch({ limit: 1 });
      expect(batch).toHaveLength(1);

      // Put 1 item in backoff
      await queue.handleNetworkFailure(batch, new Error('Transient error'));

      // Quarantine 1 item
      await queue.quarantine('mut-stat-2', 'Manual test quarantine');

      const status = await queue.getStatus();
      expect(status.ownerScope).toBe(scopeA);
      expect(status.pendingCount).toBe(2); // mut-stat-1 (backoff), mut-stat-3 (ready)
      expect(status.quarantinedCount).toBe(1); // mut-stat-2
      expect(status.inBackoffCount).toBe(1); // mut-stat-1
      expect(status.inFlightCount).toBe(0);
    });
  });
});
