import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { verifyTestDatabaseIdentity } from '../src/common/guards/test-isolation-guard';
import { RedisService } from '../src/redis/redis.service';
import { SyncDomain, SyncOperation } from '../src/modules/sync/interfaces/sync.types';

/**
 * Isolated B2 Pre-Delta Gate Spec — GuestClaim BOOKMARK Anti-Resurrection
 *
 * Erratum 2 (ADR-SYNC-07C-v2.2 / Task A.2):
 * 1. HISTORY tombstone (`reading_history_tombstones`) MUST NOT block GuestClaim bookmarks.
 * 2. BOOKMARK tombstone (`sync_tombstones` domain='BOOKMARK') MUST be checked independently.
 * 3. Guest bookmark lacking causal proof newer than cloud BOOKMARK tombstone MUST NOT auto-import/resurrect.
 * 4. Guest intent MUST be preserved via conflict/quarantine preview so user decides explicitly.
 *
 * NOTE: Currently expected to be RED on item 2..4 until B2 Pre-Delta Gate updates ClaimsModule.
 */
describe('B2 Pre-Delta Gate (Isolated Spec) — GuestClaim BOOKMARK Tombstone Anti-Resurrection', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let redisService: RedisService;
  let jwtService: JwtService;

  let storyBookmarkTombstonedId: string;
  let storyHistoryTombstonedId: string;
  let chapterHistoryTombstonedId: string;

  const createdUserIds: string[] = [];
  const createdRedisKeys: string[] = [];

  async function createUser(tag: string) {
    const uniq = `${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [u] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ($1, $2, 'synthetic_hash', 'READER', true, false)
       RETURNING id, username, role`,
      [`u_gcbm_${uniq}`.slice(0, 48), `u_gcbm_${uniq}@omninovel.test`],
    );
    createdUserIds.push(u.id);
    const sid = `sid-gcbm-${uniq}`;
    const rKey = `auth_session:${u.id}:${sid}`;
    createdRedisKeys.push(rKey);
    await redisService.set(
      rKey,
      JSON.stringify({ sessionId: sid, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    const token = jwtService.sign({ sub: u.id, username: u.username, role: u.role, sid });
    return { userId: u.id as string, token };
  }

  beforeAll(async () => {
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

    const seed = async (label: string) => {
      const [s] = await dataSource.query(
        `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
         VALUES ($1, $2, 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko')
         RETURNING id`,
        [`GCBM ${label}`, `gcbm-${label.toLowerCase()}-${Date.now()}`],
      );
      const [ed] = await dataSource.query(
        `INSERT INTO story_editions (story_id, edition_name, language, is_default) VALUES ($1, 'Default', 'vi', true) RETURNING id`,
        [s.id],
      );
      const [ch] = await dataSource.query(
        `INSERT INTO chapters (story_edition_id, chapter_number, title) VALUES ($1, 1, 'Ch 1') RETURNING id`,
        [ed.id],
      );
      const [v] = await dataSource.query(
        `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published) VALUES ($1, 1, 'RAW_ORIGINAL', true) RETURNING id`,
        [ch.id],
      );
      return { storyId: s.id as string, chapterId: ch.id as string, versionId: v.id as string };
    };

    const s1 = await seed('BookmarkTomb');
    storyBookmarkTombstonedId = s1.storyId;

    const s2 = await seed('HistoryTomb');
    storyHistoryTombstonedId = s2.storyId;
    chapterHistoryTombstonedId = s2.chapterId;
  });

  afterAll(async () => {
    for (const k of createdRedisKeys) {
      await redisService.del(k);
    }
    if (createdUserIds.length > 0) {
      await dataSource.query(`DELETE FROM guest_claims WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM sync_change_log WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM sync_mutation_receipts WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM user_sync_state WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM reading_history_tombstones WHERE user_id = ANY($1)`, [createdUserIds]);
      await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    }
    const sIds = [storyBookmarkTombstonedId, storyHistoryTombstonedId].filter(Boolean);
    if (sIds.length > 0) {
      await dataSource.query(`DELETE FROM stories WHERE id = ANY($1)`, [sIds]);
    }
    if (app) {
      await app.close();
    }
  });

  it('GUEST-BM-01: HISTORY tombstone MUST NOT block un-tombstoned guest bookmark', async () => {
    const { userId, token } = await createUser('hist_only');

    await dataSource.query(
      `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
       VALUES ($1, $2, 1, NOW())`,
      [userId, storyHistoryTombstonedId],
    );

    const prep = await request(app.getHttpServer())
      .post('/api/v1/account/guest-claims/prepare')
      .set('Authorization', `Bearer ${token}`)
      .send({
        guestProfileId: uuidv4(),
        bookmarks: [{ storyId: storyHistoryTombstonedId }],
        history: [
          {
            storyId: storyHistoryTombstonedId,
            chapterId: chapterHistoryTombstonedId,
            progressPercentage: 80,
          },
        ],
        progress: [],
      });

    expect(prep.status).toBe(200);
    expect(prep.body.bookmarksToImport).toBe(1);
    expect(prep.body.readStatesIgnoredAntiResurrectionCount).toBe(1);

    const commit = await request(app.getHttpServer())
      .post(`/api/v1/account/guest-claims/${prep.body.claimId}/commit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedStateFingerprint: prep.body.stateFingerprint });

    expect(commit.status).toBe(200);
    const bmRows = await dataSource.query(
      `SELECT story_id FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
      [userId, storyHistoryTombstonedId],
    );
    expect(bmRows.length).toBe(1);
  });

  it('GUEST-BM-02: BOOKMARK tombstone MUST prevent silent auto-import & preserve guest intent for explicit confirmation [RED until B2 Pre-Delta Gate]', async () => {
    const { userId, token } = await createUser('bm_tomb');
    const clientId = uuidv4();

    // User previously bookmarked and deleted via Sync Hub -> creates durable BOOKMARK tombstone
    const delRes = await request(app.getHttpServer())
      .post('/api/v1/sync/mutations/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mutations: [
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.BOOKMARK,
            entityId: storyBookmarkTombstonedId,
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { storyId: storyBookmarkTombstonedId },
          },
          {
            clientId,
            mutationId: uuidv4(),
            domain: SyncDomain.BOOKMARK,
            entityId: storyBookmarkTombstonedId,
            operation: SyncOperation.DELETE,
            baseServerRevision: '1',
            payload: {},
          },
        ],
      });
    expect(delRes.status).toBe(200);

    // Guest claim submits bookmark for the tombstoned story without causal proof
    const prep = await request(app.getHttpServer())
      .post('/api/v1/account/guest-claims/prepare')
      .set('Authorization', `Bearer ${token}`)
      .send({
        guestProfileId: uuidv4(),
        bookmarks: [{ storyId: storyBookmarkTombstonedId }],
        history: [],
        progress: [],
      });

    expect(prep.status).toBe(200);

    // Expected B2 Pre-Delta Gate behavior: NOT counted as clean auto-import, surfaces bookmark tombstone conflict/quarantine
    expect(prep.body.bookmarksToImport).toBe(0);
    expect((prep.body.bookmarkConflicts || []).length).toBe(1);

    const commit = await request(app.getHttpServer())
      .post(`/api/v1/account/guest-claims/${prep.body.claimId}/commit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedStateFingerprint: prep.body.stateFingerprint });

    expect(commit.status).toBe(200);
    // Default resolution without explicit user approval MUST NOT silently resurrect deleted cloud bookmark
    const bmRows = await dataSource.query(
      `SELECT story_id FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
      [userId, storyBookmarkTombstonedId],
    );
    expect(bmRows.length).toBe(0);
  });
});
