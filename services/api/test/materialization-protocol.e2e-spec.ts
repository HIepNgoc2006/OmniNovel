import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  GlobalRole,
  MediaFormat,
  PublicationFormat,
  StoryMemberRole,
  StoryStatus,
  StoryVisibility,
  TranslationJobStatus,
  NovelBlockType,
} from '@omninovel/shared';
import { StorageService } from '../src/modules/storage/storage.service';

describe('Materialization Protocol & Fenced Completion E2E (#161, #156)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storageService: StorageService;
  let materializationQueue: Queue;

  const INTERNAL_KEY = 'internal_ai_worker_secret_secure_2026';
  let ownerId: string;
  let uploaderId: string;
  let ownerToken: string;
  let uploaderToken: string;

  let comicStoryId: string;
  let comicEditionId: string;
  let comicChapterId: string;
  let comicVersionId: string;
  let comicProjectId: string;
  let comicJobId: string;

  let novelStoryId: string;
  let novelEditionId: string;
  let novelChapterId: string;
  let novelVersionId: string;
  let novelProjectId: string;
  let novelJobId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'internal/v1/(.*)'],
    });
    await app.init();

    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    storageService = app.get(StorageService);
    materializationQueue = app.get<Queue>(
      getQueueToken('translation-materialization'),
    );

    // Mock storageService helpers
    jest.spyOn(storageService, 'uploadInternalBuffer').mockResolvedValue();
    jest
      .spyOn(storageService, 'statInternalObject')
      .mockImplementation(async (key: string) => {
        if (key.includes('missing')) {
          return { exists: false, contentLength: null };
        }
        if (key.includes('size-mismatch')) {
          return { exists: true, contentLength: 999999 };
        }
        return { exists: true, contentLength: 12345 };
      });
    jest.spyOn(storageService, 'headInternalObject').mockResolvedValue(true);

    // Setup Test Users
    const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userRes = await dataSource.query(`
      INSERT INTO users (email, password_hash, username, role)
      VALUES ('mat_owner_${runId}@omninovel.test', 'hash', 'mat_owner_${runId}', '${GlobalRole.READER}')
      RETURNING id;
    `);
    ownerId = userRes[0].id;
    ownerToken = jwtService.sign({ sub: ownerId, role: GlobalRole.READER });

    const uploaderRes = await dataSource.query(`
      INSERT INTO users (email, password_hash, username, role)
      VALUES ('mat_uploader_${runId}@omninovel.test', 'hash', 'mat_uploader_${runId}', '${GlobalRole.READER}')
      RETURNING id;
    `);
    uploaderId = uploaderRes[0].id;
    uploaderToken = jwtService.sign({ sub: uploaderId, role: GlobalRole.READER });

    // Setup COMIC Story
    const cStoryRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, original_language, media_format, publication_format, status, visibility, created_by)
      VALUES ('Materialize Comic', 'materialize-comic-${Date.now()}', 'https://example.com/cover.webp', 'ja', '${MediaFormat.COMIC}', '${PublicationFormat.MANGA}', '${StoryStatus.ONGOING}', '${StoryVisibility.PUBLIC}', '${ownerId}')
      RETURNING id;
    `);
    comicStoryId = cStoryRes[0].id;

    const cEditionRes = await dataSource.query(`
      INSERT INTO story_editions (story_id, edition_name, language, is_default)
      VALUES ('${comicStoryId}', 'Comic Raw Edition', 'ja', true)
      RETURNING id;
    `);
    comicEditionId = cEditionRes[0].id;

    await dataSource.query(`
      INSERT INTO story_members (story_id, user_id, role)
      VALUES 
        ('${comicStoryId}', '${ownerId}', '${StoryMemberRole.OWNER}'),
        ('${comicStoryId}', '${uploaderId}', '${StoryMemberRole.UPLOADER}');
    `);

    const cChapterRes = await dataSource.query(`
      INSERT INTO chapters (story_edition_id, chapter_number, title)
      VALUES ('${comicEditionId}', 1, 'Comic Chapter 1')
      RETURNING id;
    `);
    comicChapterId = cChapterRes[0].id;

    const cVersionRes = await dataSource.query(`
      INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, created_by)
      VALUES ('${comicChapterId}', 1, 'RAW_ORIGINAL', 'ja', '${ownerId}')
      RETURNING id;
    `);
    comicVersionId = cVersionRes[0].id;

    const cProjectRes = await dataSource.query(`
      INSERT INTO translation_projects (story_edition_id, source_language, target_language, created_by)
      VALUES ('${comicEditionId}', 'ja', 'vi', '${ownerId}')
      RETURNING id;
    `);
    comicProjectId = cProjectRes[0].id;

    // Setup NOVEL Story
    const nStoryRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, original_language, media_format, publication_format, status, visibility, created_by)
      VALUES ('Materialize Novel', 'materialize-novel-${Date.now()}', 'https://example.com/cover.webp', 'ja', '${MediaFormat.NOVEL}', '${PublicationFormat.WEB_NOVEL}', '${StoryStatus.ONGOING}', '${StoryVisibility.PUBLIC}', '${ownerId}')
      RETURNING id;
    `);
    novelStoryId = nStoryRes[0].id;

    const nEditionRes = await dataSource.query(`
      INSERT INTO story_editions (story_id, edition_name, language, is_default)
      VALUES ('${novelStoryId}', 'Novel Raw Edition', 'ja', true)
      RETURNING id;
    `);
    novelEditionId = nEditionRes[0].id;

    await dataSource.query(`
      INSERT INTO story_members (story_id, user_id, role)
      VALUES 
        ('${novelStoryId}', '${ownerId}', '${StoryMemberRole.OWNER}'),
        ('${novelStoryId}', '${uploaderId}', '${StoryMemberRole.UPLOADER}');
    `);

    const nChapterRes = await dataSource.query(`
      INSERT INTO chapters (story_edition_id, chapter_number, title)
      VALUES ('${novelEditionId}', 1, 'Novel Chapter 1')
      RETURNING id;
    `);
    novelChapterId = nChapterRes[0].id;

    const nVersionRes = await dataSource.query(`
      INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, created_by)
      VALUES ('${novelChapterId}', 1, 'RAW_ORIGINAL', 'ja', '${ownerId}')
      RETURNING id;
    `);
    novelVersionId = nVersionRes[0].id;

    const nProjectRes = await dataSource.query(`
      INSERT INTO translation_projects (story_edition_id, source_language, target_language, created_by)
      VALUES ('${novelEditionId}', 'ja', 'vi', '${ownerId}')
      RETURNING id;
    `);
    novelProjectId = nProjectRes[0].id;
  });

  afterAll(async () => {
    const storyIds = [comicStoryId, novelStoryId].filter(Boolean);
    if (storyIds.length > 0 && dataSource?.isInitialized) {
      await dataSource.query(
        `DELETE FROM stories WHERE id IN (${storyIds.map((id) => `'${id}'`).join(',')})`,
      );
    }
    const userIds = [ownerId, uploaderId].filter(Boolean);
    if (userIds.length > 0 && dataSource?.isInitialized) {
      await dataSource.query(
        `DELETE FROM users WHERE id IN (${userIds.map((id) => `'${id}'`).join(',')})`,
      );
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Reset comic job
    await dataSource.query(
      `DELETE FROM translation_jobs WHERE project_id IN ('${comicProjectId}', '${novelProjectId}')`,
    );

    const cJobRes = await dataSource.query(`
      INSERT INTO translation_jobs (
        project_id, source_version_id,
        status, review_revision, materialized_revision,
        result_manifest, created_by
      )
      VALUES (
        '${comicProjectId}', '${comicVersionId}',
        '${TranslationJobStatus.READY_FOR_REVIEW}', 2, 1,
        '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/c1/materializations/rev-1/pages/p1.webp", "previewKey": "ai/jobs/c1/materializations/rev-1/pages/p1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}], "cleanBases": [{"page": 1, "cleanBaseKey": "ai/jobs/c1/clean/p1.webp"}]}',
        '${ownerId}'
      )
      RETURNING id;
    `);
    comicJobId = cJobRes[0].id;

    // Insert Comic Segments with integer bbox
    await dataSource.query(`
      INSERT INTO translation_segments (
        job_id, page_number, sort_order, raw_text, translated_text,
        bbox_x, bbox_y, bbox_w, bbox_h, version
      )
      VALUES 
        ('${comicJobId}', 1, 1, 'こんにちは', 'Xin chào', 10, 20, 100, 50, 1),
        ('${comicJobId}', 1, 2, '世界', 'Thế giới', 15, 80, 120, 60, 2);
    `);

    // Reset novel job
    const nJobRes = await dataSource.query(`
      INSERT INTO translation_jobs (
        project_id, source_version_id,
        status, review_revision, materialized_revision,
        result_manifest, created_by
      )
      VALUES (
        '${novelProjectId}', '${novelVersionId}',
        '${TranslationJobStatus.READY_FOR_REVIEW}', 2, 1,
        '{"version": 1, "mediaFormat": "NOVEL", "title": "Tiểu thuyết test", "language": "vi", "htmlKey": "ai/jobs/n1/materializations/rev-1/content.html", "htmlFileSizeBytes": 12345, "segmentCount": 1, "charCount": 100, "qa": {"passed": true, "score": 0.95, "fingerprintMatch": true, "issuesCount": 0}, "metrics": {"totalBlocks": 10, "totalBatches": 2, "glossaryHits": 5}}',
        '${ownerId}'
      )
      RETURNING id;
    `);
    novelJobId = nJobRes[0].id;

    // Insert Novel Segments
    await dataSource.query(`
      INSERT INTO translation_segments (
        job_id, sort_order, raw_text, translated_text,
        anchor_block_id, block_type, version
      )
      VALUES 
        ('${novelJobId}', 1, 'Novel line 1', 'Dòng tiểu thuyết 1', 'blk-1', '${NovelBlockType.NARRATION}', 1);
    `);
  });

  describe('1. Request Materialization Endpoint (POST /api/v1/ai/jobs/:id/materializations)', () => {
    it('should reject with 403 when user is UPLOADER (only OWNER, EDITOR, TRANSLATOR, ADMIN allowed)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject with 409 NOT_REVIEWABLE when job is not READY_FOR_REVIEW', async () => {
      await dataSource.query(`
        UPDATE translation_jobs SET status = '${TranslationJobStatus.TRANSLATING}' WHERE id = '${comicJobId}'
      `);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_REVIEWABLE');
    });

    it('should return 200 ALREADY_FRESH when materializedRevision === reviewRevision', async () => {
      await dataSource.query(`
        UPDATE translation_jobs SET materialized_revision = 2, review_revision = 2 WHERE id = '${comicJobId}'
      `);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ALREADY_FRESH',
        targetRevision: 2,
      });
    });

    it('should reject with 409 REVISION_INVARIANT_VIOLATION when materializedRevision > reviewRevision', async () => {
      await dataSource.query(`
        UPDATE translation_jobs SET materialized_revision = 5, review_revision = 2 WHERE id = '${comicJobId}'
      `);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVISION_INVARIANT_VIOLATION');
    });

    it('should succeed with 202 ENQUEUED and upload content-addressed snapshot with geometry for Comic', async () => {
      const uploadSpy = jest.spyOn(storageService, 'uploadInternalBuffer');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        status: 'ENQUEUED',
        targetRevision: 2,
      });

      expect(uploadSpy).toHaveBeenCalled();
      const [key, buffer] = uploadSpy.mock.calls[0];
      expect(key).toMatch(
        new RegExp(
          `^ai/jobs/${comicJobId}/materializations/rev-2/snapshots/[a-f0-9]{64}\\.json$`,
        ),
      );

      const parsedSnapshot = JSON.parse(buffer.toString('utf-8'));
      expect(parsedSnapshot.version).toBe(1);
      expect(parsedSnapshot.jobId).toBe(comicJobId);
      expect(parsedSnapshot.targetRevision).toBe(2);
      expect(parsedSnapshot.mediaFormat).toBe('COMIC');
      expect(parsedSnapshot.segments).toHaveLength(2);
      expect(parsedSnapshot.segments[0].bboxX).toBe(10);
      expect(parsedSnapshot.segments[0].bboxY).toBe(20);
      expect(parsedSnapshot.segments[0].bboxW).toBe(100);
      expect(parsedSnapshot.segments[0].bboxH).toBe(50);
    });

    it('should coalesce concurrent duplicate requests to ALREADY_ENQUEUED without creating duplicate BullMQ jobs', async () => {
      // First request
      const res1 = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res1.status).toBe(202);
      expect(res1.body.status).toBe('ENQUEUED');

      // Second immediate request
      const res2 = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res2.status).toBe(202);
      expect(res2.body.status).toBe('ALREADY_ENQUEUED');
      expect(res2.body.targetRevision).toBe(2);

      // Verify BullMQ job count
      const bullJob = await materializationQueue.getJob(
        `materialize-${comicJobId}-2`,
      );
      expect(bullJob).toBeDefined();
    });
  });

  describe('2. Completion Callback Endpoint (POST /internal/v1/ai/jobs/:id/materializations/complete)', () => {
    it('should reject with 401 when X-Internal-Service-Key is missing or wrong', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', 'wrong-key')
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(401);
    });

    it('should reject with 400 when mediaFormat does not match story format', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'NOVEL',
          result: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: `ai/jobs/${comicJobId}/materializations/rev-2/content.html`,
            htmlFileSizeBytes: 12345,
            segmentCount: 1,
            charCount: 100,
            qa: { passed: true, score: 95 },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('MEDIA_FORMAT_MISMATCH');
    });

    it('should fast-discard STALE callback without calling storage stat/head', async () => {
      const statSpy = jest.spyOn(storageService, 'statInternalObject');
      statSpy.mockClear();

      // Target revision 1 while current reviewRevision is 2
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 1, // Stale!
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-1/pages/p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-1/pages/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('STALE_DISCARDED');
      expect(statSpy).not.toHaveBeenCalled();
    });

    it('should return ALREADY_APPLIED when targetRevision === materializedRevision with identical result without storage calls', async () => {
      const statSpy = jest.spyOn(storageService, 'statInternalObject');
      statSpy.mockClear();

      // Set materialized_revision = 2, review_revision = 2
      await dataSource.query(`
        UPDATE translation_jobs 
        SET materialized_revision = 2,
            review_revision = 2,
            result_manifest = '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/${comicJobId}/materializations/rev-2/p1.webp", "previewKey": "ai/jobs/${comicJobId}/materializations/rev-2/p1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}]}'
        WHERE id = '${comicJobId}'
      `);

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ALREADY_APPLIED');
      expect(statSpy).not.toHaveBeenCalled();
    });

    it('should throw 409 MATERIALIZATION_RESULT_CONFLICT when already materialized with different result', async () => {
      await dataSource.query(`
        UPDATE translation_jobs 
        SET materialized_revision = 2,
            review_revision = 2,
            result_manifest = '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/${comicJobId}/materializations/rev-2/p1.webp", "previewKey": "ai/jobs/${comicJobId}/materializations/rev-2/p1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}]}'
        WHERE id = '${comicJobId}'
      `);

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/different-p1.webp`, // Different!
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/different-p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MATERIALIZATION_RESULT_CONFLICT');
    });

    it('should reject with 400 PREFIX_JAIL_VIOLATION if artifact keys escape revision prefix', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/other-job/materializations/rev-2/p1.webp`, // Escaping job prefix!
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('PREFIX_JAIL_VIOLATION');
    });

    it('should reject with 400 ARTIFACT_NOT_FOUND_IN_STORAGE when file does not exist in MinIO', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/missing-p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/missing-p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('ARTIFACT_NOT_FOUND_IN_STORAGE');
    });

    it('should reject with 400 ARTIFACT_SIZE_MISMATCH when storage ContentLength !== fileSizeBytes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/size-mismatch-p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/size-mismatch-p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ARTIFACT_SIZE_MISMATCH');
    });

    it('should successfully complete COMIC materialization: APPLIED, merge selective pages and advance materializedRevision', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        outcome: 'APPLIED',
        targetRevision: 2,
        materializedRevision: 2,
      });

      // Verify DB state
      const dbJob = await dataSource.query(`
        SELECT materialized_revision, result_manifest FROM translation_jobs WHERE id = '${comicJobId}'
      `);
      expect(dbJob[0].materialized_revision).toBe(2);
      const manifest = dbJob[0].result_manifest;
      expect(manifest.version).toBe(1);
      expect(manifest.pages).toHaveLength(1);
      expect(manifest.pages[0].storageKey).toBe(
        `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
      );
      // CleanBases preserved!
      expect(manifest.cleanBases).toBeDefined();
      expect(manifest.cleanBases[0].cleanBaseKey).toBe('ai/jobs/c1/clean/p1.webp');
    });

    it('should successfully complete NOVEL materialization: APPLIED, merge HTML and preserve title/assets/metrics', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'NOVEL',
          result: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: `ai/jobs/${novelJobId}/materializations/rev-2/content.html`,
            htmlFileSizeBytes: 12345,
            segmentCount: 1,
            charCount: 150,
            qa: { passed: true, score: 0.98, fingerprintMatch: true, issuesCount: 0 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        outcome: 'APPLIED',
        targetRevision: 2,
        materializedRevision: 2,
      });

      // Verify DB state
      const dbJob = await dataSource.query(`
        SELECT materialized_revision, result_manifest FROM translation_jobs WHERE id = '${novelJobId}'
      `);
      expect(dbJob[0].materialized_revision).toBe(2);
      const manifest = dbJob[0].result_manifest;
      expect(manifest.version).toBe(1);
      expect(manifest.htmlKey).toBe(
        `ai/jobs/${novelJobId}/materializations/rev-2/content.html`,
      );
      expect(manifest.charCount).toBe(150);
      expect(manifest.metrics).toEqual({
        totalBlocks: 10,
        totalBatches: 2,
        glossaryHits: 5,
      });
    });

    it('should unlock applyJob() after materialization completion (no longer ARTIFACT_STALE)', async () => {
      // 1. Before materialization: applyJob should fail with 409 ARTIFACT_STALE
      const failApply = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'a0000000-0000-4000-8000-000000000001')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(failApply.status).toBe(409);
      expect(failApply.body.error.code).toBe('ARTIFACT_STALE');

      // 2. Complete materialization to revision 2
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'COMIC',
          result: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/pages/p1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      // 3. After materialization: applyJob should succeed with 200 OK!
      const okApply = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'a0000000-0000-4000-8000-000000000002')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(okApply.status).toBe(200);
      expect(okApply.body.chapterId).toBe(comicChapterId);
      expect(okApply.body.activeVersionId).toBeDefined();
    });
  });
});
