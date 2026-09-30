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
import { TranslationMaterializationProcessor } from '../src/modules/translation/translation-materialization.processor';

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
  let comicArtifactId: string;
  let novelArtifactId: string;

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

    dataSource = app.get<DataSource>(DataSource);
    jwtService = app.get<JwtService>(JwtService);
    storageService = app.get<StorageService>(StorageService);
    materializationQueue = app.get<Queue>(
      getQueueToken('translation-materialization'),
    );

    // Mock storageService helpers
    jest.spyOn(storageService, 'uploadInternalBuffer').mockResolvedValue();
    jest.spyOn(storageService, 'deleteInternalObject').mockResolvedValue();
    jest.spyOn(storageService, 'deleteInternalPrefix').mockResolvedValue();
    jest
      .spyOn(storageService, 'createInternalDownloadUrl')
      .mockResolvedValue('https://minio.local/get/file');
    jest
      .spyOn(storageService, 'createInternalUploadUrl')
      .mockResolvedValue('https://minio.local/put/file');
    jest
      .spyOn(storageService, 'statInternalObject')
      .mockImplementation(async (key: string) => {
        if (key.includes('missing')) {
          return { exists: false, contentLength: null };
        }
        if (key.includes('size-mismatch')) {
          return { exists: true, contentLength: 999999, contentType: 'image/webp' };
        }
        if (key.includes('invalid-mime')) {
          return { exists: true, contentLength: 12345, contentType: 'image/png' };
        }
        const isHtml = key.endsWith('.html') || key.includes('content.html');
        return {
          exists: true,
          contentLength: 12345,
          contentType: isHtml ? 'text/html; charset=utf-8' : 'image/webp',
        };
      });
    jest.spyOn(storageService, 'headInternalObject').mockResolvedValue(true);

    // Default global.fetch mock to handle background BullMQ worker jobs gracefully
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'COMPLETED' }),
      text: async () => '',
    });

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

    const cArtRes = await dataSource.query(`
      INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
      VALUES ('${comicVersionId}', 'TRANSLATION_SOURCE', 'READY')
      RETURNING id;
    `);
    comicArtifactId = cArtRes[0].id;

    const nArtRes = await dataSource.query(`
      INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
      VALUES ('${novelVersionId}', 'TRANSLATION_SOURCE', 'READY')
      RETURNING id;
    `);
    novelArtifactId = nArtRes[0].id;
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
        project_id, source_version_id, source_artifact_id,
        status, review_revision, materialized_revision,
        result_manifest, created_by
      )
      VALUES (
        '${comicProjectId}', '${comicVersionId}', '${comicArtifactId}',
        '${TranslationJobStatus.READY_FOR_REVIEW}', 2, 1,
        '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/c1/materializations/rev-1/page_1.webp", "previewKey": "ai/jobs/c1/materializations/rev-1/page_1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}], "cleanBases": [{"page": 1, "cleanBaseKey": "ai/jobs/c1/clean/p1.webp"}], "sourceReview": {"version": 1, "pages": [{"page": 1, "storageKey": "ai/jobs/c1/source_reviews/page_0001.webp", "width": 1000, "height": 1500}]}}',
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
        project_id, source_version_id, source_artifact_id,
        status, review_revision, materialized_revision,
        result_manifest, created_by
      )
      VALUES (
        '${novelProjectId}', '${novelVersionId}', '${novelArtifactId}',
        '${TranslationJobStatus.READY_FOR_REVIEW}', 2, 1,
        '{"version": 1, "mediaFormat": "NOVEL", "title": "Tiểu thuyết test", "language": "vi", "htmlKey": "ai/jobs/n1/materializations/rev-1/content.html", "htmlFileSizeBytes": 12345, "segmentCount": 1, "charCount": 100, "qa": {"passed": true, "score": 0.95, "fingerprintMatch": true, "issuesCount": 0}, "metrics": {"totalBlocks": 10, "totalBatches": 2, "glossaryHits": 5}, "structureSnapshot": {"version": 1, "sha256": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890", "storageKey": "ai/jobs/n1/structure/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890.json", "sourceStructureFingerprint": "sha256:f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2", "segmenterVersion": "1.0.0"}}',
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

    it('should coalesce concurrent duplicate requests to BullMQ without creating duplicate BullMQ jobs', async () => {
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
          .set('Authorization', `Bearer ${ownerToken}`),
        request(app.getHttpServer())
          .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
          .set('Authorization', `Bearer ${ownerToken}`),
      ]);

      expect([res1.status, res2.status]).toEqual([202, 202]);
      expect([res1.body.status, res2.body.status]).toEqual(
        expect.arrayContaining([expect.stringMatching(/ENQUEUED|ALREADY_ENQUEUED/)]),
      );
      expect([res1.body.targetRevision, res2.body.targetRevision]).toEqual([2, 2]);

      // Verify BullMQ job count is exactly 1
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

      // Set materializedRevision = 2 and reviewRevision = 3 so targetRevision 1 is truly stale (< materializedRevision)
      await dataSource.query(`
        UPDATE translation_jobs 
        SET materialized_revision = 2, review_revision = 3 
        WHERE id = '${comicJobId}'
      `);

      // Target revision 1 while materializedRevision is 2 and reviewRevision is 3
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 1, // Stale (< 2)!
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
            result_manifest = '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp", "previewKey": "ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}]}'
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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
            result_manifest = '{"version": 1, "mediaFormat": "COMIC", "pages": [{"page": 1, "storageKey": "ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp", "previewKey": "ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp", "width": 1000, "height": 1500, "fileSizeBytes": 12345}]}'
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                width: 2000, // Different width causes conflict!
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
                storageKey: `ai/jobs/other-job/materializations/rev-2/page_1.webp`, // Escaping job prefix!
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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

    it('should reject with 400 PREFIX_JAIL_VIOLATION if storageKey points to snapshot JSON', async () => {
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/snapshots/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.json`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/snapshots/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.json`,
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

    it('should reject with 400 PREFIX_JAIL_VIOLATION if storageKey has non-canonical filename or extension', async () => {
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.png`, // Wrong extension!
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.png`,
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

    it('should reject with 400 PREFIX_JAIL_VIOLATION if storageKey has nested subpath traversal', async () => {
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/sub/page_1.webp`, // Nested subpath!
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/sub/page_1.webp`,
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

    it('should reject with 400 PREFIX_JAIL_VIOLATION if previewKey does not match storageKey', async () => {
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_2.webp`, // Mismatch!
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

    it('should reject with 400 ARTIFACT_INVALID_CONTENT_TYPE when MinIO Content-Type is not image/webp', async () => {
      jest.spyOn(storageService, 'statInternalObject').mockResolvedValueOnce({
        exists: true,
        contentLength: 12345,
        contentType: 'image/png',
      });

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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ARTIFACT_INVALID_CONTENT_TYPE');
    });

    it('should reject with 400 ARTIFACT_NOT_FOUND_IN_STORAGE when file does not exist in MinIO', async () => {
      jest.spyOn(storageService, 'statInternalObject').mockResolvedValueOnce({
        exists: false,
        contentLength: null,
      });

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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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
      jest.spyOn(storageService, 'statInternalObject').mockResolvedValueOnce({
        exists: true,
        contentLength: 999999,
        contentType: 'image/webp',
      });

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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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

    it('should successfully complete COMIC materialization: APPLIED, merge selective pages, advance revision, and preserve BOTH cleanBases and sourceReview', async () => {
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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
        `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
      );
      // CleanBases preserved byte-for-byte!
      expect(manifest.cleanBases).toBeDefined();
      expect(manifest.cleanBases[0].cleanBaseKey).toBe('ai/jobs/c1/clean/p1.webp');
      // sourceReview preserved byte-for-byte!
      expect(manifest.sourceReview).toBeDefined();
      expect(manifest.sourceReview.pages[0].storageKey).toBe('ai/jobs/c1/source_reviews/page_0001.webp');
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
      // Invariant #158: structureSnapshot must be preserved!
      expect(manifest.structureSnapshot).toBeDefined();
      expect(manifest.structureSnapshot.sha256).toBe(
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      );
      expect(manifest.structureSnapshot.sourceStructureFingerprint).toBe(
        'sha256:f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6f7f8f9f0f1f2',
      );
    });

    it('should retain structureSnapshot across consecutive materialization revisions (rev 2 -> rev 3) (#158)', async () => {
      // Complete rev 2 first
      const resRev2 = await request(app.getHttpServer())
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
      expect(resRev2.status).toBe(200);

      // Now reviewer edits another segment, advancing review_revision to 3
      await dataSource.query(`
        UPDATE translation_jobs
        SET review_revision = 3
        WHERE id = '${novelJobId}'
      `);

      // Complete rev 3
      const resRev3 = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 3,
          mediaFormat: 'NOVEL',
          result: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: `ai/jobs/${novelJobId}/materializations/rev-3/content.html`,
            htmlFileSizeBytes: 12345,
            segmentCount: 1,
            charCount: 160,
            qa: { passed: true, score: 0.99, fingerprintMatch: true, issuesCount: 0 },
          },
        });

      expect(resRev3.status).toBe(200);
      expect(resRev3.body).toEqual({
        outcome: 'APPLIED',
        targetRevision: 3,
        materializedRevision: 3,
      });

      const dbJob = await dataSource.query(`
        SELECT materialized_revision, result_manifest FROM translation_jobs WHERE id = '${novelJobId}'
      `);
      expect(dbJob[0].materialized_revision).toBe(3);
      const manifest = dbJob[0].result_manifest;
      expect(manifest.htmlKey).toBe(
        `ai/jobs/${novelJobId}/materializations/rev-3/content.html`,
      );
      // structureSnapshot must still be preserved identically!
      expect(manifest.structureSnapshot).toBeDefined();
      expect(manifest.structureSnapshot.sha256).toBe(
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      );
    });

    it('should reject Novel materialization callback with 400 PREFIX_JAIL_VIOLATION when htmlKey is not exact canonical key (#158)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 2,
          mediaFormat: 'NOVEL',
          result: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: `ai/jobs/${novelJobId}/materializations/rev-2/custom_output.html`,
            htmlFileSizeBytes: 12345,
            segmentCount: 1,
            charCount: 150,
            qa: { passed: true, score: 0.98, fingerprintMatch: true, issuesCount: 0 },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('PREFIX_JAIL_VIOLATION');
    });

    it('should reject Novel materialization callback with 400 ARTIFACT_INVALID_CONTENT_TYPE when MinIO Content-Type is not text/html; charset=utf-8 (#158)', async () => {
      jest.spyOn(storageService, 'statInternalObject').mockResolvedValueOnce({
        exists: true,
        contentLength: 12345,
        contentType: 'text/html', // missing charset=utf-8!
      });

      const failRes = await request(app.getHttpServer())
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

      expect(failRes.status).toBe(400);
      expect(failRes.body.error.code).toBe('ARTIFACT_INVALID_CONTENT_TYPE');
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
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

    it('should handle concurrent conflicting materialization completions under FOR UPDATE: exactly one APPLIED (200), other 409 MATERIALIZATION_RESULT_CONFLICT', async () => {
      // Barrier so both requests pass preflight & storage check before either enters the DB transaction
      let releaseBarrier: () => void;
      const barrierPromise = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let statCalls = 0;

      const statSpy = jest
        .spyOn(storageService, 'statInternalObject')
        .mockImplementation(async (key: string) => {
          if (key.includes('page_1.webp')) {
            statCalls++;
            if (statCalls === 2) {
              releaseBarrier();
            }
            await barrierPromise;
            return { exists: true, contentLength: 12345, contentType: 'image/webp' };
          }
          if (key.includes('missing')) {
            return { exists: false, contentLength: null };
          }
          if (key.includes('size-mismatch')) {
            return { exists: true, contentLength: 999999, contentType: 'image/webp' };
          }
          return { exists: true, contentLength: 12345, contentType: 'image/webp' };
        });

      try {
        const reqA = request(app.getHttpServer())
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
                  storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                  previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                  width: 1000,
                  height: 1500,
                  fileSizeBytes: 12345,
                },
              ],
            },
          });

        const reqB = request(app.getHttpServer())
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
                  storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                  previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                  width: 2000,
                  height: 1500,
                  fileSizeBytes: 12345,
                },
              ],
            },
          });

        const [resA, resB] = await Promise.all([reqA, reqB]);

        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([200, 409]);

        const successRes = resA.status === 200 ? resA : resB;
        const conflictRes = resA.status === 409 ? resA : resB;

        expect(successRes.body.outcome).toBe('APPLIED');
        expect(conflictRes.body.error.code).toBe('MATERIALIZATION_RESULT_CONFLICT');

        // Verify DB state matches the winner
        const dbJob = await dataSource.query(`
          SELECT result_manifest FROM translation_jobs WHERE id = '${comicJobId}'
        `);
        const winningWidth = resA.status === 200 ? 1000 : 2000;
        expect(dbJob[0].result_manifest.pages[0].width).toBe(winningWidth);
        expect(dbJob[0].result_manifest.pages[0].storageKey).toBe(
          `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
        );
      } finally {
        statSpy.mockImplementation(async (key: string) => {
          if (key.includes('missing')) {
            return { exists: false, contentLength: null };
          }
          if (key.includes('size-mismatch')) {
            return { exists: true, contentLength: 999999, contentType: 'image/webp' };
          }
          if (key.includes('invalid-mime')) {
            return { exists: true, contentLength: 12345, contentType: 'image/png' };
          }
          const isHtml = key.endsWith('.html') || key.includes('content.html');
          return {
            exists: true,
            contentLength: 12345,
            contentType: isHtml ? 'text/html; charset=utf-8' : 'image/webp',
          };
        });
      }
    });

    it('should return 200 ALREADY_APPLIED for duplicate callback even after Job status is APPLIED without storage calls', async () => {
      // 1. Complete materialization to revision 2
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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      // 2. Apply the job -> status becomes APPLIED
      const applyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'a0000000-0000-4000-8000-000000000099')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });
      expect(applyRes.status).toBe(200);

      const dbCheck = await dataSource.query(`
        SELECT status, materialized_revision FROM translation_jobs WHERE id = '${comicJobId}'
      `);
      expect(dbCheck[0].status).toBe(TranslationJobStatus.APPLIED);
      expect(dbCheck[0].materialized_revision).toBe(2);

      // 3. Duplicate callback for rev 2 arrives after Job is APPLIED
      const statSpy = jest.spyOn(storageService, 'statInternalObject');
      statSpy.mockClear();

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
                storageKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                previewKey: `ai/jobs/${comicJobId}/materializations/rev-2/page_1.webp`,
                width: 1000,
                height: 1500,
                fileSizeBytes: 12345,
              },
            ],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ALREADY_APPLIED');
      expect(res.body.targetRevision).toBe(2);
      expect(statSpy).not.toHaveBeenCalled();
    });

    it('should throw 409 MATERIALIZATION_RESULT_CONFLICT when novel callback has different qa.issues', async () => {
      // Seed novel job already materialized at rev 2 with qa issues
      await dataSource.query(`
        UPDATE translation_jobs
        SET materialized_revision = 2,
            review_revision = 2,
            result_manifest = '{"version": 1, "mediaFormat": "NOVEL", "title": "Tiểu thuyết test", "language": "vi", "htmlKey": "ai/jobs/${novelJobId}/materializations/rev-2/content.html", "htmlFileSizeBytes": 12345, "segmentCount": 1, "charCount": 150, "qa": {"passed": true, "score": 0.98, "fingerprintMatch": true, "issuesCount": 1, "issues": [{"severity": "warning", "ruleId": "GLOSSARY_MISS", "message": "Missing glossary term"}]}}'
        WHERE id = '${novelJobId}'
      `);

      // Attempt complete callback with same scalar fields but DIFFERENT qa.issues
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
            qa: {
              passed: true,
              score: 0.98,
              fingerprintMatch: true,
              issuesCount: 1,
              issues: [
                {
                  severity: 'error', // Different severity!
                  ruleId: 'GLOSSARY_MISS',
                  message: 'Missing glossary term',
                },
              ],
            },
          },
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MATERIALIZATION_RESULT_CONFLICT');
    });

    it('should reject with 400 when novel materialization callback has unknown keys inside qa.issues (#161, #171 Finding A)', async () => {
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
            qa: {
              passed: true,
              score: 0.98,
              fingerprintMatch: true,
              issuesCount: 1,
              issues: [
                {
                  severity: 'warning',
                  ruleId: 'GLOSSARY_MISS',
                  message: 'Missing glossary term',
                  unexpectedInternalField: 'should_be_rejected',
                },
              ],
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('unexpectedInternalField');
    });

    it('should reject with 400 even on idempotent ALREADY_APPLIED targetRevision path when qa.issues has unknown keys or is malformed (#161, #171 Finding A)', async () => {
      // Seed novel job already materialized at rev 2
      await dataSource.query(`
        UPDATE translation_jobs
        SET materialized_revision = 2,
            review_revision = 2,
            result_manifest = '{"version": 1, "mediaFormat": "NOVEL", "title": "Tiểu thuyết test", "language": "vi", "htmlKey": "ai/jobs/${novelJobId}/materializations/rev-2/content.html", "htmlFileSizeBytes": 12345, "segmentCount": 1, "charCount": 150, "qa": {"passed": true, "score": 0.98, "fingerprintMatch": true, "issuesCount": 1, "issues": [{"severity": "warning", "ruleId": "GLOSSARY_MISS", "message": "Missing glossary term"}]}}'
        WHERE id = '${novelJobId}'
      `);

      // Callback arrives with targetRevision 2 (which would otherwise hit ALREADY_APPLIED early return), but has unknown key in qa.issues
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
            qa: {
              passed: true,
              score: 0.98,
              fingerprintMatch: true,
              issuesCount: 1,
              issues: [
                {
                  severity: 'warning',
                  ruleId: 'GLOSSARY_MISS',
                  message: 'Missing glossary term',
                  forbiddenPayloadField: 'attacker_controlled',
                },
              ],
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('forbiddenPayloadField');
    });
  });

  describe('3. RED 9: Cross-Service Full E2E Flow (#157)', () => {
    it('should complete full cycle: segment edited -> apply blocked (stale) -> materialization queued -> processor executed -> callback completed -> apply succeeded', async () => {
      // 0. Setup AI Worker dispatch mock ahead of enqueuing
      const mockWorkerFetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('/internal/v1/jobs/materialize-manga')) {
          const body = JSON.parse(opts.body);
          // Worker renders and invokes the Core API complete callback
          const cbRes = await request(app.getHttpServer())
            .post(`/internal/v1/ai/jobs/${comicJobId}/materializations/complete`)
            .set('X-Internal-Service-Key', INTERNAL_KEY)
            .send({
              targetRevision: body.targetRevision,
              mediaFormat: 'COMIC',
              result: {
                version: 1,
                mediaFormat: 'COMIC',
                pages: body.pages.map((p: any) => ({
                  page: p.pageNumber,
                  storageKey: p.storageKey,
                  previewKey: p.storageKey,
                  width: 1000,
                  height: 1500,
                  fileSizeBytes: 12345,
                })),
              },
            });
          expect(cbRes.status).toBe(200);
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'COMPLETED' }),
          };
        }
        return { ok: false, status: 404 };
      });
      (global as any).fetch = mockWorkerFetch;

      // 1. Current comicJobId: review_revision = 2, materialized_revision = 1
      // Freshness Gate: Apply must be blocked (409 ARTIFACT_STALE)
      const staleApplyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'b0000000-0000-4000-8000-000000000001')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(staleApplyRes.status).toBe(409);
      expect(staleApplyRes.body.error.code).toBe('ARTIFACT_STALE');

      // 2. Request materialization
      const matReqRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(matReqRes.status).toBe(202);
      expect(matReqRes.body.status).toBe('ENQUEUED');
      expect(matReqRes.body.targetRevision).toBe(2);

      // 3. Get the queued BullMQ job
      const bullJob = await materializationQueue.getJob(
        `materialize-${comicJobId}-2`,
      );
      expect(bullJob).toBeDefined();

      // 4. Ensure processor execution has completed (either via active worker or explicit invoke)
      let attempts = 0;
      while (attempts < 20) {
        const rows = await dataSource.query(
          `SELECT materialized_revision FROM translation_jobs WHERE id = '${comicJobId}'`,
        );
        if (rows[0]?.materialized_revision === 2) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      const checkRows = await dataSource.query(
        `SELECT materialized_revision FROM translation_jobs WHERE id = '${comicJobId}'`,
      );
      if (checkRows[0]?.materialized_revision !== 2) {
        const processor = app.get<TranslationMaterializationProcessor>(
          TranslationMaterializationProcessor,
        );
        await processor.process(bullJob!);
      }

      // 5. Verify DB state: materializedRevision === 2 === reviewRevision, cleanBases & sourceReview preserved
      const updatedJobs = await dataSource.query(
        `SELECT materialized_revision, review_revision, result_manifest FROM translation_jobs WHERE id = '${comicJobId}'`,
      );
      expect(updatedJobs[0].materialized_revision).toBe(2);
      expect(updatedJobs[0].review_revision).toBe(2);
      expect(updatedJobs[0].result_manifest.cleanBases).toBeDefined();
      expect(updatedJobs[0].result_manifest.cleanBases).toHaveLength(1);
      expect(updatedJobs[0].result_manifest.sourceReview).toBeDefined();

      // 6. Freshness Gate Unlocked: Apply now succeeds!
      const freshApplyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'b0000000-0000-4000-8000-000000000002')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(freshApplyRes.status).toBe(200);
      expect(freshApplyRes.body.isAlreadyApplied).toBe(false);

      // Verify job is now APPLIED
      const finalJobs = await dataSource.query(
        `SELECT status FROM translation_jobs WHERE id = '${comicJobId}'`,
      );
      expect(finalJobs[0].status).toBe(TranslationJobStatus.APPLIED);
    });

    it('should complete full cycle for NOVEL: segment edited -> apply blocked (stale) -> materialization queued -> processor executed -> callback completed -> apply succeeded (#158)', async () => {
      // 0. Setup AI Worker dispatch mock for materialize-novel
      const mockWorkerFetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('/internal/v1/jobs/materialize-novel')) {
          const body = JSON.parse(opts.body);
          expect(body.jobId).toBe(novelJobId);
          expect(body.targetRevision).toBe(2);
          expect(body.targetLanguage).toBe('vi');
          expect(body.outputStorageKey).toBe(
            `ai/jobs/${novelJobId}/materializations/rev-2/content.html`,
          );

          // Worker sends completion callback
          const cbRes = await request(app.getHttpServer())
            .post(`/internal/v1/ai/jobs/${novelJobId}/materializations/complete`)
            .set('X-Internal-Service-Key', INTERNAL_KEY)
            .send({
              targetRevision: body.targetRevision,
              mediaFormat: 'NOVEL',
              result: {
                version: 1,
                mediaFormat: 'NOVEL',
                htmlKey: body.outputStorageKey,
                htmlFileSizeBytes: 12345,
                segmentCount: 1,
                charCount: 100,
                qa: {
                  passed: true,
                  score: 1.0,
                  fingerprintMatch: true,
                  issuesCount: 0,
                  issues: [],
                },
              },
            });
          expect(cbRes.status).toBe(200);
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'COMPLETED' }),
          };
        }
        return { ok: false, status: 404 };
      });
      (global as any).fetch = mockWorkerFetch;

      // 1. Current novelJobId: review_revision = 2, materialized_revision = 1
      // Freshness Gate: Apply must be blocked (409 ARTIFACT_STALE)
      const staleApplyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${novelJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-8000-000000000001')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(staleApplyRes.status).toBe(409);
      expect(staleApplyRes.body.error.code).toBe('ARTIFACT_STALE');

      // 2. Request materialization
      const matReqRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${novelJobId}/materializations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(matReqRes.status).toBe(202);
      expect(matReqRes.body.status).toBe('ENQUEUED');
      expect(matReqRes.body.targetRevision).toBe(2);

      // 3. Get the queued BullMQ job
      const bullJob = await materializationQueue.getJob(
        `materialize-${novelJobId}-2`,
      );
      expect(bullJob).toBeDefined();

      // 4. Ensure processor execution has completed
      let attempts = 0;
      while (attempts < 20) {
        const rows = await dataSource.query(
          `SELECT materialized_revision FROM translation_jobs WHERE id = '${novelJobId}'`,
        );
        if (rows[0]?.materialized_revision === 2) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }

      const checkRows = await dataSource.query(
        `SELECT materialized_revision FROM translation_jobs WHERE id = '${novelJobId}'`,
      );
      if (checkRows[0]?.materialized_revision !== 2) {
        const processor = app.get<TranslationMaterializationProcessor>(
          TranslationMaterializationProcessor,
        );
        await processor.process(bullJob!);
      }

      // 5. Verify DB state: materializedRevision === 2 === reviewRevision, structureSnapshot preserved
      const updatedJobs = await dataSource.query(
        `SELECT materialized_revision, review_revision, result_manifest FROM translation_jobs WHERE id = '${novelJobId}'`,
      );
      expect(updatedJobs[0].materialized_revision).toBe(2);
      expect(updatedJobs[0].review_revision).toBe(2);
      expect(updatedJobs[0].result_manifest.htmlKey).toBe(
        `ai/jobs/${novelJobId}/materializations/rev-2/content.html`,
      );
      expect(updatedJobs[0].result_manifest.structureSnapshot).toBeDefined();
      expect(updatedJobs[0].result_manifest.structureSnapshot.version).toBe(1);

      // 6. Freshness Gate Unlocked: Apply now succeeds!
      const freshApplyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${novelJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-8000-000000000002')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });

      expect(freshApplyRes.status).toBe(200);
      expect(freshApplyRes.body.isAlreadyApplied).toBe(false);

      // Verify job is now APPLIED
      const finalJobs = await dataSource.query(
        `SELECT status FROM translation_jobs WHERE id = '${novelJobId}'`,
      );
      expect(finalJobs[0].status).toBe(TranslationJobStatus.APPLIED);
    });

    it('should handle in-flight revision race for NOVEL: rev 2 rebuild in flight, segment edited to rev 3, rev 2 callback discarded as STALE_DISCARDED, rev 3 materializes and unlocks apply (#158)', async () => {
      // 1. Advance reviewRevision from 2 to 3 (simulating user edit while rev 2 was in-flight)
      await dataSource.query(`
        UPDATE translation_jobs
        SET review_revision = 3, materialized_revision = 1, status = '${TranslationJobStatus.READY_FOR_REVIEW}'
        WHERE id = '${novelJobId}'
      `);

      // 2. In-flight Rev 2 callback arrives late
      const staleCallbackRes = await request(app.getHttpServer())
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
            charCount: 100,
            qa: {
              passed: true,
              score: 1.0,
              fingerprintMatch: true,
              issuesCount: 0,
              issues: [],
            },
          },
        });

      expect(staleCallbackRes.status).toBe(200);
      expect(staleCallbackRes.body.outcome).toBe('STALE_DISCARDED');

      // Verify DB materialized_revision remains 1 (did NOT advance to 2)
      const staleCheck = await dataSource.query(
        `SELECT materialized_revision, review_revision FROM translation_jobs WHERE id = '${novelJobId}'`,
      );
      expect(staleCheck[0].materialized_revision).toBe(1);
      expect(staleCheck[0].review_revision).toBe(3);

      // Apply must still be blocked (409 ARTIFACT_STALE)
      const staleApply = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${novelJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-8000-000000000003')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });
      expect(staleApply.status).toBe(409);
      expect(staleApply.body.error.code).toBe('ARTIFACT_STALE');

      // 3. Rev 3 callback completes
      const rev3CallbackRes = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/materializations/complete`)
        .set('X-Internal-Service-Key', INTERNAL_KEY)
        .send({
          targetRevision: 3,
          mediaFormat: 'NOVEL',
          result: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: `ai/jobs/${novelJobId}/materializations/rev-3/content.html`,
            htmlFileSizeBytes: 12345,
            segmentCount: 1,
            charCount: 110,
            qa: {
              passed: true,
              score: 1.0,
              fingerprintMatch: true,
              issuesCount: 0,
              issues: [],
            },
          },
        });

      expect(rev3CallbackRes.status).toBe(200);
      expect(rev3CallbackRes.body.outcome).toBe('APPLIED');

      // Verify DB materialized_revision is now 3
      const rev3Check = await dataSource.query(
        `SELECT materialized_revision, review_revision, result_manifest FROM translation_jobs WHERE id = '${novelJobId}'`,
      );
      expect(rev3Check[0].materialized_revision).toBe(3);
      expect(rev3Check[0].review_revision).toBe(3);
      expect(rev3Check[0].result_manifest.htmlKey).toBe(
        `ai/jobs/${novelJobId}/materializations/rev-3/content.html`,
      );
      expect(rev3Check[0].result_manifest.structureSnapshot).toBeDefined();

      // 4. Apply now succeeds!
      const freshApply = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${novelJobId}/apply`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-8000-000000000004')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' });
      expect(freshApply.status).toBe(200);
    });
  });
});



