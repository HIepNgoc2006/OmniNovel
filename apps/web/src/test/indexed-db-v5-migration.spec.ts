import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  DB_VERSION,
  GLOBAL_HISTORY_SENTINEL,
  STORE_BOOKMARKS,
  STORE_PROGRESS,
  STORE_HISTORY,
  STORE_PREFERENCES,
  STORE_SYNC_META,
  STORE_PENDING_MUTATIONS,
  STORE_QUARANTINED_MUTATIONS,
  STORE_SNAPSHOT_STAGING,
  STORE_AUTHORITATIVE_REPLICAS,
  STORE_TOMBSTONES,
  LocalSyncMeta,
  InvalidDeltaPayloadError,
  ReadyStatusTransitionForbiddenError,
} from '../lib/storage/indexed-db-client';
import {
  SyncProjectionHydrator,
  hydrateProjectionFromIndexedDb,
} from '../lib/sync/projection-hydrator';
import {
  MutationQueue,
  RequeueProhibitedError,
  createStaticIdentityProvider,
} from '../lib/sync/mutation-queue';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  SyncChangesResponse,
} from '@omninovel/shared';

/**
 * Test-only fixture helper to seed an already-READY scope directly into sync_meta so we can
 * verify hydrator/materializer & P1-01 durable tombstone reload behavior WITHOUT unlocking READY
 * transitions in production DAL (Task 9: READY remains locked via ReadyStatusTransitionForbiddenError).
 */
async function seedRawReadySyncMeta(
  client: IndexedDbClient,
  meta: LocalSyncMeta,
): Promise<void> {
  const db = await client.getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SYNC_META, 'readwrite');
    tx.objectStore(STORE_SYNC_META).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('Phase 5.2b P1-01 — Durable STORE_TOMBSTONES (IDB v5), Migration, Bounded GC & Regression Matrix (P1-01-R1..R8)', () => {
  let dbClient: IndexedDbClient;

  beforeEach(async () => {
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

  describe('P1-01-R1: Non-Epoch Delete Persistence Across Reload (BOOKMARK / PROGRESS / PREFERENCE)', () => {
    it('suppresses stale offline UPSERTs (baseRev=70) after DELETE@80 across full DB close & reload without options.tombstoneRevisions', async () => {
      const scope = 'account:usr-p1-01-r1';

      // Seed active shadows & legacy records at checkpoint 50, plus READY test fixture
      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'bm-del-1',
        title: 'Legacy Bookmark Deleted Remotely',
        createdAt: '2026-11-01T00:00:00.000Z',
      });
      await dbClient.putProgress({
        ownerScope: scope,
        storyId: 'prog-del-1',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        progressPercentage: 45,
        scrollPosition: 100,
        pageIndex: 1,
        updatedAt: '2026-11-01T00:00:00.000Z',
        deviceTimestamp: 1730419200000,
      });
      await dbClient.putPreference({
        ownerScope: scope,
        key: 'pref-del-1',
        value: 'sepia',
        updatedAt: '2026-11-01T00:00:00.000Z',
      });

      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-del-1',
        serverRevision: '50',
        epoch: 0,
        payload: { storyId: 'bm-del-1', title: 'Server Bookmark' },
        isDeleted: false,
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'prog-del-1',
        serverRevision: '50',
        epoch: 0,
        payload: { storyId: 'prog-del-1', chapterId: 'chap-1', progressPercentage: 45 },
        isDeleted: false,
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PREFERENCE,
        entityKey: 'pref-del-1',
        serverRevision: '50',
        epoch: 0,
        payload: { key: 'pref-del-1', value: 'sepia' },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      // Stale offline pending mutations created at baseServerRevision = 70 (< 80)
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-bm-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-del-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'bm-del-1', title: 'Stale Resurrected Bookmark' },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-prog-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'prog-del-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'prog-del-1', chapterId: 'chap-2', progressPercentage: 80 },
        createdAt: '2026-11-01T01:01:00.000Z',
        retryCount: 0,
      });
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-pref-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PREFERENCE,
        entityId: 'pref-del-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { key: 'pref-del-1', value: 'dark' },
        createdAt: '2026-11-01T01:02:00.000Z',
        retryCount: 0,
      });

      // Authoritative delta DELETE@80 arrives for all three non-epoch domains
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '82',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '78',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-del-1',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'bm-del-1' },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
            {
              revision: '79',
              domain: SyncDomain.PROGRESS,
              entityId: 'prog-del-1',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'prog-del-1' },
              createdAt: '2026-11-01T02:00:01.000Z',
            },
            {
              revision: '80',
              domain: SyncDomain.PREFERENCE,
              entityId: 'pref-del-1',
              operation: SyncOperation.DELETE,
              payload: { key: 'pref-del-1' },
              createdAt: '2026-11-01T02:00:02.000Z',
            },
          ],
        },
      });

      // Simulate full F5 page reload: close client and create brand-new instances with no RAM state
      dbClient.close();
      const reloadedClient = new IndexedDbClient();
      try {
        const tombBm = await reloadedClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-del-1');
        const tombProg = await reloadedClient.getAuthoritativeTombstone(scope, SyncDomain.PROGRESS, 'prog-del-1');
        const tombPref = await reloadedClient.getAuthoritativeTombstone(scope, SyncDomain.PREFERENCE, 'pref-del-1');
        expect(tombBm?.deletedAtRevision).toBe('78');
        expect(tombProg?.deletedAtRevision).toBe('79');
        expect(tombPref?.deletedAtRevision).toBe('80');

        const hydrator = new SyncProjectionHydrator(reloadedClient);
        // CRITICAL: no options.tombstoneRevisions supplied!
        const hydrated = await hydrator.hydrateScope(scope);

        expect(hydrated.mode).toBe('AUTHORITATIVE_PROJECTION');
        expect(hydrated.bookmarks).toHaveLength(0);
        expect(hydrated.progress).toHaveLength(0);
        expect(hydrated.preferences).toHaveLength(0);
        expect(hydrated.suppressedMutationCount).toBe(3);

        // Materialization cleans up stale legacy stores in single atomic readwrite tx
        const matResult = await hydrator.materializeToLegacyStores(scope);
        expect(matResult.materialized).toBe(true);
        expect(matResult.deletedCounts.bookmarks).toBe(1);
        expect(matResult.deletedCounts.progress).toBe(1);
        expect(matResult.deletedCounts.preferences).toBe(1);

        expect(await reloadedClient.getBookmark(scope, 'bm-del-1')).toBeNull();
        expect(await reloadedClient.getProgress(scope, 'prog-del-1')).toBeNull();
        expect(await reloadedClient.getPreference(scope, 'pref-del-1')).toBeNull();
      } finally {
        reloadedClient.close();
      }
    });
  });

  describe('P1-01-R2: Epoch-less PROGRESS vs HISTORY DELETE Across Reload (Rev 2.2 P0-05)', () => {
    it('blocks epoch-less offline PROGRESS(baseRev=70) after story/global HISTORY DELETE@80 across reload, while allowing baseRev=80', async () => {
      const scope = 'account:usr-p1-01-r2';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Stale epoch-less PROGRESS mutation (baseRev=70 < HISTORY tombstone 80)
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-prog-stale-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-hist-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        // Note: observedHistoryEpoch intentionally omitted (legacy / StoriesService client shape)
        payload: { storyId: 'story-hist-1', chapterId: 'chap-old', progressPercentage: 33 },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      // Apply story-wide HISTORY DELETE@80 (epoch=1)
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '80',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.HISTORY,
              entityId: 'story-hist-1',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-hist-1', epoch: 1 },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
          ],
        },
      });

      // Simulate F5 reload
      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        const tomb = await reloaded.getAuthoritativeTombstone(scope, SyncDomain.HISTORY, 'story-hist-1');
        expect(tomb?.deletedAtRevision).toBe('80');
        expect(tomb?.epoch).toBe(1);

        const resAfterDelete = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(resAfterDelete.progress).toHaveLength(0);
        expect(resAfterDelete.suppressedMutationCount).toBe(1);

        // Also enqueue a stale explicit-epoch PROGRESS(baseRev=80, observedHistoryEpoch=0) -> blocked by epoch=0 < 1
        await reloaded.enqueuePendingMutation({
          ownerScope: scope,
          mutationId: 'mut-prog-stale-epoch0',
          clientId: 'web-tab-1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-hist-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '80',
          payload: {
            storyId: 'story-hist-1',
            chapterId: 'chap-stale-e0',
            progressPercentage: 40,
            observedHistoryEpoch: 0,
          },
          createdAt: '2026-11-01T02:30:00.000Z',
          retryCount: 0,
        });

        // Fresh PROGRESS at baseRev=80 (post-delete observation) -> allowed normally
        await reloaded.enqueuePendingMutation({
          ownerScope: scope,
          mutationId: 'mut-prog-fresh-80',
          clientId: 'web-tab-1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-hist-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '80',
          payload: { storyId: 'story-hist-1', chapterId: 'chap-fresh', progressPercentage: 65 },
          createdAt: '2026-11-01T03:00:00.000Z',
          retryCount: 0,
        });

        const resWithFresh = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(resWithFresh.suppressedMutationCount).toBe(2); // baseRev=70 and epoch=0 both suppressed
        expect(resWithFresh.progress).toHaveLength(1);
        expect(resWithFresh.progress[0].chapterId).toBe('chap-fresh');
        expect(resWithFresh.progress[0].progressPercentage).toBe(65);
        expect(resWithFresh.progress[0].source).toBe('PENDING');
      } finally {
        reloaded.close();
      }
    });

    it('blocks epoch-less offline PROGRESS(baseRev=70) after GLOBAL HISTORY DELETE@80 across reload', async () => {
      const scope = 'account:usr-p1-01-r2-global';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-global-prog-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'any-story',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'any-story', chapterId: 'chap-old', progressPercentage: 50 },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '80',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.HISTORY,
              entityId: 'all',
              operation: SyncOperation.DELETE,
              payload: { epoch: 2 },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
          ],
        },
      });

      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        const globalTomb = await reloaded.getAuthoritativeTombstone(
          scope,
          SyncDomain.HISTORY,
          GLOBAL_HISTORY_SENTINEL,
        );
        expect(globalTomb?.deletedAtRevision).toBe('80');
        expect(globalTomb?.epoch).toBe(2);

        const hydrated = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(hydrated.progress).toHaveLength(0);
        expect(hydrated.suppressedMutationCount).toBe(1);
      } finally {
        reloaded.close();
      }
    });
  });

  describe('P1-01-R3: DELETE@80 -> UPSERT@85 vs Pending(baseRev=70) Lineage Preservation', () => {
    it('preserves tombstone rev="80" after re-creation UPSERT@85 across pages and suppresses Pending(baseRev=70) across reload', async () => {
      const scope = 'account:usr-p1-01-r3-multipage';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Stale legacy bookmark existing before DELETE@80 -> UPSERT@85
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-reup',
        title: 'Legacy Title Before Delete',
        createdAt: '2026-11-01T00:00:00.000Z',
      });

      // Stale offline bookmark edit based on rev=70 (before DELETE@80)
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-stale-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-reup',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'story-reup', title: 'Stale Title From Offline Tab (rev 70)' },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      // Page 1: DELETE@80
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '82',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-reup',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-reup' },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
          ],
        },
      });

      // Page 2: UPSERT@85 re-creates entity on server!
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '82',
        page: {
          currentServerRevision: '85',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '85',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-reup',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-reup', title: 'Authoritative Title @85' },
              createdAt: '2026-11-01T03:00:00.000Z',
            },
          ],
        },
      });

      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        // Independent STORE_TOMBSTONES retains deletedAtRevision='80' while shadow holds rev='85'
        const tomb = await reloaded.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'story-reup');
        const shadow = await reloaded.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-reup');
        expect(tomb?.deletedAtRevision).toBe('80');
        expect(shadow?.serverRevision).toBe('85');

        // Verify Task 4: hydrateScope() & materializeToLegacyStores() each lock STORE_TOMBSTONES in ONE single IDB transaction
        const rawDb = await reloaded.getDatabase();
        const txSpy = vi.spyOn(rawDb, 'transaction');
        const hydrator = new SyncProjectionHydrator(reloaded);

        const hydrated = await hydrator.hydrateScope(scope);
        expect(txSpy).toHaveBeenCalledTimes(1);
        expect(txSpy.mock.calls[0][0]).toEqual(expect.arrayContaining([STORE_TOMBSTONES]));
        expect(txSpy.mock.calls[0][0]).toHaveLength(8);
        expect(txSpy.mock.calls[0][1]).toBe('readonly');

        expect(hydrated.suppressedMutationCount).toBe(1);
        expect(hydrated.bookmarks).toHaveLength(1);
        expect(hydrated.bookmarks[0].title).toBe('Authoritative Title @85');
        expect(hydrated.bookmarks[0].source).toBe('SHADOW');

        txSpy.mockClear();
        const matResult = await hydrator.materializeToLegacyStores(scope);
        expect(txSpy).toHaveBeenCalledTimes(1);
        expect(txSpy.mock.calls[0][0]).toEqual(expect.arrayContaining([STORE_TOMBSTONES]));
        expect(txSpy.mock.calls[0][0]).toHaveLength(8);
        expect(txSpy.mock.calls[0][1]).toBe('readwrite');
        txSpy.mockRestore();

        expect(matResult.materialized).toBe(true);
        expect(matResult.preservedPendingKeys).toEqual([]);
        expect((await reloaded.getBookmark(scope, 'story-reup'))?.title).toBe('Authoritative Title @85');

        // A valid pending edit created AFTER observing @85 overrides cleanly
        await reloaded.enqueuePendingMutation({
          ownerScope: scope,
          mutationId: 'mut-fresh-85',
          clientId: 'web-tab-1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-reup',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '85',
          payload: { storyId: 'story-reup', title: 'Fresh Valid Edit @85' },
          createdAt: '2026-11-01T04:00:00.000Z',
          retryCount: 0,
        });

        const hydratedWithFresh = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(hydratedWithFresh.suppressedMutationCount).toBe(1);
        expect(hydratedWithFresh.bookmarks[0].title).toBe('Fresh Valid Edit @85');
        expect(hydratedWithFresh.bookmarks[0].source).toBe('PENDING');
      } finally {
        reloaded.close();
      }
    });

    it('preserves delete lineage within the SAME delta page [DELETE@80, UPSERT@85] across reload', async () => {
      const scope = 'account:usr-p1-01-r3-samepage';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-prog-stale-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-reup-prog',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'story-reup-prog', chapterId: 'chap-old', progressPercentage: 10 },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '85',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-reup-prog',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-reup-prog' },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
            {
              revision: '85',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-reup-prog',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-reup-prog', chapterId: 'chap-reborn', progressPercentage: 92 },
              createdAt: '2026-11-01T02:05:00.000Z',
            },
          ],
        },
      });

      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        expect(
          (await reloaded.getAuthoritativeTombstone(scope, SyncDomain.PROGRESS, 'story-reup-prog'))
            ?.deletedAtRevision,
        ).toBe('80');

        const hydrated = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(hydrated.suppressedMutationCount).toBe(1);
        expect(hydrated.progress).toHaveLength(1);
        expect(hydrated.progress[0].chapterId).toBe('chap-reborn');
        expect(hydrated.progress[0].progressPercentage).toBe(92);
        expect(hydrated.progress[0].source).toBe('SHADOW');
      } finally {
        reloaded.close();
      }
    });
  });

  describe('P1-01-R4: Intra-Page HISTORY DELETE@80 + UPSERT@85 + Epoch-less PROGRESS@85 Cursor Hazard & Epoch Boundary', () => {
    it('prevents FIFO cursor delete from wiping post-delete HISTORY@85 and applies temporary client compatibility epoch inference for epoch-less PROGRESS@85', async () => {
      const scope = 'account:usr-p1-01-r4-story';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Seed preexisting IDB shadows for story-1 (to be deleted by cursor) and story-other (untouched)
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-1:chap-legacy',
        serverRevision: '40',
        epoch: 0,
        payload: { storyId: 'story-1', chapterId: 'chap-legacy', storyTitle: 'Story 1', progressPercentage: 50 },
        isDeleted: false,
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-1',
        serverRevision: '41',
        epoch: 0,
        payload: { storyId: 'story-1', chapterId: 'chap-legacy', progressPercentage: 50 },
        isDeleted: false,
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-other:chap-1',
        serverRevision: '42',
        epoch: 0,
        payload: { storyId: 'story-other', chapterId: 'chap-1', storyTitle: 'Other Story', progressPercentage: 100 },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      // Stale offline pending mutations at baseRev=70, epoch=0
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-hist-stale-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.HISTORY,
        entityId: 'story-1:chap-stale',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'story-1', chapterId: 'chap-stale', progressPercentage: 25, observedHistoryEpoch: 0 },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-prog-stale-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'story-1', chapterId: 'chap-stale', progressPercentage: 25 },
        createdAt: '2026-11-01T01:01:00.000Z',
        retryCount: 0,
      });

      // Single delta page containing HISTORY DELETE@80 (epoch=1) followed by HISTORY UPSERT@85 (epoch=1)
      // and StoriesService epoch-less PROGRESS UPSERT@86
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '86',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '75',
              domain: SyncDomain.HISTORY,
              entityId: 'story-1:chap-inpage-old',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-1', chapterId: 'chap-inpage-old', storyTitle: 'Story 1', progressPercentage: 30, observedHistoryEpoch: 0 },
              createdAt: '2026-11-01T01:30:00.000Z',
            },
            {
              revision: '80',
              domain: SyncDomain.HISTORY,
              entityId: 'story-1',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-1', epoch: 1 },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
            {
              revision: '85',
              domain: SyncDomain.HISTORY,
              entityId: 'story-1:chap-new',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-1', chapterId: 'chap-new', storyTitle: 'Story 1', progressPercentage: 88, observedHistoryEpoch: 1 },
              createdAt: '2026-11-01T02:05:00.000Z',
            },
            {
              revision: '86',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-1',
              operation: SyncOperation.UPSERT,
              // No observedHistoryEpoch or epoch field -> StoriesService compatibility shape
              payload: { storyId: 'story-1', chapterId: 'chap-new', progressPercentage: 88 },
              createdAt: '2026-11-01T02:06:00.000Z',
            },
          ],
        },
      });

      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        // Legacy & in-page pre-delete chapter shadows wiped; post-delete @85/@86 survived!
        expect(await reloaded.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-1:chap-legacy')).toBeNull();
        expect(await reloaded.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-1:chap-inpage-old')).toBeNull();
        expect(await reloaded.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-other:chap-1')).not.toBeNull();

        const progShadow = await reloaded.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-1');
        expect(progShadow?.serverRevision).toBe('86');
        expect(progShadow?.epoch).toBe(1); // Compatible fallback inferred local effective epoch 1

        const hydrated = await hydrateProjectionFromIndexedDb(reloaded, scope);
        expect(hydrated.suppressedMutationCount).toBe(2);
        expect(hydrated.effectiveHistoryEpochs['story-1']).toBe(1);

        const story1Hist = hydrated.history.filter((h) => h.storyId === 'story-1');
        expect(story1Hist).toHaveLength(1);
        expect(story1Hist[0].chapterId).toBe('chap-new');
        expect(story1Hist[0].source).toBe('SHADOW');

        expect(hydrated.progress).toHaveLength(1);
        expect(hydrated.progress[0].chapterId).toBe('chap-new');
        expect(hydrated.progress[0].progressPercentage).toBe(88);
        expect(hydrated.progress[0].epoch).toBe(1);
        expect(hydrated.progress[0].source).toBe('SHADOW');
      } finally {
        reloaded.close();
      }
    });

    it('handles Global HISTORY DELETE@80 + post-delete HISTORY/PROGRESS@85 in the SAME page and keeps explicit epoch=0 fail-closed', async () => {
      const scope = 'account:usr-p1-01-r4-global-and-explicit0';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-g:chap-old',
        serverRevision: '40',
        epoch: 0,
        payload: { storyId: 'story-g', chapterId: 'chap-old', progressPercentage: 10 },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '87',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.HISTORY,
              entityId: GLOBAL_HISTORY_SENTINEL,
              operation: SyncOperation.DELETE,
              payload: { epoch: 2 },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
            {
              revision: '85',
              domain: SyncDomain.HISTORY,
              entityId: 'story-g:chap-new',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-g', chapterId: 'chap-new', storyTitle: 'Global Reborn', progressPercentage: 77, observedHistoryEpoch: 2 },
              createdAt: '2026-11-01T02:01:00.000Z',
            },
            {
              revision: '86',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-g',
              operation: SyncOperation.UPSERT,
              // Epoch-less -> temporary compatibility inference inherits global epoch 2
              payload: { storyId: 'story-g', chapterId: 'chap-new', progressPercentage: 77 },
              createdAt: '2026-11-01T02:02:00.000Z',
            },
            {
              revision: '87',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-explicit-stale-0',
              operation: SyncOperation.UPSERT,
              // Explicit numeric 0 -> MUST NOT be overwritten by compatibility inference; must fail-closed (0 < 2)
              payload: { storyId: 'story-explicit-stale-0', chapterId: 'chap-1', progressPercentage: 55, observedHistoryEpoch: 0 },
              createdAt: '2026-11-01T02:03:00.000Z',
            },
          ],
        },
      });

      dbClient.close();
      const reloaded = new IndexedDbClient();
      try {
        expect(await reloaded.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-g:chap-old')).toBeNull();
        expect(
          (await reloaded.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-explicit-stale-0'))?.epoch,
        ).toBe(0);

        const hydrated = await hydrateProjectionFromIndexedDb(reloaded, scope);
        // story-g survived with inferred compat epoch 2; story-explicit-stale-0 failed closed because 0 < 2
        expect(hydrated.history.map((h) => h.chapterId)).toEqual(['chap-new']);
        expect(hydrated.progress.map((p) => p.storyId)).toEqual(['story-g']);
        expect(hydrated.progress[0].epoch).toBe(2);
      } finally {
        reloaded.close();
      }
    });
  });

  describe('P1-01-R5: Bounded Atomic GC (minActiveRevision, Quarantine, DISCARDED, Slow-Tab & Fail-Closed Guards)', () => {
    it('(a) retains tombstone >= floor when pending or non-discarded quarantined mutations exist at baseRev=70', async () => {
      const scope = 'account:usr-p1-01-r5a';
      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '80',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-60',
        deletedAtRevision: '60',
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-80',
        deletedAtRevision: '80',
        updatedAt: Date.now(),
      });

      // Non-discarded quarantined (PENDING triageStatus) at baseRev=70
      await dbClient.quarantineMutation({
        ownerScope: scope,
        mutationId: 'q-pending-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-80',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'bm-80' },
        rejectionReason: 'HTTP_410_GONE',
        rejectionStatus: 'HTTP_410_GONE',
        rejectedAt: '2026-11-01T01:00:00.000Z',
        triageStatus: 'PENDING',
      });

      const gcRes = await dbClient.gcAuthoritativeTombstones(scope);
      expect(gcRes.safeGcFloor).toBe('70');
      expect(gcRes.scannedCount).toBe(2);
      expect(gcRes.deletedCount).toBe(1); // bm-60 <= 70 deleted
      expect(gcRes.retainedCount).toBe(1); // bm-80 > 70 retained

      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-60')).toBeNull();
      expect(
        (await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-80'))?.deletedAtRevision,
      ).toBe('80');
    });

    it('(b) retains tombstone="80" when queues are empty but minActiveRevision="60" < "80" (slow-tab protection)', async () => {
      const scope = 'account:usr-p1-01-r5b';
      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '60',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'prog-80',
        deletedAtRevision: '80',
        updatedAt: Date.now(),
      });

      const gcRes = await dbClient.gcAuthoritativeTombstones(scope);
      expect(gcRes.safeGcFloor).toBe('60');
      expect(gcRes.deletedCount).toBe(0);
      expect(gcRes.retainedCount).toBe(1);
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.PROGRESS, 'prog-80')).not.toBeNull();
    });

    it('(c) & (d) ignores DISCARDED quarantine entries, evicts tombstone <= minActiveRevision="100", preserves requeue-able quarantine floor, and permits post-GC baseRev=100 mutations', async () => {
      const scope = 'account:usr-p1-01-r5cd';
      const otherScope = 'account:usr-p1-01-r5-other';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '100',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Another scope has an old pending mutation at baseRev=10 -> MUST NOT pin `scope` GC
      await dbClient.enqueuePendingMutation({
        ownerScope: otherScope,
        mutationId: 'other-mut-10',
        clientId: 'web-tab-2',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-keep',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-keep' },
        createdAt: '2026-11-01T00:30:00.000Z',
        retryCount: 0,
      });
      await dbClient.putAuthoritativeTombstone({
        ownerScope: otherScope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'other-tomb-20',
        deletedAtRevision: '20',
        updatedAt: Date.now(),
      });

      // Quarantine DISCARDED item with old baseRev=50 (must NOT pin `scope` GC!)
      await dbClient.quarantineMutation({
        ownerScope: scope,
        mutationId: 'q-discarded-50',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-gc-80',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '50',
        payload: { storyId: 'bm-gc-80', title: 'Discarded Offline Edit' },
        rejectionReason: 'REJECTED_TOMBSTONE',
        rejectionStatus: 'REJECTED_TOMBSTONE',
        rejectedAt: '2026-11-01T01:00:00.000Z',
        triageStatus: 'DISCARDED',
      });

      // Requeue-able quarantined mutation (transient NETWORK_ERROR, baseRev=75) pins GC while in quarantine AND after requeue
      await dbClient.quarantineMutation({
        ownerScope: scope,
        mutationId: 'q-transient-75',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-keep-90',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '75',
        payload: { storyId: 'bm-keep-90', title: 'Transient Failure' },
        rejectionReason: 'EXCEEDED_MAX_RETRIES',
        rejectionStatus: 'EXCEEDED_MAX_RETRIES',
        rejectedAt: '2026-11-01T01:05:00.000Z',
        triageStatus: 'PENDING',
      });

      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-gc-80',
        deletedAtRevision: '80',
        updatedAt: Date.now(),
      });

      // While q-transient-75 (non-discarded) exists, floor=75 -> '80' retained
      const whilePendingQuarantined = await dbClient.gcAuthoritativeTombstones(scope);
      expect(whilePendingQuarantined.safeGcFloor).toBe('75');
      expect(whilePendingQuarantined.retainedCount).toBe(1);

      // P1-B watermark lock: q-transient-75 (baseRev=75 < minActiveRevision=100) cannot be requeued directly
      await expect(dbClient.requeueQuarantinedMutation(scope, 'q-transient-75')).rejects.toThrow(
        /REQUEUE_PROHIBITED/,
      );

      // Move baseRev=75 check to pending_mutations explicitly to verify pending-queue GC floor, then clear it
      await dbClient.deleteQuarantinedMutation(scope, 'q-transient-75');
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'p-transient-75',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-keep-90',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '75',
        payload: { storyId: 'bm-keep-90', title: 'Transient Failure' },
        createdAt: '2026-11-01T01:05:00.000Z',
        retryCount: 0,
      });
      expect((await dbClient.gcAuthoritativeTombstones(scope)).safeGcFloor).toBe('75');

      await dbClient.deletePendingMutation(scope, 'p-transient-75');

      // Requeue-able transient mutation at baseRev=100 (>= minActiveRevision=100) still requeues cleanly
      await dbClient.quarantineMutation({
        ownerScope: scope,
        mutationId: 'q-transient-100',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-valid-100',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: { storyId: 'bm-valid-100', title: 'Valid Requeue At Watermark' },
        rejectionReason: 'EXCEEDED_MAX_RETRIES',
        rejectionStatus: 'EXCEEDED_MAX_RETRIES',
        rejectedAt: '2026-11-01T01:06:00.000Z',
        triageStatus: 'PENDING',
      });
      await dbClient.requeueQuarantinedMutation(scope, 'q-transient-100');
      expect(await dbClient.getPendingMutation(scope, 'q-transient-100')).not.toBeNull();
      await dbClient.deletePendingMutation(scope, 'q-transient-100');

      // APPROVED quarantined entry (baseRev=78) ALSO pins safeGcFloor (only DISCARDED is excluded)
      await dbClient.quarantineMutation({
        ownerScope: scope,
        mutationId: 'q-approved-78',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-approved-90',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '78',
        payload: { storyId: 'bm-approved-90', title: 'Approved Triage Entry' },
        rejectionReason: 'MANUAL',
        rejectionStatus: 'MANUAL',
        rejectedAt: '2026-11-01T01:10:00.000Z',
        triageStatus: 'APPROVED',
      });
      const whileApprovedQuarantined = await dbClient.gcAuthoritativeTombstones(scope);
      expect(whileApprovedQuarantined.safeGcFloor).toBe('78');
      expect(whileApprovedQuarantined.retainedCount).toBe(1);
      await dbClient.deleteQuarantinedMutation(scope, 'q-approved-78');

      // Now only DISCARDED@50 remains -> floor='100' -> '80' evicted atomically!
      const gcRes = await dbClient.gcAuthoritativeTombstones(scope);
      expect(gcRes.safeGcFloor).toBe('100');
      expect(gcRes.deletedCount).toBe(1);
      expect(gcRes.retainedCount).toBe(0);
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-gc-80')).toBeNull();

      // Other scope's tombstone untouched
      expect(await dbClient.getAuthoritativeTombstone(otherScope, SyncDomain.BOOKMARK, 'other-tomb-20')).not.toBeNull();

      // (d) New mutation created at baseRev='100' after GC works cleanly
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-post-gc-100',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-gc-80',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: { storyId: 'bm-gc-80', title: 'Recreated Post-GC Bookmark' },
        createdAt: '2026-11-01T04:00:00.000Z',
        retryCount: 0,
      });

      const hydrated = await hydrateProjectionFromIndexedDb(dbClient, scope);
      expect(hydrated.suppressedMutationCount).toBe(0);
      expect(hydrated.bookmarks).toHaveLength(1);
      expect(hydrated.bookmarks[0].title).toBe('Recreated Post-GC Bookmark');
      expect(hydrated.bookmarks[0].source).toBe('PENDING');
    });

    it('fails closed and aborts atomically on invalid revisions, revoked admission, or tx.abort()', async () => {
      const scope = 'account:usr-p1-01-r5-failclosed';
      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '100',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-1',
        deletedAtRevision: '50',
        updatedAt: Date.now(),
      });

      // 1. Invalid maxEvictableRevision
      await expect(
        dbClient.gcAuthoritativeTombstones(scope, { maxEvictableRevision: 'not-a-number' }),
      ).rejects.toThrow(InvalidDeltaPayloadError);
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-1')).not.toBeNull();

      // 2. Revoked admission
      await expect(
        dbClient.gcAuthoritativeTombstones(scope, {
          checkAdmission: () => {
            throw new Error('ADMISSION_REVOKED');
          },
        }),
      ).rejects.toThrow('ADMISSION_REVOKED');
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-1')).not.toBeNull();

      // 3. Aborted transaction
      await expect(
        dbClient.gcAuthoritativeTombstones(scope, {
          _testHookBeforeComplete: (tx) => tx.abort(),
        }),
      ).rejects.toThrow();
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-1')).not.toBeNull();

      // 4. Malformed baseServerRevision in pending_mutations aborts entire GC fail-closed
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'corrupt-mut',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-corrupt',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '12.34-corrupt',
        payload: { storyId: 'bm-corrupt' },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      await expect(dbClient.gcAuthoritativeTombstones(scope)).rejects.toThrow(InvalidDeltaPayloadError);
      expect(await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-1')).not.toBeNull();

      // 5. Corrupt deletedAtRevision on 2nd tombstone aborts fail-closed BEFORE evicting valid 1st tombstone '50'
      await dbClient.deletePendingMutation(scope, 'corrupt-mut');
      const rawDb = await dbClient.getDatabase();
      await new Promise<void>((resolve, reject) => {
        const wTx = rawDb.transaction(STORE_TOMBSTONES, 'readwrite');
        wTx.objectStore(STORE_TOMBSTONES).put({
          ownerScope: scope,
          domain: SyncDomain.BOOKMARK,
          entityKey: 'bm-zzz-corrupt',
          deletedAtRevision: 'bad-decimal-rev',
          updatedAt: Date.now(),
        });
        wTx.oncomplete = () => resolve();
        wTx.onerror = () => reject(wTx.error);
      });

      await expect(dbClient.gcAuthoritativeTombstones(scope)).rejects.toThrow(InvalidDeltaPayloadError);
      expect((await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-1'))?.deletedAtRevision).toBe(
        '50',
      );
    });
  });

  describe('P1-01-R6: Migration v4 -> v5 Fail-Closed Reset, 100% Data Preservation, READY Lock & Multi-Scope purgeScope()', () => {
    it('migrates v4 -> v5 preserving all 9 stores, unconditionally resetting READY/BOOTSTRAPPING to UNINITIALIZED, enforcing READY lock, and purging all 10 stores per scope', async () => {
      const scopeA = 'account:usr-v4-ready';
      const scopeB = 'account:usr-v4-keep';

      // Step 1: Manually build & populate a real v4 IndexedDB (9 object stores)
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 4);
        req.onupgradeneeded = () => {
          const v4Db = req.result;
          v4Db.createObjectStore(STORE_BOOKMARKS, { keyPath: ['ownerScope', 'storyId'] });
          v4Db.createObjectStore(STORE_PROGRESS, { keyPath: ['ownerScope', 'storyId'] });
          const histStore = v4Db.createObjectStore(STORE_HISTORY, { keyPath: ['ownerScope', 'storyId', 'chapterId'] });
          histStore.createIndex('by_owner_time', ['ownerScope', 'lastReadAt'], { unique: false });
          v4Db.createObjectStore(STORE_PREFERENCES, { keyPath: ['ownerScope', 'key'] });
          v4Db.createObjectStore(STORE_SYNC_META, { keyPath: 'ownerScope' });
          const pStore = v4Db.createObjectStore(STORE_PENDING_MUTATIONS, { keyPath: ['ownerScope', 'mutationId'] });
          pStore.createIndex('by_scope_created', ['ownerScope', 'createdAt'], { unique: false });
          const qStore = v4Db.createObjectStore(STORE_QUARANTINED_MUTATIONS, { keyPath: ['ownerScope', 'mutationId'] });
          qStore.createIndex('by_scope_rejected', ['ownerScope', 'rejectedAt'], { unique: false });
          const stStore = v4Db.createObjectStore(STORE_SNAPSHOT_STAGING, { keyPath: ['ownerScope', 'sessionId', 'domain', 'entityKey'] });
          stStore.createIndex('by_scope_session', ['ownerScope', 'sessionId'], { unique: false });
          const shStore = v4Db.createObjectStore(STORE_AUTHORITATIVE_REPLICAS, { keyPath: ['ownerScope', 'domain', 'entityKey'] });
          shStore.createIndex('by_scope_domain', ['ownerScope', 'domain'], { unique: false });
          shStore.createIndex('by_scope_revision', ['ownerScope', 'serverRevision'], { unique: false });
        };
        req.onsuccess = () => {
          const v4Db = req.result;
          const seedTx = v4Db.transaction(
            [
              STORE_BOOKMARKS,
              STORE_PROGRESS,
              STORE_HISTORY,
              STORE_PREFERENCES,
              STORE_SYNC_META,
              STORE_PENDING_MUTATIONS,
              STORE_QUARANTINED_MUTATIONS,
              STORE_SNAPSHOT_STAGING,
              STORE_AUTHORITATIVE_REPLICAS,
            ],
            'readwrite',
          );

          for (const sc of [scopeA, scopeB]) {
            seedTx.objectStore(STORE_BOOKMARKS).put({
              ownerScope: sc,
              storyId: 's-v4',
              title: `Title ${sc}`,
              createdAt: '2026-11-01T00:00:00.000Z',
            });
            seedTx.objectStore(STORE_PROGRESS).put({
              ownerScope: sc,
              storyId: 's-v4',
              chapterId: 'c-v4',
              readingMode: ReadingMode.WEBTOON,
              progressPercentage: 42,
              scrollPosition: 0,
              pageIndex: 1,
              deviceTimestamp: 1730419200000,
              updatedAt: '2026-11-01T00:00:00.000Z',
            });
            seedTx.objectStore(STORE_HISTORY).put({
              ownerScope: sc,
              storyId: 's-v4',
              chapterId: 'c-v4',
              storyTitle: `Title ${sc}`,
              chapterNumber: 1,
              progressPercentage: 42,
              lastReadAt: '2026-11-01T00:00:00.000Z',
            });
            seedTx.objectStore(STORE_PREFERENCES).put({
              ownerScope: sc,
              key: 'reader_theme',
              value: 'dark',
              updatedAt: '2026-11-01T00:00:00.000Z',
            });
            seedTx.objectStore(STORE_PENDING_MUTATIONS).put({
              ownerScope: sc,
              mutationId: `mut-${sc}`,
              clientId: 'c1',
              domain: SyncDomain.PROGRESS,
              entityId: 's-v4',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '120',
              payload: { storyId: 's-v4', chapterId: 'c-v4', progressPercentage: 60 },
              createdAt: '2026-11-01T01:00:00.000Z',
              retryCount: 0,
            });
            seedTx.objectStore(STORE_QUARANTINED_MUTATIONS).put({
              ownerScope: sc,
              mutationId: `q-${sc}`,
              clientId: 'c1',
              domain: SyncDomain.BOOKMARK,
              entityId: 's-v4',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '90',
              payload: {},
              rejectionReason: 'HTTP_410_GONE',
              rejectedAt: '2026-11-01T01:00:00.000Z',
              triageStatus: 'PENDING',
            });
            seedTx.objectStore(STORE_SNAPSHOT_STAGING).put({
              ownerScope: sc,
              sessionId: 'sess-v4',
              domain: SyncDomain.BOOKMARK,
              entityKey: 's-v4',
              payload: { title: 'Staged' },
              stagedAt: '2026-11-01T01:00:00.000Z',
            });
            seedTx.objectStore(STORE_AUTHORITATIVE_REPLICAS).put({
              ownerScope: sc,
              domain: SyncDomain.PROGRESS,
              entityKey: 's-v4',
              serverRevision: '150',
              epoch: 3,
              payload: { storyId: 's-v4', chapterId: 'c-v4', progressPercentage: 42 },
              isDeleted: false,
              updatedAt: Date.now(),
            });
          }

          // Scope A was READY in v4; Scope B was BOOTSTRAPPING in v4
          seedTx.objectStore(STORE_SYNC_META).put({
            ownerScope: scopeA,
            lastSyncedServerRevision: '180',
            minActiveRevision: '100',
            lastSyncTimestamp: '2026-11-01T05:00:00.000Z',
            effectiveHistoryEpochs: { 's-v4': 3 },
            syncState: 'IDLE',
            authoritativeBaselineStatus: 'READY',
          });
          seedTx.objectStore(STORE_SYNC_META).put({
            ownerScope: scopeB,
            lastSyncedServerRevision: '210',
            minActiveRevision: '120',
            lastSyncTimestamp: '2026-11-01T06:00:00.000Z',
            effectiveHistoryEpochs: { [GLOBAL_HISTORY_SENTINEL]: 4 },
            syncState: 'IDLE',
            authoritativeBaselineStatus: 'BOOTSTRAPPING',
          });

          seedTx.oncomplete = () => {
            v4Db.close();
            resolve();
          };
          seedTx.onerror = () => reject(seedTx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // Step 2: Upgrade v4 -> v5 via IndexedDbClient
      const db = await dbClient.getDatabase();
      expect(DB_VERSION).toBe(5);
      expect(db.version).toBe(5);
      expect(Array.from(db.objectStoreNames)).toHaveLength(10);
      expect(db.objectStoreNames.contains(STORE_TOMBSTONES)).toBe(true);

      const tombTx = db.transaction(STORE_TOMBSTONES, 'readonly');
      const tombStore = tombTx.objectStore(STORE_TOMBSTONES);
      expect(tombStore.keyPath).toEqual(['ownerScope', 'domain', 'entityKey']);
      expect(tombStore.indexNames.contains('by_scope_domain')).toBe(true);
      expect(Array.from(tombStore.indexNames)).toEqual(['by_scope_domain']); // Zero lexicographical revision index!

      // Step 3: Verify 100% data preservation + UNCONDITIONAL reset to UNINITIALIZED
      for (const sc of [scopeA, scopeB]) {
        expect((await dbClient.getBookmark(sc, 's-v4'))?.title).toBe(`Title ${sc}`);
        expect((await dbClient.getProgress(sc, 's-v4'))?.progressPercentage).toBe(42);
        expect(await dbClient.getHistory(sc)).toHaveLength(1);
        expect((await dbClient.getPreference(sc, 'reader_theme'))?.value).toBe('dark');
        expect(await dbClient.getPendingMutations(sc)).toHaveLength(1);
        expect(await dbClient.getQuarantinedMutation(sc, `q-${sc}`)).not.toBeNull();
        expect(await dbClient.getSnapshotStagingItems(sc, 'sess-v4')).toHaveLength(1);
        expect((await dbClient.getAuthoritativeShadow(sc, SyncDomain.PROGRESS, 's-v4'))?.serverRevision).toBe('150');
        expect(await dbClient.getAllAuthoritativeTombstones(sc)).toHaveLength(0);
      }

      const metaA = await dbClient.getSyncMeta(scopeA);
      expect(metaA?.authoritativeBaselineStatus).toBe('UNINITIALIZED');
      expect(metaA?.lastSyncedServerRevision).toBe('180');
      expect(metaA?.minActiveRevision).toBe('100');
      expect(metaA?.effectiveHistoryEpochs).toEqual({ 's-v4': 3 });

      const metaB = await dbClient.getSyncMeta(scopeB);
      expect(metaB?.authoritativeBaselineStatus).toBe('UNINITIALIZED');
      expect(metaB?.lastSyncedServerRevision).toBe('210');
      expect(metaB?.effectiveHistoryEpochs).toEqual({ [GLOBAL_HISTORY_SENTINEL]: 4 });

      // Step 4: Fail-closed hydration into DEGRADED_COMPATIBILITY + READY lock preserved (Task 9)
      expect(await dbClient.isAuthoritativeReady(scopeA)).toBe(false);
      const hydratedA = await hydrateProjectionFromIndexedDb(dbClient, scopeA);
      expect(hydratedA.mode).toBe('DEGRADED_COMPATIBILITY');
      expect(hydratedA.baselineStatus).toBe('UNINITIALIZED');

      await expect(dbClient.setAuthoritativeBaselineStatus(scopeA, 'READY')).rejects.toThrow(
        ReadyStatusTransitionForbiddenError,
      );
      await expect(
        dbClient.putSyncMeta({
          ownerScope: scopeA,
          lastSyncedServerRevision: '180',
          minActiveRevision: '100',
          lastSyncTimestamp: new Date().toISOString(),
          effectiveHistoryEpochs: { 's-v4': 3 },
          syncState: 'IDLE',
          authoritativeBaselineStatus: 'READY',
        }),
      ).rejects.toThrow(ReadyStatusTransitionForbiddenError);

      // Step 5: Seed STORE_TOMBSTONES for both scopes and verify multi-scope purgeScope(scopeA)
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scopeA,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-tomb-A',
        deletedAtRevision: '185',
        updatedAt: Date.now(),
      });
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scopeB,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-tomb-B',
        deletedAtRevision: '215',
        updatedAt: Date.now(),
      });

      await dbClient.purgeScope(scopeA);

      // scopeA wiped across all 10 stores (including STORE_TOMBSTONES)
      expect(await dbClient.getBookmark(scopeA, 's-v4')).toBeNull();
      expect(await dbClient.getProgress(scopeA, 's-v4')).toBeNull();
      expect(await dbClient.getHistory(scopeA)).toHaveLength(0);
      expect(await dbClient.getPreference(scopeA, 'reader_theme')).toBeNull();
      expect(await dbClient.getPendingMutations(scopeA)).toHaveLength(0);
      expect(await dbClient.getQuarantinedMutation(scopeA, `q-${scopeA}`)).toBeNull();
      expect(await dbClient.getSnapshotStagingItems(scopeA, 'sess-v4')).toHaveLength(0);
      expect(await dbClient.getAuthoritativeShadow(scopeA, SyncDomain.PROGRESS, 's-v4')).toBeNull();
      expect(await dbClient.getAllAuthoritativeTombstones(scopeA)).toHaveLength(0);
      expect(await dbClient.getSyncMeta(scopeA)).toBeNull();

      // scopeB untouched across all 10 stores
      expect(await dbClient.getBookmark(scopeB, 's-v4')).not.toBeNull();
      expect(await dbClient.getAllAuthoritativeTombstones(scopeB)).toHaveLength(1);
      expect((await dbClient.getAuthoritativeTombstone(scopeB, SyncDomain.BOOKMARK, 'bm-tomb-B'))?.deletedAtRevision).toBe('215');
      expect((await dbClient.getSyncMeta(scopeB))?.lastSyncedServerRevision).toBe('210');
    });
  });

  describe('P1-01-R7: Option Merge Monotonicity & Delta tx.abort() Atomic Rollback', () => {
    it('(a) maxBigInt preserves higher IDB tombstone="80" over caller override="50" while honoring disjoint override="95"', async () => {
      const scope = 'account:usr-p1-01-r7a';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-monotonic',
        deletedAtRevision: '80',
        updatedAt: Date.now(),
      });

      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-bm-70',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-monotonic',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'bm-monotonic', title: 'Should Be Suppressed By IDB 80' },
        createdAt: '2026-11-01T01:00:00.000Z',
        retryCount: 0,
      });

      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-pref-90',
        clientId: 'web-tab-1',
        domain: SyncDomain.PREFERENCE,
        entityId: 'reader_theme',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '90',
        payload: { key: 'reader_theme', value: 'sepia' },
        createdAt: '2026-11-01T01:01:00.000Z',
        retryCount: 0,
      });

      // Caller attempts to pass lower revision '50' for bm-monotonic and '95' for reader_theme
      const hydrated = await hydrateProjectionFromIndexedDb(dbClient, scope, {
        tombstoneRevisions: {
          [SyncDomain.BOOKMARK]: { 'bm-monotonic': '50' },
          [SyncDomain.PREFERENCE]: { reader_theme: '95' },
        },
      });

      // Both mutations are suppressed: bm-monotonic stays protected at max('80','50')='80'; reader_theme uses '95'
      expect(hydrated.bookmarks).toHaveLength(0);
      expect(hydrated.preferences).toHaveLength(0);
      expect(hydrated.suppressedMutationCount).toBe(2);
    });

    it('(b) aborts cleanly on mid-transaction tx.abort() leaving zero phantom tombstones or shadows', async () => {
      const scope = 'account:usr-p1-01-r7b';

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '50',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '40',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-seed',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'bm-seed', title: 'Seeded Title' },
              createdAt: '2026-11-01T00:00:00.000Z',
            },
          ],
        },
      });

      const abortedPage: SyncChangesResponse = {
        currentServerRevision: '90',
        minActiveRevision: '10',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '80',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-seed',
            operation: SyncOperation.DELETE,
            payload: { storyId: 'bm-seed' },
            createdAt: '2026-11-01T01:00:00.000Z',
          },
          {
            revision: '85',
            domain: SyncDomain.BOOKMARK,
            entityId: 'bm-phantom',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'bm-phantom', title: 'Phantom' },
            createdAt: '2026-11-01T01:01:00.000Z',
          },
          {
            revision: '86',
            domain: SyncDomain.HISTORY,
            entityId: 'story-x',
            operation: SyncOperation.DELETE,
            payload: { storyId: 'story-x', epoch: 1 },
            createdAt: '2026-11-01T01:02:00.000Z',
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: abortedPage,
          _testHookBeforeComplete: (tx) => tx.abort(),
        }),
      ).rejects.toThrow();

      // Prior checkpoint, prior shadow, zero tombstones, zero epochs preserved 100%
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('50');
      expect(meta?.effectiveHistoryEpochs).toEqual({});
      expect((await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-seed'))?.payload?.title).toBe(
        'Seeded Title',
      );
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'bm-phantom')).toBeNull();
      expect(await dbClient.getAllAuthoritativeTombstones(scope)).toHaveLength(0);
    });
  });

  describe('P1-01-R8: BigInt Numeric Revision Ordering & Monotonic Decrease Guard', () => {
    it('enforces 64-bit BigInt numeric ordering ("80" > "9", > MAX_SAFE_INTEGER) and never downgrades higher tombstone revisions', async () => {
      const scope = 'account:usr-p1-01-r8';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '0',
        minActiveRevision: '0',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Seed tombstone revision '9' -> lexicographically '9' > '80', numerically 80n > 9n!
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-num',
        deletedAtRevision: '9',
        updatedAt: Date.now(),
      });

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '80',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-num',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'bm-num' },
              createdAt: '2026-11-01T01:00:00.000Z',
            },
          ],
        },
      });

      const after80 = await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-num');
      expect(after80?.deletedAtRevision).toBe('80'); // Upgraded '9' -> '80'!

      // Attempt downgrade to '75' -> must be ignored monotonically!
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-num',
        deletedAtRevision: '75',
        updatedAt: Date.now(),
      });
      const after75 = await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-num');
      expect(after75?.deletedAtRevision).toBe('80');

      // Also verify applyAuthoritativeDeltaPage never downgrades higher pre-existing tombstone '90' with DELETE@85
      await dbClient.putAuthoritativeTombstone({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'bm-no-downgrade',
        deletedAtRevision: '90',
        updatedAt: Date.now(),
      });
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '80',
        page: {
          currentServerRevision: '86',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '85',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-no-downgrade',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'bm-no-downgrade' },
              createdAt: '2026-11-01T01:30:00.000Z',
            },
          ],
        },
      });
      expect(
        (await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-no-downgrade'))
          ?.deletedAtRevision,
      ).toBe('90');

      // Test precision above Number.MAX_SAFE_INTEGER (9007199254740991)
      const safePlus1 = '9007199254740992';
      const safePlus2 = '9007199254740993'; // Number(safePlus2) === Number(safePlus1) in IEEE-754 float!

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '86',
        page: {
          currentServerRevision: safePlus2,
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: safePlus2,
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-64bit',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'bm-64bit' },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
          ],
        },
      });

      const tomb64 = await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-64bit');
      expect(tomb64?.deletedAtRevision).toBe(safePlus2);

      // Pending at safePlus1 (9007199254740992 < 9007199254740993) MUST be suppressed cleanly!
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-64bit-stale',
        clientId: 'web-tab-1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-64bit',
        operation: SyncOperation.UPSERT,
        baseServerRevision: safePlus1,
        payload: { storyId: 'bm-64bit', title: 'Stale By 1 Bit' },
        createdAt: '2026-11-01T01:59:00.000Z',
        retryCount: 0,
      });

      const hydrated = await hydrateProjectionFromIndexedDb(dbClient, scope);
      expect(hydrated.bookmarks).toHaveLength(0);
      expect(hydrated.suppressedMutationCount).toBe(1);
    });
  });

  describe('P1-01-R9: End-to-End Post-GC Slow-Tab Stale Pending Remediation (P1-A & P1-B)', () => {
    it('suppresses slow-tab pending(baseRev=70) after DELETE@80 + GC@minActive=100 across reload, blocks push/requeue while preserving unconfirmed data in quarantine, and enforces DISCARDED guard', async () => {
      const scope = 'account:usr-p1-01-r9-main';
      const scopeOther = 'account:usr-p1-01-r9-other';

      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });
      await seedRawReadySyncMeta(dbClient, {
        ownerScope: scopeOther,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: '2026-11-01T00:00:00.000Z',
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
        authoritativeBaselineStatus: 'READY',
      });

      // Step 1: Delta delivers DELETE@80 (creates tombstone@80, checkpoint='105'), then minActiveRevision advances to 100
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '105',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.BOOKMARK,
              entityId: 'bm-postgc',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'bm-postgc' },
              createdAt: '2026-11-01T00:30:00.000Z',
            },
          ],
        },
      });
      expect(
        (await dbClient.getAuthoritativeTombstone(scope, SyncDomain.BOOKMARK, 'bm-postgc'))
          ?.deletedAtRevision,
      ).toBe('80');

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '105',
        page: {
          currentServerRevision: '120',
          minActiveRevision: '100',
          nextRevision: null,
          hasMore: false,
          changes: [],
        },
      });

      // Step 2: GC removes expired tombstone '80' because safeGcFloor='100'
      const gcRes = await dbClient.gcAuthoritativeTombstones(scope);
      expect(gcRes.deletedCount).toBe(1);
      expect(await dbClient.getAllAuthoritativeTombstones(scope)).toHaveLength(0);

      // Step 3: Slow tab wakes up and writes unconfirmed local bookmark + pending(baseRev=70)
      await dbClient.putBookmarkWithMutation(
        {
          ownerScope: scope,
          storyId: 'bm-postgc',
          title: 'Slow Tab Offline Edit',
          createdAt: '2026-11-01T00:10:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'mut-slow-tab-70',
          clientId: 'slow-tab-offline',
          domain: SyncDomain.BOOKMARK,
          entityId: 'bm-postgc',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '70',
          payload: { storyId: 'bm-postgc', title: 'Slow Tab Offline Edit', note: 'User draft' },
          createdAt: '2026-11-01T00:10:00.000Z',
          retryCount: 0,
        },
      );
      await dbClient.enqueuePendingMutation({
        ownerScope: scopeOther,
        mutationId: 'mut-other-70',
        clientId: 'other-tab',
        domain: SyncDomain.BOOKMARK,
        entityId: 'bm-other',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '70',
        payload: { storyId: 'bm-other', title: 'Valid in Other Scope' },
        createdAt: '2026-11-01T00:10:00.000Z',
        retryCount: 0,
      });

      // Step 4: Close DB and reopen to simulate browser reload
      dbClient.close();
      const reloadedClient = new IndexedDbClient();
      try {
        // Projection hides stale pending without tombstones AND materializer cleans legacy store
        const hydratedAfterReload = await hydrateProjectionFromIndexedDb(reloadedClient, scope);
        expect(hydratedAfterReload.mode).toBe('AUTHORITATIVE_PROJECTION');
        expect(hydratedAfterReload.baselineStatus).toBe('READY');
        expect(hydratedAfterReload.bookmarks).toHaveLength(0);
        expect(hydratedAfterReload.suppressedMutationCount).toBe(1);

        const hydrator = new SyncProjectionHydrator(reloadedClient);
        await hydrator.materializeToLegacyStores(scope);
        expect(await reloadedClient.getBookmark(scope, 'bm-postgc')).toBeNull();

        // Data is NOT silently deleted from queue before quarantine transfer
        expect(await reloadedClient.getPendingMutation(scope, 'mut-slow-tab-70')).not.toBeNull();

        // Step 5: Queue push preparation blocks push and atomically quarantines with sync_meta
        const queue = new MutationQueue({
          ownerScope: scope,
          identityStateProvider: createStaticIdentityProvider(scope),
          dbClient: reloadedClient,
        });
        const pushBatch = await queue.preparePushBatch();
        expect(pushBatch.mutations).toHaveLength(0);

        expect(await reloadedClient.getPendingMutation(scope, 'mut-slow-tab-70')).toBeNull();
        const quarantined = await reloadedClient.getQuarantinedMutation(scope, 'mut-slow-tab-70');
        expect(quarantined).not.toBeNull();
        expect(quarantined?.rejectionStatus).toBe('REJECTED_STALE');
        expect(quarantined?.triageStatus).toBe('PENDING');
        expect(quarantined?.payload).toEqual({
          storyId: 'bm-postgc',
          title: 'Slow Tab Offline Edit',
          note: 'User draft',
        });

        // Cross-scope isolation: scopeOther's baseRev=70 (>= minActiveRevision=10) untouched
        expect(await reloadedClient.getPendingMutation(scopeOther, 'mut-other-70')).not.toBeNull();
        expect(await reloadedClient.getQuarantinedMutations(scopeOther)).toHaveLength(0);

        // Step 6: Both watermark guard and DISCARDED guard prohibit requeue across reload
        await expect(queue.requeue('mut-slow-tab-70')).rejects.toThrow(RequeueProhibitedError);
        await expect(
          reloadedClient.requeueQuarantinedMutation(scope, 'mut-slow-tab-70'),
        ).rejects.toThrow(/REQUEUE_PROHIBITED/);

        // Transition record to DISCARDED (simulating user discard) and prove P1-A lock
        const rawDb = await reloadedClient.getDatabase();
        await new Promise<void>((resolve, reject) => {
          const wTx = rawDb.transaction(STORE_QUARANTINED_MUTATIONS, 'readwrite');
          wTx.objectStore(STORE_QUARANTINED_MUTATIONS).put({
            ...quarantined!,
            triageStatus: 'DISCARDED',
          });
          wTx.oncomplete = () => resolve();
          wTx.onerror = () => reject(wTx.error);
        });

        await expect(queue.requeue('mut-slow-tab-70')).rejects.toThrow(RequeueProhibitedError);
        await expect(
          reloadedClient.requeueQuarantinedMutation(scope, 'mut-slow-tab-70'),
        ).rejects.toThrow(/REQUEUE_PROHIBITED/);
        expect(await reloadedClient.getBookmark(scope, 'bm-postgc')).toBeNull();
        expect(await reloadedClient.getPendingMutation(scope, 'mut-slow-tab-70')).toBeNull();
      } finally {
        reloadedClient.close();
      }
    });
  });
});
