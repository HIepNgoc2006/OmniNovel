import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
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

describe('Studio Contract Stabilization E2E (#160, #164)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let storageService: StorageService;

  const INTERNAL_KEY = 'internal_ai_worker_secret_secure_2026';
  let ownerToken: string;
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
    jest.spyOn(storageService, 'headInternalObject').mockResolvedValue(true);
    jest.spyOn(storageService, 'statInternalObject').mockResolvedValue({
      exists: true,
      contentLength: 1024,
      contentType: 'image/webp',
    } as any);
    jest
      .spyOn(storageService, 'hashInternalObjectSha256')
      .mockImplementation(async (key: string) => {
        const parts = key.split('/');
        const filename = parts[parts.length - 1] || '';
        const sha256 = filename.replace('.json', '');
        return {
          sha256,
          size: 1024,
          contentType: 'application/json',
          exists: true,
        };
      });

    // Setup Test User
    const userRes = await dataSource.query(`
      INSERT INTO users (email, password_hash, username, role)
      VALUES ('contract_tester@omninovel.test', 'hash', 'contract_tester', '${GlobalRole.TRANSLATOR}')
      RETURNING id;
    `);
    const ownerId = userRes[0].id;
    const { RedisService } = await import('../src/redis/redis.service');
    const redisService = app.get(RedisService);
    const ownerSid = uuidv4();
    await redisService.set(
      `auth_session:${ownerId}:${ownerSid}`,
      JSON.stringify({ sessionId: ownerSid, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    ownerToken = jwtService.sign({ sub: ownerId, role: GlobalRole.TRANSLATOR, sid: ownerSid });

    // Setup COMIC Story
    const cStoryRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, original_language, media_format, publication_format, status, visibility, created_by)
      VALUES ('Contract Comic', 'contract-comic-${Date.now()}', 'https://example.com/cover.webp', 'ja', '${MediaFormat.COMIC}', '${PublicationFormat.MANGA}', '${StoryStatus.ONGOING}', '${StoryVisibility.PUBLIC}', '${ownerId}')
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
      VALUES ('${comicStoryId}', '${ownerId}', '${StoryMemberRole.OWNER}');
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

    const cArtRes = await dataSource.query(`
      INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
      VALUES ('${comicVersionId}', 'TRANSLATION_SOURCE', 'READY')
      RETURNING id;
    `);
    const comicArtifactId = cArtRes[0].id;

    const cJobRes = await dataSource.query(`
      INSERT INTO translation_jobs (project_id, source_version_id, source_artifact_id, status, attempt_count, max_attempts, last_sequence, created_by)
      VALUES ('${comicProjectId}', '${comicVersionId}', '${comicArtifactId}', '${TranslationJobStatus.QUALITY_CHECK}', 1, 3, 1, '${ownerId}')
      RETURNING id;
    `);
    comicJobId = cJobRes[0].id;

    // Setup NOVEL Story
    const nStoryRes = await dataSource.query(`
      INSERT INTO stories (title, slug, cover_url, original_language, media_format, publication_format, status, visibility, created_by)
      VALUES ('Contract Novel', 'contract-novel-${Date.now()}', 'https://example.com/cover.webp', 'ja', '${MediaFormat.NOVEL}', '${PublicationFormat.LIGHT_NOVEL}', '${StoryStatus.ONGOING}', '${StoryVisibility.PUBLIC}', '${ownerId}')
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
      VALUES ('${novelStoryId}', '${ownerId}', '${StoryMemberRole.OWNER}');
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

    const nArtRes = await dataSource.query(`
      INSERT INTO chapter_artifacts (chapter_version_id, artifact_type, status)
      VALUES ('${novelVersionId}', 'TRANSLATION_SOURCE', 'READY')
      RETURNING id;
    `);
    const novelArtifactId = nArtRes[0].id;

    const nJobRes = await dataSource.query(`
      INSERT INTO translation_jobs (project_id, source_version_id, source_artifact_id, status, attempt_count, max_attempts, last_sequence, created_by)
      VALUES ('${novelProjectId}', '${novelVersionId}', '${novelArtifactId}', '${TranslationJobStatus.QUALITY_CHECK}', 1, 3, 1, '${ownerId}')
      RETURNING id;
    `);
    novelJobId = nJobRes[0].id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (comicJobId) await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${comicJobId}'`);
      if (novelJobId) await dataSource.query(`DELETE FROM translation_jobs WHERE id = '${novelJobId}'`);
      if (comicProjectId) await dataSource.query(`DELETE FROM translation_projects WHERE id = '${comicProjectId}'`);
      if (novelProjectId) await dataSource.query(`DELETE FROM translation_projects WHERE id = '${novelProjectId}'`);
      if (comicStoryId) await dataSource.query(`DELETE FROM stories WHERE id = '${comicStoryId}'`);
      if (novelStoryId) await dataSource.query(`DELETE FROM stories WHERE id = '${novelStoryId}'`);
      await dataSource.query(`DELETE FROM users WHERE email = 'contract_tester@omninovel.test'`);
    }
    await app.close();
  });

  describe('Comic BlockType Invariants (#160)', () => {
    it('should reject READY_FOR_REVIEW comic event if any segment includes blockType', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 2,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${comicJobId}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${comicJobId}/attempt-1/p1.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 102400,
            },
          ],
        },
        segments: [
          {
            pageNumber: 1,
            sortOrder: 1,
            rawText: 'Comic bubble',
            translatedText: 'Bong bóng truyện tranh',
            blockType: NovelBlockType.DIALOGUE, // FORBIDDEN FOR COMIC
          },
        ],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(400);

      expect(res.body.error?.code).toBe('COMIC_SEGMENT_UNEXPECTED_BLOCK_TYPE');
    });

    it('should accept READY_FOR_REVIEW comic event without blockType and normalize legacy fileSize', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 3,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${comicJobId}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${comicJobId}/attempt-1/p1.webp`,
              width: 1200,
              height: 1800,
              fileSize: 102400, // Legacy fileSize to be auto-normalized to fileSizeBytes
            },
          ],
          cleanBases: [
            {
              page: 1,
              cleanBaseKey: `ai/jobs/${comicJobId}/review-base/attempt-1/page_1.webp`,
            },
          ],
        },
        segments: [
          {
            pageNumber: 1,
            sortOrder: 1,
            rawText: 'Comic bubble',
            translatedText: 'Bong bóng truyện tranh',
          },
        ],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${comicJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);

      // Verify DB segments has null block_type
      const segs = await dataSource.query(
        `SELECT * FROM translation_segments WHERE job_id = $1`,
        [comicJobId],
      );
      expect(segs.length).toBe(1);
      expect(segs[0].block_type).toBeNull();
    });
  });

  describe('Novel BlockType Canonical Enum Invariants (#160, #164)', () => {
    it('should reject READY_FOR_REVIEW when resultManifest is missing (fail-closed)', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 2,
        segments: [],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(400);

      expect(res.body.error?.code).toBe('INVALID_TRANSLATION_MANIFEST');
      expect(res.body.error?.message).toContain('READY_FOR_REVIEW requires resultManifest');
    });

    it('should reject READY_FOR_REVIEW novel event if segments are missing blockType', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 3,
        resultManifest: {
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${novelJobId}/attempt-1/translated.html`,
          segmentCount: 1,
          charCount: 20,
          htmlFileSizeBytes: 10240,
          qa: {
            passed: true,
            score: 1.0,
            fingerprintMatch: true,
            issuesCount: 0,
          },
        },
        segments: [
          {
            sortOrder: 1,
            anchorBlockId: 'b-1',
            rawText: 'Novel raw text',
            translatedText: 'Bản dịch tiểu thuyết',
            // Missing blockType
          },
        ],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(400);

      expect(res.body.error?.code).toBe('NOVEL_SEGMENT_MISSING_BLOCK_TYPE');
    });

    it('should reject READY_FOR_REVIEW novel event with legacy blockType (PARAGRAPH)', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 4,
        resultManifest: {
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${novelJobId}/attempt-1/translated.html`,
          segmentCount: 1,
          charCount: 20,
          htmlFileSizeBytes: 10240,
          qa: {
            passed: true,
            score: 1.0,
            fingerprintMatch: true,
            issuesCount: 0,
          },
        },
        segments: [
          {
            sortOrder: 1,
            anchorBlockId: 'b-1',
            rawText: 'Novel raw text',
            translatedText: 'Bản dịch tiểu thuyết',
            blockType: 'PARAGRAPH', // Legacy - rejected by enum validator!
          },
        ],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(400);

      expect(res.body.error?.code).toBe('BAD_REQUEST');
    });

    it('should reject manifest with unknown version (fail-closed)', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 5,
        resultManifest: {
          version: 99, // Unknown manifest version
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${novelJobId}/attempt-1/translated.html`,
          segmentCount: 1,
          charCount: 20,
          htmlFileSizeBytes: 10240,
          qa: {
            passed: true,
            score: 1.0,
            fingerprintMatch: true,
            issuesCount: 0,
          },
        },
        segments: [
          {
            sortOrder: 1,
            anchorBlockId: 'b-1',
            rawText: 'Novel raw text',
            translatedText: 'Bản dịch',
            blockType: NovelBlockType.DIALOGUE,
          },
        ],
      };

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(400);

      expect(res.body.error?.code).toBe('INVALID_TRANSLATION_MANIFEST');
    });

    it('should accept READY_FOR_REVIEW novel event with canonical enum values, exact Unicode charCount, and persist blockType', async () => {
      const payload = {
        eventId: uuidv4(),
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        attemptNumber: 1,
        sequence: 6,
        resultManifest: {
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${novelJobId}/attempt-1/translated.html`,
          segmentCount: 4,
          charCount: 62, // 14 + 14 (with emoji 😀) + 13 + 21 = 62 Unicode code points
          htmlFileSizeBytes: 20480,
          structureSnapshot: {
            version: 1,
            storageKey: `ai/jobs/${novelJobId}/structure/c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd.json`,
            sha256: 'c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd',
            segmenterVersion: 'novel-v1',
            sourceStructureFingerprint:
              'sha256:c0ffee112233445566778899aabbccddeeff00112233445566778899aabbccdd',
          },
          qa: {
            passed: true,
            score: 1.0,
            fingerprintMatch: true,
            issuesCount: 0,
          },
        },
        segments: [
          {
            sortOrder: 1,
            anchorBlockId: 'b-heading',
            rawText: 'Chapter Title',
            translatedText: 'Tiêu đề chương',
            blockType: NovelBlockType.HEADING,
          },
          {
            sortOrder: 2,
            anchorBlockId: 'b-dialogue',
            rawText: 'Hello world',
            translatedText: 'Chào thế giới 😀',
            blockType: NovelBlockType.DIALOGUE,
          },
          {
            sortOrder: 3,
            anchorBlockId: 'b-narration',
            rawText: 'The wind was blowing',
            translatedText: 'Gió đang thổi',
            blockType: NovelBlockType.NARRATION,
          },
          {
            sortOrder: 4,
            anchorBlockId: 'b-blockquote',
            rawText: 'A famous quote',
            translatedText: 'Một câu nói nổi tiếng',
            blockType: NovelBlockType.BLOCKQUOTE,
          },
        ],
      };

      const computedCharCount = payload.segments.reduce(
        (sum, s) => sum + [...(s.translatedText ?? '')].length,
        0,
      );
      payload.resultManifest.charCount = computedCharCount;

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${novelJobId}/events`)
        .set('x-internal-service-key', INTERNAL_KEY)
        .send(payload)
        .expect(200);

      expect(res.body.received).toBe(true);
      expect(res.body.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);

      // Verify DB persistence of novel_block_type_enum
      const segs = await dataSource.query(
        `SELECT sort_order, block_type FROM translation_segments WHERE job_id = $1 ORDER BY sort_order ASC`,
        [novelJobId],
      );
      expect(segs.length).toBe(4);
      expect(segs[0].block_type).toBe('HEADING');
      expect(segs[1].block_type).toBe('DIALOGUE');
      expect(segs[2].block_type).toBe('NARRATION');
      expect(segs[3].block_type).toBe('BLOCKQUOTE');
    });

    it('should expose blockType via GET /api/v1/ai/jobs/:id/segments', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${novelJobId}/segments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect(res.body.data.length).toBe(4);
      expect(res.body.data[0].blockType).toBe('HEADING');
      expect(res.body.data[1].blockType).toBe('DIALOGUE');
      expect(res.body.data[2].blockType).toBe('NARRATION');
      expect(res.body.data[3].blockType).toBe('BLOCKQUOTE');
    });

    it('should preserve blockType via PATCH /api/v1/ai/jobs/:jobId/segments/:segmentId', async () => {
      // Get the second segment (DIALOGUE)
      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${novelJobId}/segments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const targetSegment = listRes.body.data[1];
      expect(targetSegment.blockType).toBe('DIALOGUE');

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/ai/jobs/${novelJobId}/segments/${targetSegment.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          expectedVersion: targetSegment.version,
          translatedText: 'Chào thế giới đã sửa',
        })
        .expect(200);

      expect(patchRes.body.translatedText).toBe('Chào thế giới đã sửa');
      expect(patchRes.body.blockType).toBe('DIALOGUE');
      expect(patchRes.body.version).toBe(targetSegment.version + 1);
    });
  });
});
