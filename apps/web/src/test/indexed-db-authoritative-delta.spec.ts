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
        currentServerRevision: '100',
        minActiveRevision: '50',
        nextRevision: '105',
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
      expect(meta?.minActiveRevision).toBe('50');
      expect(meta?.syncState).toBe('IDLE');

      // Invariant: Baseline status is NOT granted READY by delta ingestion!
      expect(meta?.authoritativeBaselineStatus).toBe('UNINITIALIZED');
      expect(await dbClient.isAuthoritativeReady(scope)).toBe(false);
    });

    it('rolls back completely if transaction aborts: neither shadows nor checkpoint are committed', async () => {
      const scope = 'account:usr-rollback-1';
      const page: SyncChangesResponse = {
        currentServerRevision: '100',
        minActiveRevision: '50',
        nextRevision: '105',
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
        nextRevision: '110',
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
        nextRevision: '110',
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
        nextRevision: '110',
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
        nextRevision: '120',
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
        page: {
          currentServerRevision: '100',
          minActiveRevision: '50',
          nextRevision: '105',
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
          nextRevision: '106',
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
        page: {
          currentServerRevision: '100',
          minActiveRevision: '50',
          nextRevision: '103',
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
          nextRevision: '104',
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
        page: {
          currentServerRevision: bigRev2,
          minActiveRevision: bigRev1,
          nextRevision: bigRev2,
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
          page: {
            currentServerRevision: '150',
            minActiveRevision: '100',
            nextRevision: '150',
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
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: '100',
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
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: '100',
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
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: '100',
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
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: '100',
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
          page: {
            currentServerRevision: '110',
            minActiveRevision: '50',
            nextRevision: '110',
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
        page: {
          currentServerRevision: '50',
          minActiveRevision: '10',
          nextRevision: '50',
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
            nextRevision: '60',
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
        page: {
          currentServerRevision: '100',
          minActiveRevision: '10',
          nextRevision: '100',
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
        page: {
          currentServerRevision: '200',
          minActiveRevision: '10',
          nextRevision: '200',
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
          checkAdmission: () => {
            throw new Error('ADMISSION_REJECTED: User logged out');
          },
          page: {
            currentServerRevision: '100',
            minActiveRevision: '50',
            nextRevision: '100',
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
});
