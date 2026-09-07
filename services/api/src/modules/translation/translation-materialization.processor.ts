import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TranslationJob } from './entities/translation-job.entity';
import { MaterializationJobData, TranslationJobStatus } from '@omninovel/shared';
import { StorageService } from '../storage/storage.service';

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

@Injectable()
@Processor('translation-materialization')
export class TranslationMaterializationProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslationMaterializationProcessor.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    @InjectRepository(TranslationJob)
    private readonly jobRepo: Repository<TranslationJob>,
  ) {
    super();
  }

  async process(job: Job<MaterializationJobData>): Promise<void> {
    if (job.name !== 'materialize') {
      throw new UnrecoverableError(`UNSUPPORTED_MATERIALIZATION_JOB: ${job.name}`);
    }

    const jobData = job.data;
    const { jobId, targetRevision, mediaFormat } = jobData;

    // Chỉ xử lý COMIC trong #157 (#158 sẽ xử lý NOVEL)
    if (mediaFormat !== 'COMIC') {
      this.logger.log(
        `[MaterializationProcessor] Bỏ qua job ${jobId} vì mediaFormat là ${mediaFormat} (chưa hỗ trợ trong worker này).`,
      );
      return;
    }

    // 1. Read-Only DB Preflight & Fencing Check
    const dbJob = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!dbJob) {
      this.logger.warn(`[MaterializationProcessor] Không tìm thấy TranslationJob ${jobId}`);
      return;
    }

    if (dbJob.materializedRevision === targetRevision) {
      this.logger.log(
        `[MaterializationProcessor] Job ${jobId} đã được materialize ở rev ${targetRevision}. Bỏ qua (ALREADY_MATERIALIZED).`,
      );
      return;
    }

    if (targetRevision !== dbJob.reviewRevision || targetRevision < dbJob.materializedRevision) {
      this.logger.warn(
        `[MaterializationProcessor] Job ${jobId} rev ${targetRevision} đã lỗi thời (current reviewRevision: ${dbJob.reviewRevision}, materializedRevision: ${dbJob.materializedRevision}). Bỏ qua (STALE).`,
      );
      return;
    }

    if (dbJob.status !== TranslationJobStatus.READY_FOR_REVIEW) {
      this.logger.warn(
        `[MaterializationProcessor] Job ${jobId} không ở trạng thái READY_FOR_REVIEW (hiện tại: ${dbJob.status}). Bỏ qua.`,
      );
      return;
    }

    // 2. Fail-Closed Sanity Checks trên JobData (#157)
    const expectedOutputPrefix = `ai/jobs/${jobId}/materializations/rev-${targetRevision}/`;
    if (jobData.outputPrefix !== expectedOutputPrefix) {
      throw new UnrecoverableError(
        `INVALID_OUTPUT_PREFIX: outputPrefix '${jobData.outputPrefix}' không khớp expected '${expectedOutputPrefix}'.`,
      );
    }

    if (!SHA256_HEX_REGEX.test(jobData.snapshotSha256)) {
      throw new UnrecoverableError(
        `INVALID_SNAPSHOT_SHA256: snapshotSha256 '${jobData.snapshotSha256}' không phải 64-hex lowercase hợp lệ.`,
      );
    }

    const expectedSnapshotKey = `${expectedOutputPrefix}snapshots/${jobData.snapshotSha256}.json`;
    if (jobData.snapshotKey !== expectedSnapshotKey) {
      throw new UnrecoverableError(
        `INVALID_SNAPSHOT_KEY: snapshotKey '${jobData.snapshotKey}' không khớp expected '${expectedSnapshotKey}'.`,
      );
    }

    // 3. Authoritative N từ resultManifest.pages & Đối chiếu CleanBases (#157)
    const resultManifest = dbJob.resultManifest as {
      pages?: Array<{ page: number }>;
      cleanBases?: Array<{ page: number; cleanBaseKey: string }>;
    } | null;

    if (
      !resultManifest ||
      !Array.isArray(resultManifest.pages) ||
      resultManifest.pages.length === 0
    ) {
      throw new UnrecoverableError(
        `MISSING_RESULT_MANIFEST_PAGES: Job ${jobId} không có resultManifest.pages hợp lệ.`,
      );
    }

    const cleanBases = resultManifest.cleanBases;
    if (!Array.isArray(cleanBases) || cleanBases.length === 0) {
      throw new UnrecoverableError(
        `MISSING_CLEAN_BASES: Job ${jobId} không có cleanBases trong resultManifest. Re-render yêu cầu authoritative cleanBases (#162).`,
      );
    }

    const expectedPagesCount = resultManifest.pages.length;
    if (cleanBases.length !== expectedPagesCount) {
      throw new UnrecoverableError(
        `CLEAN_BASES_PAGE_MISMATCH: cleanBases count (${cleanBases.length}) != pages count (${expectedPagesCount}).`,
      );
    }

    const cleanBasesSorted = [...cleanBases].sort((a, b) => a.page - b.page);
    for (let i = 0; i < expectedPagesCount; i++) {
      const expectedPage = i + 1;
      if (
        cleanBasesSorted[i].page !== expectedPage ||
        !cleanBasesSorted[i].cleanBaseKey
      ) {
        throw new UnrecoverableError(
          `CLEAN_BASES_INCOMPLETE: cleanBases không khớp thứ tự 1..${expectedPagesCount} hoặc thiếu cleanBaseKey tại page ${expectedPage}.`,
        );
      }
    }

    // 4. Sinh Presigned URLs an toàn qua StorageService (TTL 3600s)
    const snapshotUrl = await this.storageService.createInternalDownloadUrl(
      jobData.snapshotKey,
      true,
      3600,
    );

    const pageRequests = await Promise.all(
      cleanBasesSorted.map(async (cb) => ({
        pageNumber: cb.page,
        cleanBaseUrl: await this.storageService.createInternalDownloadUrl(
          cb.cleanBaseKey,
          true,
          3600,
        ),
        outputUploadUrl: await this.storageService.createInternalUploadUrl(
          `${jobData.outputPrefix}page_${cb.page}.webp`,
          'image/webp',
          true,
          3600,
        ),
        storageKey: `${jobData.outputPrefix}page_${cb.page}.webp`,
      })),
    );

    // 5. Dispatch tới AI Worker với bounded timeout
    const aiWorkerBaseUrl = this.configService.get<string>(
      'AI_WORKER_BASE_URL',
      'http://localhost:8001',
    );
    const aiWorkerSecret = this.configService.get<string>('AI_WORKER_SECRET');
    const workerTimeoutMs = this.configService.get<number>(
      'AI_WORKER_MATERIALIZATION_TIMEOUT_MS',
      120_000,
    );
    const endpoint = `${aiWorkerBaseUrl}/internal/v1/jobs/materialize-manga`;

    const payload = {
      jobId,
      targetRevision,
      snapshotUrl,
      snapshotSha256: jobData.snapshotSha256,
      pages: pageRequests,
    };

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Key': aiWorkerSecret || '',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(workerTimeoutMs),
      });
    } catch (err: any) {
      const isTimeout =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError';

      this.logger.error(
        `[MaterializationProcessor] Lỗi ${isTimeout ? 'timeout' : 'mạng'} khi gọi AI Worker ${endpoint}: ${err.message}`,
      );
      // Timeout là lỗi tạm thời (transient Error) để BullMQ retry, không ném UnrecoverableError
      throw new Error(
        isTimeout
          ? `AI_WORKER_TIMEOUT: exceeded ${workerTimeoutMs}ms`
          : `AI_WORKER_NETWORK_ERROR: ${err.message}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const status = response.status;
      // Deterministic failure: 400, 401, 403, 404, 409, 422
      if ([400, 401, 403, 404, 409, 422].includes(status)) {
        this.logger.error(
          `[MaterializationProcessor] AI Worker trả lỗi bất biến ${status}: ${errorText}`,
        );
        throw new UnrecoverableError(
          `AI_WORKER_DETERMINISTIC_ERROR: ${status} - ${errorText}`,
        );
      }
      // Transient failure: 408, 429, 5xx
      this.logger.warn(
        `[MaterializationProcessor] AI Worker trả lỗi tạm thời ${status}: ${errorText}`,
      );
      throw new Error(`AI_WORKER_TRANSIENT_ERROR: ${status} - ${errorText}`);
    }

    this.logger.log(
      `[MaterializationProcessor] Dispatch materialize-manga thành công cho job ${jobId} rev ${targetRevision}`,
    );
  }
}
