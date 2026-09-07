import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TranslationJob } from './entities/translation-job.entity';
import { MaterializationJobData, TranslationJobStatus } from '@omninovel/shared';
import { StorageService } from '../storage/storage.service';
import { TranslationService } from './translation.service';

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

@Injectable()
@Processor('translation-materialization')
export class TranslationMaterializationProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslationMaterializationProcessor.name);

  constructor(
    private readonly translationService: TranslationService,
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
  }
}
