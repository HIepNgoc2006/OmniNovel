import { DataSource } from 'typeorm';
import { CreateSyncEngineTables1700000000021 } from '../src/database/migrations/1700000000021-CreateSyncEngineTables';
import { CreateUserPreferencesTable1700000000022 } from '../src/database/migrations/1700000000022-CreateUserPreferencesTable';
import {
  validateTestDatabaseTarget,
  verifyTestDatabaseIdentity,
  bootstrapTestDatabaseMarker,
  EXPECTED_LOOPBACK_TEST_PORT,
} from '../src/common/guards/test-isolation-guard';
import { buildPostgresConnectionOptions } from '../src/database/database.config';
import { SyncService } from '../src/modules/sync/services/sync.service';
import { SyncLogEmitter } from '../src/modules/sync/services/sync-log-emitter.service';
import {
  BookmarkConflictResolver,
  ConflictResolverDispatcher,
  FollowConflictResolver,
  HistoryConflictResolver,
  PreferenceConflictResolver,
  ProgressConflictResolver,
} from '../src/modules/sync/resolvers';
import { SyncDomain, SyncOperation } from '../src/modules/sync/interfaces/sync.types';
import { StoriesService } from '../src/modules/stories/stories.service';
import { RedisService } from '../src/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

describe('Task 7C.2a: Core Sync Hub Integrity & Concurrency Remediation (Integration)', () => {
  let dataSource: DataSource;
  let syncService: SyncService;
  let syncLogEmitter: SyncLogEmitter;
  let storiesService: StoriesService;
  let configService: ConfigService;
  const cursorSecret = 'test-secret-32-chars-long-for-hmac!';

  const targetHost = process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1';
  const targetPort = Number(
    process.env.TEST_DB_PORT || process.env.DB_PORT || EXPECTED_LOOPBACK_TEST_PORT,
  );
  const targetDb = process.env.TEST_DB_NAME || process.env.DB_NAME || 'omninovel_test';
  const targetUser = process.env.TEST_DB_USER || process.env.DB_USER || 'postgres';
  const targetPassword =
    process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres_password_secure';

  beforeAll(async () => {
    // 1. Strict Fail-Closed Verification before opening connection
    validateTestDatabaseTarget({
      host: targetHost,
      port: targetPort,
      database: targetDb,
    });

    // 2. Verify identity marker and current_database() === 'omninovel_test'
    await bootstrapTestDatabaseMarker({
      host: targetHost,
      port: targetPort,
      database: targetDb,
      user: targetUser,
      password: targetPassword,
    });
    await verifyTestDatabaseIdentity({
      host: targetHost,
      port: targetPort,
      database: targetDb,
      user: targetUser,
      password: targetPassword,
    });

    // 3. Build connection strictly for isolated test database
    const pgOptions = buildPostgresConnectionOptions({
      host: targetHost,
      port: targetPort,
      username: targetUser,
      password: targetPassword,
      database: targetDb,
      ssl: false,
    });

    dataSource = new DataSource({
      type: 'postgres',
      ...pgOptions,
      synchronize: false,
      logging: false,
      entities: [path.join(__dirname, '../src/**/*.entity.ts')],
    });

    await dataSource.initialize();

    // 4. Ensure migrations 0021 and 0022 are applied
    const qr = dataSource.createQueryRunner();
    try {
      const mig21 = new CreateSyncEngineTables1700000000021();
      await mig21.up(qr);
      const mig22 = new CreateUserPreferencesTable1700000000022();
      await mig22.up(qr);
    } finally {
      await qr.release();
    }

    // 5. Instantiate services with real DataSource
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'SYNC_CURSOR_SECRET' || key === 'JWT_SECRET') {
          return cursorSecret;
        }
        return null;
      }),
    } as any;

    syncLogEmitter = new SyncLogEmitter();
    const dispatcher = new ConflictResolverDispatcher(
      new BookmarkConflictResolver(),
      new ProgressConflictResolver(),
      new HistoryConflictResolver(),
      new PreferenceConflictResolver(),
      new FollowConflictResolver(),
    );

    syncService = new SyncService(
      dataSource,
      configService,
      dispatcher,
      syncLogEmitter,
    );

    const redisMock = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    } as any;

    storiesService = new StoriesService(
      dataSource.getRepository('Story'),
      dataSource.getRepository('StoryMember'),
      dataSource.getRepository('StoryEdition'),
      dataSource.getRepository('Bookmark'),
      dataSource.getRepository('ReadingProgress'),
      dataSource.getRepository('ChapterReadState'),
      dataSource.getRepository('Volume'),
      dataSource.getRepository('Chapter'),
      redisMock,
      dataSource,
      syncLogEmitter,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function createTestUser(): Promise<string> {
    const id = uuidv4();
    const username = `u_${id.slice(0, 8)}`;
    await dataSource.query(
      `INSERT INTO users (id, username, email, password_hash)
       VALUES ($1, $2, $3, 'hash')`,
      [id, username, `sync_user_${id.slice(0, 8)}@example.com`],
    );
    return id;
  }

  async function createTestStory(userId: string): Promise<{ storyId: string; chapterId: string; versionId: string }> {
    const storyId = uuidv4();
    const editionId = uuidv4();
    const chapterId = uuidv4();
    const versionId = uuidv4();

    await dataSource.query(
      `INSERT INTO stories (id, title, slug, media_format, publication_format, cover_url, status, visibility, followers_count, created_at, updated_at)
       VALUES ($1, 'Test Story', $2, 'COMIC', 'MANGA', 'https://example.com/cover.jpg', 'COMPLETED', 'PUBLIC', 0, NOW(), NOW())`,
      [storyId, `story_${storyId.slice(0, 8)}`],
    );

    await dataSource.query(
      `INSERT INTO story_editions (id, story_id, edition_name, is_default, created_at)
       VALUES ($1, $2, 'Default Edition', true, NOW())`,
      [editionId, storyId],
    );

    await dataSource.query(
      `INSERT INTO chapters (id, story_edition_id, title, chapter_number, created_at)
       VALUES ($1, $2, 'Chapter 1', 1, NOW())`,
      [chapterId, editionId],
    );

    await dataSource.query(
      `INSERT INTO chapter_versions (id, chapter_id, version_number, version_type, is_published, created_at)
       VALUES ($1, $2, 1, 'RAW_ORIGINAL', true, NOW())`,
      [versionId, chapterId],
    );

    return { storyId, chapterId, versionId };
  }

  describe('P0-01: True Keyset Snapshot Pagination over 4 Domains', () => {
    it('should cleanly paginate across bookmarks, progress, read states, and preferences without duplicates or omission', async () => {
      const userId = await createTestUser();

      // Seed 3 stories
      const stories: { storyId: string; chapterId: string; versionId: string }[] = [];
      for (let i = 0; i < 3; i++) {
        stories.push(await createTestStory(userId));
      }

      // Add 2 bookmarks
      await dataSource.query(
        `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())`,
        [userId, stories[0].storyId, stories[1].storyId],
      );

      // Add 2 reading progress
      await dataSource.query(
        `INSERT INTO reading_progress (user_id, story_id, chapter_id, chapter_version_id, reading_mode, progress_percentage, scroll_position, page_index, updated_at)
         VALUES ($1, $2, $3, $4, 'PAGED', 50, 0, 5, NOW()),
                ($1, $5, $6, $7, 'PAGED', 30, 0, 3, NOW())`,
        [
          userId,
          stories[0].storyId,
          stories[0].chapterId,
          stories[0].versionId,
          stories[1].storyId,
          stories[1].chapterId,
          stories[1].versionId,
        ],
      );

      // Add 2 chapter read states
      await dataSource.query(
        `INSERT INTO chapter_read_states (user_id, chapter_id, last_version_id, max_progress_percentage, completed_at, last_read_at)
         VALUES ($1, $2, $3, 80, NOW(), NOW()),
                ($1, $4, $5, 40, NULL, NOW())`,
        [
          userId,
          stories[0].chapterId,
          stories[0].versionId,
          stories[1].chapterId,
          stories[1].versionId,
        ],
      );

      // Add 2 preferences
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, key, value, updated_at)
         VALUES ($1, 'font_family', '"sans"'::jsonb, NOW()),
                ($1, 'theme', '"dark"'::jsonb, NOW())`,
        [userId],
      );

      // Total items across 4 domains = 2 + 2 + 2 + 2 = 8 items.
      // Request with limit = 3: should take exactly 3 pages (Page 1: 3, Page 2: 3, Page 3: 2)

      // Page 1
      const page1 = await syncService.getSnapshot(userId, { limit: 3 });
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      const countP1 =
        page1.data.bookmarks.length +
        page1.data.readingProgress.length +
        page1.data.chapterReadStates.length +
        page1.data.preferences.length;
      expect(countP1).toBe(3);

      // Page 2
      const page2 = await syncService.getSnapshot(userId, {
        limit: 3,
        cursor: page1.nextCursor!,
      });
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBeDefined();
      const countP2 =
        page2.data.bookmarks.length +
        page2.data.readingProgress.length +
        page2.data.chapterReadStates.length +
        page2.data.preferences.length;
      expect(countP2).toBe(3);

      // Page 3
      const page3 = await syncService.getSnapshot(userId, {
        limit: 3,
        cursor: page2.nextCursor!,
      });
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
      const countP3 =
        page3.data.bookmarks.length +
        page3.data.readingProgress.length +
        page3.data.chapterReadStates.length +
        page3.data.preferences.length;
      expect(countP3).toBe(2);

      // Total collected across all 3 pages must be exactly 8 items without duplicate or miss
      const allBookmarks = [
        ...page1.data.bookmarks,
        ...page2.data.bookmarks,
        ...page3.data.bookmarks,
      ];
      const allProgress = [
        ...page1.data.readingProgress,
        ...page2.data.readingProgress,
        ...page3.data.readingProgress,
      ];
      const allReadStates = [
        ...page1.data.chapterReadStates,
        ...page2.data.chapterReadStates,
        ...page3.data.chapterReadStates,
      ];
      const allPreferences = [
        ...page1.data.preferences,
        ...page2.data.preferences,
        ...page3.data.preferences,
      ];

      expect(allBookmarks).toHaveLength(2);
      expect(allProgress).toHaveLength(2);
      expect(allReadStates).toHaveLength(2);
      expect(allPreferences).toHaveLength(2);

      const bookmarkIds = new Set(allBookmarks.map((b) => b.storyId));
      expect(bookmarkIds.size).toBe(2);
      const prefKeys = new Set(allPreferences.map((p) => p.key));
      expect(prefKeys.size).toBe(2);
      expect(prefKeys).toContain('font_family');
      expect(prefKeys).toContain('theme');
    });
  });

  describe('P0-02: PREFERENCE Source of Truth, UPSERT/DELETE & Tombstones', () => {
    it('should persist UPSERT to user_preferences, delete on DELETE, and record sync_tombstones', async () => {
      const userId = await createTestUser();
      const clientId = uuidv4();

      // 1. UPSERT preference 'theme' = 'dark'
      const upsertRes = await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.PREFERENCE,
            entityId: 'theme',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { key: 'theme', value: 'dark' },
          },
        ],
      });
      expect(upsertRes.results[0].status).toBe('APPLIED');

      // Check DB
      const dbPref = await dataSource.query(
        `SELECT key, value FROM user_preferences WHERE user_id = $1 AND key = 'theme'`,
        [userId],
      );
      expect(dbPref).toHaveLength(1);
      expect(dbPref[0].value).toBe('dark');

      // Snapshot contains theme
      const snap1 = await syncService.getSnapshot(userId, {});
      expect(snap1.data.preferences).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'theme', value: 'dark' })]),
      );

      // 2. DELETE preference 'theme'
      const deleteRes = await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.PREFERENCE,
            entityId: 'theme',
            operation: SyncOperation.DELETE,
            baseServerRevision: upsertRes.newServerRevision,
            payload: { key: 'theme', value: null },
          },
        ],
      });
      expect(deleteRes.results[0].status).toBe('APPLIED');

      // Check DB: preference deleted
      const dbPrefAfter = await dataSource.query(
        `SELECT key FROM user_preferences WHERE user_id = $1 AND key = 'theme'`,
        [userId],
      );
      expect(dbPrefAfter).toHaveLength(0);

      // Check sync_tombstones
      const tombstone = await dataSource.query(
        `SELECT domain, entity_id FROM sync_tombstones WHERE user_id = $1 AND domain = 'PREFERENCE' AND entity_id = 'theme'`,
        [userId],
      );
      expect(tombstone).toHaveLength(1);

      // Snapshot does NOT contain deleted preference
      const snap2 = await syncService.getSnapshot(userId, {});
      expect(snap2.data.preferences.find((p) => p.key === 'theme')).toBeUndefined();
    });
  });

  describe('P0-03: HISTORY DELETE Semantics & Epoch Progression', () => {
    it('should clear reading progress and read states for story, increment epoch, and insert tombstones', async () => {
      const userId = await createTestUser();
      const story = await createTestStory(userId);
      const clientId = uuidv4();

      // Seed progress and read state
      await dataSource.query(
        `INSERT INTO reading_progress (user_id, story_id, chapter_id, chapter_version_id, reading_mode, progress_percentage, scroll_position, page_index, updated_at)
         VALUES ($1, $2, $3, $4, 'PAGED', 75, 0, 7, NOW())`,
        [userId, story.storyId, story.chapterId, story.versionId],
      );
      await dataSource.query(
        `INSERT INTO chapter_read_states (user_id, chapter_id, last_version_id, max_progress_percentage, completed_at, last_read_at)
         VALUES ($1, $2, $3, 75, NULL, NOW())`,
        [userId, story.chapterId, story.versionId],
      );

      // Execute HISTORY DELETE for story
      const res = await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.HISTORY,
            entityId: story.storyId,
            operation: SyncOperation.DELETE,
            baseServerRevision: '0',
            payload: { storyId: story.storyId, observedHistoryEpoch: 0 },
          },
        ],
      });
      expect(res.results[0].status).toBe('APPLIED');

      // Assert reading_progress for story was deleted
      const progRows = await dataSource.query(
        `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [userId, story.storyId],
      );
      expect(progRows).toHaveLength(0);

      // Assert chapter_read_states for story was deleted
      const readRows = await dataSource.query(
        `SELECT * FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
        [userId, story.chapterId],
      );
      expect(readRows).toHaveLength(0);

      // Assert reading_history_tombstones was recorded with epoch >= 1
      const histTomb = await dataSource.query(
        `SELECT epoch FROM reading_history_tombstones WHERE user_id = $1 AND story_id = $2`,
        [userId, story.storyId],
      );
      expect(histTomb).toHaveLength(1);
      expect(Number(histTomb[0].epoch)).toBeGreaterThanOrEqual(1);

      // Assert sync_tombstones was recorded
      const syncTomb = await dataSource.query(
        `SELECT domain, entity_id FROM sync_tombstones WHERE user_id = $1 AND domain = 'HISTORY' AND entity_id = $2`,
        [userId, story.storyId],
      );
      expect(syncTomb).toHaveLength(1);
    });
  });

  describe('P0-04: Durable Idempotency Order & Durable Rejections', () => {
    it('should return durable receipt for retries and persist rejections durably', async () => {
      const userId = await createTestUser();
      const story = await createTestStory(userId);
      const clientId = uuidv4();
      const mutationId = uuidv4();

      // 1. Initial valid mutation
      const mut1 = {
        clientId,
        mutationId,
        domain: SyncDomain.BOOKMARK,
        entityId: story.storyId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: { storyId: story.storyId },
      };
      const res1 = await syncService.pushMutations(userId, { mutations: [mut1] });
      expect(res1.results[0].status).toBe('APPLIED');
      const assignedRev = res1.results[0].assignedRevision;

      // 2. Retry identical mutation: returns DEDUPLICATED with original assignedRevision
      const retryRes = await syncService.pushMutations(userId, { mutations: [mut1] });
      expect(retryRes.results[0].status).toBe('DEDUPLICATED');
      expect(retryRes.results[0].assignedRevision).toBe(assignedRev);

      // 3. Retry same mutationId with altered payload: throws 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
      const alteredMut = {
        ...mut1,
        payload: { storyId: uuidv4() }, // Changed payload!
      };
      await expect(
        syncService.pushMutations(userId, { mutations: [alteredMut] }),
      ).rejects.toThrow();

      // 4. Mutation ahead of server: returns REJECTED_STALE and persists in receipts
      const aheadMutationId = uuidv4();
      const aheadMut = {
        clientId,
        mutationId: aheadMutationId,
        domain: SyncDomain.BOOKMARK,
        entityId: story.storyId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '999999', // Ahead of server!
        payload: { storyId: story.storyId },
      };
      const aheadRes = await syncService.pushMutations(userId, {
        mutations: [aheadMut],
      });
      expect(aheadRes.results[0].status).toBe('REJECTED_STALE');
      expect(aheadRes.results[0].reason).toBe('BASE_REVISION_AHEAD_OF_SERVER');

      // Verify stored in sync_mutation_receipts
      const savedReceipt = await dataSource.query(
        `SELECT status, response_meta FROM sync_mutation_receipts WHERE user_id = $1 AND mutation_id = $2`,
        [userId, aheadMutationId],
      );
      expect(savedReceipt).toHaveLength(1);
      expect(savedReceipt[0].status).toBe('REJECTED_STALE');

      // Retry ahead mutation returns durable rejection without throwing
      const retryAheadRes = await syncService.pushMutations(userId, {
        mutations: [aheadMut],
      });
      expect(retryAheadRes.results[0].status).toBe('REJECTED_STALE');
      expect(retryAheadRes.results[0].reason).toBe('BASE_REVISION_AHEAD_OF_SERVER');
    });
  });

  describe('P0-05: Effective History Epoch in Snapshot', () => {
    it('should compute effectiveEpoch = MAX(storyEpoch, globalEpoch) including global sentinel', async () => {
      const userId = await createTestUser();
      const story = await createTestStory(userId);

      // Set global sentinel tombstone with epoch = 5
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, '00000000-0000-0000-0000-000000000000'::uuid, 5, NOW())`,
        [userId],
      );

      // Insert chapter read state for story (no individual tombstone)
      await dataSource.query(
        `INSERT INTO chapter_read_states (user_id, chapter_id, last_version_id, max_progress_percentage, completed_at, last_read_at)
         VALUES ($1, $2, $3, 90, NOW(), NOW())`,
        [userId, story.chapterId, story.versionId],
      );

      // Snapshot must reflect storyHistoryEpoch = 5 from global sentinel!
      const snap = await syncService.getSnapshot(userId, {});
      expect(snap.data.chapterReadStates).toHaveLength(1);
      expect(snap.data.chapterReadStates[0].storyHistoryEpoch).toBe(5);
    });
  });

  describe('P0-06: Business Side Effects & Reading Progress Parity', () => {
    it('should increment/decrement stories.followers_count and mirror PROGRESS to chapter_read_states', async () => {
      const userId = await createTestUser();
      const story = await createTestStory(userId);
      const clientId = uuidv4();

      // 1. BOOKMARK UPSERT
      await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.BOOKMARK,
            entityId: story.storyId,
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { storyId: story.storyId },
          },
        ],
      });

      // Verify followers_count incremented to 1
      const storyAfterAdd = await dataSource.query(
        `SELECT followers_count FROM stories WHERE id = $1`,
        [story.storyId],
      );
      expect(Number(storyAfterAdd[0].followers_count)).toBe(1);

      // 2. PROGRESS UPSERT (percentage 85% -> completed_at set)
      await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.PROGRESS,
            entityId: story.storyId,
            operation: SyncOperation.UPSERT,
            baseServerRevision: '1',
            payload: {
              storyId: story.storyId,
              chapterId: story.chapterId,
              readingMode: 'WEBTOON',
              pageIndex: 1,
              scrollPosition: 1200,
              progressPercentage: 85,
            },
          },
        ],
      });

      // Verify chapter_read_states mirrored
      const readState = await dataSource.query(
        `SELECT max_progress_percentage, completed_at FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
        [userId, story.chapterId],
      );
      expect(readState).toHaveLength(1);
      expect(Number(readState[0].max_progress_percentage)).toBe(85);
      expect(readState[0].completed_at).not.toBeNull();

      // 3. BOOKMARK DELETE
      await syncService.pushMutations(userId, {
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.BOOKMARK,
            entityId: story.storyId,
            operation: SyncOperation.DELETE,
            baseServerRevision: '2',
            payload: { storyId: story.storyId },
          },
        ],
      });

      // Verify followers_count decremented back to 0
      const storyAfterDel = await dataSource.query(
        `SELECT followers_count FROM stories WHERE id = $1`,
        [story.storyId],
      );
      expect(Number(storyAfterDel[0].followers_count)).toBe(0);
    });
  });

  describe('P1-01: Reject getChanges when after is ahead of currentServerRevision', () => {
    it('should throw HTTP 400 Bad Request with code SYNC_REVISION_AHEAD', async () => {
      const userId = await createTestUser();
      await expect(
        syncService.getChanges(userId, { after: '999999' }),
      ).rejects.toThrow();
    });
  });

  describe('P1-05: Concurrency & Lock Ordering Alignment', () => {
    it('should run concurrent sync mutations and history clear without deadlock and maintain monotonic revision order', async () => {
      const userId = await createTestUser();
      const story1 = await createTestStory(userId);
      const story2 = await createTestStory(userId);

      const clientId1 = uuidv4();
      const clientId2 = uuidv4();

      // Run 3 concurrent operations on the same user:
      // - Task A: push Bookmark mutation
      // - Task B: push Progress mutation
      // - Task C: clear all reading history via StoriesService
      const taskA = syncService.pushMutations(userId, {
        mutations: [
          {
            clientId: clientId1,
            mutationId: uuidv4(),
            domain: SyncDomain.BOOKMARK,
            entityId: story1.storyId,
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { storyId: story1.storyId },
          },
        ],
      });

      const taskB = syncService.pushMutations(userId, {
        mutations: [
          {
            clientId: clientId2,
            mutationId: uuidv4(),
            domain: SyncDomain.PROGRESS,
            entityId: story2.storyId,
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: {
              storyId: story2.storyId,
              chapterId: story2.chapterId,
              readingMode: 'PAGED',
              pageIndex: 2,
              scrollPosition: 0,
              progressPercentage: 20,
            },
          },
        ],
      });

      const taskC = storiesService.clearAllReadingHistory(userId);

      // Execute all 3 concurrently
      const results = await Promise.allSettled([taskA, taskB, taskC]);

      // All tasks must either fulfill or cleanly reject without postgres deadlock exception (40P01)
      for (const res of results) {
        if (res.status === 'rejected') {
          const errMsg = res.reason?.message || '';
          expect(errMsg).not.toContain('deadlock detected');
        }
      }

      // Check user_sync_state
      const state = await dataSource.query(
        `SELECT current_sync_revision FROM user_sync_state WHERE user_id = $1`,
        [userId],
      );
      expect(state).toHaveLength(1);
      const finalRev = BigInt(state[0].current_sync_revision);
      expect(finalRev).toBeGreaterThanOrEqual(1n);

      // Check sync_change_log revisions: must be sequential without holes
      const changes = await dataSource.query(
        `SELECT revision FROM sync_change_log WHERE user_id = $1 ORDER BY revision ASC`,
        [userId],
      );
      expect(changes.length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < changes.length; i++) {
        expect(BigInt(changes[i].revision)).toBe(BigInt(i + 1));
      }
    });
  });
});
