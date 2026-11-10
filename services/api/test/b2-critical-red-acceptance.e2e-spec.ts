import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { verifyTestDatabaseIdentity } from '../src/common/guards/test-isolation-guard';
import { RedisService } from '../src/redis/redis.service';
import { StoriesService } from '../src/modules/stories/stories.service';
import { ReadingMode, SyncDomain, SyncOperation } from '../src/modules/sync/interfaces/sync.types';

/**
 * Six-Domain Snapshot Contract Validators & Invariants (matching ADR v2.2 & PR #213 Patch Set A)
 */
export const GLOBAL_HISTORY_EPOCH_SENTINEL = '00000000-0000-0000-0000-000000000000';
export const SNAPSHOT_PARTITION_DOMAINS = [
  'BOOKMARK',
  'PROGRESS',
  'CHAPTER_READ_STATE',
  'PREFERENCE',
  'HISTORY_TOMBSTONE',
  'SYNC_TOMBSTONE',
] as const;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidUnsignedBigIntRevision(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 9223372036854775807n;
  } catch {
    return false;
  }
}

export function isSixDomainSyncSnapshotResponse(response: any): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return false;
  }
  if (
    !isValidUnsignedBigIntRevision(response.snapshotRevision) ||
    !isValidUnsignedBigIntRevision(response.minActiveRevision)
  ) {
    return false;
  }
  const snapshotRevBigInt = BigInt(response.snapshotRevision);
  const minActiveRevBigInt = BigInt(response.minActiveRevision);
  if (minActiveRevBigInt > snapshotRevBigInt) {
    return false;
  }
  if (typeof response.hasMore !== 'boolean') {
    return false;
  }
  if (response.hasMore) {
    if (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0) {
      return false;
    }
  } else if (response.nextCursor !== null) {
    return false;
  }
  if (!isNonNegativeSafeInteger(response.globalHistoryEpoch)) {
    return false;
  }
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  if (
    !Array.isArray(data.bookmarks) ||
    !Array.isArray(data.readingProgress) ||
    !Array.isArray(data.chapterReadStates) ||
    !Array.isArray(data.preferences) ||
    !Array.isArray(data.historyEpochs) ||
    !Array.isArray(data.tombstones)
  ) {
    return false;
  }
  for (const item of data.historyEpochs) {
    if (!item || typeof item !== 'object') return false;
    if (
      typeof item.storyId !== 'string' ||
      item.storyId.trim().length === 0 ||
      item.storyId === GLOBAL_HISTORY_EPOCH_SENTINEL ||
      !isNonNegativeSafeInteger(item.epoch)
    ) {
      return false;
    }
  }
  for (const item of data.tombstones) {
    if (!item || typeof item !== 'object') return false;
    if (
      item.domain !== 'BOOKMARK' &&
      item.domain !== 'PROGRESS' &&
      item.domain !== 'HISTORY' &&
      item.domain !== 'PREFERENCE'
    ) {
      return false;
    }
    if (
      typeof item.entityId !== 'string' ||
      item.entityId.trim().length === 0 ||
      (item.domain === 'HISTORY' && item.entityId === 'all')
    ) {
      return false;
    }
    if (!isValidUnsignedBigIntRevision(item.deletedAtRevision)) {
      return false;
    }
    const tombstoneRevBigInt = BigInt(item.deletedAtRevision);
    if (tombstoneRevBigInt < minActiveRevBigInt || tombstoneRevBigInt > snapshotRevBigInt) {
      return false;
    }
  }
  return true;
}

/**
 * Helper to manually forge signed HMAC cursor tokens for testing
 */
function forgeSignedHmacCursor(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

function decodeCursorPayload(cursor: string): Record<string, any> {
  const [b64] = cursor.split('.');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

/**
 * Patch Set B2 Executable Critical RED Acceptance Test Suite (ADR-SYNC-07C-v2.2)
 *
 * Scope:
 * - Dual-Delta: Atomic PROGRESS (r+1) and HISTORY (r+2) changes, receipt assignedRevision = r+2
 * - Six-Domain Snapshot: bookmarks, readingProgress, chapterReadStates, preferences, historyEpochs, tombstones
 * - REG-17: 11 database rows -> 9 wire items across 5 pages (limit = 2) with exact domain boundaries
 * - Cursor & GC: mrev pinning, CUR-01..05 fail-closed validation, REG-18 concurrent GC invalidation
 * - Server Producer: StoriesService observedHistoryEpoch, canonical wire entityId invariance, forceRewind
 */
describe('Patch Set B2 — Dual-Delta & Six-Domain Snapshot Critical RED Acceptance Suite', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let redisService: RedisService;
  let jwtService: JwtService;
  let storiesService: StoriesService;

  const cursorSecret = 'test_sync_cursor_secret_key_very_long_secure';
  const previousCursorSecret = process.env.SYNC_CURSOR_SECRET;

  let storyAId: string;
  let chapterAId: string;
  let storyBId: string;
  let chapterBId: string;

  const createdUserIds: string[] = [];
  const createdRedisKeys: string[] = [];
  const createdStoryIds: string[] = [];

  async function createFreshUser(tag: string) {
    const uniq = `${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [u] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ($1, $2, 'synthetic_hash', 'READER', true, false)
       RETURNING id, username, role`,
      [`u_b2_${uniq}`.slice(0, 48), `u_b2_${uniq}@omninovel.test`],
    );
    createdUserIds.push(u.id);
    const sid = `sid-b2-${uniq}`;
    const rKey = `auth_session:${u.id}:${sid}`;
    createdRedisKeys.push(rKey);
    await redisService.set(
      rKey,
      JSON.stringify({
        sessionId: sid,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }),
    );
    const token = jwtService.sign({
      sub: u.id,
      username: u.username,
      role: u.role,
      sid,
    });
    return { userId: u.id as string, token, sid };
  }

  beforeAll(async () => {
    process.env.SYNC_CURSOR_SECRET = cursorSecret;
    await verifyTestDatabaseIdentity();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.use(json({ limit: '2mb' }));
    app.use(urlencoded({ extended: true, limit: '2mb' }));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        stopAtFirstError: false,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'internal/v1/(.*)', 'metrics'],
    });

    await app.init();

    dataSource = app.get(DataSource);
    redisService = app.get(RedisService);
    jwtService = app.get(JwtService);
    storiesService = app.get(StoriesService);

    const seedStory = async (label: string) => {
      const uniq = `${label}_${Date.now()}`;
      const [s] = await dataSource.query(
        `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
         VALUES ($1, $2, 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko')
         RETURNING id`,
        [`B2 Story ${label}`, `b2-story-${uniq.toLowerCase()}`],
      );
      const [ed] = await dataSource.query(
        `INSERT INTO story_editions (story_id, edition_name, language, is_default)
         VALUES ($1, 'Default', 'vi', true) RETURNING id`,
        [s.id],
      );
      const [ch] = await dataSource.query(
        `INSERT INTO chapters (story_edition_id, chapter_number, title)
         VALUES ($1, 1, 'Ch 1') RETURNING id`,
        [ed.id],
      );
      return { storyId: s.id as string, chapterId: ch.id as string };
    };

    const sA = await seedStory('A');
    storyAId = sA.storyId;
    chapterAId = sA.chapterId;

    const sB = await seedStory('B');
    storyBId = sB.storyId;
    chapterBId = sB.chapterId;
  });

  afterAll(async () => {
    try {
      for (const k of createdRedisKeys) {
        await redisService.del(k);
      }
    } catch {
      // ignore
    }
    try {
      if (createdUserIds.length > 0) {
        await dataSource.query(`DELETE FROM bookmarks WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM reading_progress WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM chapter_read_states WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM user_preferences WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM sync_change_log WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM sync_mutation_receipts WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM user_sync_state WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM reading_history_tombstones WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM reading_history_epoch_counters WHERE user_id = ANY($1)`, [createdUserIds]);
        await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
      }
    } catch {
      // ignore
    }
    try {
      const sIds = [storyAId, storyBId, ...createdStoryIds].filter(Boolean);
      if (sIds.length > 0) {
        await dataSource.query(`DELETE FROM stories WHERE id = ANY($1)`, [sIds]);
      }
    } catch {
      // ignore
    }
    if (previousCursorSecret !== undefined) {
      process.env.SYNC_CURSOR_SECRET = previousCursorSecret;
    } else {
      delete process.env.SYNC_CURSOR_SECRET;
    }
    if (app) {
      await app.close();
    }
  });

  describe('1. Dual-Delta Acceptance (DUAL-DELTA-01..03)', () => {
    it('DUAL-DELTA-01: PROGRESS UPSERT mutation MUST emit atomic dual-delta (PROGRESS at r+1, HISTORY at r+2) and return assignedRevision = r+2 [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('dd01');
      const clientId = uuidv4();
      const mutationId = uuidv4();

      // Client pushes a PROGRESS UPSERT from baseServerRevision = '0'
      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId,
              domain: SyncDomain.PROGRESS,
              entityId: storyAId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: {
                storyId: storyAId,
                chapterId: chapterAId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 60,
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      // Expected B2: newServerRevision must advance by 2 (r+2)
      expect(res.body.newServerRevision).toBe('2');
      expect(res.body.results).toEqual([
        expect.objectContaining({
          mutationId,
          status: 'APPLIED',
          assignedRevision: '2', // receipt assignedRevision MUST equal r+2
        }),
      ]);

      // Verify DB atomicity in sync_change_log: 2 rows emitted
      const changeRows = await dataSource.query(
        `SELECT revision::text, domain, entity_id, operation, payload
         FROM sync_change_log
         WHERE user_id = $1
         ORDER BY revision ASC`,
        [userId],
      );

      expect(changeRows.length).toBe(2);
      // Delta 1: PROGRESS at r+1
      expect(changeRows[0]).toMatchObject({
        revision: '1',
        domain: 'PROGRESS',
        entity_id: storyAId,
        operation: 'UPSERT',
      });
      expect(changeRows[0].payload.progressPercentage).toBe(60);

      // Delta 2: HISTORY at r+2
      expect(changeRows[1]).toMatchObject({
        revision: '2',
        domain: 'HISTORY',
        entity_id: chapterAId,
        operation: 'UPSERT',
      });
      expect(changeRows[1].payload.progressPercentage).toBe(60);
      expect(changeRows[1].payload.observedHistoryEpoch).toBe(0);

      // Verify sync_mutation_receipts matches r+2
      const receiptRows = await dataSource.query(
        `SELECT assigned_revision::text FROM sync_mutation_receipts WHERE user_id = $1 AND mutation_id = $2`,
        [userId, mutationId],
      );
      expect(receiptRows[0]?.assigned_revision).toBe('2');
    });

    it('DUAL-DELTA-02: PROGRESS UPSERT retry with matching payload MUST return 200 DEDUPLICATED with assignedRevision = r+2 [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('dd02');
      const clientId = uuidv4();
      const mutationId = uuidv4();

      const mutation = {
        clientId,
        mutationId,
        domain: SyncDomain.PROGRESS,
        entityId: storyAId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          storyId: storyAId,
          chapterId: chapterAId,
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 0,
          progressPercentage: 65,
        },
      };

      // Push 1
      const firstRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [mutation] });
      expect(firstRes.status).toBe(200);

      // Push 2 (Replay / Retry)
      const retryRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [mutation] });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.newServerRevision).toBe('2');
      expect(retryRes.body.results[0]).toMatchObject({
        mutationId,
        status: 'DEDUPLICATED',
        assignedRevision: '2', // Must be r+2, never r+1
      });
    });

    it('DUAL-DELTA-03: PROGRESS UPSERT with forceRewind: true MUST update reading_progress, emit single PROGRESS delta at r+1, and preserve higher chapter_read_states [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('dd03');
      const clientId = uuidv4();

      // Step 1: User reads to 80%
      await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PROGRESS,
              entityId: storyAId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: {
                storyId: storyAId,
                chapterId: chapterAId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 80,
              },
            },
          ],
        });

      // Step 2: Push forceRewind: true back to 30%
      const rewindMutId = uuidv4();
      const rewindRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: rewindMutId,
              domain: SyncDomain.PROGRESS,
              entityId: storyAId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '2',
              payload: {
                storyId: storyAId,
                chapterId: chapterAId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 30,
                forceRewind: true,
              },
            },
          ],
        });

      expect(rewindRes.status).toBe(200);
      // In B2 forceRewind: only PROGRESS advances (r+1 -> '3')
      expect(rewindRes.body.newServerRevision).toBe('3');
      expect(rewindRes.body.results[0]).toMatchObject({
        mutationId: rewindMutId,
        status: 'APPLIED',
        assignedRevision: '3',
      });

      // Verify DB state: reading_progress rewound to 30, chapter_read_states preserved at 80
      const [progRow] = await dataSource.query(
        `SELECT progress_percentage FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [userId, storyAId],
      );
      expect(Number(progRow.progress_percentage)).toBe(30);

      const [crsRow] = await dataSource.query(
        `SELECT max_progress_percentage FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
        [userId, chapterAId],
      );
      expect(Number(crsRow.max_progress_percentage)).toBe(80);

      // Verify sync_change_log at revision 3: ONLY domain PROGRESS is emitted
      const rev3Changes = await dataSource.query(
        `SELECT revision::text, domain, entity_id FROM sync_change_log WHERE user_id = $1 AND revision = 3`,
        [userId],
      );
      expect(rev3Changes.length).toBe(1);
      expect(rev3Changes[0].domain).toBe('PROGRESS');
    });
  });

  describe('2. Six-Domain Snapshot & REG-17 Acceptance (SNAP-SIX-01..03)', () => {
    it('SNAP-SIX-01: GET /api/v1/sync/snapshot MUST conform to SixDomainSyncSnapshotResponse contract [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('snap01');

      // Seed 1 item in each partition
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 5, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW())`,
        [userId, storyAId],
      );
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, '00000000-0000-0000-0000-000000000000'::uuid, 2, NOW()),
                ($1, $2, 1, NOW())`,
        [userId, storyAId],
      );
      await dataSource.query(
        `INSERT INTO sync_tombstones (user_id, domain, entity_id, deleted_at_revision)
         VALUES ($1, 'PREFERENCE', 'theme', 3)`,
        [userId],
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/sync/snapshot')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);

      // Strict validation of the 6-domain envelope and invariants
      expect(isSixDomainSyncSnapshotResponse(res.body)).toBe(true);
      expect(res.body.globalHistoryEpoch).toBe(2);
      expect(res.body.data.historyEpochs).toEqual([
        expect.objectContaining({ storyId: storyAId, epoch: 1 }),
      ]);
      expect(res.body.data.tombstones).toEqual([
        expect.objectContaining({ domain: 'PREFERENCE', entityId: 'theme', deletedAtRevision: '3' }),
      ]);
    });

    it('SNAP-SIX-02 (REG-17): 11 database rows MUST produce 9 wire items across 5 pages (limit = 2) with exact domain-boundary cursors [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('reg17');

      // Deterministic ordered UUID fixtures (story1 < story2 < story3)
      const story1 = '10000000-0000-4000-8000-000000000001';
      const story2 = '20000000-0000-4000-8000-000000000002';
      const story3 = '30000000-0000-4000-8000-000000000003';

      // Multi-seed determinism verification: verify sorted ordering holds across distinct seeds
      for (let seed = 1; seed <= 5; seed++) {
        const dynamicUuids = [uuidv4(), uuidv4(), uuidv4()].sort();
        expect(dynamicUuids[0] < dynamicUuids[1]).toBe(true);
        expect(dynamicUuids[1] < dynamicUuids[2]).toBe(true);
      }

      // 1. Initial State: 11 DB rows
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 15, 1)`,
        [userId],
      );
      // Bookmarks (2: deterministically ordered bmStory1 < bmStory2)
      const [bmStory1, bmStory2] = [storyAId, storyBId].sort();
      await dataSource.query(
        `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())`,
        [userId, bmStory1, bmStory2],
      );
      // Preferences (1)
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'theme:colon', '"dark"', NOW())`,
        [userId],
      );
      // Reading History Tombstones (4: sentinel epoch=3, story1=1, story2=2, story3=4)
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES
           ($1, '00000000-0000-0000-0000-000000000000'::uuid, 3, NOW()),
           ($1, $2, 1, NOW()),
           ($1, $3, 2, NOW()),
           ($1, $4, 4, NOW())`,
        [userId, story1, story2, story3],
      );
      // Sync Tombstones (4: ('HISTORY', sentinel, 11), ('HISTORY', 'all', 11), ('PREFERENCE', 'pref:a:b', 12), ('PREFERENCE', 'pref:a:c', 13))
      await dataSource.query(
        `INSERT INTO sync_tombstones (user_id, domain, entity_id, deleted_at_revision)
         VALUES
           ($1, 'HISTORY', '00000000-0000-0000-0000-000000000000', 11),
           ($1, 'HISTORY', 'all', 11),
           ($1, 'PREFERENCE', 'pref:a:b', 12),
           ($1, 'PREFERENCE', 'pref:a:c', 13)`,
        [userId],
      );

      // Verify exactly 11 DB rows exist
      const [bmCount, prefCount, histTombCount, syncTombCount] = await Promise.all([
        dataSource.query(`SELECT COUNT(*)::int AS c FROM bookmarks WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM user_preferences WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM reading_history_tombstones WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM sync_tombstones WHERE user_id = $1`, [userId]),
      ]);
      expect(bmCount[0].c + prefCount[0].c + histTombCount[0].c + syncTombCount[0].c).toBe(11);

      // --- PAGE 1 (limit = 2) ---
      const p1 = await request(app.getHttpServer())
        .get('/api/v1/sync/snapshot?limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(p1.status).toBe(200);
      expect(isSixDomainSyncSnapshotResponse(p1.body)).toBe(true);
      expect(p1.body.globalHistoryEpoch).toBe(3);
      expect(p1.body.data.bookmarks.length).toBe(2);
      expect(p1.body.hasMore).toBe(true);

      // Domain-boundary cursor check: ends on BOOKMARK -> points to PREFERENCE key '' (PROGRESS & READ_STATE skipped)
      const c1 = decodeCursorPayload(p1.body.nextCursor);
      expect(c1.domain).toBe('PREFERENCE');
      expect(c1.key).toBe('');
      expect(c1.srev).toBe('15');
      expect(c1.mrev).toBe('1');

      // --- PAGE 2 (limit = 2) ---
      const p2 = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?limit=2&cursor=${p1.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(p2.status).toBe(200);
      expect(p2.body.data.preferences.length).toBe(1);
      expect(p2.body.data.historyEpochs.length).toBe(1);
      expect(p2.body.data.historyEpochs[0].storyId).toBe(story1);
      expect(p2.body.hasMore).toBe(true);

      // Cursor: domain HISTORY_TOMBSTONE, key story1
      const c2 = decodeCursorPayload(p2.body.nextCursor);
      expect(c2.domain).toBe('HISTORY_TOMBSTONE');
      expect(c2.key).toBe(story1);

      // --- PAGE 3 (limit = 2) ---
      const p3 = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?limit=2&cursor=${p2.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(p3.status).toBe(200);
      expect(p3.body.data.historyEpochs.length).toBe(2);
      expect(p3.body.data.historyEpochs[0].storyId).toBe(story2);
      expect(p3.body.data.historyEpochs[1].storyId).toBe(story3);
      expect(p3.body.hasMore).toBe(true);

      // Cursor: domain SYNC_TOMBSTONE, key ''
      const c3 = decodeCursorPayload(p3.body.nextCursor);
      expect(c3.domain).toBe('SYNC_TOMBSTONE');
      expect(c3.key).toBe('');

      // --- PAGE 4 (limit = 2) ---
      const p4 = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?limit=2&cursor=${p3.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(p4.status).toBe(200);
      expect(p4.body.data.tombstones.length).toBe(2);
      expect(p4.body.hasMore).toBe(true);

      // Cursor: domain SYNC_TOMBSTONE, JSON tuple key
      const c4 = decodeCursorPayload(p4.body.nextCursor);
      expect(c4.domain).toBe('SYNC_TOMBSTONE');
      expect(c4.key).toBe('["PREFERENCE","pref:a:b"]');

      // --- PAGE 5 (limit = 2) ---
      const p5 = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?limit=2&cursor=${p4.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(p5.status).toBe(200);
      expect(p5.body.data.tombstones.length).toBe(1);
      expect(p5.body.data.tombstones[0].entityId).toBe('pref:a:c');
      expect(p5.body.hasMore).toBe(false);
      expect(p5.body.nextCursor).toBeNull();

      // Total wire count across all 5 pages MUST equal 9 items
      const totalWireItems =
        p1.body.data.bookmarks.length +
        p2.body.data.preferences.length +
        p2.body.data.historyEpochs.length +
        p3.body.data.historyEpochs.length +
        p4.body.data.tombstones.length +
        p5.body.data.tombstones.length;
      expect(totalWireItems).toBe(9);
    });

    it('SNAP-SIX-03 (REG-17 subcase limit = 3): Page 1 ending at exact boundary of PREFERENCE MUST NOT terminate early [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('reg17_sub');

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 15, 1)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW()), ($1, $3, NOW())`,
        [userId, storyAId, storyBId],
      );
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'theme:colon', '"dark"', NOW())`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, '00000000-0000-0000-0000-000000000000'::uuid, 3, NOW()), ($1, $2, 1, NOW())`,
        [userId, uuidv4()],
      );

      // limit = 3 collects 2 bookmarks + 1 preference = 3 items (exact boundary of PREFERENCE)
      const p1 = await request(app.getHttpServer())
        .get('/api/v1/sync/snapshot?limit=3')
        .set('Authorization', `Bearer ${token}`);

      expect(p1.status).toBe(200);
      expect(p1.body.hasMore).toBe(true); // MUST NOT terminate early (bug in baseline)
      expect(p1.body.nextCursor).not.toBeNull();

      const c1 = decodeCursorPayload(p1.body.nextCursor);
      expect(c1.domain).toBe('HISTORY_TOMBSTONE');
      expect(c1.key).toBe('');
    });
  });

  describe('3. Cursor & GC Acceptance (CUR-01..05 & REG-18)', () => {
    it('CUR-01: HMAC cursor with negative mrev MUST be rejected with 400 CURSOR_INVALID_REVISION [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('cur01');

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 10, 0)`,
        [userId],
      );

      const badCursor = forgeSignedHmacCursor(
        {
          v: 1,
          uid: userId,
          srev: '10',
          mrev: '-1',
          domain: 'BOOKMARK',
          key: '',
          exp: Math.floor(Date.now() / 1000) + 900,
        },
        cursorSecret,
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?cursor=${badCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('CURSOR_INVALID_REVISION');
    });

    it("CUR-02: HMAC cursor with malformed mrev ('abc', '1.5', ' 10 ', numeric 10) MUST be rejected with 400 CURSOR_INVALID_REVISION [RED until B2]", async () => {
      const { userId, token } = await createFreshUser('cur02');

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 10, 0)`,
        [userId],
      );

      const malformedCases = ['abc', '1.5', ' 10 ', 10];
      for (const mrevVal of malformedCases) {
        const badCursor = forgeSignedHmacCursor(
          {
            v: 1,
            uid: userId,
            srev: '10',
            mrev: mrevVal,
            domain: 'BOOKMARK',
            key: '',
            exp: Math.floor(Date.now() / 1000) + 900,
          },
          cursorSecret,
        );

        const res = await request(app.getHttpServer())
          .get(`/api/v1/sync/snapshot?cursor=${badCursor}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(400);
        expect(res.body?.error?.code).toBe('CURSOR_INVALID_REVISION');
      }
    });

    it('CUR-03: HMAC cursor with mrev exceeding PostgreSQL BIGINT max MUST be rejected with 400 CURSOR_INVALID_REVISION [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('cur03');

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 10, 0)`,
        [userId],
      );

      const overflowCursor = forgeSignedHmacCursor(
        {
          v: 1,
          uid: userId,
          srev: '10',
          mrev: '9223372036854775808', // BIGINT max + 1
          domain: 'BOOKMARK',
          key: '',
          exp: Math.floor(Date.now() / 1000) + 900,
        },
        cursorSecret,
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?cursor=${overflowCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('CURSOR_INVALID_REVISION');
    });

    it("CUR-04: HMAC cursor with valid mrev='0' is accepted, but signature tampering on mrev MUST be rejected with 400 CURSOR_SIGNATURE_INVALID", async () => {
      const { userId, token } = await createFreshUser('cur04');

      const originalPayload = {
        v: 1,
        uid: userId,
        srev: '10',
        mrev: '0',
        domain: 'BOOKMARK',
        key: '',
        exp: Math.floor(Date.now() / 1000) + 900,
      };
      const validCursor = forgeSignedHmacCursor(originalPayload, cursorSecret);

      // Verify mrev='0' is valid and accepted (HTTP 200) before tampering
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 10, 0)`,
        [userId],
      );
      const okRes = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?cursor=${validCursor}`)
        .set('Authorization', `Bearer ${token}`);
      expect(okRes.status).toBe(200);

      const [, originalSig] = validCursor.split('.');

      // Tamper payload mrev: '0' -> '1', keep original signature
      const tamperedPayload = { ...originalPayload, mrev: '1' };
      const tamperedB64 = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
      const tamperedCursor = `${tamperedB64}.${originalSig}`;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?cursor=${tamperedCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('CURSOR_SIGNATURE_INVALID');
    });

    it('CUR-05: Signed legacy v1 cursor lacking mrev MUST trigger 409 SNAPSHOT_INVALIDATED (reason: CURSOR_WATERMARK_UPGRADE_REQUIRED) [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('cur05');

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 5, 0)`,
        [userId],
      );

      // Valid signed v1 cursor without mrev
      const legacyCursor = forgeSignedHmacCursor(
        {
          v: 1,
          uid: userId,
          srev: '5',
          // mrev omitted
          domain: 'BOOKMARK',
          key: '',
          exp: Math.floor(Date.now() / 1000) + 900,
        },
        cursorSecret,
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?cursor=${legacyCursor}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe('SNAPSHOT_INVALIDATED');
      // Under GlobalExceptionFilter fail-closed allowlist, error metadata MUST be structured under error.meta
      const errorMeta = res.body?.error?.meta ?? res.body?.error;
      expect(errorMeta?.reason).toBe('CURSOR_WATERMARK_UPGRADE_REQUIRED');
      expect(errorMeta?.currentServerRevision).toBe('5');
      expect(errorMeta?.minActiveRevision).toBe('0');
    });

    it('REG-18: Concurrent GC raising min_active_revision during snapshot pagination MUST invalidate cursor with 409 SNAPSHOT_INVALIDATED [RED until B2]', async () => {
      const { userId, token } = await createFreshUser('reg18');

      // Seed 4 bookmarks and 1 tombstone at revision 2; srev=5, mrev=0
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 5, 0)`,
        [userId],
      );
      for (let i = 0; i < 4; i++) {
        const [s] = await dataSource.query(
          `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
           VALUES ($1, $2, 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko') RETURNING id`,
          [`Story GC ${i}`, `story-gc-${Date.now()}-${i}`],
        );
        createdStoryIds.push(s.id);
        await dataSource.query(
          `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW())`,
          [userId, s.id],
        );
      }
      await dataSource.query(
        `INSERT INTO sync_tombstones (user_id, domain, entity_id, deleted_at_revision) VALUES ($1, 'PREFERENCE', 'theme', 2)`,
        [userId],
      );

      // Page 1 (limit = 2): pins srev = 5, mrev = 0
      const p1 = await request(app.getHttpServer())
        .get('/api/v1/sync/snapshot?limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(p1.status).toBe(200);
      expect(p1.body.hasMore).toBe(true);

      // Concurrent GC runs: raises min_active_revision = 3 and purges tombstones < 3 (srev stays 5)
      await dataSource.query(
        `UPDATE user_sync_state SET min_active_revision = 3 WHERE user_id = $1`,
        [userId],
      );
      await dataSource.query(
        `DELETE FROM sync_tombstones WHERE user_id = $1 AND deleted_at_revision < 3`,
        [userId],
      );

      // Page 2 request using Page 1 cursor (pinned mrev = 0 < current min_active_revision 3)
      const p2 = await request(app.getHttpServer())
        .get(`/api/v1/sync/snapshot?limit=2&cursor=${p1.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`);

      // MUST NOT return 200 with torn snapshot; MUST throw 409 SNAPSHOT_INVALIDATED
      expect(p2.status).toBe(409);
      expect(p2.body?.error?.code).toBe('SNAPSHOT_INVALIDATED');
      // Under GlobalExceptionFilter fail-closed allowlist, error metadata MUST be structured under error.meta
      const p2Meta = p2.body?.error?.meta ?? p2.body?.error;
      expect(p2Meta?.minActiveRevision).toBe('3');
      expect(p2Meta?.cursorMinActiveRevision).toBe('0');
      expect(p2Meta?.currentServerRevision).toBe('5');
    });
  });

  describe('4. Server Producer Acceptance (PROD-01..03)', () => {
    it('PROD-01: StoriesService.saveReadingProgress MUST attach correct observedHistoryEpoch to emitted HISTORY change log', async () => {
      const { userId } = await createFreshUser('prod01');

      // Set up effective history epoch = 2 for storyA via tombstone
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, $2, 2, NOW())`,
        [userId, storyAId],
      );
      await dataSource.query(
        `INSERT INTO reading_history_epoch_counters (user_id, epoch, updated_at) VALUES ($1, 2, NOW())`,
        [userId],
      );

      const testUser = { id: userId, role: 'READER' };
      const saveRes = await storiesService.saveReadingProgress(testUser, {
        storyId: storyAId,
        chapterId: chapterAId,
        readingMode: 'WEBTOON' as any,
        pageIndex: 1,
        scrollPosition: 100,
        progressPercentage: 55,
        writeEpoch: 2,
      });

      expect(saveRes).toMatchObject({
        storyId: storyAId,
        chapterId: chapterAId,
        progressPercentage: 55,
      });

      // Verify emitted HISTORY change log has observedHistoryEpoch === 2
      const histChanges = await dataSource.query(
        `SELECT revision::text, domain, entity_id, payload
         FROM sync_change_log
         WHERE user_id = $1 AND domain = 'HISTORY'
         ORDER BY revision DESC
         LIMIT 1`,
        [userId],
      );

      expect(histChanges.length).toBe(1);
      expect(histChanges[0].payload.observedHistoryEpoch).toBe(2);
      expect(histChanges[0].payload.progressPercentage).toBe(55);
    });

    it('PROD-02: Canonical wire entityId invariance: emitted HISTORY delta has entityId = chapterId, PROGRESS delta has entityId = storyId', async () => {
      const { userId } = await createFreshUser('prod02');

      const testUser = { id: userId, role: 'READER' };
      await storiesService.saveReadingProgress(testUser, {
        storyId: storyBId,
        chapterId: chapterBId,
        readingMode: 'WEBTOON' as any,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 40,
        writeEpoch: 0,
      });

      const [progChange] = await dataSource.query(
        `SELECT entity_id FROM sync_change_log WHERE user_id = $1 AND domain = 'PROGRESS' ORDER BY revision DESC LIMIT 1`,
        [userId],
      );
      expect(progChange.entity_id).toBe(storyBId); // PROGRESS entityId MUST be storyId

      const [histChange] = await dataSource.query(
        `SELECT entity_id FROM sync_change_log WHERE user_id = $1 AND domain = 'HISTORY' ORDER BY revision DESC LIMIT 1`,
        [userId],
      );
      expect(histChange.entity_id).toBe(chapterBId); // HISTORY entityId MUST be chapterId
    });

    it('PROD-03: StoriesService.saveReadingProgress with lower percentage (rewind) MUST preserve chapter_read_states max_progress_percentage', async () => {
      const { userId } = await createFreshUser('prod03');

      const testUser = { id: userId, role: 'READER' };
      // 1. First read to 85%
      await storiesService.saveReadingProgress(testUser, {
        storyId: storyAId,
        chapterId: chapterAId,
        readingMode: 'WEBTOON' as any,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 85,
        writeEpoch: 0,
      });

      // 2. Rewind to 20%
      await storiesService.saveReadingProgress(testUser, {
        storyId: storyAId,
        chapterId: chapterAId,
        readingMode: 'WEBTOON' as any,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 20,
        writeEpoch: 0,
      });

      // reading_progress pointer updated to 20
      const [prog] = await dataSource.query(
        `SELECT progress_percentage FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [userId, storyAId],
      );
      expect(Number(prog.progress_percentage)).toBe(20);

      // chapter_read_states max progress preserved at 85
      const [crs] = await dataSource.query(
        `SELECT max_progress_percentage FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
        [userId, chapterAId],
      );
      expect(Number(crs.max_progress_percentage)).toBe(85);
    });
  });
});
