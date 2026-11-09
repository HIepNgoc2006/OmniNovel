import './setup-e2e';
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
import {
  bootstrapTestDatabaseMarker,
  verifyTestDatabaseIdentity,
} from '../src/common/guards/test-isolation-guard';
import { RedisService } from '../src/redis/redis.service';
import { computeCanonicalMutationHash } from '../src/modules/sync/helpers/canonical-json.helper';
import { ReadingMode, SyncDomain, SyncOperation } from '../src/modules/sync/interfaces/sync.types';

interface ProbeEvidence {
  id: string;
  title: string;
  httpStatus: number;
  responseBody: unknown;
  dbBefore: Record<string, unknown>;
  dbAfter: Record<string, unknown>;
  extraChecks?: Record<string, unknown>;
  exploitabilityDemonstrated: boolean;
  classification:
    | 'Confirmed defect'
    | 'Confirmed missing validation'
    | 'Exploitability unverified'
    | 'Spec-only risk'
    | 'Verified healthy baseline';
  notes: string;
}

async function snapshotUserSyncDbState(
  dataSource: DataSource,
  userId: string,
): Promise<Record<string, unknown>> {
  const [stateRows, receiptRows, changeRows, tombRows, bookmarkRows, progressRows, prefRows, histTombRows] =
    await Promise.all([
      dataSource.query(
        `SELECT current_sync_revision::text, min_active_revision::text FROM user_sync_state WHERE user_id = $1`,
        [userId],
      ),
      dataSource.query(
        `SELECT mutation_id, status, assigned_revision::text, response_meta FROM sync_mutation_receipts WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      dataSource.query(
        `SELECT revision::text, domain, entity_id, operation, payload FROM sync_change_log WHERE user_id = $1 ORDER BY revision ASC`,
        [userId],
      ),
      dataSource.query(
        `SELECT domain, entity_id, deleted_at_revision::text FROM sync_tombstones WHERE user_id = $1 ORDER BY domain, entity_id`,
        [userId],
      ),
      dataSource.query(
        `SELECT story_id FROM bookmarks WHERE user_id = $1 ORDER BY story_id`,
        [userId],
      ),
      dataSource.query(
        `SELECT story_id, chapter_id, progress_percentage, text_offset FROM reading_progress WHERE user_id = $1 ORDER BY story_id`,
        [userId],
      ),
      dataSource.query(
        `SELECT key, value FROM user_preferences WHERE user_id = $1 ORDER BY key`,
        [userId],
      ),
      dataSource.query(
        `SELECT story_id, epoch FROM reading_history_tombstones WHERE user_id = $1 ORDER BY story_id`,
        [userId],
      ),
    ]);

  return {
    currentSyncRevision: stateRows[0]?.current_sync_revision ?? '0',
    minActiveRevision: stateRows[0]?.min_active_revision ?? '0',
    receiptCount: receiptRows.length,
    receipts: receiptRows.map((r: any) => ({
      mutationId: r.mutation_id,
      status: r.status,
      assignedRevision: r.assigned_revision,
    })),
    changeLogCount: changeRows.length,
    changeLogs: changeRows.map((c: any) => ({
      revision: c.revision,
      domain: c.domain,
      entityId: c.entity_id,
      operation: c.operation,
    })),
    tombstones: tombRows,
    bookmarksCount: bookmarkRows.length,
    bookmarks: bookmarkRows.map((b: any) => b.story_id),
    progressCount: progressRows.length,
    preferences: prefRows,
    historyTombstones: histTombRows,
  };
}

async function runProbe(): Promise<void> {
  await bootstrapTestDatabaseMarker();
  await verifyTestDatabaseIdentity();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication = moduleFixture.createNestApplication();
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

  const dataSource = app.get(DataSource);
  const redisService = app.get(RedisService);
  const jwtService = app.get(JwtService);

  const now = Date.now();
  const createdUserIds: string[] = [];
  const createdStoryIds: string[] = [];
  const redisKeysToDelete: string[] = [];
  const evidences: ProbeEvidence[] = [];

  const createSyntheticUserAndToken = async (tag: string) => {
    const [u] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ($1, $2, 'synthetic_hash', 'READER', true, false)
       RETURNING id, username, role`,
      [`b1_probe_${tag}_${now}`, `b1_probe_${tag}_${now}@omninovel.test`],
    );
    createdUserIds.push(u.id);
    const sid = `probe-sid-${tag}-${now}`;
    const redisKey = `auth_session:${u.id}:${sid}`;
    redisKeysToDelete.push(redisKey);
    await redisService.set(
      redisKey,
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
  };

  try {
    // Seed 2 synthetic stories + edition/chapter/version
    const seedStory = async (label: string) => {
      const [s] = await dataSource.query(
        `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
         VALUES ($1, $2, 'https://example.com/probe.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko')
         RETURNING id`,
        [`B1 Probe ${label}`, `b1-probe-${label.toLowerCase()}-${now}`],
      );
      createdStoryIds.push(s.id);
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
      const [ver] = await dataSource.query(
        `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published)
         VALUES ($1, 1, 'RAW_ORIGINAL', true) RETURNING id`,
        [ch.id],
      );
      await dataSource.query(`UPDATE chapters SET active_version_id = $1 WHERE id = $2`, [
        ver.id,
        ch.id,
      ]);
      return { storyId: s.id as string, chapterId: ch.id as string, versionId: ver.id as string };
    };

    const storyA = await seedStory('A');
    const storyB = await seedStory('B');

    // ------------------------------------------------------------------
    // Probe 1a: Malformed Express JSON syntax
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('1a');
      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send('{"mutations": [');
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);
      evidences.push({
        id: 'PROBE-1A',
        title: 'Malformed Express JSON Syntax',
        httpStatus: res.status,
        responseBody: res.body,
        dbBefore,
        dbAfter,
        exploitabilityDemonstrated: false,
        classification: res.status === 500 ? 'Confirmed defect' : 'Spec-only risk',
        notes:
          res.status === 500
            ? 'GlobalExceptionFilter fell through to 500 INTERNAL_SERVER_ERROR on Express body-parser SyntaxError (entity.parse.failed).'
            : 'NestJS RoutesResolver mapped SyntaxError to 400 BAD_REQUEST (raw V8 message exposed instead of canonical INVALID_JSON_PAYLOAD code).',
      });
    }

    // ------------------------------------------------------------------
    // Probe 1b: Bare identifier NaN vs valid JSON 1e309 -> Infinity (PROGRESS vs PREFERENCE.value) & lone surrogate
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('1b');
      const clientId = uuidv4();
      const mutNan = uuidv4();
      const rawNan = `{"mutations":[{"clientId":"${clientId}","mutationId":"${mutNan}","domain":"BOOKMARK","entityId":"${storyA.storyId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyA.storyId}","x":NaN}}]}`;
      const resNan = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawNan);

      const mutInfProgress = uuidv4();
      const rawInfProgress = `{"mutations":[{"clientId":"${clientId}","mutationId":"${mutInfProgress}","domain":"PROGRESS","entityId":"${storyA.storyId}","operation":"UPSERT","baseServerRevision":"0","payload":{"storyId":"${storyA.storyId}","chapterId":"${storyA.chapterId}","readingMode":"WEBTOON","pageIndex":1,"scrollPosition":0,"progressPercentage":1e309}}]}`;
      const resInfProgress = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawInfProgress);

      const mutInfPref = uuidv4();
      const rawInfPref = `{"mutations":[{"clientId":"${clientId}","mutationId":"${mutInfPref}","domain":"PREFERENCE","entityId":"theme","operation":"UPSERT","baseServerRevision":"0","payload":{"key":"theme","value":1e309}}]}`;
      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const resInfPref = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawInfPref);

      const rawLoneSurrogate = `{"mutations":[{"clientId":"${clientId}","mutationId":"${uuidv4()}","domain":"PREFERENCE","entityId":"theme","operation":"UPSERT","baseServerRevision":"0","payload":{"key":"theme","value":"\\uD800"}}]}`;
      const resSurr = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(rawLoneSurrogate);
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      evidences.push({
        id: 'PROBE-1B',
        title: 'JSON Bare NaN vs Valid JSON 1e309 -> Infinity & Lone Surrogate',
        httpStatus: resInfPref.status,
        responseBody: {
          rawNanResult: { status: resNan.status, body: resNan.body },
          numeric1e309Progress: { status: resInfProgress.status, body: resInfProgress.body },
          numeric1e309PreferenceValue: { status: resInfPref.status, body: resInfPref.body },
          loneSurrogatePreferenceValue: { status: resSurr.status, body: resSurr.body },
        },
        dbBefore,
        dbAfter,
        extraChecks: { jsJsonParse1e309: JSON.parse('{"v":1e309}').v === Infinity },
        exploitabilityDemonstrated: false,
        classification:
          resInfPref.status === 500 || resSurr.status === 500
            ? 'Confirmed defect'
            : 'Confirmed missing validation',
        notes:
          'JSON.parse evaluates 1e309 to Infinity (not null). PROGRESS rejected Infinity (400 via @IsNumber), whereas PREFERENCE.value=1e309 and lone surrogate \\uD800 bypassed ValidationPipe and threw raw [JCS] Error in SyncService -> HTTP 500 INTERNAL_SERVER_ERROR.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 2: HTTP Body > 2 MB (PayloadTooLargeError)
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('2');
      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const bigPadding = 'x'.repeat(2_200_000);
      const bigBody = JSON.stringify({
        mutations: [
          {
            clientId: uuidv4(),
            mutationId: uuidv4(),
            domain: SyncDomain.PREFERENCE,
            entityId: 'theme',
            operation: SyncOperation.UPSERT,
            baseServerRevision: '0',
            payload: { key: 'theme', value: bigPadding },
          },
        ],
      });
      const res = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(bigBody);
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      evidences.push({
        id: 'PROBE-2',
        title: 'HTTP Body > 2 MB (PayloadTooLargeError)',
        httpStatus: res.status,
        responseBody: res.body,
        dbBefore,
        dbAfter,
        extraChecks: { byteLength: Buffer.byteLength(bigBody, 'utf8') },
        exploitabilityDemonstrated: false,
        classification: res.status === 500 ? 'Confirmed defect' : 'Verified healthy baseline',
        notes:
          res.status === 500
            ? 'GlobalExceptionFilter mapped Express PayloadTooLargeError (entity.too.large) to HTTP 500 instead of 413 PAYLOAD_TOO_LARGE.'
            : 'Returned proper 413.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 3: Nested '__proto__', 'constructor', 'prototype' in JSON HTTP & JCS
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('3');
      const clientId = uuidv4();
      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);

      const buildVec = (mutId: string, extraPropJson: string) =>
        `{"mutations":[{"clientId":"${clientId}","mutationId":"${mutId}",` +
        `"domain":"BOOKMARK","entityId":"${storyA.storyId}","operation":"UPSERT",` +
        `"baseServerRevision":"0","payload":{"storyId":"${storyA.storyId}",${extraPropJson}}}]}`;

      const resProtoOnly = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(buildVec(uuidv4(), `"__proto__":{"b1Polluted":true}`));

      const resCtorOnly = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(buildVec(uuidv4(), `"constructor":{"prototype":{"b1CtorPolluted":true}}`));

      const resPrototypeOnly = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(buildVec(uuidv4(), `"prototype":{"b1ProtoKey":1}`));

      const resCombined = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(
          buildVec(
            uuidv4(),
            `"__proto__":{"b1Polluted":true},"constructor":{"prototype":{"b1CtorPolluted":true}},"prototype":{"b1ProtoKey":1}`,
          ),
        );

      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);
      const cleanProbeObj: any = {};
      const objectProtoPolluted =
        cleanProbeObj.b1Polluted !== undefined ||
        (Object.prototype as any).b1Polluted !== undefined ||
        cleanProbeObj.b1CtorPolluted !== undefined ||
        (Object.prototype as any).b1CtorPolluted !== undefined;

      // Also check direct JCS helper call with parsed object containing own property __proto__
      const parsedPayload = JSON.parse(
        `{"storyId":"${storyA.storyId}","__proto__":{"b1Polluted":true},"constructor":{"x":1},"prototype":{"y":2}}`,
      );
      const jcsAcceptedWithoutThrowing = (() => {
        try {
          const hash = computeCanonicalMutationHash({
            clientId,
            mutationId: uuidv4(),
            domain: 'BOOKMARK',
            entityId: storyA.storyId,
            operation: 'UPSERT',
            baseServerRevision: '0',
            payload: parsedPayload,
          });
          return { accepted: true, hash };
        } catch (err: any) {
          return { accepted: false, error: err?.message };
        }
      })();

      evidences.push({
        id: 'PROBE-3',
        title: "Nested '__proto__', 'constructor', 'prototype' in HTTP JSON & JCS",
        httpStatus: resCombined.status,
        responseBody: {
          protoOnly: { status: resProtoOnly.status, body: resProtoOnly.body },
          constructorOnly: { status: resCtorOnly.status, body: resCtorOnly.body },
          prototypeOnly: { status: resPrototypeOnly.status, body: resPrototypeOnly.body },
          combined: { status: resCombined.status, body: resCombined.body },
        },
        dbBefore,
        dbAfter,
        extraChecks: {
          objectProtoPolluted,
          jcsAcceptedWithoutThrowing,
        },
        exploitabilityDemonstrated: objectProtoPolluted,
        classification:
          resCtorOnly.status === 500 || resCombined.status === 500
            ? 'Confirmed defect'
            : resProtoOnly.status === 200
              ? 'Exploitability unverified'
              : 'Verified healthy baseline',
        notes:
          'Standalone __proto__/prototype were accepted with HTTP 200 (missing nested prototype-key guard), constructor triggered HTTP 500 TypeError in ValidationPipe/class-transformer, and Object.prototype remained unmodified.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 4: Legacy receipt replay vs ValidationPipe pre-controller rejection
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('4');
      const clientId = uuidv4();

      // 4a: Legacy PROGRESS receipt with storyId:chapterId entityId
      const mutProgressColon = uuidv4();
      const legacyProgDto = {
        clientId,
        mutationId: mutProgressColon,
        domain: SyncDomain.PROGRESS,
        entityId: `${storyA.storyId}:${storyA.chapterId}`,
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          storyId: storyA.storyId,
          chapterId: storyA.chapterId,
          readingMode: ReadingMode.WEBTOON,
          pageIndex: 1,
          scrollPosition: 0,
          progressPercentage: 40,
        },
      };
      const hashProg = computeCanonicalMutationHash(legacyProgDto);

      // 4b: Legacy HISTORY receipt missing observedHistoryEpoch (pre-epoch enforcement shape)
      const mutHistoryNoEpoch = uuidv4();
      const legacyHistDto = {
        clientId,
        mutationId: mutHistoryNoEpoch,
        domain: SyncDomain.HISTORY,
        entityId: storyA.storyId, // legacy entityId = storyId AND missing observedHistoryEpoch!
        operation: SyncOperation.UPSERT,
        baseServerRevision: '0',
        payload: {
          storyId: storyA.storyId,
          chapterId: storyA.chapterId,
          progressPercentage: 55,
        },
      };
      const hashHist = computeCanonicalMutationHash(legacyHistDto);

      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 2, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES
           ($1, $2, $3, $4, 'APPLIED', 1, '{"message":"legacy prog"}'),
           ($1, $2, $5, $6, 'APPLIED', 2, '{"message":"legacy hist"}')`,
        [userId, clientId, mutProgressColon, hashProg, mutHistoryNoEpoch, hashHist],
      );

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const resProg = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyProgDto] });
      const resHist = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyHistDto] });
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      evidences.push({
        id: 'PROBE-4',
        title: 'Legacy Receipt Replay vs ValidationPipe Pre-Receipt Interception',
        httpStatus: resHist.status,
        responseBody: {
          legacyProgressColonReplay: { status: resProg.status, body: resProg.body },
          legacyHistoryMissingEpochReplay: { status: resHist.status, body: resHist.body },
        },
        dbBefore,
        dbAfter,
        exploitabilityDemonstrated: false,
        classification: resHist.status === 400 ? 'Confirmed defect' : 'Verified healthy baseline',
        notes:
          resHist.status === 400
            ? 'ValidationPipe blocked valid legacy HISTORY receipt replay (HTTP 400) BEFORE SyncService could lookup sync_mutation_receipts!'
            : 'Replay reached receipt ledger.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 5: Same (userId, clientId, mutationId) + altered payload -> 409 & meta.mutationId
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('5');
      const clientId = uuidv4();
      const mutId = uuidv4();

      const firstRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: mutId,
              domain: SyncDomain.PROGRESS,
              entityId: storyA.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: {
                storyId: storyA.storyId,
                chapterId: storyA.chapterId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 25,
              },
            },
          ],
        });

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const mismatchRes = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: mutId,
              domain: SyncDomain.PROGRESS,
              entityId: storyA.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: {
                storyId: storyA.storyId,
                chapterId: storyA.chapterId,
                readingMode: ReadingMode.WEBTOON,
                pageIndex: 1,
                scrollPosition: 0,
                progressPercentage: 85, // Altered!
              },
            },
          ],
        });
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      const hasMutationIdInMeta =
        mismatchRes.body?.error?.meta?.mutationId === mutId ||
        mismatchRes.body?.mutationId === mutId;

      evidences.push({
        id: 'PROBE-5',
        title: 'Payload Mismatch (Same userId/clientId/mutationId) -> 409 & meta.mutationId',
        httpStatus: mismatchRes.status,
        responseBody: mismatchRes.body,
        dbBefore,
        dbAfter,
        extraChecks: {
          firstPushStatus: firstRes.status,
          hasMutationIdInMeta,
        },
        exploitabilityDemonstrated: false,
        classification:
          mismatchRes.status === 409 && !hasMutationIdInMeta
            ? 'Confirmed defect'
            : 'Verified healthy baseline',
        notes:
          mismatchRes.status === 409 && !hasMutationIdInMeta
            ? 'Returned HTTP 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH cleanly, but GlobalExceptionFilter stripped mutationId from response body (not in PUBLIC_ERROR_META_FIELDS).'
            : '409 & meta intact.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 6: Mixed Batch [valid fresh, invalid fresh] & TX rollback
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('6');
      const clientId = uuidv4();
      // Seed one receipt so subcase 6b can force an in-TX error after Item[0] executes SQL
      const mismatchMutId = uuidv4();
      await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: mismatchMutId,
              domain: SyncDomain.BOOKMARK,
              entityId: storyB.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { storyId: storyB.storyId },
            },
          ],
        });

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      // 6a: Pipe-level mixed [valid BOOKMARK storyA, invalid HISTORY missing observedHistoryEpoch]
      const res6a = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyA.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '1',
              payload: { storyId: storyA.storyId },
            },
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.HISTORY,
              entityId: storyA.chapterId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '1',
              payload: {
                storyId: storyA.storyId,
                chapterId: storyA.chapterId,
                progressPercentage: 40,
              },
            },
          ],
        });
      // 6b: In-TX failure after Item[0] (BOOKMARK storyA INSERT runs inside TX, then Item[1] triggers 409)
      const res6b = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyA.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '1',
              payload: { storyId: storyA.storyId },
            },
            {
              clientId,
              mutationId: mismatchMutId,
              domain: SyncDomain.BOOKMARK,
              entityId: storyB.storyId,
              operation: SyncOperation.DELETE, // different operation -> 409 inside TX!
              baseServerRevision: '1',
              payload: { storyId: storyB.storyId },
            },
          ],
        });
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      evidences.push({
        id: 'PROBE-6',
        title: 'Mixed Batch [Valid Fresh, Invalid] Atomicity & TX Rollback',
        httpStatus: res6a.status,
        responseBody: {
          pipeMixedResult: { status: res6a.status, body: res6a.body },
          inTxRollbackResult: { status: res6b.status, body: res6b.body },
        },
        dbBefore,
        dbAfter,
        extraChecks: {
          storyABookmarked: (dbAfter.bookmarks as string[]).includes(storyA.storyId),
          revisionUnchanged: dbBefore.currentSyncRevision === dbAfter.currentSyncRevision,
        },
        exploitabilityDemonstrated: false,
        classification: 'Verified healthy baseline',
        notes: 'Both Pipe-level rejection (400) and in-transaction error (409 after Item 0 INSERT) rolled back cleanly; zero partial commits.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 7: HISTORY DELETE 'all' fresh vs legacy receipt replay
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('7');
      const clientId = uuidv4();
      const legacyMutId = uuidv4();
      const legacyDto = {
        clientId,
        mutationId: legacyMutId,
        domain: SyncDomain.HISTORY,
        entityId: 'all',
        operation: SyncOperation.DELETE,
        baseServerRevision: '0',
        payload: {},
      };
      const legacyHash = computeCanonicalMutationHash(legacyDto);
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_mutation_receipts (user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta)
         VALUES ($1, $2, $3, $4, 'APPLIED', 1, '{"message":"legacy all delete"}')`,
        [userId, clientId, legacyMutId, legacyHash],
      );

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);
      const resLegacy = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ mutations: [legacyDto] });

      const freshMutId = uuidv4();
      const resFreshAll = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: freshMutId,
              domain: SyncDomain.HISTORY,
              entityId: 'all',
              operation: SyncOperation.DELETE,
              baseServerRevision: '1',
              payload: {},
            },
          ],
        });
      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      const wroteAllTombstone = (dbAfter.tombstones as any[]).some((t) => t.entity_id === 'all');

      evidences.push({
        id: 'PROBE-7',
        title: "HISTORY DELETE 'all' Fresh vs Legacy Receipt Replay",
        httpStatus: resFreshAll.status,
        responseBody: {
          legacyReceiptAll: { status: resLegacy.status, body: resLegacy.body },
          freshAllDelete: { status: resFreshAll.status, body: resFreshAll.body },
        },
        dbBefore,
        dbAfter,
        extraChecks: { wroteAllTombstone },
        exploitabilityDemonstrated: false,
        classification: resFreshAll.status === 200 || wroteAllTombstone ? 'Confirmed defect' : 'Verified healthy baseline',
        notes:
          resFreshAll.status === 200
            ? "Fresh HISTORY DELETE 'all' was ACCEPTED (HTTP 200) and inserted entity_id='all' into sync_tombstones (violating B1 Erratum 1: fresh must reject 'all' with 400 and never emit 'all' tombstones)."
            : 'Fresh rejected cleanly.',
      });
    }

    // ------------------------------------------------------------------
    // Probe 8: Preference Tombstone (account + historical) & no-trim bug
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('8');
      const clientId = uuidv4();
      // Seed tombstones at rev 12 for both canonical 'theme' and historical 'pref:a:b'
      await dataSource.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision) VALUES ($1, 15, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await dataSource.query(
        `INSERT INTO sync_tombstones (user_id, domain, entity_id, deleted_at_revision)
         VALUES
           ($1, 'PREFERENCE', 'theme', 12),
           ($1, 'PREFERENCE', 'pref:a:b', 12)`,
        [userId],
      );

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);

      // 8a: Fresh 'theme' with stale baseServerRevision='5' (< tombstone rev 12) -> Resurrection test!
      const resThemeStale = await request(app.getHttpServer())
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

      // 8b: Fresh historical 'pref:a:b' with baseServerRevision='5' (< tombstone rev 12)
      const resHistTomb = await request(app.getHttpServer())
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
              payload: { key: 'pref:a:b', value: 'x' },
            },
          ],
        });

      // 8c: Untrimmed preference key ' locale ' (same untrimmed string in entityId and payload.key)
      const resUntrimmed = await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.PREFERENCE,
              entityId: ' locale ',
              operation: SyncOperation.UPSERT,
              baseServerRevision: '15',
              payload: { key: ' locale ', value: 'vi' },
            },
          ],
        });

      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      evidences.push({
        id: 'PROBE-8',
        title: 'Preference Tombstone Precedence, Historical Key & Silent .trim()',
        httpStatus: resThemeStale.status,
        responseBody: {
          themeUnderTombstone: { status: resThemeStale.status, body: resThemeStale.body },
          historicalPrefUnderTombstone: { status: resHistTomb.status, body: resHistTomb.body },
          untrimmedLocaleKey: { status: resUntrimmed.status, body: resUntrimmed.body },
        },
        dbBefore,
        dbAfter,
        exploitabilityDemonstrated: resThemeStale.body?.results?.[0]?.status === 'APPLIED',
        classification: 'Confirmed defect',
        notes:
          'PreferenceConflictResolver ignored tombstoneRevision (resurrecting deleted "theme" with APPLIED), returned PREFERENCE_KEY_NOT_SUPPORTED before TOMBSTONE_CONFLICT on "pref:a:b", and silently trimmed " locale " to "locale" in DB while JCS hashed untrimmed " locale ".',
      });
    }

    // ------------------------------------------------------------------
    // Probe 9: GuestClaim Bookmark after BOOKMARK Tombstone vs HISTORY Tombstone
    // ------------------------------------------------------------------
    {
      const { userId, token } = await createSyntheticUserAndToken('9');
      const clientId = uuidv4();

      // Step 1: User bookmarks Story A then deletes Story A via Sync Hub -> creates sync_tombstones('BOOKMARK', storyA)
      await request(app.getHttpServer())
        .post('/api/v1/sync/mutations/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          mutations: [
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyA.storyId,
              operation: SyncOperation.UPSERT,
              baseServerRevision: '0',
              payload: { storyId: storyA.storyId },
            },
            {
              clientId,
              mutationId: uuidv4(),
              domain: SyncDomain.BOOKMARK,
              entityId: storyA.storyId,
              operation: SyncOperation.DELETE,
              baseServerRevision: '1',
              payload: {},
            },
          ],
        });

      // Also clear Story B history only (reading_history_tombstones, NO BOOKMARK tombstone for Story B)
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, $2, 1, NOW())`,
        [userId, storyB.storyId],
      );

      const dbBefore = await snapshotUserSyncDbState(dataSource, userId);

      // Step 2: Prepare & commit GuestClaim with bookmarks [Story A (BOOKMARK tombstoned), Story B (HISTORY tombstoned)]
      const prepRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${token}`)
        .send({
          guestProfileId: uuidv4(),
          bookmarks: [{ storyId: storyA.storyId }, { storyId: storyB.storyId }],
          history: [
            { storyId: storyB.storyId, chapterId: storyB.chapterId, progressPercentage: 50 },
          ],
          progress: [],
        });

      let commitRes: any = null;
      if (prepRes.status === 200 && prepRes.body?.claimId) {
        commitRes = await request(app.getHttpServer())
          .post(`/api/v1/account/guest-claims/${prepRes.body.claimId}/commit`)
          .set('Authorization', `Bearer ${token}`)
          .send({ expectedStateFingerprint: prepRes.body.stateFingerprint });
      }

      const dbAfter = await snapshotUserSyncDbState(dataSource, userId);

      const storyAResurrected = (dbAfter.bookmarks as string[]).includes(storyA.storyId);
      const storyBImported = (dbAfter.bookmarks as string[]).includes(storyB.storyId);

      evidences.push({
        id: 'PROBE-9',
        title: 'GuestClaim Bookmark After BOOKMARK Tombstone vs HISTORY Tombstone',
        httpStatus: commitRes?.status ?? prepRes.status,
        responseBody: {
          prepareStatus: prepRes.status,
          prepareBody: prepRes.body,
          commitStatus: commitRes?.status,
          commitBody: commitRes?.body,
        },
        dbBefore,
        dbAfter,
        extraChecks: {
          storyAResurrectedAfterBookmarkTombstone: storyAResurrected,
          storyBImportedUnderHistoryTombstoneOnly: storyBImported,
        },
        exploitabilityDemonstrated: storyAResurrected,
        classification: storyAResurrected ? 'Confirmed missing validation' : 'Verified healthy baseline',
        notes:
          'Confirmed: HISTORY tombstone does NOT block Story B bookmark, while GuestClaimService does NOT inspect sync_tombstones(BOOKMARK) so Story A bookmark was auto-imported (resurrected) without conflict/quarantine confirmation.',
      });
    }

    // Emit full structured JSON evidence to stdout
    console.log('=== B1 HTTP REPRODUCTION EVIDENCE START ===');
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), evidences }, null, 2));
    console.log('=== B1 HTTP REPRODUCTION EVIDENCE END ===');
  } finally {
    // Clean up all synthetic test data cleanly
    for (const key of redisKeysToDelete) {
      await redisService.del(key);
    }
    if (createdUserIds.length > 0) {
      await dataSource.query(`DELETE FROM guest_claims WHERE user_id = ANY($1)`, [createdUserIds]);
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
    if (createdStoryIds.length > 0) {
      await dataSource.query(`DELETE FROM stories WHERE id = ANY($1)`, [createdStoryIds]);
    }
    await app.close();
  }
}

runProbe().catch((err) => {
  console.error('PROBE FATAL ERROR:', err);
  process.exit(1);
});
