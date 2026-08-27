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
import { PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as AdmZip from 'adm-zip';

jest.setTimeout(60000);

describe('Real Python FastAPI Worker Cross-Service Integration Spec (Slice 2C Acceptance)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let storageService: StorageService;
  let configService: ConfigService;
  let corePort: number;
  let pythonProcess: ChildProcess;
  const pythonPort = 8097;

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

    // 1. Tạo User Owner
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('py_owner_${Date.now()}', 'py_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    // 2. Tạo Story & Story Member
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Real Python Manga Story', 'real-py-story-${Date.now()}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
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
       VALUES ($1, 1, 'Hồi 1: Real AI Manga Inference')
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

    // 5. Tạo file ZIP manga hợp lệ và upload lên MinIO
    const pngBuffer = fs.readFileSync(path.resolve(__dirname, 'fixtures/page_0001.png'));
    const zip = new AdmZip();
    zip.addFile('page_0001.png', pngBuffer);
    const sourceZipBuffer = zip.toBuffer();

    const sourceZipKey = `manga/packages/real_py_source_${Date.now()}.zip`;
    const s3 = (storageService as any).s3Client;
    await s3.send(
      new PutObjectCommand({
        Bucket: 'manga-media',
        Key: sourceZipKey,
        Body: sourceZipBuffer,
        ContentType: 'application/zip',
      }),
    );

    const sessRes = await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP_ARCHIVE', $3, 'quar_py.zip', $4, 'PROMOTED', $5, NOW() + INTERVAL '1 hour')
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

  it('Full E2E with Real Python FastAPI Worker: BullMQ -> Python Process -> MinIO -> Callbacks -> READY -> Apply', async () => {
    // 1. Tạo TranslationJob
    const idempKey = `py000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;
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

    // 2. Chờ BullMQ Processor tự động gọi Python FastAPI Process -> Download -> OCR -> Translate -> Inpaint -> Typeset -> QA -> Upload MinIO -> READY_FOR_REVIEW
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
        expect(jobCheck[0].result_manifest?.pages?.length).toBe(1);
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
      `app_py_idemp_${Date.now()}`,
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
  }, 45000);
});
