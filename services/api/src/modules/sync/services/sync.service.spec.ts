import 'reflect-metadata';
import { BadRequestException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncLogEmitter } from './sync-log-emitter.service';
import { ConflictResolverDispatcher } from '../resolvers/conflict-resolver.dispatcher';
import { BookmarkConflictResolver } from '../resolvers/bookmark.resolver';
import { ProgressConflictResolver } from '../resolvers/progress.resolver';
import { HistoryConflictResolver } from '../resolvers/history.resolver';
import { PreferenceConflictResolver } from '../resolvers/preference.resolver';
import { FollowConflictResolver } from '../resolvers/follow.resolver';
import { HmacCursorHelper } from '../helpers/hmac-cursor.helper';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';

describe('SyncService (Step 3 Unit & Concurrency Tests)', () => {
  const SECRET = 'test-sync-cursor-secret-key-32chars!!';
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

  let syncService: SyncService;
  let syncLogEmitter: SyncLogEmitter;
  let dispatcher: ConflictResolverDispatcher;
  let mockDataSource: any;
  let mockConfigService: any;
  let mockRunner: any;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, def?: any) => {
        if (key === 'SYNC_CURSOR_SECRET' || key === 'JWT_SECRET') return SECRET;
        return def;
      }),
    };

    mockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockImplementation(() => {
        mockRunner.isTransactionActive = true;
        return Promise.resolve();
      }),
      commitTransaction: jest.fn().mockImplementation(() => {
        mockRunner.isTransactionActive = false;
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn().mockImplementation(() => {
        mockRunner.isTransactionActive = false;
        return Promise.resolve();
      }),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: false,
      query: jest.fn(),
      manager: {
        query: jest.fn(),
      },
    };

    mockRunner.manager.query = mockRunner.query;

    mockDataSource = {
      query: jest.fn(),
      createQueryRunner: jest.fn().mockReturnValue(mockRunner),
    };

    dispatcher = new ConflictResolverDispatcher(
      new BookmarkConflictResolver(),
      new ProgressConflictResolver(),
      new HistoryConflictResolver(),
      new PreferenceConflictResolver(),
      new FollowConflictResolver(),
    );

    syncLogEmitter = new SyncLogEmitter();
    syncService = new SyncService(
      mockDataSource as any,
      mockConfigService as any,
      dispatcher,
      syncLogEmitter,
    );
  });

  describe('getChanges', () => {
    it('should return delta changes after cursor revision', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          { currentSyncRevision: 105n, minActiveRevision: 0n },
        ])
        .mockResolvedValueOnce([
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-1' },
            createdAt: new Date(),
          },
          {
            revision: '102',
            domain: SyncDomain.PROGRESS,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: { storyId: 'story-1', progressPercentage: 50 },
            createdAt: new Date(),
          },
        ]);

      const res = await syncService.getChanges(USER_ID, {
        after: '100',
        limit: 10,
      });

      expect(res.currentServerRevision).toBe('105');
      expect(res.minActiveRevision).toBe('0');
      expect(res.changes.length).toBe(2);
      expect(res.hasMore).toBe(false);
      expect(res.nextRevision).toBeNull();
    });

    it('should indicate hasMore and nextRevision when more changes exist', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          { currentSyncRevision: 105n, minActiveRevision: 0n },
        ])
        .mockResolvedValueOnce([
          {
            revision: '101',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date(),
          },
          {
            revision: '102',
            domain: SyncDomain.PROGRESS,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            payload: {},
            createdAt: new Date(),
          },
        ]);

      // limit: 1 -> received 2 rows -> hasMore is true, nextRevision is '101'
      const res = await syncService.getChanges(USER_ID, {
        after: '100',
        limit: 1,
      });

      expect(res.hasMore).toBe(true);
      expect(res.changes.length).toBe(1);
      expect(res.nextRevision).toBe('101');
    });

    it('should throw HTTP 410 SYNC_REVISION_EXPIRED if client requested after < minActiveRevision', async () => {
      mockDataSource.query.mockResolvedValueOnce([
        { currentSyncRevision: 500n, minActiveRevision: 200n },
      ]);

      try {
        await syncService.getChanges(USER_ID, {
          after: '100', // < 200n
          limit: 50,
        });
        throw new Error('Expected 410 GONE');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.GONE);
        expect(err.getResponse().code).toBe('SYNC_REVISION_EXPIRED');
      }
    });
  });

  describe('getSnapshot', () => {
    it('should fetch snapshot data in a REPEATABLE READ READ ONLY transaction', async () => {
      mockRunner.query
        .mockResolvedValueOnce('SET TRANSACTION READ ONLY')
        .mockResolvedValueOnce([
          { currentSyncRevision: 100n, minActiveRevision: 0n },
        ]) // user_sync_state
        .mockResolvedValueOnce([
          { story_id: 'story-1', created_at: new Date() },
        ]) // bookmarks
        .mockResolvedValueOnce([
          {
            story_id: 'story-1',
            chapter_id: 'chap-1',
            chapter_version_id: null,
            reading_mode: 'WEBTOON',
            page_index: 1,
            scroll_position: 100,
            progress_percentage: 50,
            anchor_block_id: null,
            text_offset: null,
          },
        ]) // reading_progress
        .mockResolvedValueOnce([
          {
            chapter_id: 'chap-1',
            story_id: 'story-1',
            last_version_id: null,
            max_progress_percentage: 50,
            completed_at: null,
            last_read_at: new Date(),
            story_history_epoch: 0,
          },
        ]) // chapter_read_states
        .mockResolvedValueOnce([]); // preferences

      const snapshot = await syncService.getSnapshot(USER_ID, { limit: 100 });

      expect(mockRunner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
      expect(snapshot.snapshotRevision).toBe('100');
      expect(snapshot.data.bookmarks.length).toBe(1);
      expect(snapshot.data.readingProgress.length).toBe(1);
      expect(snapshot.data.chapterReadStates.length).toBe(1);
      expect(mockRunner.commitTransaction).toHaveBeenCalled();
      expect(mockRunner.release).toHaveBeenCalled();
    });

    it('should throw HTTP 409 SNAPSHOT_INVALIDATED when cursor revision != currentServerRevision (Optimistic Snapshot Restart)', async () => {
      // Client cursor has revision 100
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_ID,
          snapshotRevision: '100',
          domain: 'PROGRESS',
          key: 'offset-key',
        },
        SECRET,
      );

      mockRunner.query
        .mockResolvedValueOnce('SET TRANSACTION READ ONLY')
        .mockResolvedValueOnce([
          { currentSyncRevision: 101n, minActiveRevision: 0n }, // Server has moved to 101!
        ]);

      try {
        await syncService.getSnapshot(USER_ID, { cursor, limit: 100 });
        throw new Error('Expected 409 SNAPSHOT_INVALIDATED');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse().code).toBe('SNAPSHOT_INVALIDATED');
        expect(mockRunner.rollbackTransaction).toHaveBeenCalled();
        expect(mockRunner.release).toHaveBeenCalled();
      }
    });
  });

  describe('pushMutations: Idempotency, Concurrency & Invariants', () => {
    it('should apply fresh mutation and bump server revision monotonically', async () => {
      const mutationId = '33333333-3333-4333-8333-333333333333';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-1' },
      };

      // 1. Lock user_sync_state
      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state ON CONFLICT
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT sync_mutation_receipts (empty -> fresh)
        .mockResolvedValueOnce([]) // SELECT sync_tombstones
        .mockResolvedValueOnce([]) // SELECT effectiveEpoch
        .mockResolvedValueOnce([]) // INSERT bookmarks
        .mockResolvedValueOnce([]) // INSERT sync_change_log
        .mockResolvedValueOnce([]) // INSERT sync_mutation_receipts
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      const res = await syncService.pushMutations(USER_ID, {
        mutations: [mutation],
      });

      expect(res.processedCount).toBe(1);
      expect(res.newServerRevision).toBe('11');
      expect(res.results[0].status).toBe('APPLIED');
      expect(res.results[0].assignedRevision).toBe('11');
      expect(mockRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should return DEDUPLICATED with original assigned revision on retry with identical canonical hash', async () => {
      const mutationId = '33333333-3333-4333-8333-333333333333';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-1' },
      };

      const canonicalHash = require('../helpers/canonical-json.helper').computeCanonicalMutationHash(mutation);

      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state
        .mockResolvedValueOnce([
          { current_sync_revision: 15n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([
          {
            payload_hash: canonicalHash,
            status: 'APPLIED',
            assigned_revision: 11n,
            response_meta: {},
          },
        ]) // Found existing receipt with matching hash
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      const res = await syncService.pushMutations(USER_ID, {
        mutations: [mutation],
      });

      expect(res.newServerRevision).toBe('15'); // No new revision allocated!
      expect(res.results[0].status).toBe('DEDUPLICATED');
      expect(res.results[0].assignedRevision).toBe('11');
    });

    it('should throw HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH if mutationId reused with different payload', async () => {
      const mutationId = '33333333-3333-4333-8333-333333333333';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-1', note: 'new payload' },
      };

      mockRunner.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { current_sync_revision: 15n, min_active_revision: 0n },
        ])
        .mockResolvedValueOnce([
          {
            payload_hash: 'different-hash-from-previous-execution',
            status: 'APPLIED',
            assigned_revision: 11n,
          },
        ]);

      try {
        await syncService.pushMutations(USER_ID, {
          mutations: [mutation],
        });
        throw new Error('Expected 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse().code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
        expect(mockRunner.rollbackTransaction).toHaveBeenCalled();
      }
    });

    it('should return original rejection on retry of a rejected mutation (not converted to DEDUPLICATED)', async () => {
      const mutationId = '33333333-3333-4333-8333-333333333333';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.FOLLOW,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: { storyId: 'story-1' },
      };

      const canonicalHash = require('../helpers/canonical-json.helper').computeCanonicalMutationHash(mutation);

      mockRunner.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { current_sync_revision: 20n, min_active_revision: 0n },
        ])
        .mockResolvedValueOnce([
          {
            payload_hash: canonicalHash,
            status: 'DOMAIN_NOT_SUPPORTED',
            assigned_revision: null,
            response_meta: { reason: 'FOLLOW_DOMAIN_NOT_SUPPORTED' },
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await syncService.pushMutations(USER_ID, {
        mutations: [mutation],
      });

      // Invariant P2: giữ nguyên mã từ chối ban đầu, không đổi thành DEDUPLICATED
      expect(res.results[0].status).toBe('DOMAIN_NOT_SUPPORTED');
      expect(res.results[0].assignedRevision).toBeNull();
    });

    it('should reject mutation if baseServerRevision is ahead of current server revision (REJECTED_STALE)', async () => {
      const mutation = {
        clientId: CLIENT_ID,
        mutationId: '44444444-4444-4444-8444-444444444444',
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-1',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '999', // Server is at 10
        payload: { storyId: 'story-1' },
      };

      mockRunner.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ])
        .mockResolvedValueOnce([]);

      const res = await syncService.pushMutations(USER_ID, {
        mutations: [mutation],
      });

      expect(res.results[0].status).toBe('REJECTED_STALE');
      expect(res.results[0].reason).toBe('BASE_REVISION_AHEAD_OF_SERVER');
    });

    it('should enforce zero gamification side-effects during sync replay', async () => {
      const mutation = {
        clientId: CLIENT_ID,
        mutationId: '55555555-5555-4555-8555-555555555555',
        domain: SyncDomain.HISTORY,
        entityId: '11111111-2222-3333-4444-555555555555',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          storyId: '99999999-9999-4999-8999-999999999999',
          chapterId: '11111111-2222-3333-4444-555555555555',
          progressPercentage: 100,
          observedHistoryEpoch: 0,
        },
      };

      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT receipts
        .mockResolvedValueOnce([]) // SELECT tombstones
        .mockResolvedValueOnce([{ effectiveEpoch: 0 }]) // SELECT epoch (0 === 0)
        .mockResolvedValueOnce([{ max_progress_percentage: 100 }]) // INSERT chapter_read_states RETURNING max_progress_percentage
        .mockResolvedValueOnce([]) // INSERT sync_change_log
        .mockResolvedValueOnce([]) // INSERT receipts
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      await syncService.pushMutations(USER_ID, { mutations: [mutation] });

      // Assert that neither user_progression nor reward_transactions were queried or modified
      const executedQueries = mockRunner.query.mock.calls
        .map((call: any[]) => call[0])
        .join('\n');
      expect(executedQueries).not.toContain('user_progression');
      expect(executedQueries).not.toContain('reward_transactions');
      expect(executedQueries).not.toContain('daily_checkins');
    });

    it('DT-20B: HISTORY UPSERT should emit canonical max_progress_percentage committed in DB', async () => {
      const mutationId = '77777777-7777-4777-8777-777777777777';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.HISTORY,
        entityId: '11111111-2222-3333-4444-555555555555',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '10',
        payload: {
          storyId: '99999999-9999-4999-8999-999999999999',
          chapterId: '11111111-2222-3333-4444-555555555555',
          progressPercentage: 30, // Client sends 30%
          observedHistoryEpoch: 0,
        },
      };

      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT receipts
        .mockResolvedValueOnce([]) // SELECT tombstones
        .mockResolvedValueOnce([{ effectiveEpoch: 0 }]) // SELECT epoch
        .mockResolvedValueOnce([{ max_progress_percentage: 90 }]) // DB already has 90%, GREATEST returns 90
        .mockResolvedValueOnce([]) // INSERT sync_change_log
        .mockResolvedValueOnce([]) // INSERT receipts
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      const res = await syncService.pushMutations(USER_ID, { mutations: [mutation] });

      expect(res.results[0].status).toBe('APPLIED');
      expect(res.newServerRevision).toBe('11');

      // Check the payload written to sync_change_log: must have progressPercentage: 90 (canonical), not 30
      const changeLogCall = mockRunner.query.mock.calls.find((call: any[]) =>
        call[0].includes('INSERT INTO sync_change_log'),
      );
      expect(changeLogCall).toBeDefined();
      const changeLogPayload = JSON.parse(changeLogCall[1][7]); // payload is 8th param ($8, index 7)
      expect(changeLogPayload.progressPercentage).toBe(90);
    });

    it('DT-19B: story-wide HISTORY DELETE should bump epoch, record tombstone, and emit payload with epoch', async () => {
      const mutationId = '88888888-8888-4888-8888-888888888888';
      const storyId = '99999999-9999-4999-8999-999999999999';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.HISTORY,
        entityId: storyId,
        operation: SyncOperation.DELETE,
        baseServerRevision: '10',
        payload: { storyId },
      };

      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT receipts
        .mockResolvedValueOnce([]) // SELECT tombstones
        .mockResolvedValueOnce([]) // SELECT epoch
        .mockResolvedValueOnce([{ epoch: 3 }]) // INSERT reading_history_epoch_counters ... RETURNING epoch
        .mockResolvedValueOnce([]) // DELETE reading_progress
        .mockResolvedValueOnce([]) // DELETE chapter_read_states
        .mockResolvedValueOnce([]) // INSERT reading_history_tombstones
        .mockResolvedValueOnce([]) // INSERT sync_tombstones
        .mockResolvedValueOnce([]) // INSERT sync_change_log
        .mockResolvedValueOnce([]) // INSERT receipts
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      const res = await syncService.pushMutations(USER_ID, { mutations: [mutation] });

      expect(res.results[0].status).toBe('APPLIED');
      expect(res.newServerRevision).toBe('11');

      // Verify sync_change_log has payload with epoch: 3
      const changeLogCall = mockRunner.query.mock.calls.find((call: any[]) =>
        call[0].includes('INSERT INTO sync_change_log'),
      );
      expect(changeLogCall).toBeDefined();
      const changeLogPayload = JSON.parse(changeLogCall[1][7]); // payload is 8th param ($8, index 7)
      expect(changeLogPayload.storyId).toBe(storyId);
      expect(changeLogPayload.epoch).toBe(3);
    });

    it('DT-20A: global HISTORY DELETE should normalize entityId to UUID sentinel and write dual tombstones', async () => {
      const mutationId = '99999999-9999-4999-8999-999999999999';
      const mutation = {
        clientId: CLIENT_ID,
        mutationId,
        domain: SyncDomain.HISTORY,
        entityId: 'all',
        operation: SyncOperation.DELETE,
        baseServerRevision: '10',
        payload: {},
      };

      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT user_sync_state
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT receipts
        .mockResolvedValueOnce([]) // SELECT tombstones
        // No epoch query because 'all' is not UUID
        .mockResolvedValueOnce([{ epoch: 1 }]) // INSERT reading_history_epoch_counters ... RETURNING epoch
        .mockResolvedValueOnce([]) // DELETE ALL reading_progress
        .mockResolvedValueOnce([]) // DELETE ALL chapter_read_states
        .mockResolvedValueOnce([]) // INSERT reading_history_tombstones
        .mockResolvedValueOnce([]) // INSERT sync_tombstones (sentinel UUID)
        .mockResolvedValueOnce([]) // INSERT sync_tombstones ('all' alias)
        .mockResolvedValueOnce([]) // INSERT sync_change_log
        .mockResolvedValueOnce([]) // INSERT receipts
        .mockResolvedValueOnce([]); // UPDATE user_sync_state

      const res = await syncService.pushMutations(USER_ID, { mutations: [mutation] });

      expect(res.results[0].status).toBe('APPLIED');
      expect(res.newServerRevision).toBe('11');

      // Verify sync_change_log entityId is normalized UUID sentinel
      const changeLogCall = mockRunner.query.mock.calls.find((call: any[]) =>
        call[0].includes('INSERT INTO sync_change_log'),
      );
      expect(changeLogCall).toBeDefined();
      expect(changeLogCall[1][5]).toBe('00000000-0000-0000-0000-000000000000'); // entityId param $6 (index 5)
      const changeLogPayload = JSON.parse(changeLogCall[1][7]); // payload param $8 (index 7)
      expect(changeLogPayload.epoch).toBe(1);

      // Verify sync_tombstones inserted with sentinel and alias
      const tombstoneCalls = mockRunner.query.mock.calls.filter((call: any[]) =>
        call[0].includes('INSERT INTO sync_tombstones'),
      );
      expect(tombstoneCalls.length).toBe(2);
      expect(tombstoneCalls[0][1][2]).toBe('00000000-0000-0000-0000-000000000000');
      expect(tombstoneCalls[1][1][2]).toBe('all');
    });
  });

  describe('SyncLogEmitter: Integration & Monotonic Bumps', () => {
    it('should atomically lock user_sync_state and emit change log records', async () => {
      const mockManager: any = {
        query: jest
          .fn()
          .mockResolvedValueOnce([]) // INSERT ON CONFLICT
          .mockResolvedValueOnce([
            { current_sync_revision: 40n, min_active_revision: 0n },
          ]) // SELECT FOR UPDATE
          .mockResolvedValueOnce([{ current_sync_revision: 41n }]) // UPDATE RETURNING
          .mockResolvedValueOnce([]), // INSERT sync_change_log
      };

      const rev = await syncLogEmitter.emit(mockManager, {
        userId: USER_ID,
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-99',
        operation: SyncOperation.UPSERT,
        payload: { storyId: 'story-99' },
      });

      expect(rev).toBe('41');
      expect(mockManager.query).toHaveBeenCalledWith(
        expect.stringContaining('user_sync_state'),
        expect.anything(),
      );
    });

    it('should create tombstone on DELETE operation in SyncLogEmitter', async () => {
      const mockManager: any = {
        query: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { current_sync_revision: 41n, min_active_revision: 0n },
          ])
          .mockResolvedValueOnce([{ current_sync_revision: 42n }])
          .mockResolvedValueOnce([]) // INSERT sync_change_log
          .mockResolvedValueOnce([]), // INSERT sync_tombstones
      };

      const rev = await syncLogEmitter.emit(mockManager, {
        userId: USER_ID,
        domain: SyncDomain.BOOKMARK,
        entityId: 'story-99',
        operation: SyncOperation.DELETE,
        payload: { storyId: 'story-99' },
      });

      expect(rev).toBe('42');
      const calls = mockManager.query.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((sql: string) => sql.includes('sync_tombstones'))).toBe(
        true,
      );
    });
  });

  describe('Concurrency & Lock Ordering Alignment', () => {
    it('should verify Level 1 Lock Hierarchy: user_sync_state is always locked before domain mutations', async () => {
      mockRunner.query
        .mockResolvedValueOnce([]) // INSERT ON CONFLICT
        .mockResolvedValueOnce([
          { current_sync_revision: 10n, min_active_revision: 0n },
        ]) // SELECT user_sync_state FOR UPDATE
        .mockResolvedValueOnce([]) // SELECT receipts
        .mockResolvedValueOnce([]) // SELECT tombstones
        .mockResolvedValueOnce([]) // SELECT epoch
        .mockResolvedValueOnce([]) // domain mutations
        .mockResolvedValueOnce([]) // sync_change_log
        .mockResolvedValueOnce([]) // sync_mutation_receipts
        .mockResolvedValueOnce([]); // update user_sync_state

      await syncService.pushMutations(USER_ID, {
        mutations: [
          {
            clientId: CLIENT_ID,
            mutationId: '66666666-6666-4666-8666-666666666666',
            domain: SyncDomain.BOOKMARK,
            entityId: 'story-1',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '10',
            payload: { storyId: 'story-1' },
          },
        ],
      });

      // Verify query order: user_sync_state FOR UPDATE must precede any domain write
      const queries = mockRunner.query.mock.calls.map((c: any[]) => c[0]);
      const userSyncStateLockIdx = queries.findIndex((q: string) =>
        q.includes('FROM user_sync_state') && q.includes('FOR UPDATE'),
      );
      const bookmarkWriteIdx = queries.findIndex((q: string) =>
        q.includes('INSERT INTO bookmarks'),
      );

      expect(userSyncStateLockIdx).toBeGreaterThanOrEqual(0);
      expect(bookmarkWriteIdx).toBeGreaterThan(userSyncStateLockIdx);
    });
  });
});
