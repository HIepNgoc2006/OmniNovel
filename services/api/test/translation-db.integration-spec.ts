import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { TranslationService } from '../src/modules/translation/translation.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { TranslationJobStatus, ChapterVersionType } from '@omninovel/shared';
import { ApplyTranslationMode } from '../src/modules/translation/dto/apply-translation-job.dto';

describe('Translation DB Concurrency & Locking Suite (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let storageService: StorageService;

  let ownerUser: any;
  let storyId: string;
  let editionId: string;
  let chapterId: string;
  let versionId: string;

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
    await app.init();

    dataSource = app.get(DataSource);
    service = app.get(TranslationService);
    storageService = app.get(StorageService);

    // Chuẩn bị dữ liệu
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('db_owner_${Date.now()}', 'db_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('DB Story', 'db-story-${Date.now()}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    storyId = sRes[0].id;

    await dataSource.query(
      `INSERT INTO story_members (story_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [storyId, ownerUser.id],
    );

    const edRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Bản gốc', 'ja', true)
       RETURNING id`,
      [storyId],
    );
    editionId = edRes[0].id;

    const chRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, 1, 'Chương 1')
       RETURNING id`,
      [editionId],
    );
    chapterId = chRes[0].id;

    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chapterId, ownerUser.id],
    );
    versionId = vRes[0].id;

    await dataSource.query(
      `UPDATE chapters SET active_version_id = $1 WHERE id = $2`,
      [versionId, chapterId],
    );

    // Upload session cho version
    await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP', 1024, 'quar', 'final_db.zip', 'PROMOTED', $3, NOW() + INTERVAL '15 minutes')`,
      [editionId, versionId, ownerUser.id],
    );
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('Parallel concurrent createJob with same Idempotency-Key should create exactly 1 TranslationJob', async () => {
    const key = `d0000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;

    const results = await Promise.all([
      service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
        key,
      ),
      service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
        key,
      ),
      service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
        key,
      ),
    ]);

    const firstId = results[0].id;
    expect(results.every((r) => r.id === firstId)).toBe(true);

    const duplicateFlags = results.map((r) => r.isDuplicate);
    expect(duplicateFlags.filter((f) => f === false).length).toBe(1);
    expect(duplicateFlags.filter((f) => f === true).length).toBe(2);

    const jobsInDb = await dataSource.query(
      `SELECT count(*) FROM translation_jobs WHERE idempotency_key = $1`,
      [key],
    );
    expect(parseInt(jobsInDb[0].count, 10)).toBe(1);
  });

  it('Concurrent callbacks with Promise.all should be atomic, monotonic in sequence, and never roll back', async () => {
    // Tạo 1 job riêng cho test này
    const created = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `e0000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = created.id;
    // Set trạng thái ban đầu là QUALITY_CHECK attempt 1 sequence 0 để kiểm tra concurrent callbacks chuyển sang READY_FOR_REVIEW
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'QUALITY_CHECK', attempt_count = 1, last_sequence = 0 WHERE id = $1`,
      [testJobId],
    );

    // Upload mock WebP artifact vào MinIO để vượt qua storage verification ở READY_FOR_REVIEW
    const presign = await service.createOutputUploadUrls(testJobId, 1, [
      { filename: 'p1.webp', contentType: 'image/webp' },
    ]);
    await fetch(presign.files[0].uploadUrl, {
      method: 'PUT',
      body: Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
        0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
      ]),
      headers: { 'Content-Type': 'image/webp' },
    });
    const mockStorageKey = presign.files[0].storageKey;

    const cbPresign = await service.createCleanBaseUploadUrls(testJobId, 1, [1]);
    await fetch(cbPresign.cleanBases[0].uploadUrl, {
      method: 'PUT',
      body: Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
        0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
      ]),
      headers: { 'Content-Type': 'image/webp' },
    });

    const sourceReviewKey = `ai/jobs/${testJobId}/source-review/attempt-1/page_1.webp`;
    const s3 = (storageService as any).s3Client;
    await s3.send(
      new PutObjectCommand({
        Bucket: 'manga-media',
        Key: sourceReviewKey,
        Body: Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
          0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
          0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
        ]),
        ContentType: 'image/webp',
      }),
    );

    // Gửi đồng thời 4 callback cùng một lúc (Same-stage heartbeat progression -> READY_FOR_REVIEW)
    const events = [
      {
        eventId: 'f0000000-0000-4000-a000-000000000001',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.QUALITY_CHECK,
        progress: 95,
      },
      {
        eventId: 'f0000000-0000-4000-a000-000000000002',
        attemptNumber: 1,
        sequence: 2,
        stage: TranslationJobStatus.QUALITY_CHECK,
        progress: 96,
      },
      {
        eventId: 'f0000000-0000-4000-a000-000000000003',
        attemptNumber: 1,
        sequence: 3,
        stage: TranslationJobStatus.QUALITY_CHECK,
        progress: 97,
      },
      {
        eventId: 'f0000000-0000-4000-a000-000000000004',
        attemptNumber: 1,
        sequence: 4,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1 as const,
          mediaFormat: 'COMIC' as const,
          pages: [
            {
              page: 1,
              storageKey: mockStorageKey,
              previewKey: mockStorageKey,
              width: 1200,
              height: 1800,
              fileSizeBytes: 102400,
            },
          ],
          cleanBases: [
            {
              page: 1,
              cleanBaseKey: cbPresign.cleanBases[0].storageKey,
            },
          ],
          sourceReview: {
            version: 1 as const,
            pages: [
              {
                page: 1,
                storageKey: sourceReviewKey,
              },
            ],
          },
        },
        segments: [
          {
            pageNumber: 1,
            sortOrder: 1,
            bboxX: 0,
            bboxY: 0,
            bboxW: 100,
            bboxH: 200,
            rawText: 'こんにちは',
            confidence: null,
          },
        ],
      },
    ];

    // Chạy đồng thời Promise.all
    await Promise.all(events.map((ev) => service.handleWorkerEvent(testJobId, ev as any)));

    // Kiểm tra trạng thái DB sau khi tất cả Promise hoàn thành
    const finalJob = await dataSource.query(
      `SELECT status, last_sequence, progress_percentage FROM translation_jobs WHERE id = $1`,
      [testJobId],
    );

    expect(finalJob[0].last_sequence).toBe(4);
    expect(finalJob[0].status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
    expect(finalJob[0].progress_percentage).toBe(100);

    // Xác minh PostgreSQL lưu đúng bbox_x = 0, bbox_y = 0 và confidence IS NULL (không bị fallback 0.95 hay NULL)
    const savedSegments = await dataSource.query(
      `SELECT bbox_x, bbox_y, bbox_w, bbox_h, confidence, raw_text FROM translation_segments WHERE job_id = $1`,
      [testJobId],
    );
    expect(savedSegments.length).toBe(1);
    expect(savedSegments[0].bbox_x).toBe(0);
    expect(savedSegments[0].bbox_y).toBe(0);
    expect(savedSegments[0].bbox_w).toBe(100);
    expect(savedSegments[0].bbox_h).toBe(200);
    expect(savedSegments[0].confidence).toBeNull();
    expect(savedSegments[0].raw_text).toBe('こんにちは');
  });

  it('Parallel concurrent applyJob with same Idempotency-Key should create exactly 1 new ChapterVersion', async () => {
    // Tạo 1 job ở trạng thái READY_FOR_REVIEW
    const created = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `a0000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = created.id;

    await dataSource.query(
      `UPDATE translation_jobs SET status = 'READY_FOR_REVIEW', result_manifest = $1 WHERE id = $2`,
      [
        JSON.stringify({
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${testJobId}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${testJobId}/attempt-1/p1.webp`,
              width: 1200,
              height: 1800,
              fileSizeBytes: 102400,
            },
          ],
        }),
        testJobId,
      ],
    );

    const applyKey = `b0000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;

    // Gọi đồng thời 3 lần applyJob
    const applyResults = await Promise.all([
      service.applyJob(
        testJobId,
        { mode: ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION },
        ownerUser,
        applyKey,
      ),
      service.applyJob(
        testJobId,
        { mode: ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION },
        ownerUser,
        applyKey,
      ),
      service.applyJob(
        testJobId,
        { mode: ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION },
        ownerUser,
        applyKey,
      ),
    ]);

    const createdFlags = applyResults.map((r) => r.isAlreadyApplied);
    expect(createdFlags.filter((f) => f === false).length).toBe(1);
    expect(createdFlags.filter((f) => f === true).length).toBe(2);

    // Kiểm tra số lượng version AI_TRANSLATED trong chapter
    const versions = await dataSource.query(
      `SELECT count(*) FROM chapter_versions WHERE chapter_id = $1 AND version_type = 'AI_TRANSLATED'`,
      [chapterId],
    );
    expect(parseInt(versions[0].count, 10)).toBe(1);
  });

  it('createJob() on ChapterVersion without promoted upload session must reject with 400 SOURCE_VERSION_ARTIFACT_UNAVAILABLE (#165)', async () => {
    const noSessionVersion = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 999, 'RAW_ORIGINAL', 'ja', false, $2)
       RETURNING id`,
      [chapterId, ownerUser.id],
    );
    const noSessionVersionId = noSessionVersion[0].id;

    await expect(
      service.createJob(
        ownerUser,
        { chapterVersionId: noSessionVersionId, sourceLang: 'ja', targetLang: 'vi' },
        `f0000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
      ),
    ).rejects.toThrow(/SOURCE_VERSION_ARTIFACT_UNAVAILABLE/);

    await dataSource.query(`DELETE FROM chapter_versions WHERE id = $1`, [noSessionVersionId]);
  });

  it('createJob() on valid ChapterVersion with promoted upload session must resolve valid non-empty sourceDownloadUrl in startAttempt() (#165)', async () => {
    const jobKey = `f1000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`;
    const created = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      jobKey,
    );
    const createdJobId = created.id;

    await dataSource.query(
      `UPDATE translation_jobs SET status = 'QUEUED', attempt_count = 0 WHERE id = $1`,
      [createdJobId],
    );

    const attemptContext = await service.startAttempt(createdJobId, 1);
    expect(attemptContext).toBeDefined();
    expect(attemptContext?.sourceDownloadUrl).toBeDefined();
    expect(typeof attemptContext?.sourceDownloadUrl).toBe('string');
    expect(attemptContext?.sourceDownloadUrl.length).toBeGreaterThan(0);
    expect(attemptContext?.sourceDownloadUrl).toContain('final_db.zip');
  });
});

