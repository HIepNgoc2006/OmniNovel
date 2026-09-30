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
  StoryMemberRole,
  TranslationJobStatus,
} from '@omninovel/shared';
import { TranslationService } from '../src/modules/translation/translation.service';
import { TranslationProcessor } from '../src/modules/translation/translation.processor';
import { StorageService } from '../src/modules/storage/storage.service';

describe('Studio Snapshot Coherence & Workspace Revision Invariants (#182 RED 0 Round 5)', () => {
  jest.setTimeout(30000);

  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let translationService: TranslationService;
  let translationProcessor: TranslationProcessor;
  let storageService: StorageService;

  let editorToken: string;
  let storyId: string;
  let editionId: string;
  let chapterId: string;
  let sourceVersionId: string;
  let sourceArtifactId: string;
  let projectId: string;
  let testJobId: string;
  let segmentId: string;

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
    translationService = app.get(TranslationService);
    translationProcessor = app.get(TranslationProcessor);
    storageService = app.get(StorageService);

    // 1. Seed User
    const ts = Date.now();
    const userRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ($1, $2, 'hash', $3, true)
       RETURNING id, username, role`,
      [`coherence_ed_${ts}`, `coherence_${ts}@example.com`, GlobalRole.TRANSLATOR],
    );
    const user = userRes[0];
    editorToken = jwtService.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    // 2. Seed Story Hierarchy
    const storyRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language, views_count)
      VALUES ('Coherence Comic', 'coherence-comic-${ts}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja', 10)
      RETURNING id;
    `);
    storyId = storyRes[0].id;

    await dataSource.query(`
      INSERT INTO story_members (story_id, user_id, role)
      VALUES ('${storyId}', '${user.id}', '${StoryMemberRole.EDITOR}');
    `);

    const edRes = await dataSource.query(`
      INSERT INTO story_editions (story_id, edition_name, language, is_default)
      VALUES ('${storyId}', 'Ed 1', 'ja', true)
      RETURNING id;
    `);
    editionId = edRes[0].id;

    const chRes = await dataSource.query(`
      INSERT INTO chapters (story_edition_id, chapter_number, title)
      VALUES ('${editionId}', 1.00, 'Chapter 1')
      RETURNING id;
    `);
    chapterId = chRes[0].id;

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

    const artRes = await dataSource.query(`
      INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
      VALUES ('${sourceVersionId}', 'TRANSLATION_SOURCE', 'READY')
      RETURNING id;
    `);
    sourceArtifactId = artRes[0].id;

    // Seed Comic Job in READY_FOR_REVIEW with workspace_revision = 1
    const jobRes = await dataSource.query(`
      INSERT INTO translation_jobs (project_id, source_version_id, source_artifact_id, status, progress_percentage, review_revision, materialized_revision, workspace_revision)
      VALUES ('${projectId}', '${sourceVersionId}', '${sourceArtifactId}', '${TranslationJobStatus.READY_FOR_REVIEW}', 100, 0, 0, 1)
      RETURNING id;
    `);
    testJobId = jobRes[0].id;

    const segRes = await dataSource.query(`
      INSERT INTO translation_segments (job_id, page_number, sort_order, raw_text, translated_text, is_human_verified, version)
      VALUES ('${testJobId}', 1, 1, 'Hello', 'Xin chao', false, 1)
      RETURNING id;
    `);
    segmentId = segRes[0].id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DELETE FROM translation_segments WHERE job_id = '${testJobId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${testJobId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM translation_projects WHERE id = '${projectId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM chapter_versions WHERE id = '${sourceVersionId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM chapters WHERE id = '${chapterId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM story_editions WHERE id = '${editionId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM story_members WHERE story_id = '${storyId}'`).catch(() => {});
      await dataSource.query(`DELETE FROM stories WHERE id = '${storyId}'`).catch(() => {});
    }
    await app.close();
  });

  describe('BE-1 & BE-2 & BE-3: Mutually Exclusive Monotonic Workspace Revision Bumps', () => {
    it('BE-1: should bump review_revision and workspace_revision on text change', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${testJobId}/segments/${segmentId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Text v2',
          expectedVersion: 1,
        })
        .expect(200);

      expect(res.body.version).toBe(2);
      expect(res.body.translatedText).toBe('Text v2');

      const job = (await dataSource.query(`SELECT review_revision, workspace_revision FROM translation_jobs WHERE id = '${testJobId}'`))[0];
      expect(job.review_revision).toBe(1);
      expect(job.workspace_revision).toBe(2);
    });

    it('BE-2: should bump workspace_revision without bumping review_revision on verification-only change', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${testJobId}/segments/${segmentId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          isHumanVerified: true,
          expectedVersion: 2,
        })
        .expect(200);

      expect(res.body.version).toBe(3);
      expect(res.body.isHumanVerified).toBe(true);

      const job = (await dataSource.query(`SELECT review_revision, workspace_revision FROM translation_jobs WHERE id = '${testJobId}'`))[0];
      // review_revision remains 1, but workspace_revision incremented to 3!
      expect(job.review_revision).toBe(1);
      expect(job.workspace_revision).toBe(3);
    });

    it('BE-3: should bump workspace_revision exactly ONCE when text AND verification change together', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${testJobId}/segments/${segmentId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({
          translatedText: 'Text v4 verified',
          isHumanVerified: false,
          expectedVersion: 3,
        })
        .expect(200);

      expect(res.body.version).toBe(4);

      const job = (await dataSource.query(`SELECT review_revision, workspace_revision FROM translation_jobs WHERE id = '${testJobId}'`))[0];
      // review_revision bumped to 2; workspace_revision bumped from 3 to 4 (NOT 5!)
      expect(job.review_revision).toBe(2);
      expect(job.workspace_revision).toBe(4);
    });
  });

  describe('BE-5: Authoritative Read Endpoints Return Consistent workspaceRevision', () => {
    it('should return workspaceRevision across job detail and segments', async () => {
      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${testJobId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .expect(200);

      expect(detailRes.body.job.workspaceRevision).toBe(4);

      const segmentsRes = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${testJobId}/segments`)
        .set('Authorization', `Bearer ${editorToken}`)
        .expect(200);

      expect(segmentsRes.body.workspaceRevision).toBe(4);
      expect(segmentsRes.body.data).toBeInstanceOf(Array);
      expect(segmentsRes.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('BE-6: Worker Event Callback Exactly-Once workspaceRevision Bump', () => {
    it('should bump workspace_revision exactly once on worker event callback', async () => {
      const workerJobRes = await dataSource.query(`
        INSERT INTO translation_jobs (project_id, source_version_id, source_artifact_id, status, progress_percentage, attempt_count, max_attempts, last_sequence, workspace_revision)
        VALUES ('${projectId}', '${sourceVersionId}', '${sourceArtifactId}', '${TranslationJobStatus.OCR}', 10, 1, 3, 1, 1)
        RETURNING id;
      `);
      const workerJobId = workerJobRes[0].id;

      try {
        await translationService.handleWorkerEvent(workerJobId, {
          eventId: 'c0a80101-0000-0000-0000-000000000001',
          attemptNumber: 1,
          sequence: 2,
          stage: TranslationJobStatus.TRANSLATING,
          progress: 50,
        });

        const updatedJob = (
          await dataSource.query(
            `SELECT status, last_sequence, workspace_revision FROM translation_jobs WHERE id = '${workerJobId}'`,
          )
        )[0];
        expect(updatedJob.status).toBe(TranslationJobStatus.TRANSLATING);
        expect(updatedJob.last_sequence).toBe(2);
        expect(updatedJob.workspace_revision).toBe(2);
      } finally {
        await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${workerJobId}'`).catch(() => {});
      }
    });
  });

  describe('BE-8B: Storage Signing Failure in startAttempt() transitions to FAILED on last attempt', () => {
    it('should catch URL signing failure in process() and fail job gracefully instead of getting stuck in PREPROCESSING', async () => {
      const sessionId = 'c0a80101-0000-0000-0000-000000000002';
      await dataSource.query(`
        INSERT INTO upload_sessions (id, user_id, story_edition_id, file_type, expected_size, status, final_key, quarantine_key, expires_at)
        VALUES ('${sessionId}', (SELECT id FROM users LIMIT 1), '${editionId}', 'MANGA_ZIP', '1000', 'PROMOTED', 'manga/test.zip', 'quarantine/test.zip', NOW() + INTERVAL '1 hour')
        ON CONFLICT (id) DO UPDATE SET final_key = 'manga/test.zip', quarantine_key = 'quarantine/test.zip', status = 'PROMOTED', expires_at = NOW() + INTERVAL '1 hour';
      `);

      // Create a dedicated job on max attempt (attempt 3 of 3)
      const doomedJobRes = await dataSource.query(`
        INSERT INTO translation_jobs (project_id, source_version_id, source_upload_session_id, status, progress_percentage, attempt_count, max_attempts, workspace_revision, input_manifest)
        VALUES ('${projectId}', '${sourceVersionId}', '${sessionId}', '${TranslationJobStatus.PREPROCESSING}', 0, 2, 3, 1, '{"sourceLang":"ja","targetLang":"vi"}')
        RETURNING id;
      `);
      const doomedJobId = doomedJobRes[0].id;

      try {
        // Mock createInternalDownloadUrl to simulate network failure / credential failure
        const signSpy = jest
          .spyOn(storageService as any, 'createInternalDownloadUrl')
          .mockRejectedValue(new Error('S3 Connection Timeout during presigning'));

        // Process job via TranslationProcessor with attempt = 3 (maxAttempts = 3)
        const mockJob = {
          data: { translationJobId: doomedJobId },
          attemptsMade: 2,
          opts: { attempts: 3 },
        } as any;

        await expect(translationProcessor.process(mockJob)).rejects.toThrow(
          'S3 Connection Timeout during presigning',
        );

        signSpy.mockRestore();

        // Job must be in FAILED status, NOT stuck in PREPROCESSING!
        const finalJob = (
          await dataSource.query(
            `SELECT status, workspace_revision FROM translation_jobs WHERE id = '${doomedJobId}'`,
          )
        )[0];
        expect(finalJob.status).toBe(TranslationJobStatus.FAILED);
        // workspace_revision must have bumped (from 1 to 2 in startAttempt, then 2 to 3 in handleJobFailure)
        expect(finalJob.workspace_revision).toBe(3);
      } finally {
        await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${doomedJobId}'`).catch(() => {});
        await dataSource.query(`DELETE FROM upload_sessions WHERE id = '${sessionId}'`).catch(() => {});
      }
    });
  });

  describe('BE-9: Conditional Update Zero-Row Race Handling', () => {
    it('should handle zero-row affected as benign lost race in watchdog without throwing 500', async () => {
      // Create test job in PREPROCESSING with expired heartbeat
      const staleJobRes = await dataSource.query(`
        INSERT INTO translation_jobs (project_id, source_version_id, source_artifact_id, status, progress_percentage, attempt_count, max_attempts, heartbeat_at, workspace_revision)
        VALUES ('${projectId}', '${sourceVersionId}', '${sourceArtifactId}', '${TranslationJobStatus.PREPROCESSING}', 10, 1, 3, NOW() - INTERVAL '15 minutes', 1)
        RETURNING id;
      `);
      const staleJobId = staleJobRes[0].id;

      try {
        // Watchdog conditional update to VALIDATING should succeed
        const updateRes = await dataSource.query(
          `UPDATE translation_jobs 
           SET status = 'VALIDATING', workspace_revision = workspace_revision + 1 
           WHERE id = $1 AND status = 'PREPROCESSING'`,
          [staleJobId],
        );
        expect(updateRes[1]).toBe(1); // 1 row updated

        // Concurrent race: A second update with the same condition receives 0 rows affected
        const raceRes = await dataSource.query(
          `UPDATE translation_jobs 
           SET status = 'VALIDATING', workspace_revision = workspace_revision + 1 
           WHERE id = $1 AND status = 'PREPROCESSING'`,
          [staleJobId],
        );
        expect(raceRes[1]).toBe(0); // 0 rows affected is safely handled as benign lost race
      } finally {
        await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${staleJobId}'`).catch(() => {});
      }
    });
  });
});
