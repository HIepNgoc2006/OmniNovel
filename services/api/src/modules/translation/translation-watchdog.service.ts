import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TranslationJobStatus } from '@omninovel/shared';
import { TranslationJob } from './entities/translation-job.entity';
import { TranslationProcessor } from './translation.processor';

@Injectable()
export class TranslationWatchdogService {
  private readonly logger = new Logger(TranslationWatchdogService.name);

  constructor(
    @InjectRepository(TranslationJob)
    private jobRepo: Repository<TranslationJob>,
    @InjectQueue('translation')
    private translationQueue: Queue,
    private processor: TranslationProcessor,
  ) {}

  /**
   * 1. Reconcile các job bị kẹt ở VALIDATING do lỗi enqueue ban đầu
   */
  async reconcileValidatingJobs() {
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    const stuckJobs = await this.jobRepo.find({
      where: {
        status: TranslationJobStatus.VALIDATING,
        createdAt: LessThan(thirtySecondsAgo),
      },
    });

    for (const job of stuckJobs) {
      try {
        const existingQueueJob = await this.translationQueue.getJob(job.id);
        if (!existingQueueJob) {
          await this.translationQueue.add(
            'process',
            { translationJobId: job.id },
            {
              jobId: job.id,
              attempts: 3,
              backoff: { type: 'exponential', delay: 2000 },
            },
          );
        }
        job.status = TranslationJobStatus.QUEUED;
        await this.jobRepo.save(job);
        this.logger.log(
          `[Watchdog Reconciler] Đã phục hồi và đưa TranslationJob ${job.id} vào hàng đợi QUEUED.`,
        );
      } catch (err: any) {
        this.logger.error(
          `[Watchdog Reconciler] Lỗi phục hồi job ${job.id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * 2. Kiểm tra heartbeat của các job đang xử lý (heartbeat > 60s)
   */
  async checkStalledJobs() {
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
    const activeStatuses = [
      TranslationJobStatus.PREPROCESSING,
      TranslationJobStatus.OCR,
      TranslationJobStatus.TRANSLATING,
      TranslationJobStatus.INPAINTING,
      TranslationJobStatus.TYPESETTING,
      TranslationJobStatus.QUALITY_CHECK,
    ];

    const stalledJobs = await this.jobRepo.find({
      where: {
        status: In(activeStatuses),
        heartbeatAt: LessThan(sixtySecondsAgo),
      },
    });

    for (const job of stalledJobs) {
      this.logger.warn(
        `[Watchdog] Phát hiện TranslationJob ${job.id} bị mất heartbeat quá 60s (Lần heartbeat cuối: ${job.heartbeatAt}). Kích hoạt abort attempt hiện tại để BullMQ xử lý retry.`,
      );
      // Abort attempt hiện tại -> Processor catch lỗi -> BullMQ retry theo chu trình chuẩn
      this.processor.abortAttempt(job.id);
    }
  }
}
