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
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as AdmZip from 'adm-zip';

jest.setTimeout(60000);

describe('Real Python FastAPI Worker Novel Cross-Service Integration Spec (Slice 3D Acceptance)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let storageService: StorageService;
  let configService: ConfigService;
  let corePort: number;
  let pythonProcess: ChildProcess;
  const pythonPort = 8098;

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

    // Dọn dẹp BullMQ queue
    try {
      const queue = app.get<Queue>(getQueueToken('translation'));
      await queue.drain();
      await queue.clean(0, 1000, 'completed');
      await queue.clean(0, 1000, 'failed');
      await queue.clean(0, 1000, 'active');
    } catch (e) {}

    // 1. Tạo User Owner
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('novel_owner_${Date.now()}', 'novel_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    // 2. Tạo Story & Story Member (MediaFormat: NOVEL, LIGHT_NOVEL)
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Real Python Light Novel Story', 'real-py-novel-${Date.now()}', 'https://example.com/cover.webp', 'PUBLIC', 'NOVEL', 'LIGHT_NOVEL', 'JP', 'ja')
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
       VALUES ($1, 'Bản gốc Tiếng Nhật', 'ja', true)
       RETURNING id`,
      [storyId],
    );
    editionId = edRes[0].id;

    const chRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Chương 1: Khởi đầu mới')
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

    // 5. Tạo file EPUB/ZIP Light Novel hợp lệ và upload lên MinIO
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile(
      'META-INF/container.xml',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`),
    );
    zip.addFile(
      'OEBPS/content.opf',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Chapter 1: The Awakening</dc:title>
    </metadata>
    <manifest>
        <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="img1" href="assets/star.png" media-type="image/png"/>
    </manifest>
    <spine>
        <itemref idref="chapter1"/>
    </spine>
</package>`),
    );
    zip.addFile(
      'OEBPS/chapter1.xhtml',
      Buffer.from(`<!DOCTYPE html>
<html>
<head><title>Chapter 1</title></head>
<body>
    <h1>第1章 覚醒</h1>
    <p>彼は<strong>勇者</strong>であり、<ruby>魔王<rt>まおう</rt></ruby>を討つ者だ。</p>
    <p>「行くぞ！」</p>
    <figure><img src="assets/star.png" alt="Star Hero" /></figure>
</body>
</html>`),
    );
    zip.addFile(
      'OEBPS/assets/star.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );

    const sourceZipBuffer = zip.toBuffer();
    const sourceZipKey = `novel/packages/real_py_novel_${Date.now()}.epub`;
    const s3 = (storageService as any).s3Client;
    await s3.send(
      new PutObjectCommand({
        Bucket: 'novel-media',
        Key: sourceZipKey,
        Body: sourceZipBuffer,
        ContentType: 'application/epub+zip',
      }),
    );

    const sessRes = await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'NOVEL_PACKAGE', $3, 'quar_novel.epub', $4, 'PROMOTED', $5, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [editionId, rawVersionId, sourceZipBuffer.length, sourceZipKey, ownerUser.id],
    );
    uploadSessionId = sessRes[0].id;

    // 6. Khởi chạy tiến trình Python FastAPI Worker thật
    const aiWorkerDir = path.resolve(__dirname, '../../ai-worker');
    const isWin = process.platform === 'win32';
    const uvicornPath = isWin
      ? path.join(aiWorkerDir, '.venv', 'Scripts', 'uvicorn.exe')
      : path.join(aiWorkerDir, '.venv', 'bin', 'uvicorn');

    pythonProcess = spawn(
      uvicornPath,
      ['main:app', '--port', pythonPort.toString(), '--host', '127.0.0.1'],
      {
        cwd: aiWorkerDir,
        env: {
          ...process.env,
          PORT: pythonPort.toString(),
          CORE_API_INTERNAL_URL: `http://127.0.0.1:${corePort}`,
          AI_WORKER_SECRET: 'internal_ai_worker_secret_secure_2026',
          AI_WORKER_TEST_MODE: 'true',
          ENV: 'test',
          MINIO_ENDPOINT: 'localhost:9000',
        },
        stdio: 'pipe',
      },
    );

    // Đợi Python Worker sẵn sàng qua /health check
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const health = await axios.get(
          `http://127.0.0.1:${pythonPort}/internal/v1/jobs/health`,
          { timeout: 1000 },
        );
        if (health.status === 200) {
          ready = true;
          break;
        }
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!ready) {
      throw new Error(`Python worker process failed to start on port ${pythonPort}`);
    }

    // Trỏ AI_WORKER_BASE_URL sang tiến trình Python Worker thật
    const origGet = configService.get.bind(configService);
    jest.spyOn(configService, 'get').mockImplementation((key: string, def?: any) => {
      if (key === 'AI_WORKER_BASE_URL') {
        return `http://127.0.0.1:${pythonPort}`;
      }
      return origGet(key, def);
    });
  }, 60000);

  afterAll(async () => {
    if (pythonProcess) {
      try {
        pythonProcess.kill('SIGTERM');
      } catch (e) {}
    }
    if (app) {
      await app.close();
    }
  }, 60000);

  it('Full Novel E2E with Real Python FastAPI Worker: BullMQ -> Novel Pipeline -> HTML Upload -> Callbacks -> READY -> Apply', async () => {
    // 1. Tạo TranslationJob cho Light Novel
    const idempKey = `nv000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;
    const createRes = await service.createJob(
      ownerUser,
      {
        chapterVersionId: rawVersionId,
        sourceLang: 'ja',
        targetLang: 'vi',
        externalConsent: true,
      },
      idempKey,
    );
    expect(createRes.id).toBeDefined();
    const jobId = createRes.id;

    // 2. Chờ BullMQ Processor gọi Python /process-novel -> FullNovelPipeline -> Upload HTML -> READY_FOR_REVIEW
    let isReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const jobCheck = await dataSource.query(
        `SELECT status, progress_percentage, last_sequence, result_manifest FROM translation_jobs WHERE id = $1`,
        [jobId],
      );
      if (jobCheck[0]?.status === TranslationJobStatus.READY_FOR_REVIEW) {
        isReady = true;
        expect(jobCheck[0].progress_percentage).toBe(100);
        expect(jobCheck[0].result_manifest?.mediaFormat).toBe('NOVEL');
        expect(jobCheck[0].result_manifest?.qa?.passed).toBe(true);
        expect(jobCheck[0].result_manifest?.htmlKey).toBeDefined();
        break;
      }
    }
    expect(isReady).toBe(true);

    // 3. Apply Job với CREATE_ALTERNATE_VERSION
    const applyRes = await service.applyJob(
      jobId,
      {
        mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION,
      },
      ownerUser,
      `app_novel_idemp_${Date.now()}`,
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

    // 5. Kiểm tra MediaAssets được tạo: cả NOVEL_HTML và ILLUSTRATION
    const assets = await dataSource.query(
      `SELECT * FROM media_assets WHERE version_id = $1 ORDER BY sort_order ASC`,
      [appliedJobDb[0].target_version_id],
    );
    expect(assets.length).toBe(2);

    const htmlAsset = assets.find((a: any) => a.asset_type === MediaAssetType.NOVEL_HTML);
    expect(htmlAsset).toBeDefined();
    expect(htmlAsset.storage_key).toContain('novel_translated.html');

    const imgAsset = assets.find((a: any) => a.asset_type === MediaAssetType.ILLUSTRATION);
    expect(imgAsset).toBeDefined();
    expect(imgAsset.storage_key).toContain('assets_star--');

    // 6. Kiểm tra file HTML & Illustration thật sự tồn tại trong MinIO (bucket novel-media)
    const htmlExistsInMinio = await storageService.headInternalObject(
      htmlAsset.storage_key,
      false, // novel bucket
    );
    expect(htmlExistsInMinio).toBe(true);

    const imgExistsInMinio = await storageService.headInternalObject(
      imgAsset.storage_key,
      false, // novel bucket
    );
    expect(imgExistsInMinio).toBe(true);

    // 7. Negative Test: handleWorkerEvent từ chối Novel READY_FOR_REVIEW khi manifest rỗng {}
    await expect(
      service.handleWorkerEvent(jobId, {
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        attemptNumber: 1,
        sequence: 998,
        timestamp: new Date().toISOString(),
        resultManifest: {},
      } as any),
    ).rejects.toThrow('Result manifest không hợp lệ cho NOVEL');

    // 8. Negative Test: handleWorkerEvent từ chối Novel READY_FOR_REVIEW khi giả mạo mediaFormat: 'COMIC'
    await expect(
      service.handleWorkerEvent(jobId, {
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        attemptNumber: 1,
        sequence: 999,
        timestamp: new Date().toISOString(),
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${jobId}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${jobId}/attempt-1/p1.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 1024,
            },
          ],
        },
      } as any),
    ).rejects.toThrow("mediaFormat must be 'NOVEL', got 'COMIC'");

    // 9. Negative Test: handleWorkerEvent từ chối Novel READY_FOR_REVIEW khi thiếu htmlKey
    await expect(
      service.handleWorkerEvent(jobId, {
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        attemptNumber: 1,
        sequence: 1000,
        timestamp: new Date().toISOString(),
        resultManifest: {
          version: 1,
          mediaFormat: 'NOVEL',
          segmentCount: 1,
          charCount: 10,
          htmlFileSizeBytes: 1024,
          qa: { passed: true, score: 1, fingerprintMatch: true, issuesCount: 0 },
        },
      } as any),
    ).rejects.toThrow('htmlKey');

    // 10. Negative Test: handleWorkerEvent từ chối Novel READY_FOR_REVIEW khi QA failed
    await expect(
      service.handleWorkerEvent(jobId, {
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        attemptNumber: 1,
        sequence: 1001,
        timestamp: new Date().toISOString(),
        resultManifest: {
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${jobId}/attempt-1/novel_translated.html`,
          htmlFileSizeBytes: 10240,
          segmentCount: 1,
          charCount: 10,
          qa: { passed: false, score: 0.5, fingerprintMatch: false, issuesCount: 1 },
        },
      } as any),
    ).rejects.toThrow('Structural QA không đạt yêu cầu');

    // 11. Negative Test: Từ chối apply job Novel nếu QA failed
    const failedQaJob = await dataSource.query(
      `INSERT INTO translation_jobs (
         id, project_id, source_version_id, created_by, status, provider, model_name, prompt_version,
         result_manifest, progress_percentage, attempt_count, max_attempts, last_sequence
       ) VALUES (
         gen_random_uuid(), (SELECT project_id FROM translation_jobs WHERE id = $1), $2, $3,
         'READY_FOR_REVIEW', 'OPENAI', 'gpt-4o-mini', 'novel-ja-vi-v2',
         $4, 100, 1, 3, 4
       ) RETURNING id`,
      [
        jobId,
        rawVersionId,
        ownerUser.id,
        JSON.stringify({
          version: 1,
          mediaFormat: 'NOVEL',
          htmlKey: `ai/jobs/${jobId}/attempt-1/novel_translated.html`,
          htmlFileSizeBytes: 10240,
          segmentCount: 1,
          charCount: 10,
          qa: { passed: false, score: 0.5, fingerprintMatch: false, issuesCount: 1 },
        }),
      ],
    );

    await expect(
      service.applyJob(
        failedQaJob[0].id,
        { mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION },
        ownerUser,
        `app_failed_qa_${Date.now()}`,
      ),
    ).rejects.toThrow('Kiểm định chất lượng cấu trúc (Structural QA) không đạt yêu cầu');

    // 12. Negative Test: Từ chối apply job Novel nếu manifest rỗng hoặc sai mediaFormat
    const emptyManifestJob = await dataSource.query(
      `INSERT INTO translation_jobs (
         id, project_id, source_version_id, created_by, status, provider, model_name, prompt_version,
         result_manifest, progress_percentage, attempt_count, max_attempts, last_sequence
       ) VALUES (
         gen_random_uuid(), (SELECT project_id FROM translation_jobs WHERE id = $1), $2, $3,
         'READY_FOR_REVIEW', 'OPENAI', 'gpt-4o-mini', 'novel-ja-vi-v2',
         $4, 100, 1, 3, 4
       ) RETURNING id`,
      [
        jobId,
        rawVersionId,
        ownerUser.id,
        null,
      ],
    );

    await expect(
      service.applyJob(
        emptyManifestJob[0].id,
        { mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION },
        ownerUser,
        `app_empty_manifest_${Date.now()}`,
      ),
    ).rejects.toThrow('Result manifest không tồn tại hoặc sai mediaFormat');
  }, 45000);
});
