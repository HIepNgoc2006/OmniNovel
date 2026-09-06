import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { TranslationService } from '../src/modules/translation/translation.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  TranslationJobStatus,
  ChapterVersionType,
  MediaAssetType,
} from '@omninovel/shared';
import { ApplyTranslationMode } from '../src/modules/translation/dto/apply-translation-job.dto';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as http from 'http';

// 1x1 WebP Lossless image buffer
const VALID_WEBP_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
]);

describe('Full Cross-Service End-to-End Orchestration Smoke (Nest -> BullMQ -> Worker HTTP -> MinIO -> Callbacks -> Apply)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let storageService: StorageService;
  let configService: ConfigService;
  let corePort: number;
  let workerServer: http.Server;
  let workerPort: number;

  let ownerUser: any;
  let storyId: string;
  let editionId: string;
  let chapterId: string;
  let rawVersionId: string;
  let uploadSessionId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    corePort = server.address().port;

    dataSource = app.get(DataSource);
    service = app.get(TranslationService);
    storageService = app.get(StorageService);
    configService = app.get(ConfigService);

    // 1. Tạo HTTP Server giả lập Python Worker chạy trên cổng riêng
    workerServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/internal/v1/jobs/process-')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const { jobId, attemptNumber } = data;
            const secret = 'internal_ai_worker_secret_secure_2026';

            // Bước A1: Worker gọi Core API xin Presigned Upload URLs cho output
            const presignResp = await axios.post(
              `http://localhost:${corePort}/internal/v1/ai/jobs/${jobId}/output-uploads`,
              {
                attemptNumber,
                files: [{ filename: 'page-001.webp', contentType: 'image/webp' }],
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'X-Internal-Service-Key': secret,
                },
              },
            );
            const uploadedFile = presignResp.data.files[0];

            // Bước A2: Worker gọi Core API xin Presigned Upload URLs cho clean bases (#162)
            const cleanBaseResp = await axios.post(
              `http://localhost:${corePort}/internal/v1/ai/jobs/${jobId}/clean-base-uploads`,
              {
                attemptNumber,
                pages: [1],
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'X-Internal-Service-Key': secret,
                },
              },
            );
            const cleanBaseFile = cleanBaseResp.data.cleanBases[0];

            // Bước B: Worker thực hiện PUT WebP buffer thật lên MinIO qua Presigned URLs
            await axios.put(uploadedFile.uploadUrl, VALID_WEBP_BUFFER, {
              headers: { 'Content-Type': 'image/webp' },
            });
            await axios.put(cleanBaseFile.uploadUrl, VALID_WEBP_BUFFER, {
              headers: { 'Content-Type': 'image/webp' },
            });

            // Bước C: Worker gửi chuỗi sequential callbacks lên Core API
            const stages = [
              { stage: 'PREPROCESSING', prog: 15, seq: 1 },
              { stage: 'OCR', prog: 35, seq: 2 },
              { stage: 'TRANSLATING', prog: 55, seq: 3 },
              { stage: 'INPAINTING', prog: 75, seq: 4 },
              { stage: 'TYPESETTING', prog: 85, seq: 5 },
              { stage: 'QUALITY_CHECK', prog: 95, seq: 6 },
            ];

            for (const s of stages) {
              await axios.post(
                `http://localhost:${corePort}/internal/v1/ai/jobs/${jobId}/events`,
                {
                  eventId: `e0000000-0000-4000-a000-00000000000${s.seq}`,
                  attemptNumber,
                  sequence: s.seq,
                  stage: s.stage,
                  progress: s.prog,
                  heartbeat: true,
                },
                {
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Service-Key': secret,
                  },
                },
              );
            }

            // Bước D: Worker gửi final callback READY_FOR_REVIEW kèm manifest & segments
            await axios.post(
              `http://localhost:${corePort}/internal/v1/ai/jobs/${jobId}/events`,
              {
                eventId: 'e0000000-0000-4000-a000-000000000007',
                attemptNumber,
                sequence: 7,
                stage: 'READY_FOR_REVIEW',
                progress: 100,
                heartbeat: true,
                resultManifest: {
                  version: 1,
                  mediaFormat: 'COMIC',
                  pages: [
                    {
                      page: 1,
                      storageKey: uploadedFile.storageKey,
                      previewKey: uploadedFile.storageKey,
                      width: 1200,
                      height: 1800,
                      fileSizeBytes: VALID_WEBP_BUFFER.length,
                    },
                  ],
                  cleanBases: [
                    {
                      page: 1,
                      cleanBaseKey: cleanBaseFile.storageKey,
                    },
                  ],
                },
                segments: [
                  {
                    pageNumber: 1,
                    sortOrder: 1,
                    rawText: 'オレは海賊王になる男だ！',
                    translatedText: 'Tôi là người sẽ trở thành Vua Hải Tặc!',
                    confidence: 0.99,
                  },
                ],
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'X-Internal-Service-Key': secret,
                },
              },
            );

            // Trả về 200 cho BullMQ Processor
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, status: 'READY_FOR_REVIEW' }));
          } catch (err: any) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      workerServer.listen(0, () => {
        workerPort = (workerServer.address() as any).port;
        const origGet = configService.get.bind(configService);
        jest.spyOn(configService, 'get').mockImplementation((key: string, def?: any) => {
          if (key === 'AI_WORKER_BASE_URL') {
            return `http://localhost:${workerPort}`;
          }
          return origGet(key, def);
        });
        resolve();
      });
    });

    // 2. Tạo User Owner
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('smoke_owner_${Date.now()}', 'smoke_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    // 3. Tạo Story & Story Member
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Smoke Manga Story', 'smoke-story-${Date.now()}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    storyId = sRes[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [storyId, ownerUser.id],
    );

    // 4. Tạo Story Edition & Chapter
    const edRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Bản gốc Nhật', 'ja', true)
       RETURNING id`,
      [storyId],
    );
    editionId = edRes[0].id;

    const chRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Hồi 1: Khởi đầu')
       RETURNING id`,
      [editionId],
    );
    chapterId = chRes[0].id;

    // 5. Tạo RAW Chapter Version
    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterId, ownerUser.id],
    );
    rawVersionId = vRes[0].id;

    // 6. Tạo Promoted Upload Session với raw package trong MinIO
    const sessRes = await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP_ARCHIVE', 2048, 'quar_smoke.zip', 'manga/packages/smoke_raw_v1.zip', 'PROMOTED', $3, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [editionId, rawVersionId, ownerUser.id],
    );
    uploadSessionId = sessRes[0].id;
  });

  afterAll(async () => {
    if (workerServer) {
      await new Promise<void>((resolve) => workerServer.close(() => resolve()));
    }
    await app.close();
  }, 30000);

  it('Full Cross-Service Flow: Create Job -> BullMQ Processor -> HTTP Worker -> Real MinIO Upload -> Callbacks -> READY_FOR_REVIEW -> Apply', async () => {
    // 1. Tạo TranslationJob
    const idempKey = `smk00000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;
    const createRes = await service.createJob(
      ownerUser,
      { chapterVersionId: rawVersionId, sourceLang: 'ja', targetLang: 'vi' },
      idempKey,
    );
    expect(createRes.id).toBeDefined();
    const jobId = createRes.id;

    // 2. Chờ BullMQ Processor tự động gọi Worker HTTP -> Upload MinIO -> Gửi Callbacks -> Đạt READY_FOR_REVIEW
    let isReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const jobCheck = await dataSource.query(
        `SELECT status, progress_percentage, last_sequence, result_manifest FROM translation_jobs WHERE id = $1`,
        [jobId],
      );
      if (jobCheck[0]?.status === TranslationJobStatus.READY_FOR_REVIEW) {
        isReady = true;
        expect(jobCheck[0].progress_percentage).toBe(100);
        expect(jobCheck[0].last_sequence).toBe(7);
        expect(jobCheck[0].result_manifest.pages.length).toBe(1);
        expect(jobCheck[0].result_manifest.cleanBases?.length).toBe(1);
        expect(jobCheck[0].result_manifest.cleanBases[0].page).toBe(1);
        expect(jobCheck[0].result_manifest.cleanBases[0].cleanBaseKey).toBe(
          `ai/jobs/${jobId}/review-base/attempt-1/page_1.webp`,
        );
        break;
      }
    }
    expect(isReady).toBe(true);

    // Verify clean base object exists before apply
    const cleanBaseKey = `ai/jobs/${jobId}/review-base/attempt-1/page_1.webp`;
    const cleanBaseBeforeApply = await storageService.headInternalObject(cleanBaseKey, true);
    expect(cleanBaseBeforeApply).toBe(true);

    // 3. Apply Job với CREATE_ALTERNATE_VERSION (Immutable Versioning)
    const applyRes = await service.applyJob(
      jobId,
      {
        mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION,
      },
      ownerUser,
      'app_idemp_smoke_cross_001',
    );

    expect(applyRes.chapterId).toBe(chapterId);
    expect(applyRes.versionNumber).toBe(2);
    expect(applyRes.versionType).toBe(ChapterVersionType.AI_TRANSLATED);

    // 4. Kiểm tra DB: Bản ghi Job đã APPLIED và trỏ đúng target_version_id
    const appliedJobDb = await dataSource.query(
      `SELECT status, target_version_id, progress_percentage FROM translation_jobs WHERE id = $1`,
      [jobId],
    );
    expect(appliedJobDb[0].status).toBe(TranslationJobStatus.APPLIED);
    expect(appliedJobDb[0].target_version_id).toBeDefined();

    // 5. Kiểm tra MediaAsset được tạo và trỏ tới file WebP trong MinIO
    const assets = await dataSource.query(
      `SELECT * FROM media_assets WHERE version_id = $1`,
      [appliedJobDb[0].target_version_id],
    );
    expect(assets.length).toBe(1);
    expect(assets[0].asset_type).toBe(MediaAssetType.MANGA_PAGE);

    // 6. Kiểm tra object thật sự tồn tại trong MinIO
    const existsInMinio = await storageService.headInternalObject(
      assets[0].storage_key,
      true,
    );
    expect(existsInMinio).toBe(true);

    // 6b. Kiểm tra Clean Base đã được xóa an toàn sau khi Apply hoàn tất (#162 Lifecycle Cleanup)
    const cleanBaseAfterApply = await storageService.headInternalObject(cleanBaseKey, true);
    expect(cleanBaseAfterApply).toBe(false);

    // 7. Kiểm tra getJob trả về canonical review detail & metadata contract (#148)
    const jobDetail = await service.getJob(jobId, ownerUser);
    expect(jobDetail.job.id).toBe(jobId);
    expect(jobDetail.context.story.id).toBe(storyId);
    expect(jobDetail.context.chapter.id).toBe(chapterId);
    expect(jobDetail.reviewSummary).toBeDefined();
    expect(typeof jobDetail.reviewSummary.segmentCount).toBe('number');
    expect(typeof jobDetail.reviewSummary.verifiedCount).toBe('number');
  }, 30000);
});
