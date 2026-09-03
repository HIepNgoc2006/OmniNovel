import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  GlobalRole,
  MediaFormat,
  StoryMemberRole,
  TranslationJobStatus,
} from '@omninovel/shared';

describe('Studio Concurrency & Review Mutation E2E (#147, #156)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  // Tokens
  let editorToken: string;
  let readerToken: string;

  // Resource IDs
  let storyId: string;
  let novelStoryId: string;
  let editionId: string;
  let novelEditionId: string;
  let chapterId: string;
  let novelChapterId: string;
  let sourceVersionId: string;
  let novelSourceVersionId: string;
  let projectId: string;
  let novelProjectId: string;

  let comicJobId: string;
  let seg1Id: string;
  let seg2Id: string;

  let novelJobId: string;
  let novelSegId: string;

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

    // 1. Seed Users
    const createTestUser = async (usernamePrefix: string, role: GlobalRole) => {
      const ts = Date.now();
      const res = await dataSource.query(
        `INSERT INTO users (username, email, password_hash, role, is_active)
         VALUES ($1, $2, 'hash', $3, true)
         RETURNING id, username, role`,
        [`${usernamePrefix}_${ts}`, `${usernamePrefix}_${ts}@example.com`, role],
      );
      const user = res[0];
      const token = jwtService.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      return { user, token };
    };

    const editor = await createTestUser('mut_editor', GlobalRole.TRANSLATOR);
    editorToken = editor.token;

    const reader = await createTestUser('mut_reader', GlobalRole.READER);
    readerToken = reader.token;

    // 2. Seed Comic Story & Project & Job
    const storyRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language, views_count)
      VALUES ('Mutation Comic', 'mutation-comic-${Date.now()}', 'https://example.com/comic.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja', 100)
      RETURNING id;
    `);
    storyId = storyRes[0].id;

    await dataSource.query(`
      INSERT INTO story_members (story_id, user_id, role)
      VALUES ('${storyId}', '${editor.user.id}', '${StoryMemberRole.EDITOR}');
    `);

    const editionRes = await dataSource.query(`
      INSERT INTO story_editions (story_id, edition_name, language, is_default)
      VALUES ('${storyId}', 'Original Edition', 'ja', true)
      RETURNING id;
    `);
    editionId = editionRes[0].id;

    const chapterRes = await dataSource.query(`
      INSERT INTO chapters (story_edition_id, chapter_number, title)
      VALUES ('${editionId}', 1.00, 'Chapter 1')
      RETURNING id;
    `);
    chapterId = chapterRes[0].id;

    const verRes = await dataSource.query(`
      INSERT INTO chapter_versions (chapter_id, version_number, version_type)
      VALUES ('${chapterId}', 1, 'RAW_ORIGINAL')
      RETURNING id;
    `);
    sourceVersionId = verRes[0].id;

    const projRes = await dataSource.query(`
      INSERT INTO translation_projects (story_edition_id, source_language, target_language)
      VALUES ('${editionId}', 'ja', 'vi')
      RETURNING id;
    `);
    projectId = projRes[0].id;

    // Comic Translation Job in READY_FOR_REVIEW
    const jobRes = await dataSource.query(`
      INSERT INTO translation_jobs (project_id, source_version_id, status, progress_percentage, review_revision, materialized_revision)
      VALUES ('${projectId}', '${sourceVersionId}', '${TranslationJobStatus.READY_FOR_REVIEW}', 100, 0, 0)
      RETURNING id;
    `);
    comicJobId = jobRes[0].id;

    const seg1Res = await dataSource.query(`
      INSERT INTO translation_segments (job_id, page_number, sort_order, raw_text, translated_text, is_human_verified, version)
      VALUES ('${comicJobId}', 1, 1, 'Raw Text 1', 'Bản dịch 1', false, 1)
      RETURNING id;
    `);
    seg1Id = seg1Res[0].id;

    const seg2Res = await dataSource.query(`
      INSERT INTO translation_segments (job_id, page_number, sort_order, raw_text, translated_text, is_human_verified, version)
      VALUES ('${comicJobId}', 1, 2, 'Raw Text 2', 'Bản dịch 2', false, 1)
      RETURNING id;
    `);
    seg2Id = seg2Res[0].id;

    // 3. Seed Novel Story & Project & Job
    const novelStoryRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language, views_count)
      VALUES ('Mutation Novel', 'mutation-novel-${Date.now()}', 'https://example.com/novel.webp', 'PUBLIC', 'NOVEL', 'LIGHT_NOVEL', 'JP', 'ja', 100)
      RETURNING id;
    `);
    novelStoryId = novelStoryRes[0].id;

    await dataSource.query(`
      INSERT INTO story_members (story_id, user_id, role)
      VALUES ('${novelStoryId}', '${editor.user.id}', '${StoryMemberRole.EDITOR}');
    `);

    const novelEdRes = await dataSource.query(`
      INSERT INTO story_editions (story_id, edition_name, language, is_default)
      VALUES ('${novelStoryId}', 'Novel Edition', 'ja', true)
      RETURNING id;
    `);
    novelEditionId = novelEdRes[0].id;

    const novelChRes = await dataSource.query(`
      INSERT INTO chapters (story_edition_id, chapter_number, title)
      VALUES ('${novelEditionId}', 1.00, 'Novel Chapter 1')
      RETURNING id;
    `);
    novelChapterId = novelChRes[0].id;

    const novelVerRes = await dataSource.query(`
      INSERT INTO chapter_versions (chapter_id, version_number, version_type)
      VALUES ('${novelChapterId}', 1, 'RAW_ORIGINAL')
      RETURNING id;
    `);
    novelSourceVersionId = novelVerRes[0].id;

    const novelProjRes = await dataSource.query(`
      INSERT INTO translation_projects (story_edition_id, source_language, target_language)
      VALUES ('${novelEditionId}', 'ja', 'vi')
      RETURNING id;
    `);
    novelProjectId = novelProjRes[0].id;

    const novelJobRes = await dataSource.query(`
      INSERT INTO translation_jobs (project_id, source_version_id, status, progress_percentage, review_revision, materialized_revision)
      VALUES ('${novelProjectId}', '${novelSourceVersionId}', '${TranslationJobStatus.READY_FOR_REVIEW}', 100, 0, 0)
      RETURNING id;
    `);
    novelJobId = novelJobRes[0].id;

    const novelSegRes = await dataSource.query(`
      INSERT INTO translation_segments (job_id, sort_order, raw_text, translated_text, is_human_verified, version)
      VALUES ('${novelJobId}', 1, '彼は⟦S:0001⟧勇者⟦/S:0001⟧だ。', 'Anh ấy là ⟦S:0001⟧Dũng sĩ⟦/S:0001⟧.', false, 1)
      RETURNING id;
    `);
    novelSegId = novelSegRes[0].id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (comicJobId && novelJobId) {
        await dataSource.query(`DELETE FROM translation_segments WHERE job_id IN ('${comicJobId}', '${novelJobId}')`);
        await dataSource.query(`DELETE FROM translation_jobs WHERE id IN ('${comicJobId}', '${novelJobId}')`);
      }
      if (projectId && novelProjectId) {
        await dataSource.query(`DELETE FROM translation_projects WHERE id IN ('${projectId}', '${novelProjectId}')`);
      }
      if (sourceVersionId && novelSourceVersionId) {
        await dataSource.query(`DELETE FROM chapter_versions WHERE id IN ('${sourceVersionId}', '${novelSourceVersionId}')`);
      }
      if (chapterId && novelChapterId) {
        await dataSource.query(`DELETE FROM chapters WHERE id IN ('${chapterId}', '${novelChapterId}')`);
      }
      if (editionId && novelEditionId) {
        await dataSource.query(`DELETE FROM story_editions WHERE id IN ('${editionId}', '${novelEditionId}')`);
      }
      if (storyId && novelStoryId) {
        await dataSource.query(`DELETE FROM story_members WHERE story_id IN ('${storyId}', '${novelStoryId}')`);
        await dataSource.query(`DELETE FROM stories WHERE id IN ('${storyId}', '${novelStoryId}')`);
      }
    }
    await app.close();
  });

  describe('ValidationPipe, Immutability & RBAC Boundaries', () => {
    it('should reject unauthenticated request with 401', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .send({ translatedText: 'New', expectedVersion: 1 })
        .expect(401);
    });

    it('should reject unauthorized reader with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ translatedText: 'New', expectedVersion: 1 })
        .expect(403);
    });

    it('should reject empty mutation (neither text nor verified provided) with 400 EMPTY_MUTATION', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ expectedVersion: 1 })
        .expect(400);

      expect(res.body.error.code).toBe('EMPTY_MUTATION');
    });

    it('should reject non-whitelisted immutable fields (bboxX, pageNumber, rawText) with 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Hack',
          bboxX: 100,
          expectedVersion: 1,
        })
        .expect(400);
    });
  });

  describe('OCC Version Conflict (#147)', () => {
    it('should return 409 Conflict (VERSION_CONFLICT) when expectedVersion does not match current version', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Outdated update',
          expectedVersion: 99, // Current is 1
        })
        .expect(409);

      expect(res.body.error.code).toBe('VERSION_CONFLICT');
      expect(res.body.error.currentVersion).toBe(1);
    });
  });

  describe('No-Op Mutation Semantics (#147)', () => {
    it('should return 200 with untouched version and not increment reviewRevision when content is identical', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Bản dịch 1', // Identical
          isHumanVerified: false,       // Identical
          expectedVersion: 1,
        })
        .expect(200);

      expect(res.body.version).toBe(1); // Not bumped

      // Check DB: review_revision must still be 0
      const jobRows = await dataSource.query(`SELECT review_revision FROM translation_jobs WHERE id = '${comicJobId}'`);
      expect(jobRows[0].review_revision).toBe(0);
    });
  });

  describe('Novel Inline Protected Anchors Validation (#147)', () => {
    it('should reject novel segment edit if protected anchors are corrupted with 400 ANCHOR_TOPOLOGY_VIOLATION', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${novelJobId}/segments/${novelSegId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Anh ấy là dũng sĩ mất thẻ tag.', // Missing ⟦S:0001⟧
          expectedVersion: 1,
        })
        .expect(400);

      expect(res.body.error.code).toBe('ANCHOR_TOPOLOGY_VIOLATION');
    });

    it('should accept novel segment edit when protected anchors are preserved correctly', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${novelJobId}/segments/${novelSegId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Hắn chính là ⟦S:0001⟧Dũng Sĩ Huyền Thoại⟦/S:0001⟧.',
          expectedVersion: 1,
        })
        .expect(200);

      expect(res.body.version).toBe(2);
      expect(res.body.translatedText).toBe('Hắn chính là ⟦S:0001⟧Dũng Sĩ Huyền Thoại⟦/S:0001⟧.');

      // Check review_revision incremented to 1
      const jobRows = await dataSource.query(`SELECT review_revision FROM translation_jobs WHERE id = '${novelJobId}'`);
      expect(jobRows[0].review_revision).toBe(1);
    });
  });

  describe('Freshness Counter Separation: Text vs Verification (#147, #156)', () => {
    it('should increment version AND reviewRevision when text changes, auto-resetting isHumanVerified', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Bản dịch 1 cập nhật',
          expectedVersion: 1,
          // isHumanVerified not provided -> must reset to false
        })
        .expect(200);

      expect(res.body.version).toBe(2);
      expect(res.body.isHumanVerified).toBe(false);

      const jobRows = await dataSource.query(`SELECT review_revision FROM translation_jobs WHERE id = '${comicJobId}'`);
      expect(jobRows[0].review_revision).toBe(1);
    });

    it('should increment version but NOT reviewRevision when only isHumanVerified changes', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          isHumanVerified: true, // Only verify
          expectedVersion: 2,
        })
        .expect(200);

      expect(res.body.version).toBe(3);
      expect(res.body.isHumanVerified).toBe(true);

      // reviewRevision should still be 1!
      const jobRows = await dataSource.query(`SELECT review_revision FROM translation_jobs WHERE id = '${comicJobId}'`);
      expect(jobRows[0].review_revision).toBe(1);
    });
  });

  describe('Concurrent Overlapping Transactions (Per-Job Mutex Proof)', () => {
    it('should serialize concurrent PATCH requests on different segments without deadlock and increment reviewRevision accurately', async () => {
      // Current state:
      // comicJobId review_revision = 1
      // seg1Id version = 3
      // seg2Id version = 1

      // Fire 2 simultaneous PATCH requests to different segments of the same job
      const req1 = request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Seg 1 Concurrent Edit',
          expectedVersion: 3,
        });

      const req2 = request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg2Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Seg 2 Concurrent Edit',
          expectedVersion: 1,
        });

      const [res1, res2] = await Promise.all([req1, req2]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      expect(res1.body.version).toBe(4);
      expect(res2.body.version).toBe(2);

      // Both changed text -> review_revision should have accurately incremented by 2: 1 + 2 = 3!
      const jobRows = await dataSource.query(`SELECT review_revision FROM translation_jobs WHERE id = '${comicJobId}'`);
      expect(jobRows[0].review_revision).toBe(3);
    });
  });

  describe('Apply Freshness Gate & Invariant Protection (#156)', () => {
    it('should reject Apply with 409 ARTIFACT_STALE when materializedRevision !== reviewRevision', async () => {
      // Current comicJobId: review_revision = 3, materialized_revision = 0
      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${editorToken}`)
        .set('idempotency-key', '33333333-3333-4333-8333-333333333333')
        .send({
          mode: 'OVERWRITE_ACTIVE_VERSION',
        })
        .expect(409);

      expect(res.body.error.code).toBe('ARTIFACT_STALE');
      expect(res.body.error.reviewRevision).toBe(3);
      expect(res.body.error.materializedRevision).toBe(0);
    });

    it('should allow Apply when materializedRevision === reviewRevision', async () => {
      // Simulate successful materialization: bump materialized_revision to 3
      await dataSource.query(
        `UPDATE translation_jobs SET materialized_revision = 3 WHERE id = '${comicJobId}'`,
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${comicJobId}/apply`)
        .set('Authorization', `Bearer ${editorToken}`)
        .set('idempotency-key', '44444444-4444-4444-8444-444444444444')
        .send({
          mode: 'OVERWRITE_ACTIVE_VERSION',
        })
        .expect(200);

      expect(res.body.isAlreadyApplied).toBe(false);

      // Check job status is now APPLIED
      const jobRows = await dataSource.query(`SELECT status FROM translation_jobs WHERE id = '${comicJobId}'`);
      expect(jobRows[0].status).toBe(TranslationJobStatus.APPLIED);
    });

    it('should reject subsequent PATCH on an APPLIED job with 409 NOT_REVIEWABLE (Zero-Leak Concurrency Invariant)', async () => {
      // Once APPLIED, any new PATCH must be firmly rejected!
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${comicJobId}/segments/${seg1Id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Late edit after apply',
          expectedVersion: 4,
        })
        .expect(409);

      expect(res.body.error.code).toBe('NOT_REVIEWABLE');
    });
  });
});
