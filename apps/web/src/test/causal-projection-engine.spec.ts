import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  LocalBookmark,
  LocalReadingProgress,
  LocalReadingHistory,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  STORE_SYNC_META,
  LocalSyncMeta,
  LocalPendingMutation,
  LocalPreference,
  AuthoritativeShadowRecord,
  IndexedDbUnavailableError,
} from '../lib/storage/indexed-db-client';
import {
  UUID_SENTINEL,
  DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
  isGlobalHistorySentinel,
  getCanonicalEntityKey,
  getEffectiveHistoryEpoch,
  resolveCausalProjection,
  GraceProjectionEntry,
} from '../lib/sync/causal-projection-engine';
import {
  SyncProjectionHydrator,
  hydrateProjectionFromIndexedDb,
} from '../lib/sync/projection-hydrator';

/**
 * Test-only fixture helper matching Step 5.2a/5.2b convention:
 * Production DAL strictly forbids transitioning to READY before Step 6.
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

function makeReadyMeta(
  ownerScope: string,
  overrides: Partial<LocalSyncMeta> = {},
): LocalSyncMeta {
  return {
    ownerScope,
    lastSyncedServerRevision: '100',
    minActiveRevision: '0',
    lastSyncTimestamp: '2026-11-09T09:00:00.000Z',
    effectiveHistoryEpochs: {},
    syncState: 'IDLE',
    authoritativeBaselineStatus: 'READY',
    ...overrides,
  };
}

describe('Phase 5.2c — Pure Deterministic Causal Projection Engine & Hydration', () => {
  let dbClient: IndexedDbClient;
  const scope = 'account:usr-proj-1';

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
    vi.unstubAllGlobals();
  });

  describe('1. Pure Helpers, Canonical Mapping & Determinism', () => {
    it('getCanonicalEntityKey normalizes BOOKMARK, PROGRESS, HISTORY (ST-12), and PREFERENCE keys', () => {
      expect(isGlobalHistorySentinel('all')).toBe(true);
      expect(isGlobalHistorySentinel(UUID_SENTINEL)).toBe(true);
      expect(isGlobalHistorySentinel('story-1')).toBe(false);

      expect(
        getCanonicalEntityKey(SyncDomain.BOOKMARK, 'fallback-id', { storyId: 'story-1' }),
      ).toBe('story-1');
      expect(
        getCanonicalEntityKey(SyncDomain.PROGRESS, 'fallback-id', { storyId: 'story-2' }),
      ).toBe('story-2');
      expect(
        getCanonicalEntityKey(SyncDomain.PREFERENCE, 'fallback-key', { key: 'reader_theme' }),
      ).toBe('reader_theme');

      expect(
        getCanonicalEntityKey(SyncDomain.HISTORY, 'all', {}),
      ).toBe(UUID_SENTINEL);
      expect(
        getCanonicalEntityKey(SyncDomain.HISTORY, UUID_SENTINEL, {}),
      ).toBe(UUID_SENTINEL);
      expect(
        getCanonicalEntityKey(SyncDomain.HISTORY, 'chap-7', {
          storyId: 'story-9',
          chapterId: 'chap-7',
        }),
      ).toBe('story-9:chap-7');
      expect(
        getCanonicalEntityKey(SyncDomain.HISTORY, 'story-9:chap-7', undefined),
      ).toBe('story-9:chap-7');
      expect(
        getCanonicalEntityKey(SyncDomain.HISTORY, 'story-9', { storyId: 'story-9' }),
      ).toBe('story-9');
    });

    it('getEffectiveHistoryEpoch returns max(storyEpoch, globalEpoch)', () => {
      const epochs = {
        [UUID_SENTINEL]: 3,
        'story-low': 1,
        'story-high': 5,
      };
      expect(getEffectiveHistoryEpoch(epochs, 'story-low')).toBe(3);
      expect(getEffectiveHistoryEpoch(epochs, 'story-high')).toBe(5);
      expect(getEffectiveHistoryEpoch(epochs, 'story-missing')).toBe(3);
      expect(getEffectiveHistoryEpoch(undefined, 'story-missing')).toBe(0);
    });

    it('is strictly permutation-invariant and deterministic across shuffled shadows and pending arrays', () => {
      const shadows: AuthoritativeShadowRecord[] = [
        {
          ownerScope: scope,
          domain: SyncDomain.BOOKMARK,
          entityKey: 'story-1',
          serverRevision: '80',
          epoch: 0,
          payload: { storyId: 'story-1', title: 'Shadow Novel', createdAt: '2026-11-01T00:00:00.000Z' },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.PROGRESS,
          entityKey: 'story-1',
          serverRevision: '85',
          epoch: 0,
          payload: {
            storyId: 'story-1',
            chapterId: 'chap-2',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 450,
            progressPercentage: 60,
            updatedAt: '2026-11-01T02:00:00.000Z',
          },
          isDeleted: false,
          updatedAt: 1730426400000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.HISTORY,
          entityKey: 'story-1:chap-2',
          serverRevision: '86',
          epoch: 0,
          payload: {
            storyId: 'story-1',
            chapterId: 'chap-2',
            progressPercentage: 75,
            lastReadAt: '2026-11-01T02:00:00.000Z',
          },
          isDeleted: false,
          updatedAt: 1730426400000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.PREFERENCE,
          entityKey: 'reader_theme',
          serverRevision: '88',
          epoch: 0,
          payload: { key: 'reader_theme', value: 'sepia', updatedAt: '2026-11-01T03:00:00.000Z' },
          isDeleted: false,
          updatedAt: 1730430000000,
        },
      ];

      const pendingMutations: LocalPendingMutation[] = [
        {
          ownerScope: scope,
          mutationId: 'm-1',
          clientId: 'c1',
          domain: SyncDomain.PREFERENCE,
          entityId: 'reader_theme',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: { key: 'reader_theme', value: 'dark' },
          createdAt: '2026-11-01T04:00:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'm-2',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-1',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: {
            storyId: 'story-1',
            chapterId: 'chap-2',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 200,
            progressPercentage: 40,
            observedHistoryEpoch: 0,
          },
          createdAt: '2026-11-01T04:05:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'm-3',
          clientId: 'c1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-2',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: { storyId: 'story-2', title: 'Offline Pending Story' },
          createdAt: '2026-11-01T04:10:00.000Z',
        },
      ];

      const resOrder1 = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        effectiveHistoryEpochs: {},
        shadows,
        pendingMutations,
        nowMs: 1730440000000,
      });

      const resOrder2 = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        effectiveHistoryEpochs: {},
        shadows: [...shadows].reverse(),
        pendingMutations: [...pendingMutations].reverse(),
        nowMs: 1730440000000,
      });

      expect(resOrder1).toEqual(resOrder2);
      expect(resOrder1.bookmarks).toHaveLength(2);
      expect(resOrder1.preferences[0]).toMatchObject({ key: 'reader_theme', value: 'dark', source: 'PENDING' });
      // Same chapter lower percentage (40% < 60%) without forceRewind preserves Shadow 60% & position
      expect(resOrder1.progress[0]).toMatchObject({
        storyId: 'story-1',
        chapterId: 'chap-2',
        progressPercentage: 60,
        scrollPosition: 450,
      });
      // History stays max(75, 40) = 75
      expect(resOrder1.history[0]).toMatchObject({
        storyId: 'story-1',
        chapterId: 'chap-2',
        progressPercentage: 75,
      });
    });

    it('respects pending cross-chapter switch user intent and explicit forceRewind on same chapter', () => {
      const shadow: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-1',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-old',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 900,
          progressPercentage: 95,
        },
        isDeleted: false,
        updatedAt: 1730426400000,
      };

      const switchChapterMutation: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'm-switch',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-new',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 50,
          progressPercentage: 5,
        },
        createdAt: '2026-11-01T05:00:00.000Z',
      };

      const switched = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadow],
        pendingMutations: [switchChapterMutation],
      });
      expect(switched.progress[0]).toMatchObject({
        chapterId: 'chap-new',
        progressPercentage: 5,
        source: 'PENDING',
      });

      const rewindSameChapter: LocalPendingMutation = {
        ...switchChapterMutation,
        mutationId: 'm-rewind',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-old',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 20,
          progressPercentage: 10,
          forceRewind: true,
        },
      };

      const rewound = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadow],
        pendingMutations: [rewindSameChapter],
      });
      expect(rewound.progress[0]).toMatchObject({
        chapterId: 'chap-old',
        progressPercentage: 10,
        scrollPosition: 20,
        source: 'PENDING',
      });
    });

    it('flags needsHydration: true when presentation metadata is absent and hydrates cleanly from catalog', () => {
      const shadows: AuthoritativeShadowRecord[] = [
        {
          ownerScope: scope,
          domain: SyncDomain.BOOKMARK,
          entityKey: 'story-bare',
          serverRevision: '50',
          epoch: 0,
          payload: { storyId: 'story-bare' },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.HISTORY,
          entityKey: 'story-bare:chap-1',
          serverRevision: '51',
          epoch: 0,
          payload: { storyId: 'story-bare', chapterId: 'chap-1', progressPercentage: 45 },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
      ];

      const unhydrated = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '51',
        shadows,
        pendingMutations: [],
      });
      expect(unhydrated.bookmarks[0].needsHydration).toBe(true);
      expect(unhydrated.history[0].needsHydration).toBe(true);

      const hydrated = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '51',
        shadows,
        pendingMutations: [],
        catalog: {
          stories: {
            'story-bare': {
              title: 'Solo Leveling',
              slug: 'solo-leveling',
              coverUrl: '/covers/sl.jpg',
            },
          },
          chapters: {
            'chap-1': {
              chapterNumber: 1,
              chapterTitle: 'The Weakest Hunter',
            },
          },
        },
      });
      expect(hydrated.bookmarks[0]).toMatchObject({
        title: 'Solo Leveling',
        slug: 'solo-leveling',
        coverUrl: '/covers/sl.jpg',
        needsHydration: false,
      });
      expect(hydrated.history[0]).toMatchObject({
        storyTitle: 'Solo Leveling',
        storySlug: 'solo-leveling',
        chapterNumber: 1,
        chapterTitle: 'The Weakest Hunter',
        needsHydration: false,
      });
    });
  });

  describe('2. Dual-Layer Tombstone & Causal Epoch Suppression (Revision 2.2 P0-03 & P0-05)', () => {
    it('suppresses stale epoch HISTORY shadows (epoch < effective) while preserving matching epoch (4 === 4)', () => {
      const shadows: AuthoritativeShadowRecord[] = [
        {
          ownerScope: scope,
          domain: SyncDomain.HISTORY,
          entityKey: 'story-A:chap-old',
          serverRevision: '50',
          epoch: 3, // stale (< 4)
          payload: { storyId: 'story-A', chapterId: 'chap-old', progressPercentage: 100 },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.HISTORY,
          entityKey: 'story-A:chap-fresh',
          serverRevision: '101',
          epoch: 4, // matching (4 === 4)
          payload: { storyId: 'story-A', chapterId: 'chap-fresh', progressPercentage: 65 },
          isDeleted: false,
          updatedAt: 1730422800000,
        },
      ];

      const result = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '101',
        effectiveHistoryEpochs: {
          [UUID_SENTINEL]: 2,
          'story-A': 4,
        },
        shadows,
        pendingMutations: [],
      });

      expect(result.history).toHaveLength(1);
      expect(result.history[0].chapterId).toBe('chap-fresh');
      expect(result.history[0].progressPercentage).toBe(65);
    });

    it('suppresses pending PROGRESS with stale observedHistoryEpoch AND missing-epoch mutations with baseServerRevision < tombstoneRevision (P0-05)', () => {
      const tombstoneShadow: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-tomb',
        serverRevision: '100',
        epoch: 2,
        payload: { storyId: 'story-tomb', epoch: 2 },
        isDeleted: true,
        updatedAt: 1730420000000,
      };

      const staleObservedEpochProg: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'm-stale-epoch',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '105',
        payload: {
          storyId: 'story-tomb',
          chapterId: 'chap-1',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 100,
          progressPercentage: 40,
          observedHistoryEpoch: 1, // < 2
        },
        createdAt: '2026-11-01T01:00:00.000Z',
      };

      const staleBaseRevWithoutEpoch: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'm-stale-baserev',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '90', // < 100 tombstoneRevision!
        payload: {
          storyId: 'story-tomb',
          chapterId: 'chap-2',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 200,
          progressPercentage: 55,
          // observedHistoryEpoch intentionally omitted
        },
        createdAt: '2026-11-01T01:01:00.000Z',
      };

      const blocked = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        effectiveHistoryEpochs: { 'story-tomb': 2 },
        shadows: [tombstoneShadow],
        pendingMutations: [staleObservedEpochProg, staleBaseRevWithoutEpoch],
      });

      expect(blocked.progress).toHaveLength(0);
      expect(blocked.history).toHaveLength(0);
      expect(blocked.suppressedMutationCount).toBe(2);

      // Post-tombstone mutation (baseServerRevision >= 100) without epoch for PROGRESS IS allowed in progress,
      // while matching observedHistoryEpoch: 2 updates both progress and history cleanly.
      const freshAfterTombstone: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'm-fresh',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-tomb',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-tomb',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 300,
          progressPercentage: 70,
          observedHistoryEpoch: 2,
        },
        createdAt: '2026-11-01T02:00:00.000Z',
      };

      const allowed = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        effectiveHistoryEpochs: { 'story-tomb': 2 },
        shadows: [tombstoneShadow],
        pendingMutations: [staleObservedEpochProg, staleBaseRevWithoutEpoch, freshAfterTombstone],
      });

      expect(allowed.progress).toHaveLength(1);
      expect(allowed.progress[0].chapterId).toBe('chap-3');
      expect(allowed.history).toHaveLength(1);
      expect(allowed.history[0].chapterId).toBe('chap-3');
      expect(allowed.suppressedMutationCount).toBe(2);
    });

    it('suppresses BOOKMARK pending UPSERT resurrection against tombstoneRevisions map & applies chronological HISTORY DELETE', () => {
      const shadows: AuthoritativeShadowRecord[] = [
        {
          ownerScope: scope,
          domain: SyncDomain.HISTORY,
          entityKey: 'story-1:chap-1',
          serverRevision: '40',
          epoch: 0,
          payload: { storyId: 'story-1', chapterId: 'chap-1', progressPercentage: 90 },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
        {
          ownerScope: scope,
          domain: SyncDomain.PROGRESS,
          entityKey: 'story-1',
          serverRevision: '40',
          epoch: 0,
          payload: {
            storyId: 'story-1',
            chapterId: 'chap-1',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 500,
            progressPercentage: 90,
          },
          isDeleted: false,
          updatedAt: 1730419200000,
        },
      ];

      const pendingMutations: LocalPendingMutation[] = [
        {
          ownerScope: scope,
          mutationId: 'm-bm-stale',
          clientId: 'c1',
          domain: SyncDomain.BOOKMARK,
          entityId: 'story-deleted',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '70', // < tombstone 80
          payload: { storyId: 'story-deleted', title: 'Ghost Bookmark' },
          createdAt: '2026-11-01T03:00:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'm-hist-del',
          clientId: 'c1',
          domain: SyncDomain.HISTORY,
          entityId: 'all',
          operation: SyncOperation.DELETE,
          baseServerRevision: '100',
          payload: {},
          createdAt: '2026-11-01T03:05:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'm-after-clear',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-2',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: {
            storyId: 'story-2',
            chapterId: 'chap-1',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 100,
            progressPercentage: 15,
          },
          createdAt: '2026-11-01T03:06:00.000Z',
        },
      ];

      const result = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows,
        pendingMutations,
        tombstoneRevisions: {
          [SyncDomain.BOOKMARK]: { 'story-deleted': '80' },
        },
      });

      expect(result.bookmarks).toHaveLength(0);
      expect(result.suppressedMutationCount).toBe(1);
      // story-1 history and progress were cleared by pending global HISTORY DELETE, while subsequent story-2 remains!
      expect(result.history).toHaveLength(1);
      expect(result.history[0].storyId).toBe('story-2');
      expect(result.progress).toHaveLength(1);
      expect(result.progress[0].storyId).toBe('story-2');
    });
  });

  describe('3. Bounded Post-Receipt Grace (Revision 2.2 Section 5 P0-04) & Degraded Mode', () => {
    it('maintains bounded grace window after APPLIED receipt until Delta Pull catches up OR TTL expires', () => {
      const shadowChap3: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-1',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 300,
          progressPercentage: 50,
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      };

      const appliedChap5: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'm-applied-c5',
        clientId: 'c1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-1',
          chapterId: 'chap-5',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 120,
          progressPercentage: 20,
        },
        createdAt: '2026-11-01T04:00:00.000Z',
      };

      const t0 = 1_730_440_000_000;
      const graceEntries: GraceProjectionEntry[] = [
        {
          ownerScope: scope,
          mutation: appliedChap5,
          assignedRevision: '105',
          recordedAtMs: t0,
          expiresAtMs: t0 + DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
        },
      ];

      // 1. Within grace window and before Delta Pull reaches rev 105: shows chap-5 (no backwards flicker!)
      const duringGrace = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadowChap3],
        pendingMutations: [],
        graceEntries,
        nowMs: t0 + 1000,
      });
      expect(duringGrace.progress[0]).toMatchObject({ chapterId: 'chap-5', source: 'GRACE' });
      expect(duringGrace.activeGraceCount).toBe(1);

      // 2. Delta Pull has caught up to assignedRevision '105' -> grace retires cleanly, Shadow authoritative!
      const afterPullCatchup = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '105',
        shadows: [
          {
            ...shadowChap3,
            serverRevision: '105',
            payload: { ...shadowChap3.payload, chapterId: 'chap-5', progressPercentage: 25 },
          },
        ],
        pendingMutations: [],
        graceEntries,
        nowMs: t0 + 1000,
      });
      expect(afterPullCatchup.progress[0]).toMatchObject({
        chapterId: 'chap-5',
        progressPercentage: 25,
        source: 'SHADOW',
      });
      expect(afterPullCatchup.activeGraceCount).toBe(0);

      // 3. TTL expired (>= 5000ms) while shadow still at 100 -> reverts cleanly to Shadow!
      const afterTtlExpired = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadowChap3],
        pendingMutations: [],
        graceEntries,
        nowMs: t0 + DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
      });
      expect(afterTtlExpired.progress[0]).toMatchObject({
        chapterId: 'chap-3',
        source: 'SHADOW',
      });
      expect(afterTtlExpired.activeGraceCount).toBe(0);
    });

    it('P2-01: fails closed deterministically when graceEntries are passed without finite nowMs', () => {
      const shadowChap3: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-p201',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-p201',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 300,
          progressPercentage: 50,
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      };
      const t0 = 1_730_440_000_000;
      const graceEntries: GraceProjectionEntry[] = [
        {
          ownerScope: scope,
          mutation: {
            ownerScope: scope,
            mutationId: 'm-p201-grace',
            clientId: 'c1',
            domain: SyncDomain.PROGRESS,
            entityId: 'story-p201',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '100',
            payload: {
              storyId: 'story-p201',
              chapterId: 'chap-5',
              readingMode: ReadingMode.WEBTOON,
              pageIndex: 1,
              scrollPosition: 100,
              progressPercentage: 25,
            },
            createdAt: '2026-11-01T04:00:00.000Z',
          },
          assignedRevision: '105',
          recordedAtMs: t0,
          expiresAtMs: t0 + DEFAULT_POST_RECEIPT_GRACE_TTL_MS,
        },
      ];

      const withoutNowA = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadowChap3],
        pendingMutations: [],
        graceEntries,
      });
      const withoutNowB = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadowChap3],
        pendingMutations: [],
        graceEntries,
      });
      const withNaNNow = resolveCausalProjection({
        ownerScope: scope,
        syncedServerRevision: '100',
        shadows: [shadowChap3],
        pendingMutations: [],
        graceEntries,
        nowMs: Number.NaN,
      });

      expect(withoutNowA).toEqual(withoutNowB);
      expect(withoutNowA.activeGraceCount).toBe(0);
      expect(withoutNowA.progress[0]).toMatchObject({
        chapterId: 'chap-3',
        source: 'SHADOW',
      });
      expect(withNaNNow).toEqual(withoutNowA);
    });

    it('integrates SyncProjectionHydrator.recordAppliedGrace() through GRACE -> Delta Pull catch-up SHADOW & TTL expiration', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope, { lastSyncedServerRevision: '100' }));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-grace-idb',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-grace-idb',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 300,
          progressPercentage: 50,
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PREFERENCE,
        entityKey: 'reader_theme',
        serverRevision: '100',
        epoch: 0,
        payload: { key: 'reader_theme', value: 'light' },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      const t0 = 1_730_440_000_000;
      let fakeNow = t0;
      const hydrator = new SyncProjectionHydrator(dbClient, () => fakeNow);

      // Simulate Step 4 receiving APPLIED receipts after dequeuing/deleting pending mutations
      hydrator.recordAppliedGrace(
        scope,
        {
          ownerScope: scope,
          mutationId: 'm-grace-chap5',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-grace-idb',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: {
            storyId: 'story-grace-idb',
            chapterId: 'chap-5',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 120,
            progressPercentage: 20,
          },
          createdAt: '2026-11-01T04:00:00.000Z',
        },
        '105',
        5_000,
      );
      hydrator.recordAppliedGrace(
        scope,
        {
          ownerScope: scope,
          mutationId: 'm-grace-pref',
          clientId: 'c1',
          domain: SyncDomain.PREFERENCE,
          entityId: 'reader_theme',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: { key: 'reader_theme', value: 'sepia' },
          createdAt: '2026-11-01T04:01:00.000Z',
        },
        '110',
        5_000,
      );

      // 1. Inside TTL before Delta Pull catches up -> both show GRACE
      fakeNow = t0 + 1_000;
      const inGrace = await hydrator.hydrateScope(scope);
      expect(inGrace.activeGraceCount).toBe(2);
      expect(inGrace.progress[0]).toMatchObject({
        chapterId: 'chap-5',
        progressPercentage: 20,
        source: 'GRACE',
      });
      expect(inGrace.preferences[0]).toMatchObject({
        key: 'reader_theme',
        value: 'sepia',
        source: 'GRACE',
      });

      // 2. Step 5.2b Delta Pull catches up to rev '105' -> rev '105' grace retires to SHADOW; rev '110' remains GRACE
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '100',
        page: {
          currentServerRevision: '105',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '105',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-grace-idb',
              operation: SyncOperation.UPSERT,
              payload: {
                storyId: 'story-grace-idb',
                chapterId: 'chap-5',
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 180,
                progressPercentage: 25,
              },
              createdAt: '2026-11-01T04:00:01.000Z',
            },
          ],
        },
      });

      fakeNow = t0 + 2_000;
      const afterCatchup = await hydrator.hydrateScope(scope);
      expect(afterCatchup.activeGraceCount).toBe(1);
      expect(afterCatchup.progress[0]).toMatchObject({
        chapterId: 'chap-5',
        progressPercentage: 25,
        source: 'SHADOW',
      });
      expect(afterCatchup.preferences[0]).toMatchObject({
        key: 'reader_theme',
        value: 'sepia',
        source: 'GRACE',
      });

      // 3. TTL expires at t0 + 5000ms without rev 110 Delta Pull -> remaining grace pruned & reverts cleanly to Shadow
      fakeNow = t0 + 5_000;
      const afterTtl = await hydrator.hydrateScope(scope);
      expect(afterTtl.activeGraceCount).toBe(0);
      expect(afterTtl.preferences[0]).toMatchObject({
        key: 'reader_theme',
        value: 'light',
        source: 'SHADOW',
      });

      // Pruned grace entry was permanently evicted from internal map (does not revive if clock checked earlier)
      fakeNow = t0 + 2_500;
      const afterPruneReCheck = await hydrator.hydrateScope(scope);
      expect(afterPruneReCheck.activeGraceCount).toBe(0);
      expect(afterPruneReCheck.preferences[0].value).toBe('light');
    });

    it('fails closed into DEGRADED_COMPATIBILITY mode for UNINITIALIZED / BOOTSTRAPPING / missing sync_meta', async () => {
      const guestScope = 'guest:dev-degraded-1';
      await dbClient.putBookmark({
        ownerScope: guestScope,
        storyId: 'story-leg',
        title: 'Legacy Local Novel',
        createdAt: '2026-11-01T00:00:00.000Z',
      });
      // Seed an unverified shadow record for this uninitialized scope to verify it is IGNORED
      await dbClient.putAuthoritativeShadow({
        ownerScope: guestScope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'story-unverified-shadow',
        serverRevision: '999',
        epoch: 0,
        payload: { storyId: 'story-unverified-shadow', title: 'Should Be Ignored' },
        isDeleted: false,
        updatedAt: Date.now(),
      });

      const hydrator = new SyncProjectionHydrator(dbClient);
      const resUninitialized = await hydrator.hydrateScope(guestScope);
      expect(resUninitialized.mode).toBe('DEGRADED_COMPATIBILITY');
      expect(resUninitialized.baselineStatus).toBe('UNINITIALIZED');
      expect(resUninitialized.bookmarks.map((b) => b.storyId)).toEqual(['story-leg']);
      expect(resUninitialized.bookmarks[0].source).toBe('LEGACY');

      await dbClient.setAuthoritativeBaselineStatus(guestScope, 'BOOTSTRAPPING');
      const resBootstrapping = await hydrator.hydrateScope(guestScope);
      expect(resBootstrapping.mode).toBe('DEGRADED_COMPATIBILITY');
      expect(resBootstrapping.baselineStatus).toBe('BOOTSTRAPPING');
      expect(resBootstrapping.bookmarks.map((b) => b.storyId)).toEqual(['story-leg']);

      // Materialization must also fail closed when baseline !== READY
      const matRes = await hydrator.materializeToLegacyStores(guestScope);
      expect(matRes.materialized).toBe(false);
      expect(matRes.mode).toBe('DEGRADED_COMPATIBILITY');
    });
  });

  describe('4. Mandatory Step 5.2c Acceptance Matrix (ST-02, ST-03, ST-04, ST-06, ST-12, ST-13, ST-15)', () => {
    it('ST-02: Authoritative Payload Preservation — evicting rejected pending Chap 5 reverts projection to Shadow Chap 3 without network call', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-st02',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st02',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 400,
          progressPercentage: 85,
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      const pendingChap5: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-st02-chap5',
        clientId: 'client-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-st02',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-st02',
          chapterId: 'chap-5',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 100,
          progressPercentage: 20,
        },
        createdAt: '2026-11-01T02:00:00.000Z',
      };
      await dbClient.enqueuePendingMutation(pendingChap5);

      const hydrator = new SyncProjectionHydrator(dbClient);
      const beforeReject = await hydrator.hydrateScope(scope);
      expect(beforeReject.mode).toBe('AUTHORITATIVE_PROJECTION');
      expect(beforeReject.progress[0]).toMatchObject({
        storyId: 'story-st02',
        chapterId: 'chap-5',
        progressPercentage: 20,
        source: 'PENDING',
      });

      // Server rejects pending Chap 5 with REJECTED_TOMBSTONE -> Step 4 evicts pending
      await dbClient.deletePendingMutation(scope, 'mut-st02-chap5');

      const afterReject = await hydrator.hydrateScope(scope);
      expect(afterReject.progress).toHaveLength(1);
      expect(afterReject.progress[0]).toMatchObject({
        storyId: 'story-st02',
        chapterId: 'chap-3',
        progressPercentage: 85,
        source: 'SHADOW',
      });
    });

    it('ST-03: Step 4 Isolation Guard — recordReadingSessionWithMutation leaves sync_authoritative_replicas untouched while Projection reflects pending write', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      const shadowRecord: AuthoritativeShadowRecord = {
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-st03',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st03',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 300,
          progressPercentage: 60,
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      };
      await dbClient.putAuthoritativeShadow(shadowRecord);

      const progressC5: LocalReadingProgress = {
        ownerScope: scope,
        storyId: 'story-st03',
        chapterId: 'chap-5',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 500,
        progressPercentage: 75,
        updatedAt: '2026-11-01T05:00:00.000Z',
        deviceTimestamp: 1730437200000,
      };
      const historyC5: LocalReadingHistory = {
        ownerScope: scope,
        storyId: 'story-st03',
        chapterId: 'chap-5',
        storyTitle: 'One Piece',
        chapterNumber: 5,
        progressPercentage: 75,
        lastReadAt: '2026-11-01T05:00:00.000Z',
      };
      const mutC5: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-st03-c5',
        clientId: 'client-1',
        domain: SyncDomain.PROGRESS,
        entityId: 'story-st03',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-st03',
          chapterId: 'chap-5',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 500,
          progressPercentage: 75,
          observedHistoryEpoch: 0,
        },
        createdAt: '2026-11-01T05:00:00.000Z',
      };

      await dbClient.recordReadingSessionWithMutation(progressC5, historyC5, mutC5);

      // Authoritative Shadow MUST NOT be overwritten by Step 4 local write
      const shadowAfter = await dbClient.getAuthoritativeShadow(
        scope,
        SyncDomain.PROGRESS,
        'story-st03',
      );
      expect(shadowAfter?.payload?.chapterId).toBe('chap-3');
      expect(shadowAfter?.payload?.progressPercentage).toBe(60);
      expect(
        await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-st03:chap-5'),
      ).toBeNull();

      // Projection reflects new pending chap-5 and hydrates presentation metadata safely from legacy history
      const hydrated = await hydrateProjectionFromIndexedDb(dbClient, scope);
      expect(hydrated.progress[0]).toMatchObject({
        storyId: 'story-st03',
        chapterId: 'chap-5',
        progressPercentage: 75,
        source: 'PENDING',
      });
      expect(hydrated.history[0]).toMatchObject({
        storyId: 'story-st03',
        chapterId: 'chap-5',
        storyTitle: 'One Piece',
        chapterNumber: 5,
        progressPercentage: 75,
        source: 'PENDING',
      });
    });

    it('ST-04: Monotonic History Upsert Merge — shadow 80% + pending 30% retains 80% before & after pending flush', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-st04:chap-1',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st04',
          chapterId: 'chap-1',
          progressPercentage: 80,
          lastReadAt: '2026-11-01T01:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730422800000,
      });

      const pendingLowerHistory: LocalPendingMutation = {
        ownerScope: scope,
        mutationId: 'mut-st04-lower',
        clientId: 'client-1',
        domain: SyncDomain.HISTORY,
        entityId: 'chap-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-st04',
          chapterId: 'chap-1',
          progressPercentage: 30,
          observedHistoryEpoch: 0,
        },
        createdAt: '2026-11-01T03:00:00.000Z',
      };
      await dbClient.enqueuePendingMutation(pendingLowerHistory);

      const hydrator = new SyncProjectionHydrator(dbClient);
      const withPending = await hydrator.hydrateScope(scope);
      expect(withPending.history).toHaveLength(1);
      expect(withPending.history[0].progressPercentage).toBe(80);

      // Simulate pending mutation flushed/committed on server -> removed from queue
      await dbClient.deletePendingMutation(scope, 'mut-st04-lower');

      const afterFlush = await hydrator.hydrateScope(scope);
      expect(afterFlush.history).toHaveLength(1);
      expect(afterFlush.history[0].progressPercentage).toBe(80);
      expect(afterFlush.history[0].source).toBe('SHADOW');
    });

    it('ST-06: Multi-Scope Tenant Isolation — same story/chapter across account-1, account-2, and guest-1 stay isolated', async () => {
      const account1 = 'account:usr-alpha';
      const account2 = 'account:usr-beta';
      const guest1 = 'guest:dev-gamma';
      const sharedStoryId = 'story-shared-uuid';

      await seedRawReadySyncMeta(dbClient, makeReadyMeta(account1, { effectiveHistoryEpochs: { [sharedStoryId]: 2 } }));
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(account2, { effectiveHistoryEpochs: {} }));

      await dbClient.putAuthoritativeShadow({
        ownerScope: account1,
        domain: SyncDomain.BOOKMARK,
        entityKey: sharedStoryId,
        serverRevision: '100',
        epoch: 0,
        payload: { storyId: sharedStoryId, title: 'Alpha Story' },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      // Account 1 shadow chapter on epoch 1 (< effective 2) must be suppressed only in account 1
      await dbClient.putAuthoritativeShadow({
        ownerScope: account1,
        domain: SyncDomain.HISTORY,
        entityKey: `${sharedStoryId}:chap-1`,
        serverRevision: '90',
        epoch: 1,
        payload: { storyId: sharedStoryId, chapterId: 'chap-1', progressPercentage: 50 },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      // Account 2 has shadow at rev 100 on epoch 0
      await dbClient.putAuthoritativeShadow({
        ownerScope: account2,
        domain: SyncDomain.HISTORY,
        entityKey: `${sharedStoryId}:chap-1`,
        serverRevision: '100',
        epoch: 0,
        payload: { storyId: sharedStoryId, chapterId: 'chap-1', progressPercentage: 95 },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      // Guest has legacy store only (DEGRADED_COMPATIBILITY)
      await dbClient.putBookmark({
        ownerScope: guest1,
        storyId: sharedStoryId,
        title: 'Guest Local Title',
        createdAt: '2026-11-01T00:00:00.000Z',
      });

      const hydrator = new SyncProjectionHydrator(dbClient);
      const resA1 = await hydrator.hydrateScope(account1);
      const resA2 = await hydrator.hydrateScope(account2);
      const resG1 = await hydrator.hydrateScope(guest1);

      expect(resA1.mode).toBe('AUTHORITATIVE_PROJECTION');
      expect(resA1.bookmarks).toHaveLength(1);
      expect(resA1.bookmarks[0].ownerScope).toBe(account1);
      expect(resA1.history).toHaveLength(0); // Suppressed by account1's epoch 2

      expect(resA2.mode).toBe('AUTHORITATIVE_PROJECTION');
      expect(resA2.bookmarks).toHaveLength(0); // account1's bookmark does NOT leak to account2
      expect(resA2.history).toHaveLength(1);
      expect(resA2.history[0].ownerScope).toBe(account2);
      expect(resA2.history[0].progressPercentage).toBe(95);

      expect(resG1.mode).toBe('DEGRADED_COMPATIBILITY');
      expect(resG1.bookmarks).toHaveLength(1);
      expect(resG1.bookmarks[0].title).toBe('Guest Local Title');
      expect(resG1.bookmarks[0].ownerScope).toBe(guest1);
    });

    it('ST-12: Entity Key Mismatch Mapping — HISTORY mutation with raw chapterId or storyId entityId merges with ${storyId}:${chapterId} shadow', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-st12:chap-9',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st12',
          chapterId: 'chap-9',
          progressPercentage: 40,
          lastReadAt: '2026-11-01T01:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      // Mismatch format 1: entityId === chapterId
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-st12-chapid',
        clientId: 'c1',
        domain: SyncDomain.HISTORY,
        entityId: 'chap-9',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-st12',
          chapterId: 'chap-9',
          progressPercentage: 65,
          observedHistoryEpoch: 0,
        },
        createdAt: '2026-11-01T02:00:00.000Z',
      });

      // Mismatch format 2: entityId === storyId (with lower % -> must merge monotonically with 65%)
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-st12-storyid',
        clientId: 'c1',
        domain: SyncDomain.HISTORY,
        entityId: 'story-st12',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '100',
        payload: {
          storyId: 'story-st12',
          chapterId: 'chap-9',
          progressPercentage: 50,
          observedHistoryEpoch: 0,
        },
        createdAt: '2026-11-01T03:00:00.000Z',
      });

      const res = await hydrateProjectionFromIndexedDb(dbClient, scope);
      expect(res.history).toHaveLength(1);
      expect(res.history[0]).toMatchObject({
        storyId: 'story-st12',
        chapterId: 'chap-9',
        progressPercentage: 65,
      });
    });

    it('ST-13: Post-Receipt Reload Determinism — killing tab immediately after IDB commit without RAM events hydrates exact canonical state across fresh client & hydrator instances', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-st13',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st13',
          chapterId: 'chap-2',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 200,
          progressPercentage: 45,
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });

      // Local bookmark and pending chap-7 reading mutation written via Step 4 atomic primitive
      await dbClient.recordReadingSessionWithMutation(
        {
          ownerScope: scope,
          storyId: 'story-st13',
          chapterId: 'chap-7',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 600,
          progressPercentage: 80,
          updatedAt: '2026-11-01T01:00:00.000Z',
          deviceTimestamp: 1730422800000,
        },
        {
          ownerScope: scope,
          storyId: 'story-st13',
          chapterId: 'chap-7',
          storyTitle: 'ST13 Novel',
          chapterNumber: 7,
          progressPercentage: 80,
          lastReadAt: '2026-11-01T01:00:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'mut-st13-c7',
          clientId: 'client-1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-st13',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: {
            storyId: 'story-st13',
            chapterId: 'chap-7',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 600,
            progressPercentage: 80,
          },
          createdAt: '2026-11-01T01:00:00.000Z',
        },
      );

      // Step 4 commits REJECTED_TOMBSTONE eviction in IDB and tab is killed IMMEDIATELY (zero RAM callbacks/grace used)
      await dbClient.evictReplicaAndRemovePending(
        scope,
        SyncDomain.PROGRESS,
        'story-st13',
        'mut-st13-c7',
      );
      dbClient.close();

      // Reload simulation: brand new IndexedDbClient + two independent brand new SyncProjectionHydrator instances
      const freshClientA = new IndexedDbClient();
      const freshClientB = new IndexedDbClient();
      try {
        const hydratorA = new SyncProjectionHydrator(freshClientA);
        const hydratorB = new SyncProjectionHydrator(freshClientB);

        // Even if hydratorA had stale in-memory grace earlier, a fresh tab (hydratorB) reads pure committed IDB
        hydratorA.recordAppliedGrace(
          scope,
          {
            ownerScope: scope,
            mutationId: 'mut-stale-tab-only',
            clientId: 'c1',
            domain: SyncDomain.BOOKMARK,
            entityId: 'ghost-bm',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '100',
            payload: { storyId: 'ghost-bm', title: 'RAM Only Grace' },
            createdAt: '2026-11-01T02:00:00.000Z',
          },
          '105',
        );

        const reloaded = await hydratorB.hydrateScope(scope);
        const reloadedAgain = await hydratorB.hydrateScope(scope);

        expect(reloaded).toEqual(reloadedAgain);
        expect(reloaded.activeGraceCount).toBe(0);
        expect(reloaded.bookmarks).toHaveLength(0);
        expect(reloaded.progress).toHaveLength(1);
        expect(reloaded.progress[0]).toMatchObject({
          storyId: 'story-st13',
          chapterId: 'chap-2',
          progressPercentage: 45,
          source: 'SHADOW',
        });
      } finally {
        freshClientA.close();
        freshClientB.close();
      }
    });

    it('ST-15: Concurrent Local Write vs Materialization — concurrent local reading write is never overwritten and pending mutation is preserved', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-st15',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-st15',
          chapterId: 'chap-3',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 100,
          progressPercentage: 30,
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'story-shadow-bm',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-shadow-bm',
          title: 'Shadow Bookmark To Materialize',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      // Stale legacy bookmark that no longer exists in Shadow (should be cleaned up cleanly)
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-old-removed',
        title: 'Removed On Server',
        createdAt: '2026-10-01T00:00:00.000Z',
      });

      const hydrator = new SyncProjectionHydrator(dbClient);

      // Concurrent write: user jumps to chap-9 right as materialization is about to acquire its transaction
      const materializePromise = hydrator.materializeToLegacyStores(scope, {
        _testHookBeforeTransaction: async () => {
          await dbClient.recordReadingSessionWithMutation(
            {
              ownerScope: scope,
              storyId: 'story-st15',
              chapterId: 'chap-9',
              readingMode: ReadingMode.WEBTOON,
              pageIndex: 1,
              scrollPosition: 777,
              progressPercentage: 88,
              updatedAt: '2026-11-01T06:00:00.000Z',
              deviceTimestamp: 1730440800000,
            },
            {
              ownerScope: scope,
              storyId: 'story-st15',
              chapterId: 'chap-9',
              storyTitle: 'ST15 Epic Novel',
              chapterNumber: 9,
              progressPercentage: 88,
              lastReadAt: '2026-11-01T06:00:00.000Z',
            },
            {
              ownerScope: scope,
              mutationId: 'mut-st15-c9',
              clientId: 'client-1',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-st15',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '100',
              payload: {
                storyId: 'story-st15',
                chapterId: 'chap-9',
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 777,
                progressPercentage: 88,
                observedHistoryEpoch: 0,
              },
              createdAt: '2026-11-01T06:00:00.000Z',
            },
          );
        },
      });

      const matResult = await materializePromise;
      expect(matResult.materialized).toBe(true);
      expect(matResult.mode).toBe('AUTHORITATIVE_PROJECTION');

      // 1. Concurrent pending mutation MUST still exist intact
      const pending = await dbClient.getPendingMutation(scope, 'mut-st15-c9');
      expect(pending).not.toBeNull();

      // 2. Concurrent local progress & history (chap-9 with full metadata) MUST NOT be clobbered by Shadow chap-3
      const persistedProgress = await dbClient.getProgress(scope, 'story-st15');
      expect(persistedProgress).toMatchObject({
        chapterId: 'chap-9',
        scrollPosition: 777,
        progressPercentage: 88,
      });

      const persistedHistory = await dbClient.getHistory(scope);
      const chap9Hist = persistedHistory.find(
        (h) => h.storyId === 'story-st15' && h.chapterId === 'chap-9',
      );
      expect(chap9Hist).toMatchObject({
        storyTitle: 'ST15 Epic Novel',
        chapterNumber: 9,
        progressPercentage: 88,
      });

      // 3. Authoritative shadow bookmark materialized cleanly & stale un-pending removed bookmark cleaned up
      const bms = await dbClient.getBookmarks(scope);
      expect(bms.map((b) => b.storyId)).toEqual(['story-shadow-bm']);

      // 4. Subsequent simultaneous race where both start together also preserves local intent
      const simultaneousWrite = dbClient.putPreferenceWithMutation(
        {
          ownerScope: scope,
          key: 'reader_theme',
          value: 'black',
          updatedAt: '2026-11-01T07:00:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'mut-st15-pref',
          clientId: 'client-1',
          domain: SyncDomain.PREFERENCE,
          entityId: 'reader_theme',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '100',
          payload: { key: 'reader_theme', value: 'black' },
          createdAt: '2026-11-01T07:00:00.000Z',
        },
      );
      const simultaneousMat = hydrator.materializeToLegacyStores(scope);
      await Promise.all([simultaneousWrite, simultaneousMat]);

      const pref = await dbClient.getPreference(scope, 'reader_theme');
      expect(pref?.value).toBe('black');
      expect(await dbClient.getPendingMutation(scope, 'mut-st15-pref')).not.toBeNull();
    });

    it('integrates Step 5.2b applyAuthoritativeDeltaPage HISTORY DELETE + reload suppression and pending DELETE materialization cleanup', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope, { lastSyncedServerRevision: '50' }));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-52b:chap-1',
        serverRevision: '40',
        epoch: 0,
        payload: { storyId: 'story-52b', chapterId: 'chap-1', progressPercentage: 90 },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'story-keep',
        serverRevision: '45',
        epoch: 0,
        payload: { storyId: 'story-keep', title: 'Keep Novel' },
        isDeleted: false,
        updatedAt: 1730419200000,
      });
      // Offline pending mutation from old epoch 0 and a pending bookmark DELETE
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-stale-epoch0',
        clientId: 'c1',
        domain: SyncDomain.HISTORY,
        entityId: 'chap-2',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '50',
        payload: {
          storyId: 'story-52b',
          chapterId: 'chap-2',
          progressPercentage: 40,
          observedHistoryEpoch: 0,
        },
        createdAt: '2026-11-01T01:00:00.000Z',
      });
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-bm-del',
        title: 'Should Be Deleted On Materialize',
        createdAt: '2026-11-01T00:00:00.000Z',
      });
      await dbClient.enqueuePendingMutation({
        ownerScope: scope,
        mutationId: 'mut-bm-del',
        clientId: 'c1',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-bm-del',
        operation: SyncOperation.DELETE,
        baseServerRevision: '50',
        payload: { storyId: 'story-bm-del' },
        createdAt: '2026-11-01T01:05:00.000Z',
      });

      // Step 5.2b ingests story-wide HISTORY DELETE at rev 80 -> epoch bumped to 1
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '50',
        page: {
          currentServerRevision: '80',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.HISTORY,
              entityId: 'story-52b',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-52b', epoch: 1 },
              createdAt: '2026-11-01T02:00:00.000Z',
            },
          ],
        },
      });

      // Simulate reload (new IndexedDbClient + new SyncProjectionHydrator)
      dbClient.close();
      const reloadedClient = new IndexedDbClient();
      try {
        const hydrator = new SyncProjectionHydrator(reloadedClient);
        const hydrated = await hydrator.hydrateScope(scope);

        expect(hydrated.mode).toBe('AUTHORITATIVE_PROJECTION');
        expect(hydrated.effectiveHistoryEpochs['story-52b']).toBe(1);
        expect(hydrated.history).toHaveLength(0);
        expect(hydrated.suppressedMutationCount).toBe(1);
        expect(hydrated.bookmarks.map((b) => b.storyId)).toEqual(['story-keep']);

        await hydrator.materializeToLegacyStores(scope);
        expect(await reloadedClient.getBookmark(scope, 'story-bm-del')).toBeNull();
        expect((await reloadedClient.getBookmarks(scope)).map((b) => b.storyId)).toEqual([
          'story-keep',
        ]);

        // Subsequent read on matching epoch 1 IS accepted immediately
        await reloadedClient.enqueuePendingMutation({
          ownerScope: scope,
          mutationId: 'mut-fresh-epoch1',
          clientId: 'c1',
          domain: SyncDomain.HISTORY,
          entityId: 'chap-3',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '80',
          payload: {
            storyId: 'story-52b',
            chapterId: 'chap-3',
            progressPercentage: 60,
            observedHistoryEpoch: 1,
          },
          createdAt: '2026-11-01T03:00:00.000Z',
        });

        const afterFreshRead = await hydrator.hydrateScope(scope);
        expect(afterFreshRead.history).toHaveLength(1);
        expect(afterFreshRead.history[0]).toMatchObject({
          storyId: 'story-52b',
          chapterId: 'chap-3',
          progressPercentage: 60,
          epoch: 1,
        });
      } finally {
        reloadedClient.close();
      }
    });

    it('P1-02: updates stale legacy progress/history when Shadow wins monotonic merge while keeping concurrent pending protection intact', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));

      // Offline Session 1: device persisted lower progress (40%) & history (40% / 30%) + pending mutations
      await dbClient.recordReadingSessionWithMutation(
        {
          ownerScope: scope,
          storyId: 'story-p102',
          chapterId: 'chap-2',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 200,
          progressPercentage: 40,
          updatedAt: '2026-11-01T01:00:00.000Z',
          deviceTimestamp: 1730422800000,
        },
        {
          ownerScope: scope,
          storyId: 'story-p102',
          chapterId: 'chap-2',
          storyTitle: 'P102 Monotonic Novel',
          chapterNumber: 2,
          progressPercentage: 40,
          lastReadAt: '2026-11-01T01:00:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'mut-p102-prog40',
          clientId: 'c1',
          domain: SyncDomain.PROGRESS,
          entityId: 'story-p102',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '90',
          payload: {
            storyId: 'story-p102',
            chapterId: 'chap-2',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 200,
            progressPercentage: 40,
            observedHistoryEpoch: 0,
          },
          createdAt: '2026-11-01T01:00:00.000Z',
        },
      );

      await dbClient.recordReadingSessionWithMutation(
        {
          ownerScope: scope,
          storyId: 'story-hist-only',
          chapterId: 'chap-1',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 100,
          progressPercentage: 30,
          updatedAt: '2026-11-01T01:05:00.000Z',
          deviceTimestamp: 1730423100000,
        },
        {
          ownerScope: scope,
          storyId: 'story-hist-only',
          chapterId: 'chap-1',
          storyTitle: 'History Shadow Winner Novel',
          chapterNumber: 1,
          progressPercentage: 30,
          lastReadAt: '2026-11-01T01:05:00.000Z',
        },
        {
          ownerScope: scope,
          mutationId: 'mut-hist-only-30',
          clientId: 'c1',
          domain: SyncDomain.HISTORY,
          entityId: 'story-hist-only',
          operation: SyncOperation.UPSERT,
          baseServerRevision: '90',
          payload: {
            storyId: 'story-hist-only',
            chapterId: 'chap-1',
            progressPercentage: 30,
            observedHistoryEpoch: 0,
          },
          createdAt: '2026-11-01T01:05:00.000Z',
        },
      );

      // Authoritative Shadow arrives with higher same-chapter values (Progress 60%, History 80%)
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-p102',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-p102',
          chapterId: 'chap-2',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 450,
          progressPercentage: 60,
          updatedAt: '2026-11-01T02:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730426400000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-p102:chap-2',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-p102',
          chapterId: 'chap-2',
          progressPercentage: 80,
          lastReadAt: '2026-11-01T02:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730426400000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.HISTORY,
        entityKey: 'story-hist-only:chap-1',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-hist-only',
          chapterId: 'chap-1',
          progressPercentage: 80,
          lastReadAt: '2026-11-01T02:05:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730426700000,
      });
      // Concurrent story where Shadow has 50% on chap-1
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-concurrent',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-concurrent',
          chapterId: 'chap-1',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 250,
          progressPercentage: 50,
          updatedAt: '2026-11-01T02:00:00.000Z',
        },
        isDeleted: false,
        updatedAt: 1730426400000,
      });

      const hydrator = new SyncProjectionHydrator(dbClient);

      // Materialize while a concurrent winning local write (88% on story-concurrent) runs right before tx lock
      const matRes = await hydrator.materializeToLegacyStores(scope, {
        _testHookBeforeTransaction: async () => {
          await dbClient.recordReadingSessionWithMutation(
            {
              ownerScope: scope,
              storyId: 'story-concurrent',
              chapterId: 'chap-1',
              readingMode: ReadingMode.WEBTOON,
              pageIndex: 1,
              scrollPosition: 700,
              progressPercentage: 88,
              updatedAt: '2026-11-01T06:00:00.000Z',
              deviceTimestamp: 1730440800000,
            },
            {
              ownerScope: scope,
              storyId: 'story-concurrent',
              chapterId: 'chap-1',
              storyTitle: 'Concurrent Winner Novel',
              chapterNumber: 1,
              progressPercentage: 88,
              lastReadAt: '2026-11-01T06:00:00.000Z',
            },
            {
              ownerScope: scope,
              mutationId: 'mut-concurrent-win88',
              clientId: 'c1',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-concurrent',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '100',
              payload: {
                storyId: 'story-concurrent',
                chapterId: 'chap-1',
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 700,
                progressPercentage: 88,
                observedHistoryEpoch: 0,
              },
              createdAt: '2026-11-01T06:00:00.000Z',
            },
          );
        },
      });

      expect(matRes.materialized).toBe(true);
      // Concurrent winning write MUST stay protected in preservedPendingKeys; Shadow-won keys MUST NOT!
      expect(matRes.preservedPendingKeys).toContain('PROGRESS:story-concurrent');
      expect(matRes.preservedPendingKeys).toContain('HISTORY:story-concurrent:chap-1');
      expect(matRes.preservedPendingKeys).not.toContain('PROGRESS:story-p102');
      expect(matRes.preservedPendingKeys).not.toContain('HISTORY:story-p102:chap-2');
      expect(matRes.preservedPendingKeys).not.toContain('HISTORY:story-hist-only:chap-1');

      // 1. Legacy progress for story-p102 updated from stale 40% -> Shadow 60% (and scrollPosition 450)
      const legP102 = await dbClient.getProgress(scope, 'story-p102');
      expect(legP102).toMatchObject({
        chapterId: 'chap-2',
        progressPercentage: 60,
        scrollPosition: 450,
      });

      // 2. Legacy history updated to Shadow 80% for both PROGRESS-mirrored and direct HISTORY entries
      const allLegHist = await dbClient.getHistory(scope);
      expect(
        allLegHist.find((h) => h.storyId === 'story-p102' && h.chapterId === 'chap-2'),
      ).toMatchObject({
        storyTitle: 'P102 Monotonic Novel',
        chapterNumber: 2,
        progressPercentage: 80,
      });
      expect(
        allLegHist.find((h) => h.storyId === 'story-hist-only' && h.chapterId === 'chap-1'),
      ).toMatchObject({
        storyTitle: 'History Shadow Winner Novel',
        chapterNumber: 1,
        progressPercentage: 80,
      });

      // 3. Pending mutations remain untouched in pending_mutations for Step 4 push
      expect(await dbClient.getPendingMutation(scope, 'mut-p102-prog40')).not.toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-hist-only-30')).not.toBeNull();
      expect(await dbClient.getPendingMutation(scope, 'mut-concurrent-win88')).not.toBeNull();

      // 4. Concurrent winning write preserved 100%
      const legConcurrent = await dbClient.getProgress(scope, 'story-concurrent');
      expect(legConcurrent).toMatchObject({
        chapterId: 'chap-1',
        progressPercentage: 88,
        scrollPosition: 700,
      });
    });

    it('checkAdmission rollback: fails pre-transaction AND atomically aborts mid-transaction without mutating legacy stores', async () => {
      await seedRawReadySyncMeta(dbClient, makeReadyMeta(scope));
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.BOOKMARK,
        entityKey: 'story-shadow-new',
        serverRevision: '100',
        epoch: 0,
        payload: { storyId: 'story-shadow-new', title: 'New From Server' },
        isDeleted: false,
        updatedAt: 1730426400000,
      });
      await dbClient.putAuthoritativeShadow({
        ownerScope: scope,
        domain: SyncDomain.PROGRESS,
        entityKey: 'story-prog-rb',
        serverRevision: '100',
        epoch: 0,
        payload: {
          storyId: 'story-prog-rb',
          chapterId: 'chap-5',
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 500,
          progressPercentage: 90,
        },
        isDeleted: false,
        updatedAt: 1730426400000,
      });

      // Seed existing legacy state that materialization would overwrite / delete
      await dbClient.putBookmark({
        ownerScope: scope,
        storyId: 'story-legacy-keep-on-abort',
        title: 'Must Survive Rollback',
        createdAt: '2026-11-01T00:00:00.000Z',
      });
      await dbClient.putProgress({
        ownerScope: scope,
        storyId: 'story-prog-rb',
        chapterId: 'chap-1',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 10,
        progressPercentage: 10,
        updatedAt: '2026-11-01T00:00:00.000Z',
        deviceTimestamp: 1730419200000,
      });

      const hydrator = new SyncProjectionHydrator(dbClient);

      // Case 1: Pre-transaction checkAdmission fails after _testHookBeforeTransaction (authority revoked before opening tx)
      let authorityValid = true;
      await expect(
        hydrator.materializeToLegacyStores(scope, {
          checkAdmission: () => {
            if (!authorityValid) {
              throw new Error('PRE_TX_ADMISSION_REVOKED');
            }
          },
          _testHookBeforeTransaction: () => {
            authorityValid = false;
          },
        }),
      ).rejects.toThrow('PRE_TX_ADMISSION_REVOKED');

      expect((await dbClient.getBookmarks(scope)).map((b) => b.storyId)).toEqual([
        'story-legacy-keep-on-abort',
      ]);
      expect(await dbClient.getProgress(scope, 'story-prog-rb')).toMatchObject({
        chapterId: 'chap-1',
        progressPercentage: 10,
      });

      // Case 2: Mid-transaction checkAdmission throws on 3rd check (after queued bmStore.put/delete & progStore.put) -> tx.abort() rolls back
      let callCount = 0;
      await expect(
        hydrator.materializeToLegacyStores(scope, {
          checkAdmission: () => {
            callCount += 1;
            if (callCount >= 3) {
              throw new Error('MID_TX_ADMISSION_REVOKED');
            }
          },
        }),
      ).rejects.toThrow('MID_TX_ADMISSION_REVOKED');

      // Assert complete atomic IDB rollback
      expect(callCount).toBe(3);
      expect((await dbClient.getBookmarks(scope)).map((b) => b.storyId)).toEqual([
        'story-legacy-keep-on-abort',
      ]);
      expect(await dbClient.getBookmark(scope, 'story-shadow-new')).toBeNull();
      expect(await dbClient.getProgress(scope, 'story-prog-rb')).toMatchObject({
        chapterId: 'chap-1',
        progressPercentage: 10,
      });
    });

    it('fails closed when IndexedDB is unavailable (SSR environment)', async () => {
      vi.stubGlobal('window', undefined);
      const ssrClient = new IndexedDbClient();
      const hydrator = new SyncProjectionHydrator(ssrClient);

      await expect(hydrator.hydrateScope(scope)).rejects.toThrow(IndexedDbUnavailableError);
      await expect(hydrator.materializeToLegacyStores(scope)).rejects.toThrow(
        IndexedDbUnavailableError,
      );
    });
  });
});
