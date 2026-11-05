import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbClient,
  DB_NAME,
  STORE_AUTHORITATIVE_REPLICAS,
  STORE_SYNC_META,
  CheckpointConflictError,
  InvalidDeltaPayloadError,
  ReadyStatusTransitionForbiddenError,
  AuthoritativeShadowRecord,
  LocalSyncMeta,
  ApplyAuthoritativeDeltaResult,
} from '../lib/storage/indexed-db-client';
import {
  SyncDomain,
  SyncOperation,
  SyncChangesResponse,
  ReadingMode,
} from '@omninovel/shared';

describe('Phase 5.2b — Authoritative Shadow DAL & Atomic Delta Ingestion (ST-01, ST-05, ST-08, ST-09, ST-11, ST-14)', () => {
  let dbClient: IndexedDbClient;

  beforeEach(async () => {
    // Reset fakeIndexedDB state between tests
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

  describe('ST-01: Atomic Ingestion Transaction (Shadow + SyncMeta Checkpoint)', () => {
    it('atomically commits shadow records and checkpoint in a single IDB transaction', async () => {
      const scope = 'account:usr-atomic-1';
      const page: SyncChangesResponse = {
        currentServerRevision: '105',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-1', title: 'Story One' },
            createdAt: new Date().toISOString(),
          },
          {
            revision: '102',
            domain: SyncDomain.PROGRESS,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: {
              storyId: 'story-1',
              chapterId: 'chap-1',
              progressPercentage: 75,
              readingMode: ReadingMode.WEBTOON,
            },
            createdAt: new Date().toISOString(),
          },
          {
            revision: '103',
            domain: SyncDomain.HISTORY,
            entityId: 'story-1:chap-1',
            operation: SyncOperation.UPSERT,
            payload: {
              storyId: 'story-1',
              chapterId: 'chap-1',
              progressPercentage: 75,
              observedHistoryEpoch: 0,
            },
            createdAt: new Date().toISOString(),
          },
          {
            revision: '104',
            domain: SyncDomain.PREFERENCE,
            entityId: 'theme',
            operation: SyncOperation.UPSERT,
            payload: { key: 'theme', value: 'dark' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page,
      });

      expect(result.appliedCount).toBe(4);
      expect(result.newCheckpoint).toBe('105');
      expect(result.hasMore).toBe(false);

      // Verify all shadow records are present
      const bm = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-1');
      expect(bm?.serverRevision).toBe('101');
      expect(bm?.payload?.title).toBe('Story One');

      const prog = await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-1');
      expect(prog?.serverRevision).toBe('102');
      expect(prog?.payload?.progressPercentage).toBe(75);

      const hist = await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-1:chap-1');
      expect(hist?.serverRevision).toBe('103');
      expect(hist?.payload?.chapterId).toBe('chap-1');

      const pref = await dbClient.getAuthoritativeShadow(scope, SyncDomain.PREFERENCE, 'theme');
      expect(pref?.serverRevision).toBe('104');
      expect(pref?.payload?.value).toBe('dark');

      // Verify sync_meta checkpoint
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('105');
      expect(meta?.minActiveRevision).toBe('0');
      expect(meta?.syncState).toBe('IDLE');

      // Invariant: Baseline status is NOT granted READY by delta ingestion!
      expect(meta?.authoritativeBaselineStatus).toBe('UNINITIALIZED');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);
    });

    it('rolls back completely if transaction aborts: neither shadows nor checkpoint are committed', async () => {
      const scope = 'account:usr-rollback-1';
      const page: SyncChangesResponse = {
        currentServerRevision: '105',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-rb',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-rb', title: 'Rollback Story' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
          _testHookBeforeComplete: (tx) => {
            tx.abort();
          },
        })
      ).rejects.toThrow();

      // Verify rollback: shadow record does not exist
      const bm = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-rb');
      expect(bm).toBeNull();

      // Verify rollback: sync_meta was not updated
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta).toBeNull();
    });
  });

  describe('ST-05: Checkpoint OCC Guard & Competing Delta Pages', () => {
    it('accepts ingestion when expectedCheckpoint matches current checkpoint in IDB', async () => {
      const scope = 'account:usr-occ-1';

      // Initialize checkpoint at 100
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '50',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '110',
        minActiveRevision: '50',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-occ',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-occ' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '100', // matches!
        page,
      });

      expect(result.newCheckpoint).toBe('110');
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('110');
    });

    it('rejects ingestion with CheckpointConflictError when expectedCheckpoint mismatches', async () => {
      const scope = 'account:usr-occ-2';

      // Current checkpoint is 100
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '50',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '110',
        minActiveRevision: '50',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-stale',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-stale' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      // Caller expects checkpoint 90, but current is 100
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '90', // mismatch!
          page,
        })
      ).rejects.toThrow(CheckpointConflictError);

      // Verify checkpoint remains untouched at 100
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('100');

      // Verify shadow record was not written
      const shadow = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-stale');
      expect(shadow).toBeNull();
    });

    it('handles competing concurrent delta pages: first wins, second fails OCC', async () => {
      const scope = 'account:usr-occ-competing';

      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '50',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page1: SyncChangesResponse = {
        currentServerRevision: '110',
        minActiveRevision: '50',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-p1',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-p1' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const page2: SyncChangesResponse = {
        currentServerRevision: '120',
        minActiveRevision: '50',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '115',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-p2',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-p2' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      // First call succeeds
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '100',
        page: page1,
      });

      // Second call expects 100, but checkpoint is now 110
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100', // Stale expected checkpoint!
          page: page2,
        })
      ).rejects.toThrow(CheckpointConflictError);

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('110');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-p1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-p2')).toBeNull();
    });
  });

  describe('ST-08: Cascading Tombstone Eviction for Story-Wide and Global HISTORY DELETE', () => {
    it('story-wide HISTORY DELETE cascades to delete all story chapters & progress, updating story epoch', async () => {
      const scope = 'account:usr-cascade-story';

      // 1. Seed Story A (3 chapters + progress) and Story B (2 chapters + progress)
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '105',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            // Story A
            {
              revision: '101',
              domain: SyncDomain.HISTORY,
              entityId: 'story-A:c1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-A', chapterId: 'c1', progressPercentage: 100 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '102',
              domain: SyncDomain.HISTORY,
              entityId: 'story-A:c2',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-A', chapterId: 'c2', progressPercentage: 50 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '103',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-A',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-A', chapterId: 'c2', progressPercentage: 50 },
              createdAt: new Date().toISOString(),
            },
            // Story B
            {
              revision: '104',
              domain: SyncDomain.HISTORY,
              entityId: 'story-B:c1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-B', chapterId: 'c1', progressPercentage: 80 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '105',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-B',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-B', chapterId: 'c1', progressPercentage: 80 },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Verify seeds
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-A:c1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-A:c2')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-A')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-B:c1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-B')).not.toBeNull();

      // 2. Ingest Story-wide HISTORY DELETE for Story A with epoch = 5
      const deleteResult = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '105',
        page: {
          currentServerRevision: '106',
          minActiveRevision: '50',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '106',
              domain: SyncDomain.HISTORY,
              entityId: 'story-A',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-A', epoch: 5 },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      expect(deleteResult.effectiveEpochs['story-A']).toBe(5);

      // Verify Story A shadows are completely wiped
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-A:c1')).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-A:c2')).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-A')).toBeNull();

      // Verify Story B shadows are 100% untouched
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-B:c1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-B')).not.toBeNull();

      // Verify epoch map in sync_meta
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.effectiveHistoryEpochs['story-A']).toBe(5);
      expect(meta?.lastSyncedServerRevision).toBe('106');
    });

    it('global HISTORY DELETE cascades to delete ALL history & progress, updating global UUID sentinel epoch', async () => {
      const scope = 'account:usr-cascade-global';

      // Seed Story A and Story B
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '103',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '101',
              domain: SyncDomain.HISTORY,
              entityId: 'story-1:c1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-1', chapterId: 'c1', progressPercentage: 100 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '102',
              domain: SyncDomain.PROGRESS,
              entityId: 'story-1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-1', chapterId: 'c1', progressPercentage: 100 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '103',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-1',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-1' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Ingest Global HISTORY DELETE with UUID sentinel and epoch = 9
      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '103',
        page: {
          currentServerRevision: '104',
          minActiveRevision: '50',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '104',
              domain: SyncDomain.HISTORY,
              entityId: '00000000-0000-0000-0000-000000000000',
              operation: SyncOperation.DELETE,
              payload: { epoch: 9 },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      expect(result.effectiveEpochs['00000000-0000-0000-0000-000000000000']).toBe(9);

      // Verify all history and progress are wiped
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.HISTORY, 'story-1:c1')).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.PROGRESS, 'story-1')).toBeNull();

      // Verify non-history domain (BOOKMARK) is preserved!
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-1')).not.toBeNull();

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.effectiveHistoryEpochs['00000000-0000-0000-0000-000000000000']).toBe(9);
    });
  });

  describe('ST-09: Decimal BigInt Monotonic Revision Progression', () => {
    it('handles revisions larger than Number.MAX_SAFE_INTEGER with correct BigInt comparison', async () => {
      const scope = 'account:usr-bigint';
      const bigRev1 = '9007199254740995'; // > Number.MAX_SAFE_INTEGER (9007199254740991)
      const bigRev2 = '9007199254740999';

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: bigRev2,
          minActiveRevision: bigRev1,
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: bigRev1,
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-big',
              operation: SyncOperation.UPSERT,
              payload: { storyId: 'story-big' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      expect(result.newCheckpoint).toBe(bigRev2);
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe(bigRev2);
      expect(meta?.minActiveRevision).toBe(bigRev1);
    });

    it('rejects malformed non-numeric revisions (letters, negative, decimal dot) with InvalidDeltaPayloadError', async () => {
      const scope = 'account:usr-malformed-rev';

      const malformedRevisions = ['abc', '-1', '1.5', '', '  '];
      for (const badRev of malformedRevisions) {
        await expect(
          dbClient.applyAuthoritativeDeltaPage({
            ownerScope: scope,
            expectedCheckpoint: '0',
            page: {
              currentServerRevision: '100',
              minActiveRevision: '50',
              nextRevision: badRev,
              hasMore: false,
              changes: [],
            },
          })
        ).rejects.toThrow(InvalidDeltaPayloadError);
      }
    });

    it('rejects regressive target checkpoint (lower than current checkpoint in IDB)', async () => {
      const scope = 'account:usr-regressive-ckpt';

      // Current checkpoint is 200
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '200',
        minActiveRevision: '100',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      // Target checkpoint is 150 (regressive!)
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '200',
          page: {
            currentServerRevision: '150',
            minActiveRevision: '100',
            nextRevision: null,
            hasMore: false,
            changes: [],
          },
        })
      ).rejects.toThrow(/REGRESSIVE_CHECKPOINT/i);

      // Verify checkpoint remains 200
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('200');
    });
  });

  describe('ST-11: Fail-Closed Input Validation', () => {
    it('rejects HISTORY DELETE when epoch is missing, non-numeric, or <= 0', async () => {
      const scope = 'account:usr-missing-epoch';

      // Missing epoch
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '100',
                domain: SyncDomain.HISTORY,
                entityId: 'story-1',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-1' }, // Missing epoch!
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/MISSING_HISTORY_DELETE_EPOCH/i);

      // Non-positive epoch
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '100',
                domain: SyncDomain.HISTORY,
                entityId: 'story-1',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-1', epoch: 0 }, // Epoch <= 0!
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/MISSING_HISTORY_DELETE_EPOCH/i);
    });

    it('rejects unsupported domain or operation', async () => {
      const scope = 'account:usr-bad-domain';

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '100',
                domain: 'NON_EXISTENT_DOMAIN' as any,
                entityId: 'e1',
                operation: SyncOperation.UPSERT,
                payload: {},
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/unsupported domain/i);

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '100',
                domain: SyncDomain.BOOKMARK,
                entityId: 'e1',
                operation: 'PATCH' as any,
                payload: {},
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/unsupported operation/i);
    });

    it('rejects changes within the same page that have regressive revision order', async () => {
      const scope = 'account:usr-regressive-page';

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.BOOKMARK,
                entityId: 'b1',
                operation: SyncOperation.UPSERT,
                payload: {},
                createdAt: new Date().toISOString(),
              },
              {
                revision: '102', // Regressive within page! 102 < 105
                domain: SyncDomain.BOOKMARK,
                entityId: 'b2',
                operation: SyncOperation.UPSERT,
                payload: {},
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/regressive revision/i);
    });
  });

  describe('ST-14: Persistence Across Abort/Reopen & Multi-Scope Isolation', () => {
    it('preserves clean persisted state across connection close and reopen following aborted transaction', async () => {
      const scope = 'account:usr-reopen-test';

      // 1. Initial valid commit at checkpoint 50
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
              entityId: 'story-persisted',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Persisted Story' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // 2. Aborted ingestion attempt at checkpoint 60
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: {
            currentServerRevision: '60',
            minActiveRevision: '10',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '55',
                domain: SyncDomain.BOOKMARK,
                entityId: 'story-aborted',
                operation: SyncOperation.UPSERT,
                payload: { title: 'Should Never Exist' },
                createdAt: new Date().toISOString(),
              },
            ],
          },
          _testHookBeforeComplete: (tx) => tx.abort(),
        })
      ).rejects.toThrow();

      // 3. Close connection
      dbClient.close();

      // 4. Open with new client instance
      const freshClient = new IndexedDbClient();
      try {
        const bmPersisted = await freshClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-persisted');
        expect(bmPersisted).not.toBeNull();
        expect(bmPersisted?.payload?.title).toBe('Persisted Story');

        const bmAborted = await freshClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-aborted');
        expect(bmAborted).toBeNull();

        const meta = await freshClient.getSyncMeta(scope);
        expect(meta?.lastSyncedServerRevision).toBe('50');
      } finally {
        freshClient.close();
      }
    });

    it('strictly isolates delta ingestion between multiple scopes (multi-tenant safety)', async () => {
      const scopeA = 'account:usr-tenant-A';
      const scopeB = 'account:usr-tenant-B';

      // Ingest scope A at rev 100
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scopeA,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '100',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '100',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-shared-id',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Scope A Title' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Ingest scope B at rev 200
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scopeB,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '200',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '200',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-shared-id',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Scope B Title' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Verify isolated shadows
      const shadowA = await dbClient.getAuthoritativeShadow(scopeA, SyncDomain.BOOKMARK, 'story-shared-id');
      expect(shadowA?.serverRevision).toBe('100');
      expect(shadowA?.payload?.title).toBe('Scope A Title');

      const shadowB = await dbClient.getAuthoritativeShadow(scopeB, SyncDomain.BOOKMARK, 'story-shared-id');
      expect(shadowB?.serverRevision).toBe('200');
      expect(shadowB?.payload?.title).toBe('Scope B Title');

      // Verify isolated checkpoints
      expect((await dbClient.getSyncMeta(scopeA))?.lastSyncedServerRevision).toBe('100');
      expect((await dbClient.getSyncMeta(scopeB))?.lastSyncedServerRevision).toBe('200');
    });

    it('aborts transaction if checkAdmission callback throws', async () => {
      const scope = 'account:usr-admission-fail';

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          checkAdmission: () => {
            throw new Error('ADMISSION_REJECTED: User logged out');
          },
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '90',
                domain: SyncDomain.BOOKMARK,
                entityId: 'b1',
                operation: SyncOperation.UPSERT,
                payload: {},
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow('ADMISSION_REJECTED: User logged out');

      expect(await dbClient.getSyncMeta(scope)).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'b1')).toBeNull();
    });
  });

  describe('P0-01 Remediation: Mandatory OCC Checkpoint Guard', () => {
    it('P0-01A: rejects delta ingestion when expectedCheckpoint is omitted or undefined', async () => {
      const scope = 'account:usr-p0-01-omitted';
      const page: SyncChangesResponse = {
        currentServerRevision: '100',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          page,
        } as any)
      ).rejects.toThrow(/MANDATORY_OCC_CHECKPOINT_REQUIRED/i);
    });

    it('P0-01B: rejects delta ingestion when expectedCheckpoint is non-numeric or malformed', async () => {
      const scope = 'account:usr-p0-01-bad-str';
      const page: SyncChangesResponse = {
        currentServerRevision: '100',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [],
      };

      for (const badCkpt of ['abc', '-1', '1.5', '', '  ', null as any]) {
        await expect(
          dbClient.applyAuthoritativeDeltaPage({
            ownerScope: scope,
            expectedCheckpoint: badCkpt,
            page,
          })
        ).rejects.toThrow(/MANDATORY_OCC_CHECKPOINT_REQUIRED/i);
      }
    });

    it('P0-01C: rejects delta ingestion with CheckpointConflictError when expectedCheckpoint mismatches storage', async () => {
      const scope = 'account:usr-p0-01-mismatch';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '150',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '149', // Mismatched! Current is 150
          page,
        })
      ).rejects.toThrow(CheckpointConflictError);
    });
  });

  describe('P0-02 Remediation: Delta Page Consistency & Server Boundaries', () => {
    it('P0-02A: rejects delta page when hasMore is true but nextRevision is null or missing', async () => {
      const scope = 'account:usr-p0-02-hasmore-null';
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: null, // Invalid: hasMore true requires valid nextRevision
        hasMore: true,
        changes: [
          {
            revision: '150',
            domain: SyncDomain.BOOKMARK,
            entityId: 'b1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
        })
      ).rejects.toThrow(/INCONSISTENT_DELTA_PAGE/i);
    });

    it('P0-02B: rejects delta page when a change has revision <= expectedCheckpoint', async () => {
      const scope = 'account:usr-p0-02-stale-change';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '110',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '100', // Stale! revision == expectedCheckpoint (must be > expectedCheckpoint)
            domain: SyncDomain.BOOKMARK,
            entityId: 'b1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page,
        })
      ).rejects.toThrow(/INCONSISTENT_DELTA_PAGE/i);
    });

    it('P0-02C: rejects delta page when a change has revision > targetCheckpoint', async () => {
      const scope = 'account:usr-p0-02-future-change';
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: '150', // Target checkpoint is 150
        hasMore: true,
        changes: [
          {
            revision: '155', // Anomaly! 155 > targetCheckpoint 150
            domain: SyncDomain.BOOKMARK,
            entityId: 'b1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
        })
      ).rejects.toThrow(/INCONSISTENT_DELTA_PAGE/i);
    });

    it('P0-02D: rejects delta page when targetCheckpoint exceeds currentServerRevision', async () => {
      const scope = 'account:usr-p0-02-server-bound';
      const page: SyncChangesResponse = {
        currentServerRevision: '100',
        minActiveRevision: '0',
        nextRevision: '120',
        hasMore: true,
        changes: [
          {
            revision: '120', // matches cursor, but 120 > currentServerRevision 100!
            domain: SyncDomain.BOOKMARK,
            entityId: 'b1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
        })
      ).rejects.toThrow(/INCONSISTENT_DELTA_PAGE/i);
    });

    it('P0-02E: rejects delta page when client checkpoint has fallen behind minActiveRevision (Compacted Gap)', async () => {
      const scope = 'account:usr-p0-02-gap';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '50',
        minActiveRevision: '10',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      // Server retention window has pruned everything before revision 80!
      const page: SyncChangesResponse = {
        currentServerRevision: '150',
        minActiveRevision: '80', // Gap! client checkpoint 50 < server minActiveRevision 80
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '85',
            domain: SyncDomain.BOOKMARK,
            entityId: 'b1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page,
        })
      ).rejects.toThrow(/COMPACTED_RETENTION_GAP/i);
    });
  });

  describe('P1-01 Remediation: HISTORY Epoch Monotonicity Guard', () => {
    it('P1-01A: rejects global HISTORY DELETE when incoming epoch <= current global epoch', async () => {
      const scope = 'account:usr-p1-01-global-monotonic';
      // Seed initial global epoch = 5
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {
          '00000000-0000-0000-0000-000000000000': 5,
        },
        syncState: 'IDLE',
      });

      // Attempt to apply global delete with stale epoch = 4
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.HISTORY,
                entityId: '00000000-0000-0000-0000-000000000000',
                operation: SyncOperation.DELETE,
                payload: { epoch: 4 }, // Stale! 4 < 5
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);

      // Attempt to apply global delete with equal epoch = 5
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.HISTORY,
                entityId: '00000000-0000-0000-0000-000000000000',
                operation: SyncOperation.DELETE,
                payload: { epoch: 5 }, // Stale! 5 <= 5
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);
    });

    it('P1-01B: rejects story-wide HISTORY DELETE when incoming epoch <= current story epoch', async () => {
      const scope = 'account:usr-p1-01-story-monotonic';
      // Seed story-A epoch = 10
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {
          'story-A': 10,
        },
        syncState: 'IDLE',
      });

      // Attempt to apply delete with epoch 8 (stale)
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.HISTORY,
                entityId: 'story-A',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-A', epoch: 8 },
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);

      // Attempt to apply delete with epoch 10 (equal)
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.HISTORY,
                entityId: 'story-A',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-A', epoch: 10 },
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);
    });

    it('P1-01C: rejects story-wide HISTORY DELETE when incoming epoch <= current global epoch', async () => {
      const scope = 'account:usr-p1-01-global-dominance';
      // Global epoch = 12, story-A epoch = 0
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {
          '00000000-0000-0000-0000-000000000000': 12,
        },
        syncState: 'IDLE',
      });

      // Attempt story-A delete with epoch = 11 (less than global epoch 12)
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '105',
                domain: SyncDomain.HISTORY,
                entityId: 'story-A',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-A', epoch: 11 }, // < 12!
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);
    });

    it('P1-01D: rejects intra-page non-monotonic HISTORY DELETE progression', async () => {
      const scope = 'account:usr-p1-01-intra-page';

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page: {
            currentServerRevision: '110',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: [
              {
                revision: '101',
                domain: SyncDomain.HISTORY,
                entityId: 'story-A',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-A', epoch: 5 },
                createdAt: new Date().toISOString(),
              },
              {
                revision: '102',
                domain: SyncDomain.HISTORY,
                entityId: 'story-A',
                operation: SyncOperation.DELETE,
                payload: { storyId: 'story-A', epoch: 4 }, // Non-monotonic within same page! 4 <= 5
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/NON_MONOTONIC_HISTORY_EPOCH/i);
    });

    it('P1-01E: accepts strictly increasing HISTORY DELETE epochs and updates epoch map atomically', async () => {
      const scope = 'account:usr-p1-01-increasing';

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '110',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '101',
              domain: SyncDomain.HISTORY,
              entityId: 'story-A',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-A', epoch: 3 },
              createdAt: new Date().toISOString(),
            },
            {
              revision: '105',
              domain: SyncDomain.HISTORY,
              entityId: 'story-A',
              operation: SyncOperation.DELETE,
              payload: { storyId: 'story-A', epoch: 7 }, // Strictly increasing: 7 > 3
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      expect(result.effectiveEpochs['story-A']).toBe(7);
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.effectiveHistoryEpochs['story-A']).toBe(7);
    });
  });

  describe('P0-03 Remediation: Delta Pagination Cursor Integrity & Server Contract Alignment', () => {
    it('P0-03A: rejects delta page when hasMore is true but changes array is empty', async () => {
      const scope = 'account:usr-p0-03-empty-hasmore';
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: '150',
        hasMore: true,
        changes: [],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
        })
      ).rejects.toThrow(/INCONSISTENT_DELTA_PAGE: hasMore is true, but changes array is empty/i);

      // Verify no metadata change
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta).toBeNull();
    });

    it('P0-03B: rejects delta page when hasMore is true and cursor exceeds last change revision (potential skipped deltas)', async () => {
      const scope = 'account:usr-p0-03-cursor-exceeds';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      // Cursor is 150, but changes only contains revision 101!
      // If accepted, next pull with after=150 would skip revisions 102..150 permanently.
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: '150',
        hasMore: true,
        changes: [
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-101',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Story 101' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page,
        })
      ).rejects.toThrow(/does not match last change revision/i);

      // Verify rollback / zero mutation: checkpoint remains 100, no shadow written
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('100');
      const shadow = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-101');
      expect(shadow).toBeNull();
    });

    it('P0-03C: rejects delta page when hasMore is true and cursor is less than last change revision', async () => {
      const scope = 'account:usr-p0-03-cursor-lagging';
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: '101', // Cursor lags behind last change 105!
        hasMore: true,
        changes: [
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-101',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-105',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '0',
          page,
        })
      ).rejects.toThrow(/does not match last change revision/i);

      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-101')).toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-105')).toBeNull();
    });

    it('P0-03D: rejects delta page when hasMore is false but nextRevision is not null', async () => {
      const scope = 'account:usr-p0-03-hasmore-false-nonnull';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '150',
        minActiveRevision: '0',
        nextRevision: '150', // Non-null when hasMore is false!
        hasMore: false,
        changes: [
          {
            revision: '120',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-120',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Story 120' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '100',
          page,
        })
      ).rejects.toThrow(/hasMore is false, but nextRevision is not null/i);

      // Verify checkpoint remains 100, story-120 was not written
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('100');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-120')).toBeNull();
    });

    it('P0-03E: successfully advances checkpoint to nextRevision when hasMore is true and cursor matches last change exactly', async () => {
      const scope = 'account:usr-p0-03-valid-page-more';
      const page: SyncChangesResponse = {
        currentServerRevision: '200',
        minActiveRevision: '0',
        nextRevision: '105',
        hasMore: true,
        changes: [
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-p1',
            operation: SyncOperation.UPSERT,
            payload: { title: 'P1' },
            createdAt: new Date().toISOString(),
          },
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-p2',
            operation: SyncOperation.UPSERT,
            payload: { title: 'P2' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page,
      });

      expect(result.appliedCount).toBe(2);
      expect(result.newCheckpoint).toBe('105');
      expect(result.hasMore).toBe(true);

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('105');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-p1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-p2')).not.toBeNull();
    });

    it('P0-03F: successfully advances checkpoint to currentServerRevision when hasMore is false and nextRevision is null', async () => {
      const scope = 'account:usr-p0-03-valid-page-final';
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '105',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page: SyncChangesResponse = {
        currentServerRevision: '120',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '110',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-final',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Final Page' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const result = await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '105',
        page,
      });

      expect(result.appliedCount).toBe(1);
      expect(result.newCheckpoint).toBe('120'); // Advanced to currentServerRevision
      expect(result.hasMore).toBe(false);

      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('120');
      expect(await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-final')).not.toBeNull();
    });

    it('P0-03G: rollback verification: rejecting invalid cursor preserves prior checkpoint and shadow records atomically', async () => {
      const scope = 'account:usr-p0-03-rollback-test';
      // Seed initial state at checkpoint 50
      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '50',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '50',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-seed',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Seeded Story' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Attempt invalid delta with cursor > last change revision
      await expect(
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: {
            currentServerRevision: '200',
            minActiveRevision: '0',
            nextRevision: '150', // Cursor mismatch: 150 != 101
            hasMore: true,
            changes: [
              {
                revision: '101',
                domain: SyncDomain.BOOKMARK,
                entityId: 'story-should-rollback',
                operation: SyncOperation.UPSERT,
                payload: { title: 'Should Not Exist' },
                createdAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).rejects.toThrow(/does not match last change revision/i);

      // Verify atomic preservation of prior checkpoint and shadows
      const meta = await dbClient.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision).toBe('50');

      const seedShadow = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-seed');
      expect(seedShadow).not.toBeNull();
      expect(seedShadow?.payload?.title).toBe('Seeded Story');

      const rejectedShadow = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-should-rollback');
      expect(rejectedShadow).toBeNull();
    });
  });

  describe('P1-02 Remediation: Concurrent Transaction Isolation & OCC Race', () => {
    it('P1-02A: exactly one transaction succeeds and competing transaction fails with CheckpointConflictError in concurrent race', async () => {
      const scope = 'account:usr-p1-02-concurrent-race';

      // Setup initial checkpoint at 100
      await dbClient.putSyncMeta({
        ownerScope: scope,
        lastSyncedServerRevision: '100',
        minActiveRevision: '0',
        lastSyncTimestamp: new Date().toISOString(),
        effectiveHistoryEpochs: {},
        syncState: 'IDLE',
      });

      const page1: SyncChangesResponse = {
        currentServerRevision: '120',
        minActiveRevision: '0',
        nextRevision: '105',
        hasMore: true,
        changes: [
          {
            revision: '105',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-race-1',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Winner 1' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const page2: SyncChangesResponse = {
        currentServerRevision: '120',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '115',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-race-2',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Winner 2' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      // Launch both concurrent transactions with the same expectedCheckpoint = '100'
      const p1 = dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '100',
        page: page1,
      });
      p1.catch(() => {});

      const p2 = dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '100',
        page: page2,
      });
      p2.catch(() => {});

      const results = await Promise.allSettled([p1, p2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Verify the failure reason is CheckpointConflictError
      const rejectedResult = rejected[0] as PromiseRejectedResult;
      expect(rejectedResult.reason).toBeInstanceOf(CheckpointConflictError);

      // Verify shadow records of both winner and loser:
      const p1Won = results[0].status === 'fulfilled';
      const shadow1 = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-race-1');
      const shadow2 = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-race-2');
      const meta = await dbClient.getSyncMeta(scope);

      if (p1Won) {
        expect(shadow1).not.toBeNull();
        expect(shadow1?.payload?.title).toBe('Winner 1');
        expect(shadow2).toBeNull(); // Losing transaction shadow must NOT exist
        expect(meta?.lastSyncedServerRevision).toBe('105');
      } else {
        expect(shadow2).not.toBeNull();
        expect(shadow2?.payload?.title).toBe('Winner 2');
        expect(shadow1).toBeNull(); // Losing transaction shadow must NOT exist
        expect(meta?.lastSyncedServerRevision).toBe('120');
      }
    });

    it('P1-02B: two independent IndexedDbClient instances racing on same database results in exactly one success, one OCC conflict, and zero dirty shadow', async () => {
      const scope = 'account:usr-p1-02-independent-clients';
      const client1 = new IndexedDbClient();
      const client2 = new IndexedDbClient();

      try {
        await client1.putSyncMeta({
          ownerScope: scope,
          lastSyncedServerRevision: '50',
          minActiveRevision: '0',
          lastSyncTimestamp: new Date().toISOString(),
          effectiveHistoryEpochs: {},
          syncState: 'IDLE',
        });

        const pageA: SyncChangesResponse = {
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '60',
          hasMore: true,
          changes: [
            {
              revision: '60',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-client1-A',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Client 1 Story' },
              createdAt: new Date().toISOString(),
            },
          ],
        };

        const pageB: SyncChangesResponse = {
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '75',
          hasMore: true,
          changes: [
            {
              revision: '75',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-client2-B',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Client 2 Story' },
              createdAt: new Date().toISOString(),
            },
          ],
        };

        const p1 = client1.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: pageA,
        });
        p1.catch(() => {});

        const p2 = client2.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: pageB,
        });
        p2.catch(() => {});

        const results = await Promise.allSettled([p1, p2]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CheckpointConflictError);

        const client1Won = results[0].status === 'fulfilled';
        const shadowA = await client1.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-client1-A');
        const shadowB = await client1.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-client2-B');
        const meta = await client1.getSyncMeta(scope);

        if (client1Won) {
          expect(shadowA).not.toBeNull();
          expect(shadowA?.payload?.title).toBe('Client 1 Story');
          expect(shadowB).toBeNull(); // Loser's shadow must NOT exist
          expect(meta?.lastSyncedServerRevision).toBe('60');
        } else {
          expect(shadowB).not.toBeNull();
          expect(shadowB?.payload?.title).toBe('Client 2 Story');
          expect(shadowA).toBeNull(); // Loser's shadow must NOT exist
          expect(meta?.lastSyncedServerRevision).toBe('75');
        }
      } finally {
        client1.close();
        client2.close();
      }
    });

    it('P1-02C: delayed-commit interleaving with deterministic coordination enforces OCC rollback and zero dirty shadow', async () => {
      const scope = 'account:usr-p1-02-interleaved-delayed-commit';
      const clientA = new IndexedDbClient();
      const clientB = new IndexedDbClient();

      try {
        await clientA.putSyncMeta({
          ownerScope: scope,
          lastSyncedServerRevision: '50',
          minActiveRevision: '0',
          lastSyncTimestamp: new Date().toISOString(),
          effectiveHistoryEpochs: {},
          syncState: 'IDLE',
        });

        const pageA: SyncChangesResponse = {
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '70',
          hasMore: true,
          changes: [
            {
              revision: '70',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-interleaved-A',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Story A' },
              createdAt: new Date().toISOString(),
            },
          ],
        };

        const pageB: SyncChangesResponse = {
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '80',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-interleaved-B',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Story B' },
              createdAt: new Date().toISOString(),
            },
          ],
        };

        let promiseB: Promise<ApplyAuthoritativeDeltaResult> | null = null;

        // Client A launches and in its _testHookBeforeComplete (while A's transaction is active in DB,
        // before commit), client B initiates transaction with stale expectedCheckpoint '50'.
        const promiseA = clientA.applyAuthoritativeDeltaPage({
          ownerScope: scope,
          expectedCheckpoint: '50',
          page: pageA,
          _testHookBeforeComplete: () => {
            // Interleaving barrier: Client B initiates concurrent transaction against the same DB
            // using the checkpoint it observed ('50') before client A commits '70'.
            promiseB = clientB.applyAuthoritativeDeltaPage({
              ownerScope: scope,
              expectedCheckpoint: '50',
              page: pageB,
            });
            promiseB.catch(() => {});
          },
        });

        const resultA = await promiseA;
        expect(resultA.newCheckpoint).toBe('70');

        expect(promiseB).not.toBeNull();
        await expect(promiseB!).rejects.toThrow(CheckpointConflictError);

        // Verify Story A exists and Story B does NOT exist in shadow store
        expect(await clientA.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-interleaved-A')).not.toBeNull();
        expect(await clientA.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-interleaved-B')).toBeNull();

        // Verify checkpoint remains at Client A's committed revision ('70')
        const meta = await clientA.getSyncMeta(scope);
        expect(meta?.lastSyncedServerRevision).toBe('70');
      } finally {
        clientA.close();
        clientB.close();
      }
    });

    it('P1-02D: concurrent transactions on different scopes execute simultaneously without interference', async () => {
      const scope1 = 'account:usr-p1-02-scope-1';
      const scope2 = 'account:usr-p1-02-scope-2';

      // Both start at checkpoint '0'
      const page1: SyncChangesResponse = {
        currentServerRevision: '50',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '40',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-s1',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Scope 1 Story' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      const page2: SyncChangesResponse = {
        currentServerRevision: '60',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: [
          {
            revision: '45',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-s2',
            operation: SyncOperation.UPSERT,
            payload: { title: 'Scope 2 Story' },
            createdAt: new Date().toISOString(),
          },
        ],
      };

      // Concurrently run on two different scopes
      const [res1, res2] = await Promise.all([
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope1,
          expectedCheckpoint: '0',
          page: page1,
        }),
        dbClient.applyAuthoritativeDeltaPage({
          ownerScope: scope2,
          expectedCheckpoint: '0',
          page: page2,
        }),
      ]);

      expect(res1.newCheckpoint).toBe('50');
      expect(res2.newCheckpoint).toBe('60');

      // Verify scope 1
      expect((await dbClient.getSyncMeta(scope1))?.lastSyncedServerRevision).toBe('50');
      expect(await dbClient.getAuthoritativeShadow(scope1, SyncDomain.BOOKMARK, 'story-s1')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope1, SyncDomain.BOOKMARK, 'story-s2')).toBeNull();

      // Verify scope 2
      expect((await dbClient.getSyncMeta(scope2))?.lastSyncedServerRevision).toBe('60');
      expect(await dbClient.getAuthoritativeShadow(scope2, SyncDomain.BOOKMARK, 'story-s2')).not.toBeNull();
      expect(await dbClient.getAuthoritativeShadow(scope2, SyncDomain.BOOKMARK, 'story-s1')).toBeNull();
    });

    it('P1-02E: concurrent read during or after delta commit returns strictly committed snapshot', async () => {
      const scope = 'account:usr-p1-02-read-isolation';

      await dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: {
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '90',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-read-isolation',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Version 1' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });

      // Attempt second ingestion that fails OCC
      const failingPromise = dbClient.applyAuthoritativeDeltaPage({
        ownerScope: scope,
        expectedCheckpoint: '99', // Mismatch!
        page: {
          currentServerRevision: '150',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: [
            {
              revision: '140',
              domain: SyncDomain.BOOKMARK,
              entityId: 'story-read-isolation',
              operation: SyncOperation.UPSERT,
              payload: { title: 'Version 2 (Dirty)' },
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
      failingPromise.catch(() => {});

      // Concurrent read while failingPromise is in flight
      const readRecord = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-read-isolation');
      expect(readRecord?.payload?.title).toBe('Version 1'); // Never dirty!

      await expect(failingPromise).rejects.toThrow(CheckpointConflictError);

      // Read after rejection
      const postReadRecord = await dbClient.getAuthoritativeShadow(scope, SyncDomain.BOOKMARK, 'story-read-isolation');
      expect(postReadRecord?.payload?.title).toBe('Version 1');
      expect((await dbClient.getSyncMeta(scope))?.lastSyncedServerRevision).toBe('100');
    });
  });
});
