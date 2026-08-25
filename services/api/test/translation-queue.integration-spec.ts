import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { TranslationService } from '../src/modules/translation/translation.service';
import { TranslationProcessor } from '../src/modules/translation/translation.processor';
import { TranslationWatchdogService } from '../src/modules/translation/translation-watchdog.service';
import { TranslationJobStatus } from '@omninovel/shared';

describe('Translation Queue Lifecycle, Cancel & Watchdog Suite (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let processor: TranslationProcessor;
  let watchdog: TranslationWatchdogService;

  let ownerUser: any;
  let versionId: string;
  let editionId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    service = app.get(TranslationService);
    processor = app.get(TranslationProcessor);
    watchdog = app.get(TranslationWatchdogService);

    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('queue_owner_${Date.now()}', 'queue_owner_${Date.now()}@example.com', 'hash', 'TRANSLATOR', true)
       RETURNING id, email, role`,
    );
    ownerUser = uRes[0];

    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Queue Story', 'queue-story-${Date.now()}', 'https://example.com/c.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    const storyId = sRes[0].id;

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

    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published, created_by)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'ja', true, $2)
       RETURNING id`,
      [chRes[0].id, ownerUser.id],
    );
    versionId = vRes[0].id;

    await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP', 1024, 'quar', 'final_q.zip', 'PROMOTED', $3, NOW() + INTERVAL '15 minutes')`,
      [editionId, versionId, ownerUser.id],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('Cancel Job should abort attempt with reason CANCELED and startAttempt should return null (Anti-Resurrection)', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `c1000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = jobRes.id;

    // Giả lập attempt 1 đang chạy
    await service.startAttempt(testJobId, 1);

    // Người dùng hủy job
    const cancelRes = await service.cancelJob(testJobId, ownerUser);
    expect(cancelRes.status).toBe(TranslationJobStatus.CANCELED);

    // Giả lập BullMQ processor sau đó cố tình gọi startAttempt attempt 2
    const attempt2Context = await service.startAttempt(testJobId, 2);
    expect(attempt2Context).toBeNull(); // Anti-resurrection guard đã chặn

    // Kiểm tra DB status vẫn bất biến là CANCELED, không bị kéo lại PREPROCESSING
    const jobDb = await dataSource.query(
      `SELECT status FROM translation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobDb[0].status).toBe(TranslationJobStatus.CANCELED);
  });

  it('Watchdog checkStalledJobs should trigger abort with reason STALLED on jobs with heartbeat > 60s', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `c2000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = jobRes.id;
    // Giả lập job đang ở PREPROCESSING và bị mất heartbeat 90s trước
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'PREPROCESSING', attempt_count = 1, heartbeat_at = NOW() - INTERVAL '90 seconds' WHERE id = $1`,
      [testJobId],
    );

    // Gắn spy lên abortAttempt
    const abortSpy = jest.spyOn(processor, 'abortAttempt');

    await watchdog.checkStalledJobs();

    expect(abortSpy).toHaveBeenCalledWith(testJobId, 'STALLED');
    abortSpy.mockRestore();
  });

  it('Watchdog reconcileValidatingJobs should enqueue stalled VALIDATING jobs (>30s) and mark QUEUED', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `c3000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = jobRes.id;

    // Giả lập job bị kẹt ở VALIDATING 45s trước
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'VALIDATING', created_at = NOW() - INTERVAL '45 seconds' WHERE id = $1`,
      [testJobId],
    );

    await watchdog.reconcileValidatingJobs();

    const reconciledJob = await dataSource.query(
      `SELECT status FROM translation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(reconciledJob[0].status).toBe(TranslationJobStatus.QUEUED);
  });

  it('Job in READY_FOR_REVIEW should reject startAttempt (Worker-Final Invariant: cannot reset to PREPROCESSING)', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `c4000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = jobRes.id;

    // Giả lập job đã hoàn tất worker pipeline sang READY_FOR_REVIEW ở attempt 1
    await service.startAttempt(testJobId, 1);
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'READY_FOR_REVIEW', attempt_count = 1 WHERE id = $1`,
      [testJobId],
    );

    // BullMQ processor cố gắng retry attempt 2 sau khi job đã READY
    const attempt2 = await service.startAttempt(testJobId, 2);
    expect(attempt2).toBeNull(); // Worker-final guard chặn đứng

    // Kiểm tra DB status vẫn là READY_FOR_REVIEW
    const jobDb = await dataSource.query(
      `SELECT status, attempt_count FROM translation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobDb[0].status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
    expect(jobDb[0].attempt_count).toBe(1);
  });

  it('Job in READY_FOR_REVIEW should NOT be marked FAILED when handleJobFailure is called (Worker-Final Failure Invariant)', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi' },
      `c5000000-0000-4000-a000-${Date.now().toString(16).padStart(12, '0').substring(0, 12)}`,
    );
    const testJobId = jobRes.id;

    // Giả lập attempt 3: callback READY_FOR_REVIEW đã commit vào DB thành công
    await service.startAttempt(testJobId, 3);
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'READY_FOR_REVIEW', attempt_count = 3 WHERE id = $1`,
      [testJobId],
    );

    // Giả lập sau callback: HTTP connection giữa Worker và Nest bị reset, BullMQ processor gọi handleJobFailure ở attempt 3
    await service.handleJobFailure(testJobId, 'Worker returned 502 connection reset after READY callback');

    // Kiểm tra DB: Trạng thái READY_FOR_REVIEW vẫn được bảo toàn nguyên vẹn, không bị chuyển sang FAILED
    const jobDb = await dataSource.query(
      `SELECT status, error_trace FROM translation_jobs WHERE id = $1`,
      [testJobId],
    );
    expect(jobDb[0].status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
    expect(jobDb[0].error_trace).toBeNull();
  });
});
