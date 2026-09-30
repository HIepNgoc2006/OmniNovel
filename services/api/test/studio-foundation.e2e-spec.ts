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
  PublicationFormat,
  StoryMemberRole,
  StoryStatus,
  StoryVisibility,
  TranslationJobStatus,
} from '@omninovel/shared';

describe('Studio Foundation E2E (#144, #148, #155)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  // Test Users & Tokens
  let adminToken: string;
  let ownerAToken: string;
  let editorAToken: string;
  let translatorAToken: string;
  let readerToken: string;
  let userBToken: string;

  // Resource IDs
  let storyAId: string;
  let editionAId: string;
  let chapterAId: string;
  let versionAId: string;
  let projectAId: string;
  let jobA1Id: string;
  let jobAFailedId: string;

  let storyBId: string;
  let editionBId: string;
  let chapterBId: string;
  let projectBId: string;
  let jobB1Id: string;

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

    const admin = await createTestUser('e2e_admin', GlobalRole.ADMIN);
    adminToken = admin.token;

    const ownerA = await createTestUser('e2e_owner_a', GlobalRole.TRANSLATOR);
    ownerAToken = ownerA.token;

    const editorA = await createTestUser('e2e_editor_a', GlobalRole.TRANSLATOR);
    editorAToken = editorA.token;

    const translatorA = await createTestUser('e2e_trans_a', GlobalRole.TRANSLATOR);
    translatorAToken = translatorA.token;

    const reader = await createTestUser('e2e_reader', GlobalRole.READER);
    readerToken = reader.token;

    const userB = await createTestUser('e2e_user_b', GlobalRole.TRANSLATOR);
    userBToken = userB.token;

    // 2. Seed Story A (COMIC)
    const sARes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language, views_count)
       VALUES ('E2E Story Alpha', 'e2e-story-alpha-${Date.now()}', 'https://example.com/alpha.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja', 1500)
       RETURNING id`,
    );
    storyAId = sARes[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role) VALUES
       ($1, $2, 'OWNER'),
       ($1, $3, 'EDITOR'),
       ($1, $4, 'TRANSLATOR')`,
      [storyAId, ownerA.user.id, editorA.user.id, translatorA.user.id],
    );

    const edARes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Bản Alpha Tiếng Việt', 'vi', true)
       RETURNING id`,
      [storyAId],
    );
    editionAId = edARes[0].id;

    const chARes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Hồi 1: Khởi Đầu')
       RETURNING id`,
      [editionAId],
    );
    chapterAId = chARes[0].id;

    const verARes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterAId, ownerA.user.id],
    );
    versionAId = verARes[0].id;

    const prjARes = await dataSource.query(
      `INSERT INTO translation_projects (story_edition_id, source_language, target_language)
       VALUES ($1, 'ja', 'vi')
       RETURNING id`,
      [editionAId],
    );
    projectAId = prjARes[0].id;

    const artARes = await dataSource.query(
      `INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
       VALUES ($1, 'TRANSLATION_SOURCE', 'READY')
       RETURNING id`,
      [versionAId],
    );
    const sourceArtifactAId = artARes[0].id;

    // Job A1 (READY_FOR_REVIEW with segments)
    const jobA1Res = await dataSource.query(
      `INSERT INTO translation_jobs (
         project_id, source_version_id, source_artifact_id, status, progress_percentage, provider, model_name,
         input_manifest, result_manifest, created_by
       )
       VALUES ($1, $2, $3, 'READY_FOR_REVIEW', 100, 'OPENAI', 'gpt-4o-mini',
          '{"version":1,"sourceLang":"ja","targetLang":"vi","provider":"OPENAI","model":"gpt-4o-mini","promptVersion":"v1.0","glossarySnapshot":[{"sourceTerm":"こんにちは","targetTerm":"Xin chào","category":"COMMON"}],"glossaryHash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","externalConsent":{"consented":false,"consentedAt":null,"provider":"OPENAI"}}'::jsonb,
          '{"version":1,"mediaFormat":"COMIC","pages":[{"page":1,"storageKey":"ai/jobs/fake/page1.webp","previewKey":"ai/jobs/fake/page1.webp","width":1200,"height":1800,"fileSizeBytes":102400}]}'::jsonb,
         $4
       )
       RETURNING id`,
      [projectAId, versionAId, sourceArtifactAId, ownerA.user.id],
    );
    jobA1Id = jobA1Res[0].id;

    // Seed MediaAssets for versionAId (SOURCE_MEDIA fallback)
    await dataSource.query(
      `INSERT INTO media_assets (version_id, sort_order, asset_type, storage_key, width, height, file_size_bytes)
       VALUES
       ($1, 1, 'MANGA_PAGE', 'media/editions/page_1.jpg', 1200, 1800, 150000),
       ($1, 2, 'MANGA_PAGE', 'media/editions/page_2.jpg', 1200, 1800, 140000),
       ($1, 3, 'MANGA_PAGE', 'media/editions/page_3.jpg', 1200, 1800, 160000)`,
      [versionAId],
    );

    // Update jobA1's result_manifest with valid namespaces matching jobA1Id
    await dataSource.query(
      `UPDATE translation_jobs
       SET result_manifest = $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 102400,
            },
            {
              page: 2,
              storageKey: `ai/jobs/${jobA1Id}/attempt-1/p2.webp`,
              previewKey: `ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 105000,
            },
            {
              page: 3,
              storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
              previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 101000,
            },
          ],
        }),
        jobA1Id,
      ],
    );

    // Insert 3 segments for Job A1
    await dataSource.query(
      `INSERT INTO translation_segments (job_id, page_number, sort_order, bbox_x, bbox_y, bbox_w, bbox_h, raw_text, translated_text, confidence, is_human_verified)
       VALUES
       ($1, 1, 1, 10, 20, 100, 50, 'こんにちは', 'Xin chào', 0.98, true),
       ($1, 1, 2, 10, 80, 120, 40, 'さようなら', 'Tạm biệt', 0.95, false),
       ($1, 2, 1, 15, 30, 80, 60, 'ありがとう', 'Cảm ơn', 0.99, true)`,
      [jobA1Id],
    );

    // Job A Failed (FAILED with internal errorTrace containing secret)
    const jobAFailRes = await dataSource.query(
      `INSERT INTO translation_jobs (
         project_id, source_version_id, source_artifact_id, status, progress_percentage, provider, model_name,
         error_trace, created_by
       )
       VALUES ($1, $2, $3, 'FAILED', 30, 'OPENAI', 'gpt-4o-mini',
         'InternalSecurityException: Failed connecting to https://internal.cluster/v1?token=SUPER_SECRET_TOKEN\n at internal/socket.js:10:5',
         $4
       )
       RETURNING id`,
      [projectAId, versionAId, sourceArtifactAId, ownerA.user.id],
    );
    jobAFailedId = jobAFailRes[0].id;

    // 3. Seed Story B (NOVEL - belonging to User B)
    const sBRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language, views_count)
       VALUES ('E2E Story Beta', 'e2e-story-beta-${Date.now()}', 'https://example.com/beta.webp', 'PUBLIC', 'NOVEL', 'LIGHT_NOVEL', 'KR', 'ko', 800)
       RETURNING id`,
    );
    storyBId = sBRes[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [storyBId, userB.user.id],
    );

    const edBRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Bản Beta Tiếng Việt', 'vi', true)
       RETURNING id`,
      [storyBId],
    );
    editionBId = edBRes[0].id;

    const chBRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 10, 'Chương 10')
       RETURNING id`,
      [editionBId],
    );
    chapterBId = chBRes[0].id;

    const verBRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ko', true, $2)
       RETURNING id`,
      [chapterBId, userB.user.id],
    );
    const versionBId = verBRes[0].id;

    const prjBRes = await dataSource.query(
      `INSERT INTO translation_projects (story_edition_id, source_language, target_language)
       VALUES ($1, 'ko', 'vi')
       RETURNING id`,
      [editionBId],
    );
    projectBId = prjBRes[0].id;

    const artBRes = await dataSource.query(
      `INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
       VALUES ($1, 'TRANSLATION_SOURCE', 'READY')
       RETURNING id`,
      [versionBId],
    );
    const sourceArtifactBId = artBRes[0].id;

    const jobB1Res = await dataSource.query(
      `INSERT INTO translation_jobs (
         project_id, source_version_id, source_artifact_id, status, progress_percentage, provider, model_name, created_by
       )
       VALUES ($1, $2, $3, 'READY_FOR_REVIEW', 100, 'OPENAI', 'gpt-4o-mini', $4)
       RETURNING id`,
      [projectBId, versionBId, sourceArtifactBId, userB.user.id],
    );
    jobB1Id = jobB1Res[0].id;

    await dataSource.query(
      `INSERT INTO translation_segments (job_id, anchor_block_id, sort_order, raw_text, translated_text, confidence, is_human_verified)
       VALUES
       ($1, 'blk_001_p', 1, '안녕하세요', 'Xin chào', 0.97, false),
       ($1, 'blk_002_p', 2, '감사합니다', 'Cảm ơn', 0.99, true)`,
      [jobB1Id],
    );
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  // =========================================================================
  // 1. RBAC & NEGATIVE IDOR: /api/v1/studio/stories (#144)
  // =========================================================================
  describe('GET /api/v1/studio/stories', () => {
    it('Global Admin should see all managed stories across the system', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data).toBeInstanceOf(Array);
      const storyIds = res.body.data.map((s: any) => s.id);
      expect(storyIds).toContain(storyAId);
      expect(storyIds).toContain(storyBId);
      expect(res.body.pagination).toBeDefined();
    });

    it('Story Member (OWNER/EDITOR/TRANSLATOR) should ONLY see Story A, NEVER Story B', async () => {
      for (const token of [ownerAToken, editorAToken, translatorAToken]) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/studio/stories')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        const storyIds = res.body.data.map((s: any) => s.id);
        expect(storyIds).toContain(storyAId);
        expect(storyIds).not.toContain(storyBId); // Negative IDOR proof
      }
    });

    it('User B should ONLY see Story B, NEVER Story A', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(200);

      const storyIds = res.body.data.map((s: any) => s.id);
      expect(storyIds).toContain(storyBId);
      expect(storyIds).not.toContain(storyAId); // Negative IDOR proof
    });

    it('Reader with no memberships should get an empty list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('Unauthenticated request should be rejected with 401 Unauthorized', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/studio/stories')
        .expect(401);
    });

    it('Should return ManagedStorySummaryDto with ISO date strings and canonical string viewsCount', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .expect(200);

      const story = res.body.data.find((s: any) => s.id === storyAId);
      expect(story).toBeDefined();
      expect(typeof story.createdAt).toBe('string');
      expect(story.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof story.updatedAt).toBe('string');
      expect(typeof story.viewsCount).toBe('string');
      expect(story.viewsCount).toBe('1500');
    });
  });

  // =========================================================================
  // 2. RBAC & NEGATIVE IDOR: /api/v1/ai/projects (#144)
  // =========================================================================
  describe('GET /api/v1/ai/projects', () => {
    it('Admin sees all projects with latestJob lateral mapping without N+1', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/ai/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const projectIds = res.body.data.map((p: any) => p.id);
      expect(projectIds).toContain(projectAId);
      expect(projectIds).toContain(projectBId);

      const projA = res.body.data.find((p: any) => p.id === projectAId);
      expect(projA.latestJob).toBeDefined();
      expect(projA.latestJob.status).toBe('FAILED'); // AFailed was inserted last
    });

    it('Translator A ONLY sees Project A, never Project B', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/ai/projects')
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      const projectIds = res.body.data.map((p: any) => p.id);
      expect(projectIds).toContain(projectAId);
      expect(projectIds).not.toContain(projectBId); // Negative IDOR proof
    });

    it('Filter by storyId works and isolates scope', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/projects?storyId=${storyAId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      for (const p of res.body.data) {
        expect(p.storyId).toBe(storyAId);
      }
    });
  });

  // =========================================================================
  // 3. RBAC, FILTERS & EDITION IDENTITY: /api/v1/ai/jobs (#144)
  // =========================================================================
  describe('GET /api/v1/ai/jobs', () => {
    it('Admin sees jobs from all stories', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const jobIds = res.body.data.map((j: any) => j.id);
      expect(jobIds).toContain(jobA1Id);
      expect(jobIds).toContain(jobB1Id);
    });

    it('Translator A ONLY sees jobs from Story A, never Story B', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      const jobIds = res.body.data.map((j: any) => j.id);
      expect(jobIds).toContain(jobA1Id);
      expect(jobIds).not.toContain(jobB1Id); // Negative IDOR proof
    });

    it('Each job summary contains edition identity and ISO dates', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs?projectId=${projectAId}`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      const job = res.body.data.find((j: any) => j.id === jobA1Id);
      expect(job).toBeDefined();
      expect(job.storyEditionId).toBe(editionAId);
      expect(job.editionName).toBe('Bản Alpha Tiếng Việt');
      expect(job.chapterNumber).toBe('1.00');
      expect(typeof job.createdAt).toBe('string');
      expect(job.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('Filter by status isolates matching jobs', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs?status=FAILED`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const failedJob = res.body.data.find((j: any) => j.id === jobAFailedId);
      expect(failedJob).toBeDefined();
      expect(failedJob.status).toBe('FAILED');
    });

    // ValidationPipe Negative Tests
    it('ValidationPipe: should reject page=0 with 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs?page=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('ValidationPipe: should reject limit=200 (exceeds max 100) with 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs?limit=200')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('ValidationPipe: should reject invalid status with 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs?status=INVALID_STATUS_XYZ')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('ValidationPipe: should reject non-UUID storyId with 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs?storyId=not-a-uuid')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  // =========================================================================
  // 4. METADATA & REVIEWSUMMARY & ERROR SANITIZATION: /api/v1/ai/jobs/:id (#148)
  // =========================================================================
  describe('GET /api/v1/ai/jobs/:id', () => {
    it('Authorized user receives slim response with SQL aggregate reviewSummary and glossarySnapshot', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      expect(res.body.job.id).toBe(jobA1Id);
      expect(res.body.job.status).toBe('READY_FOR_REVIEW');
      expect(typeof res.body.job.createdAt).toBe('string');
      expect(res.body.context.story.id).toBe(storyAId);
      expect(res.body.context.edition.id).toBe(editionAId);
      expect(res.body.context.chapter.id).toBe(chapterAId);

      // ReviewSummary aggregation proof: 3 segments, 2 verified, 2 pages (Comic), 3 result pages
      expect(res.body.reviewSummary).toEqual({
        segmentCount: 3,
        verifiedCount: 2,
        pageCount: 2,
        resultPageCount: 3,
        blockCount: null,
      });

      // Glossary snapshot is present
      expect(res.body.glossarySnapshot).toHaveLength(1);

      // Mega-response elimination proof:
      // segments and diffPreviewUrls MUST NOT exist in job detail
      expect(res.body.segments).toBeUndefined();
      expect(res.body.diffPreviewUrls).toBeUndefined();

      // No raw storageKey leaked to client
      const rawJson = JSON.stringify(res.body);
      expect(rawJson).not.toContain('ai/jobs/fake/page1.webp');
    });

    it('FAILED job returns safe sanitized error without leaking internal host/token/path', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobAFailedId}`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      expect(res.body.job.status).toBe('FAILED');
      expect(res.body.error).toEqual({
        code: 'TRANSLATION_JOB_FAILED',
        message: 'Translation job failed. Please retry or review job diagnostics.',
      });

      // Assert that sensitive token from errorTrace is NEVER leaked
      const rawJson = JSON.stringify(res.body);
      expect(rawJson).not.toContain('SUPER_SECRET_TOKEN');
      expect(rawJson).not.toContain('https://internal.cluster');
    });

    it('Cross-story unauthorized user should be rejected with 403 Forbidden', async () => {
      // User B has no permissions on Story A
      await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(403);
    });

    it('Reader without membership should be rejected with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}`)
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(403);
    });

    it('Non-existent job returns 404 Not Found', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // =========================================================================
  // 5. SEGMENTS PAGINATION & SECURITY FAIL-CLOSED: /api/v1/ai/jobs/:id/segments (#155)
  // =========================================================================
  describe('GET /api/v1/ai/jobs/:id/segments', () => {
    it('Authorized user receives bounded paginated segments with ISO timestamps', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/segments?page=1&limit=2`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        total: 3,
        page: 1,
        limit: 2,
        totalPages: 2,
      });

      // Page 1 sortOrder 1 segment
      expect(res.body.data[0].pageNumber).toBe(1);
      expect(res.body.data[0].sortOrder).toBe(1);
      expect(res.body.data[0].rawText).toBe('こんにちは');
      expect(typeof res.body.data[0].createdAt).toBe('string');
      expect(res.body.data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('Filter by pageNumber returns only segments on that page', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/segments?pageNumber=2`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].pageNumber).toBe(2);
      expect(res.body.data[0].rawText).toBe('ありがとう');
    });

    it('Cross-story unauthorized user is rejected with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/segments`)
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(403);
    });

    it('Fail-closed: returns 404 Not Found if job does not exist', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ai/jobs/00000000-0000-0000-0000-000000000000/segments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('Novel job segments return anchorBlockId and sortOrder', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobB1Id}/segments`)
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].anchorBlockId).toBe('blk_001_p');
      expect(res.body.data[0].pageNumber).toBeNull();
    });
  });

  // =========================================================================
  // 6. LAZY BOUNDED MANGA PREVIEWS: /api/v1/ai/jobs/:id/previews (#155)
  // =========================================================================
  describe('GET /api/v1/ai/jobs/:id/previews', () => {
    it('Single page request returns bounded source and result preview assets', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
        .set('Authorization', `Bearer ${translatorAToken}`)
        .expect(200);

      expect(res.body.sourceAssets).toHaveLength(1);
      expect(res.body.sourceAssets[0].kind).toBe('SOURCE_MEDIA');
      expect(res.body.sourceAssets[0].pageNumber).toBe(1);
      expect(typeof res.body.sourceAssets[0].url).toBe('string');

      expect(res.body.resultAssets).toHaveLength(1);
      expect(res.body.resultAssets[0].kind).toBe('RESULT');
      expect(res.body.resultAssets[0].pageNumber).toBe(1);
      expect(res.body.resultAssets[0].fileSizeBytes).toBe(102400);
      expect(typeof res.body.resultAssets[0].url).toBe('string');

      // Security verify: no internal storage keys leaked
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('storageKey');
      expect(bodyStr).not.toContain('previewKey');
      expect(bodyStr).not.toContain('cleanBaseKey');
      expect(bodyStr).not.toContain('diffAssets');
    });

    it('Range request returns multi-page bounded window up to 5 pages', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?fromPage=1&toPage=3`)
        .set('Authorization', `Bearer ${editorAToken}`)
        .expect(200);

      expect(res.body.sourceAssets).toHaveLength(3);
      expect(res.body.sourceAssets.map((s: any) => s.pageNumber)).toEqual([1, 2, 3]);

      expect(res.body.resultAssets).toHaveLength(3);
      expect(res.body.resultAssets.map((r: any) => r.pageNumber)).toEqual([1, 2, 3]);
    });

    it('Package-backed Manga with sourceReview uses SOURCE_REVIEW with highest precedence', async () => {
      // Temporarily attach sourceReview to jobA1
      const sourceReviewManifest = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
            previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
            width: 1200,
            height: 1800,
            fileSizeBytes: 102400,
          },
        ],
        sourceReview: {
          version: 1,
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${jobA1Id}/source-review/attempt-1/page_1.png`,
              width: 1200,
              height: 1800,
            },
          ],
        },
      };

      await dataSource.query(
        `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
        [JSON.stringify(sourceReviewManifest), jobA1Id],
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .expect(200);

      expect(res.body.sourceAssets).toHaveLength(1);
      expect(res.body.sourceAssets[0].kind).toBe('SOURCE_REVIEW');
      expect(res.body.sourceAssets[0].pageNumber).toBe(1);
      expect(res.body.sourceAssets[0].width).toBe(1200);
      expect(res.body.sourceAssets[0].height).toBe(1800);

      // Revert manifest back
      await dataSource.query(
        `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
        [
          JSON.stringify({
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                width: 1200,
                height: 1800,
                fileSizeBytes: 102400,
              },
              {
                page: 2,
                storageKey: `ai/jobs/${jobA1Id}/attempt-1/p2.webp`,
                previewKey: `ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`,
                width: 1200,
                height: 1800,
                fileSizeBytes: 105000,
              },
              {
                page: 3,
                storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                width: 1200,
                height: 1800,
                fileSizeBytes: 101000,
              },
            ],
          }),
          jobA1Id,
        ],
      );
    });

    it('Materialized page revision is served as RESULT asset preview', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=2`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.resultAssets).toHaveLength(1);
      expect(res.body.resultAssets[0].kind).toBe('RESULT');
      expect(res.body.resultAssets[0].pageNumber).toBe(2);
      expect(res.body.resultAssets[0].fileSizeBytes).toBe(105000);
      expect(res.body.resultAssets[0].url).toContain(`ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`);
    });

    it('Rejects request for NOVEL jobs with 400 PREVIEWS_ONLY_SUPPORTED_FOR_COMIC', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobB1Id}/previews?pageNumber=1`)
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(400);

      expect(res.body.error.code).toBe('PREVIEWS_ONLY_SUPPORTED_FOR_COMIC');
    });

    it('Rejects non-READY_FOR_REVIEW job with 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobAFailedId}/previews?pageNumber=1`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .expect(409);

      expect(res.body.error.code).toBe('PREVIEWS_NOT_AVAILABLE_FOR_STATUS');
    });

    it('Enforces window query validation contracts', async () => {
      // Missing window
      const resMissing = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(resMissing.body.error.code).toBe('PREVIEW_WINDOW_REQUIRED');

      // Ambiguous window
      const resAmbiguous = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1&fromPage=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(resAmbiguous.body.error.code).toBe('PREVIEW_WINDOW_AMBIGUOUS');

      // Incomplete range
      const resIncomplete = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?fromPage=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(resIncomplete.body.error.code).toBe('PREVIEW_RANGE_INCOMPLETE');

      // Reversed range
      const resReversed = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?fromPage=5&toPage=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(resReversed.body.error.code).toBe('INVALID_PREVIEW_RANGE');

      // Window > 5
      const resTooLarge = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?fromPage=1&toPage=7`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect(resTooLarge.body.error.code).toBe('WINDOW_TOO_LARGE');
    });

    it('Unauthorized / non-member user receives 403 Forbidden (negative IDOR)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
        .set('Authorization', `Bearer ${userBToken}`)
        .expect(403);
    });

    it('Persisted manifest invariant corruption returns 500 without leaking raw storage keys or internal paths', async () => {
      // Temporarily inject corrupted previewKey
      const corruptManifest = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
            previewKey: 'arbitrary/private/path/secret.webp',
            width: 1200,
            height: 1800,
            fileSizeBytes: 102400,
          },
        ],
      };

      await dataSource.query(
        `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
        [JSON.stringify(corruptManifest), jobA1Id],
      );

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(500);

        expect(res.body.error.code).toBe('PREVIEW_MANIFEST_INVARIANT_VIOLATION');
        expect(res.body.error.message).toBe(
          'Preview assets are unavailable because the persisted manifest is invalid.',
        );

        const body = JSON.stringify(res.body);
        expect(body).not.toContain('storageKey');
        expect(body).not.toContain('previewKey');
        expect(body).not.toContain('ai/jobs/');
        expect(body).not.toContain('arbitrary/private');
      } finally {
        // Restore original manifest
        await dataSource.query(
          `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
          [
            JSON.stringify({
              version: 1,
              mediaFormat: 'COMIC',
              pages: [
                {
                  page: 1,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 102400,
                },
                {
                  page: 2,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p2.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 105000,
                },
                {
                  page: 3,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 101000,
                },
              ],
            }),
            jobA1Id,
          ],
        );
      }
    });

    it('#178 / F14 E2E: Sparse resultManifest [1, 3] with valid schema yields resultPageCount: null on detail and 500 PREVIEW_MANIFEST_INVARIANT_VIOLATION on previews', async () => {
      const sparseManifest = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
            previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
            width: 1200,
            height: 1800,
            fileSizeBytes: 102400,
          },
          {
            page: 3,
            storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
            previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
            width: 1200,
            height: 1800,
            fileSizeBytes: 102400,
          },
        ],
      };

      await dataSource.query(
        `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
        [JSON.stringify(sparseManifest), jobA1Id],
      );

      try {
        // 1. GET detail must have resultPageCount === null
        const detailRes = await request(app.getHttpServer())
          .get(`/api/v1/ai/jobs/${jobA1Id}`)
          .set('Authorization', `Bearer ${translatorAToken}`)
          .expect(200);

        expect(detailRes.body.reviewSummary.resultPageCount).toBeNull();

        // 2. GET previews must fail-closed with 500 PREVIEW_MANIFEST_INVARIANT_VIOLATION
        const previewRes = await request(app.getHttpServer())
          .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(500);

        expect(previewRes.body.error.code).toBe('PREVIEW_MANIFEST_INVARIANT_VIOLATION');
      } finally {
        // Restore original manifest
        await dataSource.query(
          `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
          [
            JSON.stringify({
              version: 1,
              mediaFormat: 'COMIC',
              pages: [
                {
                  page: 1,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 102400,
                },
                {
                  page: 2,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p2.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 105000,
                },
                {
                  page: 3,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 101000,
                },
              ],
            }),
            jobA1Id,
          ],
        );
      }
    });

    it('#178 / F14 E2E: Malformed string JSON in resultManifest yields resultPageCount: null on detail and 500 PREVIEW_MANIFEST_INVARIANT_VIOLATION on previews', async () => {
      // In PostgreSQL jsonb column, store scalar JSON string containing invalid JSON text:
      await dataSource.query(
        `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
        [JSON.stringify('not-valid-json{'), jobA1Id],
      );

      try {
        const detailRes = await request(app.getHttpServer())
          .get(`/api/v1/ai/jobs/${jobA1Id}`)
          .set('Authorization', `Bearer ${translatorAToken}`)
          .expect(200);

        expect(detailRes.body.reviewSummary.resultPageCount).toBeNull();

        const previewRes = await request(app.getHttpServer())
          .get(`/api/v1/ai/jobs/${jobA1Id}/previews?pageNumber=1`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(500);

        expect(previewRes.body.error.code).toBe('PREVIEW_MANIFEST_INVARIANT_VIOLATION');
      } finally {
        await dataSource.query(
          `UPDATE translation_jobs SET result_manifest = $1::jsonb WHERE id = $2`,
          [
            JSON.stringify({
              version: 1,
              mediaFormat: 'COMIC',
              pages: [
                {
                  page: 1,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p1.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 102400,
                },
                {
                  page: 2,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p2.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/materializations/rev-1/page_2.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 105000,
                },
                {
                  page: 3,
                  storageKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  previewKey: `ai/jobs/${jobA1Id}/attempt-1/p3.webp`,
                  width: 1200,
                  height: 1800,
                  fileSizeBytes: 101000,
                },
              ],
            }),
            jobA1Id,
          ],
        );
      }
    });
  });
});

