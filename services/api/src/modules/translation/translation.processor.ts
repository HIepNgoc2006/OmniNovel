import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TranslationService } from './translation.service';

@Injectable()
@Processor('translation')
export class TranslationProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslationProcessor.name);
  public readonly activeAbortControllers: Map<string, AbortController> =
    new Map();

  constructor(
    private readonly translationService: TranslationService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  /**
   * Cho phép Watchdog hủy attempt đang chạy khi heartbeat quá 60s
   */
  abortAttempt(translationJobId: string): boolean {
    const controller = this.activeAbortControllers.get(translationJobId);
    if (controller) {
      this.logger.warn(
        `Watchdog aborting active worker attempt for TranslationJob ${translationJobId}`,
      );
      controller.abort();
      this.activeAbortControllers.delete(translationJobId);
      return true;
    }
    return false;
  }

  async process(job: Job<{ translationJobId: string }>): Promise<any> {
    const { translationJobId } = job.data;
    const attemptNumber = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts || 3;

    this.logger.log(
      `[BullMQ] Bắt đầu xử lý TranslationJob ${translationJobId} (Attempt ${attemptNumber}/${maxAttempts})`,
    );

    // 1. Reset sequence = 0 và cập nhật attemptCount trong DB
    await this.translationService.startAttempt(translationJobId, attemptNumber);

    // 2. Tạo AbortController cho attempt hiện tại
    const abortController = new AbortController();
    this.activeAbortControllers.set(translationJobId, abortController);

    const aiWorkerBaseUrl = this.configService.get<string>(
      'AI_WORKER_BASE_URL',
      'http://localhost:8001',
    );
    const aiWorkerSecret = this.configService.get<string>(
      'AI_WORKER_SECRET',
      'internal_ai_worker_secret_secure_2026',
    );

    try {
      const response = await fetch(
        `${aiWorkerBaseUrl}/internal/v1/jobs/process-manga`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Key': aiWorkerSecret,
          },
          body: JSON.stringify({
            jobId: translationJobId,
            attemptNumber,
            outputPrefix: `ai/jobs/${translationJobId}/attempt-${attemptNumber}/`,
          }),
          signal: abortController.signal,
        },
      );

      this.activeAbortControllers.delete(translationJobId);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(
          `AI Worker trả về mã lỗi HTTP ${response.status}: ${errBody}`,
        );
      }

      const result = await response.json();
      this.logger.log(
        `[BullMQ] Hoàn thành xử lý TranslationJob ${translationJobId} qua FastAPI Worker.`,
      );
      return result;
    } catch (err: any) {
      this.activeAbortControllers.delete(translationJobId);
      this.logger.error(
        `[BullMQ] Lỗi khi xử lý TranslationJob ${translationJobId} ở attempt ${attemptNumber}: ${err.message}`,
      );

      // Nếu đã đạt max attempts -> Cập nhật FAILED trong DB
      if (attemptNumber >= maxAttempts) {
        this.logger.error(
          `[BullMQ] Đã đạt giới hạn tối đa ${maxAttempts} attempts cho TranslationJob ${translationJobId}. Đánh dấu FAILED.`,
        );
        await this.translationService.handleJobFailure(
          translationJobId,
          `Đã thử ${maxAttempts} lần nhưng thất bại: ${err.message}`,
        );
      }

      // Rethrow để BullMQ kích hoạt retry backoff nếu chưa đạt max attempts
      throw err;
    }
  }
}
