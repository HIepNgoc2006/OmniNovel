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
import axios from 'axios';

// 1x1 WebP Lossless image buffer
const VALID_WEBP_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
  0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
]);

describe('Translation Cross-Service Orchestration Smoke (Nest -> MinIO -> Callback -> Apply)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let storageService: StorageService;

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
    await app.init();

    dataSource = app.get(DataSource);
    service = app.get(TranslationService);
    storageService = app.get(StorageService);

    // 1. Tạo User Owner
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('smoke_owner_${Date.now()}', 'smoke_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    // 2. Tạo Story & Story Member
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

    // 3. Tạo Story Edition & Chapter
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

    // 4. Tạo RAW Chapter Version
    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterId, ownerUser.id],
    );
    rawVersionId = vRes[0].id;

    // 5. Tạo Promoted Upload Session với raw package trong MinIO
    const sessRes = await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP_ARCHIVE', 2048, 'quar_smoke.zip', 'manga/packages/smoke_raw_v1.zip', 'PROMOTED', $3, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [editionId, rawVersionId, ownerUser.id],
    );
    uploadSessionId = sessRes[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('Full Cross-Service Flow: Create Job -> Presign -> Real MinIO Upload -> Fenced Callback -> Apply -> Verify Output', async () => {
    // 1. Create Job
    const idempKey = `smk00000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;
    const createRes = await service.createJob(
      ownerUser,
      { chapterVersionId: rawVersionId, sourceLang: 'ja', targetLang: 'vi' },
      idempKey,
    );
    expect(createRes.id).toBeDefined();
    const jobId = createRes.id;

    // 2. Chờ BullMQ processor kích hoạt startAttempt (hoặc tự động chuyển sang PREPROCESSING)
    let jobDb = await dataSource.query(
      `SELECT status, attempt_count FROM translation_jobs WHERE id = $1`,
      [jobId],
    );
    if (jobDb[0].attempt_count === 0) {
      await service.startAttempt(jobId, 1);
    }

    jobDb = await dataSource.query(
      `SELECT status, attempt_count FROM translation_jobs WHERE id = $1`,
      [jobId],
    );
    expect([TranslationJobStatus.QUEUED, TranslationJobStatus.PREPROCESSING]).toContain(
      jobDb[0].status,
    );

    // 3. Worker xin Presigned Upload URLs qua Two-Step Protocol
    const presignRes = await service.createOutputUploadUrls(jobId, 1, [
      { filename: 'page-001.webp', contentType: 'image/webp' },
    ]);
    expect(presignRes.files.length).toBe(1);
    const targetFile = presignRes.files[0];
    expect(targetFile.uploadUrl).toBeDefined();
    expect(targetFile.storageKey).toBe(`ai/jobs/${jobId}/attempt-1/page-001.webp`);

    // 4. Worker thực hiện PUT buffer ảnh WebP thật lên MinIO qua Presigned URL
    const uploadHttpRes = await axios.put(targetFile.uploadUrl, VALID_WEBP_BUFFER, {
      headers: { 'Content-Type': 'image/webp' },
    });
    expect([200, 201]).toContain(uploadHttpRes.status);

    // 5. Xác thực object thật sự tồn tại trong MinIO Storage
    const existsInMinio = await storageService.headInternalObject(
      targetFile.storageKey,
      true,
    );
    expect(existsInMinio).toBe(true);

    // 6. Gửi chuỗi sequential callbacks từ Worker lên Core API
    const stages = [
      { stage: TranslationJobStatus.PREPROCESSING, progress: 15, seq: 1 },
      { stage: TranslationJobStatus.OCR, progress: 35, seq: 2 },
      { stage: TranslationJobStatus.TRANSLATING, progress: 55, seq: 3 },
      { stage: TranslationJobStatus.INPAINTING, progress: 75, seq: 4 },
      { stage: TranslationJobStatus.TYPESETTING, progress: 85, seq: 5 },
      { stage: TranslationJobStatus.QUALITY_CHECK, progress: 95, seq: 6 },
    ];

    for (const st of stages) {
      const cbRes = await service.handleWorkerEvent(jobId, {
        eventId: `ev_${st.seq}`,
        attemptNumber: 1,
        sequence: st.seq,
        stage: st.stage,
        progress: st.progress,
        heartbeat: true,
      });
      expect(cbRes.status).toBe(st.stage);
      expect(cbRes.sequence).toBe(st.seq);
    }

    // 7. Gửi final callback READY_FOR_REVIEW kèm resultManifest & segments
    const finalCallback = await service.handleWorkerEvent(jobId, {
      eventId: 'ev_final',
      attemptNumber: 1,
      sequence: 7,
      stage: TranslationJobStatus.READY_FOR_REVIEW,
      progress: 100,
      heartbeat: true,
      resultManifest: {
        pages: [
          {
            page: 1,
            storageKey: targetFile.storageKey,
            previewKey: targetFile.storageKey,
            width: 1200,
            height: 1800,
            fileSize: VALID_WEBP_BUFFER.length,
          },
        ],
      },
      segments: [
        {
          pageNumber: 1,
          sortOrder: 1,
          bboxX: 100,
          bboxY: 150,
          bboxW: 200,
          bboxH: 80,
          rawText: 'こんにちは',
          translatedText: 'Xin chào',
          confidence: 0.99,
        },
      ],
    });
    expect(finalCallback.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);

    // 8. Apply Job với CREATE_ALTERNATE_VERSION (Immutable Versioning)
    const applyRes = await service.applyJob(
      jobId,
      {
        mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION,
      },
      ownerUser,
      'app_idemp_smoke_001',
    );

    expect(applyRes.chapterId).toBe(chapterId);
    expect(applyRes.versionNumber).toBe(2);
    expect(applyRes.versionType).toBe(ChapterVersionType.AI_TRANSLATED);

    // 9. Kiểm tra DB: Bản ghi Job đã APPLIED và trỏ đúng target_version_id
    const appliedJobDb = await dataSource.query(
      `SELECT status, target_version_id, progress_percentage FROM translation_jobs WHERE id = $1`,
      [jobId],
    );
    expect(appliedJobDb[0].status).toBe(TranslationJobStatus.APPLIED);
    expect(appliedJobDb[0].target_version_id).toBeDefined();

    // 10. Kiểm tra MediaAsset được tạo và trỏ tới file WebP trong MinIO
    const assets = await dataSource.query(
      `SELECT * FROM media_assets WHERE version_id = $1`,
      [appliedJobDb[0].target_version_id],
    );
    expect(assets.length).toBe(1);
    expect(assets[0].storage_key).toBe(targetFile.storageKey);
    expect(assets[0].asset_type).toBe(MediaAssetType.MANGA_PAGE);

    // 11. Kiểm tra getJob trả về diffPreviewUrls hợp lệ
    const jobDetail = await service.getJob(jobId, ownerUser);
    expect(jobDetail.diffPreviewUrls.length).toBe(1);
    expect(jobDetail.diffPreviewUrls[0]).toContain('/manga-media/');
  });
});
