import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { TranslationService } from '../src/modules/translation/translation.service';
import { TranslationProcessor } from '../src/modules/translation/translation.processor';
import { TranslationWatchdogService } from '../src/modules/translation/translation-watchdog.service';
import { TranslationJobStatus } from '@omninovel/shared';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

describe('Translation Queue Lifecycle, Cancel & Watchdog Suite (Integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TranslationService;
  let processor: TranslationProcessor;
  let watchdog: TranslationWatchdogService;
  let translationQueue: Queue;

  let ownerUser: any;
  let versionId: string;
  let editionId: string;
  let promotedSessionId: string;

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
    translationQueue = app.get<Queue>(getQueueToken('translation'));

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

    const sessRes = await dataSource.query(
      `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
       VALUES ($1, $2, 'MANGA_ZIP', 1024, 'quar', 'final_q.zip', 'PROMOTED', $3, NOW() + INTERVAL '15 minutes')
       RETURNING id`,
      [editionId, versionId, ownerUser.id],
    );
    promotedSessionId = sessRes[0].id;
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
    expect([
      TranslationJobStatus.QUEUED,
      TranslationJobStatus.PREPROCESSING,
    ]).toContain(reconciledJob[0].status);
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

  it('External provider OPENAI without externalConsent=true should throw BadRequestException', async () => {
    await expect(
      service.createJob(
        ownerUser,
        {
          chapterVersionId: versionId,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
          externalConsent: false,
        },
        `consent-test-${Date.now()}`,
      ),
    ).rejects.toThrow('EXTERNAL_PROVIDER_CONSENT_REQUIRED');
  });

  it('Idempotency should preserve immutable inputManifest snapshot across glossary updates', async () => {
    // 1. Tạo glossary ban đầu: ルフィ -> Luffy
    const pRes = await dataSource.query(
      `SELECT id FROM translation_projects WHERE story_edition_id = $1 LIMIT 1`,
      [editionId],
    );
    const projId = pRes[0].id;
    await dataSource.query(
      `INSERT INTO translation_glossaries (project_id, source_term, target_term, category)
       VALUES ($1, 'ルフィ', 'Luffy', 'CHARACTER_NAME')
       ON CONFLICT (project_id, source_term) DO UPDATE SET target_term = 'Luffy'`,
      [projId],
    );

    const idempKey = `idemp-glossary-snap-${Date.now()}`;
    const job1 = await service.createJob(
      ownerUser,
      {
        chapterVersionId: versionId,
        sourceLang: 'ja',
        targetLang: 'vi',
        provider: 'MOCK',
      },
      idempKey,
    );

    const job1Db = await dataSource.query(
      `SELECT input_manifest FROM translation_jobs WHERE id = $1`,
      [job1.id],
    );
    const initialManifest = job1Db[0].input_manifest;
    expect(initialManifest.glossarySnapshot[0].targetTerm).toBe('Luffy');
    expect(initialManifest.glossaryHash).toMatch(/^sha256:/);

    // 2. Editor sửa glossary: ルフィ -> Ruffy
    await dataSource.query(
      `UPDATE translation_glossaries SET target_term = 'Ruffy' WHERE project_id = $1 AND source_term = 'ルフィ'`,
      [projId],
    );

    // 3. Replay createJob cùng idempotencyKey
    const job2 = await service.createJob(
      ownerUser,
      {
        chapterVersionId: versionId,
        sourceLang: 'ja',
        targetLang: 'vi',
        provider: 'MOCK',
      },
      idempKey,
    );

    expect(job2.id).toBe(job1.id);
    expect(job2.isDuplicate).toBe(true);
    // Invariant: Snapshot và Hash giữ nguyên bản gốc lúc tạo job (Luffy), không bị ghi đè thành Ruffy
    expect(job2.inputManifest.glossarySnapshot[0].targetTerm).toBe('Luffy');
    expect(job2.inputManifest.glossaryHash).toBe(initialManifest.glossaryHash);
  });

  it('startAttempt should fail closed if input_manifest is missing/null', async () => {
    const jobRes = await service.createJob(
      ownerUser,
      { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi', provider: 'MOCK' },
      `fail-closed-${Date.now()}`,
    );
    // Cố tình đặt status = 'QUEUED', attempt_count = 0 và input_manifest = NULL
    await dataSource.query(
      `UPDATE translation_jobs SET status = 'QUEUED', attempt_count = 0, input_manifest = NULL WHERE id = $1`,
      [jobRes.id],
    );

    await expect(service.startAttempt(jobRes.id, 1)).rejects.toThrow(
      'MISSING_INPUT_MANIFEST',
    );
  });

  // Deterministic Regression Suite: BullMQ worker vs createJob timing race & worker lifecycle invariants
  let activeTestCleanupHooks: Array<() => void> = [];

  afterEach(() => {
    for (const fn of activeTestCleanupHooks.splice(0)) {
      try {
        fn();
      } catch {}
    }
    jest.restoreAllMocks();
  });

  const createDeferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const attachWorkerSettleListener = (getTargetJobId: () => string | null) => {
    const deferred = createDeferred<
      | { event: 'completed'; returnvalue: any }
      | { event: 'failed'; error: string }
    >();
    const onCompleted = (job: any, returnvalue: any) => {
      const targetId = getTargetJobId();
      if (targetId && (job?.id === targetId || job?.data?.translationJobId === targetId)) {
        cleanup();
        deferred.resolve({ event: 'completed', returnvalue });
      }
    };
    const onFailed = (job: any, err: Error) => {
      const targetId = getTargetJobId();
      if (targetId && (job?.id === targetId || job?.data?.translationJobId === targetId)) {
        cleanup();
        deferred.resolve({ event: 'failed', error: err?.message || 'unknown' });
      }
    };
    const cleanup = () => {
      processor.worker.off('completed', onCompleted);
      processor.worker.off('failed', onFailed);
    };
    processor.worker.on('completed', onCompleted);
    processor.worker.on('failed', onFailed);
    activeTestCleanupHooks.push(cleanup);
    return { promise: deferred.promise, cleanup };
  };

  it('Deterministic Race (Worker wins): createJob should return PREPROCESSING and preserve attempt/workspace invariants without lost update', async () => {
    let targetJobId: string | null = null;
    let workerAttempt1Invoked = false;
    const workerAttempt1Done = createDeferred<void>();
    activeTestCleanupHooks.push(() => workerAttempt1Done.resolve());
    const workerSettle = attachWorkerSettleListener(() => targetJobId);

    const origQueueAdd = Queue.prototype.add;
    const origStartAttempt = TranslationService.prototype.startAttempt;
    const origQuery = DataSource.prototype.query;

    const queueAddSpy = jest
      .spyOn(Queue.prototype, 'add')
      .mockImplementation(async function (this: Queue, name: any, data: any, opts: any) {
        if (!targetJobId && this.name === 'translation' && data?.translationJobId) {
          targetJobId = data.translationJobId;
        }
        return origQueueAdd.call(this, name, data, opts);
      });

    const startAttemptSpy = jest
      .spyOn(service, 'startAttempt')
      .mockImplementation(async (jobId: string, attemptNumber: number) => {
        try {
          if (jobId === targetJobId && attemptNumber === 1) {
            workerAttempt1Invoked = true;
          }
          return await origStartAttempt.apply(service, [jobId, attemptNumber]);
        } finally {
          if (jobId === targetJobId && attemptNumber === 1) {
            workerAttempt1Done.resolve();
          }
        }
      });

    const querySpy = jest
      .spyOn(dataSource, 'query')
      .mockImplementation((async (query: string, parameters?: any[]) => {
        if (
          typeof query === 'string' &&
          query.includes('UPDATE translation_jobs') &&
          query.includes("SET status = 'QUEUED'") &&
          query.includes("AND status = 'VALIDATING'") &&
          targetJobId &&
          parameters?.[0] === targetJobId
        ) {
          await workerAttempt1Done.promise;
        }
        return origQuery.apply(dataSource, [query, parameters]);
      }) as any);

    try {
      const jobRes = await service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi', provider: 'MOCK' },
        `race-worker-wins-${Date.now()}`,
      );

      expect(workerAttempt1Invoked).toBe(true);
      expect(jobRes.status).toBe(TranslationJobStatus.PREPROCESSING);
      expect(jobRes.isDuplicate).toBe(false);

      const jobDb = await origQuery.apply(dataSource, [
        `SELECT status, attempt_count, last_sequence, workspace_revision, started_at, error_trace, source_version_id, source_upload_session_id
         FROM translation_jobs WHERE id = $1`,
        [jobRes.id],
      ]);
      expect(jobDb).toHaveLength(1);
      expect(jobDb[0].status).toBe(TranslationJobStatus.PREPROCESSING);
      expect(jobDb[0].attempt_count).toBe(1);
      expect(jobDb[0].last_sequence).toBe(0);
      expect(jobDb[0].workspace_revision).toBe(2);
      expect(jobDb[0].started_at).not.toBeNull();
      expect(jobDb[0].error_trace).toBeNull();
      expect(jobDb[0].source_version_id).toBe(versionId);
      expect(jobDb[0].source_upload_session_id).toBe(promotedSessionId);
    } finally {
      workerAttempt1Done.resolve();
      querySpy.mockRestore();
      startAttemptSpy.mockRestore();
      queueAddSpy.mockRestore();
      if (targetJobId) {
        await service.cancelJob(targetJobId, ownerUser).catch(() => {});
        if (workerAttempt1Invoked) {
          await workerSettle.promise;
        }
        await translationQueue.remove(targetJobId).catch(() => {});
      }
      workerSettle.cleanup();
    }
  });

  it('Deterministic Race (DB wins): createJob returns QUEUED and BullMQ attempt 1 advances DB forward to PREPROCESSING', async () => {
    let targetJobId: string | null = null;
    let workerEnteredGate = false;
    const workerReachedGate = createDeferred<void>();
    const releaseWorkerGate = createDeferred<void>();
    const workerTransitionDone = createDeferred<void>();
    activeTestCleanupHooks.push(() => {
      releaseWorkerGate.resolve();
      workerTransitionDone.resolve();
    });
    const workerSettle = attachWorkerSettleListener(() => targetJobId);

    const origQueueAdd = Queue.prototype.add;
    const origStartAttempt = TranslationService.prototype.startAttempt;

    const queueAddSpy = jest
      .spyOn(Queue.prototype, 'add')
      .mockImplementation(async function (this: Queue, name: any, data: any, opts: any) {
        if (!targetJobId && this.name === 'translation' && data?.translationJobId) {
          targetJobId = data.translationJobId;
        }
        return origQueueAdd.call(this, name, data, opts);
      });

    const startAttemptSpy = jest
      .spyOn(service, 'startAttempt')
      .mockImplementation(async (jobId: string, attemptNumber: number) => {
        if (jobId === targetJobId && attemptNumber === 1) {
          workerEnteredGate = true;
          workerReachedGate.resolve();
          await releaseWorkerGate.promise;
          try {
            return await origStartAttempt.apply(service, [jobId, attemptNumber]);
          } finally {
            workerTransitionDone.resolve();
          }
        }
        return origStartAttempt.apply(service, [jobId, attemptNumber]);
      });

    try {
      const jobRes = await service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi', provider: 'MOCK' },
        `race-db-wins-${Date.now()}`,
      );

      expect(jobRes.status).toBe(TranslationJobStatus.QUEUED);
      expect(jobRes.isDuplicate).toBe(false);

      const queuedDb = await dataSource.query(
        `SELECT status, attempt_count, last_sequence, workspace_revision, started_at, source_upload_session_id
         FROM translation_jobs WHERE id = $1`,
        [jobRes.id],
      );
      expect(queuedDb[0].status).toBe(TranslationJobStatus.QUEUED);
      expect(queuedDb[0].attempt_count).toBe(0);
      expect(queuedDb[0].last_sequence).toBe(0);
      expect(queuedDb[0].workspace_revision).toBe(2);
      expect(queuedDb[0].started_at).toBeNull();
      expect(queuedDb[0].source_upload_session_id).toBe(promotedSessionId);

      await workerReachedGate.promise;
      releaseWorkerGate.resolve();
      await workerTransitionDone.promise;

      const runningDb = await dataSource.query(
        `SELECT status, attempt_count, workspace_revision, started_at, error_trace
         FROM translation_jobs WHERE id = $1`,
        [jobRes.id],
      );
      expect(runningDb[0].status).toBe(TranslationJobStatus.PREPROCESSING);
      expect(runningDb[0].attempt_count).toBe(1);
      expect(runningDb[0].workspace_revision).toBe(3);
      expect(runningDb[0].started_at).not.toBeNull();
      expect(runningDb[0].error_trace).toBeNull();
    } finally {
      releaseWorkerGate.resolve();
      workerTransitionDone.resolve();
      startAttemptSpy.mockRestore();
      queueAddSpy.mockRestore();
      if (targetJobId) {
        await service.cancelJob(targetJobId, ownerUser).catch(() => {});
        if (workerEnteredGate) {
          await workerSettle.promise;
        }
        await translationQueue.remove(targetJobId).catch(() => {});
      }
      workerSettle.cleanup();
    }
  });

  it('Deterministic Pre-Attempt-1 Cancel vs Worker Race should keep DB CANCELED and skip attempt 1 without resurrection', async () => {
    let targetJobId: string | null = null;
    let workerEnteredGate = false;
    let startAttemptResult: unknown = undefined;
    const workerReachedGate = createDeferred<void>();
    const releaseWorkerGate = createDeferred<void>();
    activeTestCleanupHooks.push(() => releaseWorkerGate.resolve());
    const workerSettle = attachWorkerSettleListener(() => targetJobId);

    const origQueueAdd = Queue.prototype.add;
    const origStartAttempt = TranslationService.prototype.startAttempt;

    const queueAddSpy = jest
      .spyOn(Queue.prototype, 'add')
      .mockImplementation(async function (this: Queue, name: any, data: any, opts: any) {
        if (!targetJobId && this.name === 'translation' && data?.translationJobId) {
          targetJobId = data.translationJobId;
        }
        return origQueueAdd.call(this, name, data, opts);
      });

    const startAttemptSpy = jest
      .spyOn(service, 'startAttempt')
      .mockImplementation(async (jobId: string, attemptNumber: number) => {
        if (jobId === targetJobId && attemptNumber === 1) {
          workerEnteredGate = true;
          workerReachedGate.resolve();
          await releaseWorkerGate.promise;
          startAttemptResult = await origStartAttempt.apply(service, [
            jobId,
            attemptNumber,
          ]);
          return startAttemptResult as any;
        }
        return origStartAttempt.apply(service, [jobId, attemptNumber]);
      });

    try {
      const jobRes = await service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi', provider: 'MOCK' },
        `race-cancel-before-attempt1-${Date.now()}`,
      );
      expect(jobRes.status).toBe(TranslationJobStatus.QUEUED);

      await workerReachedGate.promise;
      const cancelRes = await service.cancelJob(jobRes.id, ownerUser);
      expect(cancelRes.status).toBe(TranslationJobStatus.CANCELED);

      releaseWorkerGate.resolve();
      const settleResult = await workerSettle.promise;

      expect(startAttemptResult).toBeNull();
      expect(settleResult).toEqual({
        event: 'completed',
        returnvalue: { skipped: true, reason: 'JOB_TERMINAL_OR_CANCELED' },
      });

      const jobDb = await dataSource.query(
        `SELECT status, attempt_count, started_at, completed_at
         FROM translation_jobs WHERE id = $1`,
        [jobRes.id],
      );
      expect(jobDb[0].status).toBe(TranslationJobStatus.CANCELED);
      expect(jobDb[0].attempt_count).toBe(0);
      expect(jobDb[0].started_at).toBeNull();
      expect(jobDb[0].completed_at).not.toBeNull();
    } finally {
      releaseWorkerGate.resolve();
      startAttemptSpy.mockRestore();
      queueAddSpy.mockRestore();
      if (targetJobId) {
        if (workerEnteredGate) {
          await workerSettle.promise.catch(() => {});
        }
        await translationQueue.remove(targetJobId).catch(() => {});
      }
      workerSettle.cleanup();
    }
  });

  it('Worker Retry Lifecycle Regression: non-final attempt error keeps PREPROCESSING, final attempt error marks FAILED', async () => {
    let skipNextEnqueue = true;
    const origQueueAdd = Queue.prototype.add;
    const queueAddSpy = jest
      .spyOn(Queue.prototype, 'add')
      .mockImplementation(async function (this: Queue, name: any, data: any, opts: any) {
        if (skipNextEnqueue && this.name === 'translation' && data?.translationJobId) {
          skipNextEnqueue = false;
          return { id: 'synthetic-no-bg-worker' } as any;
        }
        return origQueueAdd.call(this, name, data, opts);
      });

    const origFetch = global.fetch;
    let createdJobId: string | null = null;

    try {
      const jobRes = await service.createJob(
        ownerUser,
        { chapterVersionId: versionId, sourceLang: 'ja', targetLang: 'vi', provider: 'MOCK' },
        `worker-retry-lifecycle-${Date.now()}`,
      );
      createdJobId = jobRes.id;
      expect(jobRes.status).toBe(TranslationJobStatus.QUEUED);

      global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/internal/v1/jobs/process-')) {
          return {
            ok: false,
            status: 503,
            text: async () => 'AI Worker Unavailable',
          } as Response;
        }
        return origFetch(input, init);
      }) as typeof fetch;

      // Attempt 1/3 thất bại: không được đánh FAILED sớm, giữ PREPROCESSING để BullMQ retry
      await expect(
        processor.process({
          data: { translationJobId: createdJobId },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any),
      ).rejects.toThrow('HTTP 503');

      const afterAttempt1 = await dataSource.query(
        `SELECT status, attempt_count, error_trace, started_at, completed_at
         FROM translation_jobs WHERE id = $1`,
        [createdJobId],
      );
      expect(afterAttempt1[0].status).toBe(TranslationJobStatus.PREPROCESSING);
      expect(afterAttempt1[0].attempt_count).toBe(1);
      expect(afterAttempt1[0].started_at).not.toBeNull();
      expect(afterAttempt1[0].error_trace).toBeNull();
      expect(afterAttempt1[0].completed_at).toBeNull();

      // Attempt 2/3 thất bại: tiếp tục giữ PREPROCESSING
      await expect(
        processor.process({
          data: { translationJobId: createdJobId },
          attemptsMade: 1,
          opts: { attempts: 3 },
        } as any),
      ).rejects.toThrow('HTTP 503');

      const afterAttempt2 = await dataSource.query(
        `SELECT status, attempt_count, error_trace, completed_at
         FROM translation_jobs WHERE id = $1`,
        [createdJobId],
      );
      expect(afterAttempt2[0].status).toBe(TranslationJobStatus.PREPROCESSING);
      expect(afterAttempt2[0].attempt_count).toBe(2);
      expect(afterAttempt2[0].error_trace).toBeNull();
      expect(afterAttempt2[0].completed_at).toBeNull();

      // Attempt 3/3 (cuối) thất bại: mới chuyển terminal FAILED kèm error_trace
      await expect(
        processor.process({
          data: { translationJobId: createdJobId },
          attemptsMade: 2,
          opts: { attempts: 3 },
        } as any),
      ).rejects.toThrow('HTTP 503');

      const afterAttempt3 = await dataSource.query(
        `SELECT status, attempt_count, error_trace, completed_at
         FROM translation_jobs WHERE id = $1`,
        [createdJobId],
      );
      expect(afterAttempt3[0].status).toBe(TranslationJobStatus.FAILED);
      expect(afterAttempt3[0].attempt_count).toBe(3);
      expect(afterAttempt3[0].error_trace).toContain('HTTP 503');
      expect(afterAttempt3[0].completed_at).not.toBeNull();
    } finally {
      global.fetch = origFetch;
      queueAddSpy.mockRestore();
    }
  });
});
