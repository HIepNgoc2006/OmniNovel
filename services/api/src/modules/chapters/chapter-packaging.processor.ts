import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { CanonicalPackagingService } from './canonical-packaging.service';
import { RedisService } from '../../redis/redis.service';
import { ChapterArtifactType } from '@omninovel/shared';

export interface PackagingJobPayload {
  chapterId: string;
  chapterVersionId: string;
  artifactType: ChapterArtifactType;
}

@Processor('chapter-packaging')
export class ChapterPackagingProcessor extends WorkerHost {
  private readonly logger = new Logger(ChapterPackagingProcessor.name);

  constructor(
    private readonly packagingService: CanonicalPackagingService,
    private readonly redisService: RedisService,
  ) {
    super();
  }

  async process(job: Job<PackagingJobPayload>): Promise<void> {
    const { chapterId, chapterVersionId, artifactType } = job.data;
    const lockKey = `lock:package:${chapterVersionId}:${artifactType}`;
    const lockToken = uuidv4();

    // 1. Acquire early Redis lock
    const acquired = await this.redisService.setnx(lockKey, lockToken, 120);
    if (!acquired) {
      this.logger.warn(
        `[BullMQ Packaging] Lock already held for ${chapterVersionId}:${artifactType}, skipping concurrent run`,
      );
      return;
    }

    // 2. Setup periodic lease renewal every 30s
    const renewInterval = setInterval(async () => {
      try {
        await this.redisService.renewLock(lockKey, lockToken, 120);
      } catch (err: any) {
        this.logger.warn(
          `[BullMQ Packaging] Failed to renew lease for ${lockKey}: ${err.message}`,
        );
      }
    }, 30000);

    try {
      await this.packagingService.processPackagingJob({
        chapterId,
        chapterVersionId,
        artifactType,
      });
    } catch (err: any) {
      const attemptsMade = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts || 3;
      this.logger.error(
        `[BullMQ Packaging] Error processing job ${job.id} (attempt ${attemptsMade}/${maxAttempts}): ${err.message}`,
        err.stack,
      );
      if (attemptsMade >= maxAttempts) {
        await this.packagingService.markArtifactFailed(
          chapterVersionId,
          artifactType,
          err.message || 'Unknown packaging error',
        );
      }
      throw err; // Let BullMQ handle attempts / backoff
    } finally {
      clearInterval(renewInterval);
      try {
        await this.redisService.releaseLock(lockKey, lockToken);
      } catch (e: any) {
        this.logger.warn(
          `[BullMQ Packaging] Error releasing lock ${lockKey}: ${e.message}`,
        );
      }
    }
  }
}
