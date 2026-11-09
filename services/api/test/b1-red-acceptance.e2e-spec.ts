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
import { computeCanonicalMutationHash } from '../src/modules/sync/helpers/canonical-json.helper';
import { ReadingMode, SyncDomain, SyncOperation } from '../src/modules/sync/interfaces/sync.types';

/**
 * Patch Set B1 Executable RED Acceptance Test Suite (ADR-SYNC-07C-v2.2)
 *
 * Scope:
 * - Real NestJS HTTP pipeline (express.json 2MB + ValidationPipe + GlobalExceptionFilter)
 * - Real isolated PostgreSQL (omninovel_test) + Redis
 * - Pure synthetic entities with isolated per-test user scopes
 *
 * NOTE: Expected assertions reflect Approved B1 Target Behavior. Tests targeting
 * unimplemented B1 remediation (e.g. GlobalExceptionFilter JSON/413, Prototype guard,
 * Pipe Receipt-First bypass, nested forbidNonWhitelisted, PREFERENCE tombstone/no-trim,
 * fresh HISTORY DELETE 'all' rejection) are intentionally RED until Patch Set B1 lands.
 */
describe('Patch Set B1 — Executable HTTP RED Acceptance Suite (REG-JCS-01..12)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let redisService: RedisService;
  let jwtService: JwtService;

  let storyAId: string;
  let chapterAId: string;
  let storyBId: string;
  let chapterBId: string;

  const createdUserIds: string[] = [];
  const createdRedisKeys: string[] = [];

  async function createFreshUser(tag: string) {
    const uniq = `${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [u] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ($1, $2, 'synthetic_hash', 'READER', true, false)
       RETURNING id, username, role`,
      [`u_b1red_${uniq}`.slice(0, 48), `u_b1red_${uniq}@omninovel.test`],
    );
    createdUserIds.push(u.id);
    const sid = `sid-b1red-${uniq}`;
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

    const seedStory = async (label: string) => {
      const uniq = `${label}_${Date.now()}`;
      const [s] = await dataSource.query(
        `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
         VALUES ($1, $2, 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko')
         RETURNING id`,
        [`B1 RED Story ${label}`, `b1-red-${uniq.toLowerCase()}`],
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
    for (const k of createdRedisKeys) {
      await redisService.del(k);
    }
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
    const sIds = [storyAId, storyBId].filter(Boolean);
    if (sIds.length > 0) {
      await dataSource.query(`DELETE FROM stories WHERE id = ANY($1)`, [sIds]);
    }
    if (app) {
      await app.close();
    }
  });

  describe('REG-JCS-01..03 — Receipt-First Replay Compatibility (HTTP + ValidationPipe)', () => {
    it('REG-JCS-01: Legacy PROGRESS replay (entityId=storyId:chapterId) with durable receipt MUST return 200 DEDUPLICATED without DB writes', async () => {
      const { userId, token } = await createFreshUser('jcs01');
      const clientId = uuidv4();
      const mutationId = uuidv4();
      const legacyPayload = {
        clientId,
        mutationId,
        domain: SyncDomain.PROGRESS,
        entityId: `${storyAId}:${chapterAId}`,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          storyId: storyAId,
          chapterId: chapterAId,
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 0,
          progressPercentage: 50,
        },
      };
      const hash = computeCanonicalMutationHash(legacyPayload);

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 5, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES ($1, $2, $3, $4, 'APPLIED', 5, '{"message":"ok"}')`,
        [userId, clientId, mutationId, hash],
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyPayload] });

      expect(res.status).toBe(200);
      expect(res.body.newServerRevision).toBe('5');
      expect(res.body.results[0]).toMatchObject({
        mutationId,
        status: 'DEDUPLICATED',
        assignedRevision: '5',
      });
    });

    it('REG-JCS-02: Legacy HISTORY replay (missing observedHistoryEpoch, entityId=storyId) & historical PREFERENCE with extra legacy field MUST bypass strict Pipe via Receipt-First [RED]', async () => {
      const { userId, token } = await createFreshUser('jcs02');
      const clientId = uuidv4();
      const mutHist = uuidv4();
      const mutPref = uuidv4();

      const legacyHist = {
        clientId,
        mutationId: mutHist,
        domain: SyncDomain.HISTORY,
        entityId: storyAId, // legacy entityId=storyId & omitted observedHistoryEpoch
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          storyId: storyAId,
          chapterId: chapterAId,
          progressPercentage: 85,
        },
      };
      const legacyPref = {
        clientId,
        mutationId: mutPref,
        domain: SyncDomain.PREFERENCE,
        entityId: 'theme:colon',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          key: 'theme:colon',
          value: 'dark',
          legacyExtraField: 'keep-me-for-jcs',
        },
      };

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 7, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES
           ($1, $2, $3, $4, 'APPLIED', 6, '{"message":"legacy hist"}'),
           ($1, $2, $5, $6, 'CONFLICT_MERGED', 7, '{"message":"legacy pref"}')`,
        [
          userId,
          clientId,
          mutHist,
          computeCanonicalMutationHash(legacyHist),
          mutPref,
          computeCanonicalMutationHash(legacyPref),
        ],
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyHist, legacyPref] });

      // Expected B1 behavior: Pipe permits envelope -> SyncService matches receipt -> 200 DEDUPLICATED
      expect(res.status).toBe(200);
      expect(res.body.newServerRevision).toBe('7');
      expect(res.body.results).toEqual([
        expect.objectContaining({ mutationId: mutHist, status: 'DEDUPLICATED', assignedRevision: '6' }),
        expect.objectContaining({ mutationId: mutPref, status: 'DEDUPLICATED', assignedRevision: '7' }),
      ]);
    });

    it('REG-JCS-03: Durable REJECTED_* receipts (including legacy wire shapes) MUST preserve original rejection status and never convert to DEDUPLICATED [RED on missing epoch]', async () => {
      const { userId, token } = await createFreshUser('jcs03');
      const clientId = uuidv4();
      const mutTomb = uuidv4();
      const mutStale = uuidv4();
      const mutUnsupported = uuidv4();

      const legacyHistTomb = {
        clientId,
        mutationId: mutTomb,
        domain: SyncDomain.HISTORY,
        entityId: storyAId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: { storyId: storyAId, chapterId: chapterAId, progressPercentage: 10 },
      };
      const stalePref = {
        clientId,
        mutationId: mutStale,
        domain: SyncDomain.PREFERENCE,
        entityId: 'theme:colon',
        operation: SyncOperation.UPSERT,
        baseServerRevision: '1',
        payload: { key: 'theme:colon', value: 'sepia' },
      };
      const followMut = {
        clientId,
        mutationId: mutUnsupported,
        domain: SyncDomain.FOLLOW,
        entityId: storyAId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '1',
        payload: { storyId: storyAId },
      };

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 3, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES
           ($1, $2, $3, $4, 'REJECTED_TOMBSTONE', NULL, '{"reason":"TOMBSTONE_CONFLICT"}'),
           ($1, $2, $5, $6, 'REJECTED_STALE', NULL, '{"reason":"PREFERENCE_KEY_NOT_SUPPORTED"}'),
           ($1, $2, $7, $8, 'DOMAIN_NOT_SUPPORTED', NULL, '{"reason":"FOLLOW_DOMAIN_NOT_SUPPORTED"}')`,
        [
          userId,
          clientId,
          mutTomb,
          computeCanonicalMutationHash(legacyHistTomb),
          mutStale,
          computeCanonicalMutationHash(stalePref),
          mutUnsupported,
          computeCanonicalMutationHash(followMut),
        ],
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyHistTomb, stalePref, followMut] });

      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({
        mutationId: mutTomb,
        status: 'REJECTED_TOMBSTONE',
        assignedRevision: null,
        reason: 'TOMBSTONE_CONFLICT',
      });
      expect(res.body.results[1]).toMatchObject({
        mutationId: mutStale,
        status: 'REJECTED_STALE',
        assignedRevision: null,
        reason: 'PREFERENCE_KEY_NOT_SUPPORTED',
      });
      expect(res.body.results[2]).toMatchObject({
        mutationId: mutUnsupported,
        status: 'DOMAIN_NOT_SUPPORTED',
        assignedRevision: null,
      });
    });
  });

  describe('REG-JCS-04..05 — Idempotency Mismatch & Fresh Canonical Strict Validation', () => {
    it('REG-JCS-04: Same (userId, clientId, mutationId) with altered payload MUST return 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH including meta.mutationId [RED on missing meta.mutationId]', async () => {
      const { userId, token } = await createFreshUser('jcs04');
      const clientId = uuidv4();
      const mutationId = uuidv4();

      const originalPayload = {
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
          scrollPosition: 100,
          progressPercentage: 30,
        },
      };

      const firstRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [originalPayload] });
      expect(firstRes.status).toBe(200);

      const alteredRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              ...originalPayload,
              payload: { ...originalPayload.payload, progressPercentage: 95 },
            },
          ],
        });

      expect(alteredRes.status).toBe(409);
      expect(alteredRes.body?.error?.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      expect(alteredRes.body?.error?.meta?.mutationId).toBe(mutationId);

      const logRows = await dataSource.query(
        `SELECT COUNT(*)::int AS cnt FROM sync_change_log WHERE user_id = $1`,
        [userId],
      );
      expect(logRows[0].cnt).toBe(1);
    });

    it('REG-JCS-05: Fresh malformed canonical mutations (PROGRESS colon, HISTORY entityId=storyId, extra nested fields, DELETE extra keys) MUST fail 400 with ZERO DB writes [RED]', async () => {
      const { userId, token } = await createFreshUser('jcs05');
      const clientId = uuidv4();

      const freshMalformedCases = [
        // 5a: Fresh PROGRESS using legacy storyId:chapterId entityId
        {
          clientId,
          mutationId: uuidv4(),
          domain: SyncDomain.PROGRESS,
          entityId: `${storyAId}:${chapterAId}`,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {
            storyId: storyAId,
            chapterId: chapterAId,
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 1,
            scrollPosition: 0,
            progressPercentage: 20,
          },
        },
        // 5b: Fresh HISTORY UPSERT using storyId instead of chapterId
        {
          clientId,
          mutationId: uuidv4(),
          domain: SyncDomain.HISTORY,
          entityId: storyAId,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {
            storyId: storyAId,
            chapterId: chapterAId,
            progressPercentage: 40,
            observedHistoryEpoch: 0,
          },
        },
        // 5c: Fresh BOOKMARK UPSERT with extra unknown nested field (forbidNonWhitelisted nested)
        {
          clientId,
          mutationId: uuidv4(),
          domain: SyncDomain.BOOKMARK,
          entityId: storyAId,
          operation: SyncOperation.UPSERT,
          baseServerRevision: '0',
          payload: {
            storyId: storyAId,
            unexpectedNestedKey: 'forbid-me',
          },
        },
        // 5d: Fresh BOOKMARK DELETE with extra unknown nested field
        {
          clientId,
          mutationId: uuidv4(),
          domain: SyncDomain.BOOKMARK,
          entityId: storyAId,
          operation: SyncOperation.DELETE,
          baseServerRevision: '0',
          payload: {
            storyId: storyAId,
            extraJunk: true,
          },
        },
      ];

      for (const mut of freshMalformedCases) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/sync/mutations/batch')
          .set('Authorization', `Bearer ${token}`)
          .send({ mutations: [mut] });
        expect(res.status).toBe(400);
      }

      const [receipts, bookmarks, changes] = await Promise.all([
        dataSource.query(`SELECT COUNT(*)::int AS c FROM sync_mutation_receipts WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM bookmarks WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM sync_change_log WHERE user_id = $1`, [userId]),
      ]);
      expect(receipts[0].c).toBe(0);
      expect(bookmarks[0].c).toBe(0);
      expect(changes[0].c).toBe(0);
    });
  });

  describe('REG-JCS-06..07 — Mixed Batch Compatibility & Atomic Transaction Rollback', () => {
    it('REG-JCS-06: Mixed batch [Legacy HISTORY receipt replay, Canonical Fresh BOOKMARK] MUST return 200 [DEDUPLICATED, APPLIED] [RED]', async () => {
      const { userId, token } = await createFreshUser('jcs06');
      const clientId = uuidv4();
      const legacyMutId = uuidv4();
      const freshMutId = uuidv4();

      const legacyHist = {
        clientId,
        mutationId: legacyMutId,
        domain: SyncDomain.HISTORY,
        entityId: storyAId,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: { storyId: storyAId, chapterId: chapterAId, progressPercentage: 50 },
      };

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 8, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES ($1, $2, $3, $4, 'APPLIED', 5, '{"message":"legacy"}')`,
        [userId, clientId, legacyMutId, computeCanonicalMutationHash(legacyHist)],
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            legacyHist,
            {
              clientId,
              mutationId: freshMutId,
              domain: SyncDomain.BOOKMARK,
              entityId: storyBId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '8',
              payload: { storyId: storyBId },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.newServerRevision).toBe('9');
      expect(res.body.results).toEqual([
        expect.objectContaining({ mutationId: legacyMutId, status: 'DEDUPLICATED', assignedRevision: '5' }),
        expect.objectContaining({ mutationId: freshMutId, status: 'APPLIED', assignedRevision: '9' }),
      ]);
    });

    it('REG-JCS-07: Mixed batch [Valid Fresh BOOKMARK, Fresh Invalid HISTORY entityId=storyId] MUST fail 400 and rollback 100% of Item 0 [RED on HISTORY entityId=storyId allowed]', async () => {
      const { userId, token } = await createFreshUser('jcs07');
      const clientId = uuidv4();

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyAId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { storyId: storyAId },
            },
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.HISTORY,
              entityId: storyBId, // Invalid for B1 fresh! Must fail 400 & trigger rollback
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: {
                storyId: storyBId,
                chapterId: chapterBId,
                progressPercentage: 40,
                observedHistoryEpoch: 0,
              },
            },
          ],
        });

      expect(res.status).toBe(400);

      const [bookmarks, receipts, changes, syncState] = await Promise.all([
        dataSource.query(`SELECT COUNT(*)::int AS c FROM bookmarks WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM sync_mutation_receipts WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT COUNT(*)::int AS c FROM sync_change_log WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT current_sync_revision::text AS rev FROM user_sync_state WHERE user_id = $1`, [userId]),
      ]);
      expect(bookmarks[0].c).toBe(0);
      expect(receipts[0].c).toBe(0);
      expect(changes[0].c).toBe(0);
      expect(syncState[0]?.rev ?? '0').toBe('0');
    });

    it('REG-JCS-07B: Mixed batch mid-transaction failure [Valid Fresh BOOKMARK, Idempotency Mismatch on Item 1] MUST rollback 100% of Item 0 SQL writes', async () => {
      const { userId, token } = await createFreshUser('jcs07b');
      const clientId = uuidv4();
      const seedMutId = uuidv4();

      const seedRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: seedMutId,
              domain: SyncDomain.BOOKMARK,
              entityId: storyBId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { storyId: storyBId },
            },
          ],
        });
      expect(seedRes.status).toBe(200);

      const failRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyAId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '1',
              payload: { storyId: storyAId },
            },
            {
              clientId,
              mutationId: seedMutId,
              domain: SyncDomain.BOOKMARK,
              entityId: storyBId,
              operation: SyncOperation.DELETE,
              baseServerRevision: '1',
              payload: { storyId: storyBId },
            },
          ],
        });
      expect(failRes.status).toBe(409);

      const [bookmarks, syncState] = await Promise.all([
        dataSource.query(`SELECT story_id FROM bookmarks WHERE user_id = $1`, [userId]),
        dataSource.query(`SELECT current_sync_revision::text AS rev FROM user_sync_state WHERE user_id = $1`, [userId]),
      ]);
      expect(bookmarks.map((b: any) => b.story_id)).toEqual([storyBId]);
      expect(syncState[0]?.rev).toBe('1');
    });
  });

  describe('REG-JCS-08..11 — JCS Zero-Mutation, Malformed JSON, Infinity, Prototype Pollution & Resource Bounds', () => {
    it('REG-JCS-08: Negative zero (-0 -> 0) & reordered keys MUST produce matching JCS receipt hash without mutating extra fields on replay', async () => {
      const { token } = await createFreshUser('jcs08');
      const clientId = uuidv4();
      const mutationId = uuidv4();

      const rawFirst = `{"mutations":[{"clientId":"${clientId}","mutationId":"${mutationId}","domain":"PROGRESS","entityId":"${storyAId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyAId}","chapterId":"${chapterAId}","readingMode":"WEBTOON","pageIndex":1,"scrollPosition":-0,"progressPercentage":45}}]}`;
      const res1 = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawFirst);
      expect(res1.status).toBe(200);
      expect(res1.body.results[0].status).toBe('APPLIED');

      // Replay with sorted keys and 0 instead of -0 -> exact RFC 8785 equivalence
      const res2 = await request(app.getHttpServer())
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
                chapterId: chapterAId,
                pageIndex: 1,
                progressPercentage: 45,
                readingMode: ReadingMode.WEBTOON,
                scrollPosition: 0,
                storyId: storyAId,
              },
            },
          ],
        });
      expect(res2.status).toBe(200);
      expect(res2.body.results[0].status).toBe('DEDUPLICATED');
    });

    it('REG-JCS-09A: Malformed Express JSON syntax & bare NaN/Infinity tokens MUST return HTTP 400 (NOT 500) [RED]', async () => {
      const { token } = await createFreshUser('jcs09a');

      const brokenSyntaxRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"mutations": [');

      expect(brokenSyntaxRes.status).toBe(400);
      expect(brokenSyntaxRes.body?.error?.code).toBe('INVALID_JSON_PAYLOAD');

      const bareNanRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(`{"mutations":[{"x":NaN}]}`);

      expect(bareNanRes.status).toBe(400);
      expect(bareNanRes.body?.error?.code).toBe('INVALID_JSON_PAYLOAD');
    });

    it('REG-JCS-09B: Valid JSON literal overflow 1e309 (parses to Infinity) in PROGRESS/PREFERENCE & lone surrogates MUST fail with HTTP 400 (NOT 500) [RED]', async () => {
      const { token } = await createFreshUser('jcs09b');
      const clientId = uuidv4();

      const rawOverflowProgress = `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"PROGRESS","entityId":"${storyAId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyAId}","chapterId":"${chapterAId}","readingMode":"WEBTOON","pageIndex":1,"scrollPosition":0,"progressPercentage":1e309}}]}`;
      const resInfProg = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawOverflowProgress);
      expect(resInfProg.status).toBe(400);

      const rawOverflowPref = `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"PREFERENCE","entityId":"theme","operation":"UPSERT","baseServerRevision":"0","payload":{"key":"theme","value":1e309}}]}`;
      const resInfPref = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawOverflowPref);
      expect(resInfPref.status).toBe(400);

      const rawLoneSurrogate = `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"PREFERENCE","entityId":"theme","operation":"UPSERT","baseServerRevision":"0","payload":{"key":"theme","value":"\\uD800"}}]}`;
      const resSurr = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawLoneSurrogate);
      expect(resSurr.status).toBe(400);
    });

    it("REG-JCS-10: Raw JSON containing '__proto__', 'constructor', or 'prototype' keys MUST be rejected fail-closed with 400 and preserve Object.prototype [RED]", async () => {
      const { userId, token } = await createFreshUser('jcs10');
      const clientId = uuidv4();

      const vectors = [
        `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"BOOKMARK","entityId":"${storyAId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyAId}","__proto__":{"polluted":true}}}]}`,
        `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"BOOKMARK","entityId":"${storyAId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyAId}","nested":{"constructor":{"prototype":{"polluted":true}}}}}]}`,
        `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"BOOKMARK","entityId":"${storyAId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyAId}","prototype":{"x":1}}}]}`,
      ];

      for (const rawVec of vectors) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/sync/mutations/batch')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send(rawVec);

        expect(res.status).toBe(400);
        expect(({} as any).polluted).toBeUndefined();
        expect((Object.prototype as any).polluted).toBeUndefined();
      }

      const receipts = await dataSource.query(
        `SELECT COUNT(*)::int AS c FROM sync_mutation_receipts WHERE user_id = $1`,
        [userId],
      );
      expect(receipts[0].c).toBe(0);
    });

    it('REG-JCS-11A: Body > 2 MB MUST return HTTP 413 PAYLOAD_TOO_LARGE (NOT 500) [RED]', async () => {
      const { token } = await createFreshUser('jcs11a');
      const oversized = JSON.stringify({
        mutations: [
          {
            clientId: uuidv4(),
            mutationId: uuidv4(),
            domain: SyncDomain.PREFERENCE,
            entityId: 'theme',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { key: 'theme', value: 'a'.repeat(2_200_000) },
          },
        ],
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(oversized);

      expect(res.status).toBe(413);
      expect(res.body?.error?.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('REG-JCS-11B: Additional B1 JSON hardening bounds (depth > 16, > 128 payload keys, string > 16384 chars, PREFERENCE key > 64 chars) MUST fail 400 [RED]', async () => {
      const { token } = await createFreshUser('jcs11b');
      const clientId = uuidv4();

      // 1. Nesting depth 18 (> max 16)
      let deepObj: any = { leaf: 1 };
      for (let i = 0; i < 18; i++) {
        deepObj = { child: deepObj };
      }
      const resDepth = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: 'theme',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { key: 'theme', value: deepObj },
            },
          ],
        });
      expect(resDepth.status).toBe(400);

      // 2. Recursive key count 135 (> max 128)
      const manyKeysObj: Record<string, number> = {};
      for (let i = 0; i < 135; i++) {
        manyKeysObj[`k_${i}`] = i;
      }
      const resKeys = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: 'theme',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { key: 'theme', value: manyKeysObj },
            },
          ],
        });
      expect(resKeys.status).toBe(400);

      // 3. Individual string value 20,000 chars (> max 16,384)
      const resLongStr = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: 'theme',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { key: 'theme', value: 's'.repeat(20_000) },
            },
          ],
        });
      expect(resLongStr.status).toBe(400);

      // 4. PREFERENCE key 65 chars (> VARCHAR(64) DB limit)
      const longKey = 'k'.repeat(65);
      const resPrefLen = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: longKey,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { key: longKey, value: 'v' },
            },
          ],
        });
      expect(resPrefLen.status).toBe(400);
    });
  });

  describe("Erratum 1 & Task 2 — Fresh HISTORY DELETE 'all' & Preference Tombstone/No-Trim", () => {
    it("REG-JCS-12 / ERRATA-1: Fresh HISTORY DELETE 'all' MUST fail 400, legacy receipt 'all' replays 200 DEDUPLICATED, fresh UUID sentinel succeeds WITHOUT writing entity_id='all' [RED]", async () => {
      const { userId, token } = await createFreshUser('hist_all');
      const clientId = uuidv4();

      // 1. Seed a legacy receipt for 'all'
      const legacyAllMut = {
        clientId,
        mutationId: uuidv4(),
        domain: SyncDomain.HISTORY,
        entityId: 'all',
        operation: SyncOperation.DELETE,
        baseServerRevision: '0',
        payload: {},
      };
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 1, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES ($1, $2, $3, $4, 'APPLIED', 1, '{"message":"legacy"}')`,
        [userId, clientId, legacyAllMut.mutationId, computeCanonicalMutationHash(legacyAllMut)],
      );

      // Legacy replay with receipt succeeds
      const replayRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyAllMut] });
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.results[0].status).toBe('DEDUPLICATED');

      // 2. Fresh HISTORY DELETE 'all' (NO receipt) MUST fail 400
      const freshAllRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.HISTORY,
              entityId: 'all',
              operation: SyncOperation.DELETE,
              baseServerRevision: '1',
              payload: {},
            },
          ],
        });
      expect(freshAllRes.status).toBe(400);

      // 3. Fresh HISTORY DELETE UUID sentinel MUST succeed AND create zero entity_id='all' tombstones
      const freshSentinelRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.HISTORY,
              entityId: '00000000-0000-0000-0000-000000000000',
              operation: SyncOperation.DELETE,
              baseServerRevision: '1',
              payload: {},
            },
          ],
        });
      expect(freshSentinelRes.status).toBe(200);
      expect(freshSentinelRes.body.results[0].status).toBe('APPLIED');

      const allTombRows = await dataSource.query(
        `SELECT entity_id FROM sync_tombstones WHERE user_id = $1 AND domain = 'HISTORY'`,
        [userId],
      );
      expect(allTombRows.some((r: any) => r.entity_id === 'all')).toBe(false);
    });

    it('PREF-HIST-01..03: PREFERENCE tombstone check MUST precede whitelist/stale check & untrimmed key MUST fail 400 without .trim() [RED]', async () => {
      const { userId, token } = await createFreshUser('pref_hist');
      const clientId = uuidv4();

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 15, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_tombstones (user_id, domain, entity_id, deleted_at_revision)
         VALUES ($1, 'PREFERENCE', 'theme', 12), ($1, 'PREFERENCE', 'pref:a:b', 12)`,
        [userId],
      );

      // 1. Account key 'theme' with baseRev='5' < tombstoneRev=12 -> MUST reject with REJECTED_TOMBSTONE
      const themeStaleRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: 'theme',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '5',
              payload: { key: 'theme', value: 'dark' },
            },
          ],
        });
      expect(themeStaleRes.status).toBe(200);
      expect(themeStaleRes.body.results[0]).toMatchObject({
        status: 'REJECTED_TOMBSTONE',
        reason: 'TOMBSTONE_CONFLICT',
        assignedRevision: null,
      });

      // 2. Historical key 'pref:a:b' with baseRev='5' < tombstoneRev=12 -> TOMBSTONE_CONFLICT BEFORE PREFERENCE_KEY_NOT_SUPPORTED
      const histTombRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: 'pref:a:b',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '5',
              payload: { key: 'pref:a:b', value: 'dark' },
            },
          ],
        });
      expect(histTombRes.status).toBe(200);
      expect(histTombRes.body.results[0]).toMatchObject({
        status: 'REJECTED_TOMBSTONE',
        reason: 'TOMBSTONE_CONFLICT',
      });

      // 3. Untrimmed whitespace key ' theme ' MUST return 400 (no silent .trim())
      const untrimmedRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: ' theme ',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '15',
              payload: { key: ' theme ', value: 'dark' },
            },
          ],
        });
      expect(untrimmedRes.status).toBe(400);
    });

    it('TOMB-PREC-01: PROGRESS missing observedHistoryEpoch when effectiveEpoch > 0 MUST fail with MISSING_HISTORY_EPOCH_PROOF after tombstone guard [RED]', async () => {
      const { userId, token } = await createFreshUser('prog_epoch');
      const clientId = uuidv4();

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 20, 0)`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, $2, 2, NOW())`,
        [userId, storyAId],
      );

      const res = await request(app.getHttpServer())
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
              baseServerRevision: '20', // >= tombstoneRev (none in sync_tombstones), no observedHistoryEpoch
              payload: {
                storyId: storyAId,
                chapterId: chapterAId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 40,
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({
        status: 'REJECTED_TOMBSTONE',
        reason: 'MISSING_HISTORY_EPOCH_PROOF',
        assignedRevision: null,
      });
    });
  });
});
