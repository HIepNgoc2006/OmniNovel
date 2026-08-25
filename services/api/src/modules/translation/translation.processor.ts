import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TranslationService } from './translation.service';

@Injectable()
@Processor('translation')
export class TranslationProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslationProcessor.name);
  public readonly activeAbortControllers: Map<string, AbortController> =
    new Map();
  public readonly abortReasons: Map<string, 'STALLED' | 'CANCELED'> =
    new Map();

  constructor(
    @Inject(forwardRef(() => TranslationService))
    private readonly translationService: TranslationService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  /**
   * Cho phép Watchdog hoặc User Cancel hủy attempt đang chạy.
   */
  abortAttempt(
    translationJobId: string,
    reason: 'STALLED' | 'CANCELED' = 'STALLED',
  ): boolean {
    const controller = this.activeAbortControllers.get(translationJobId);
    if (controller) {
      this.logger.warn(
        `[BullMQ] Aborting active worker attempt for TranslationJob ${translationJobId} (Reason: ${reason})`,
      );
      this.abortReasons.set(translationJobId, reason);
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

    // 1. Reset sequence = 0 và cập nhật attemptCount trong DB qua anti-resurrection guard
    const jobContext = await this.translationService.startAttempt(
      translationJobId,
      attemptNumber,
    );

    if (!jobContext) {
      this.logger.warn(
        `[BullMQ] TranslationJob ${translationJobId} đã ở trạng thái Terminal/CANCELED. Dừng xử lý attempt ${attemptNumber}.`,
      );
      return { skipped: true, reason: 'JOB_TERMINAL_OR_CANCELED' };
    }

    // 2. Tạo AbortController cho attempt hiện tại
    const abortController = new AbortController();
    this.activeAbortControllers.set(translationJobId, abortController);

    const aiWorkerBaseUrl = this.configService.get<string>(
      'AI_WORKER_BASE_URL',
      'http://localhost:8001',
    );
    const aiWorkerSecret = this.configService.get<string>('AI_WORKER_SECRET');

    // Dynamic routing: Manga vs Novel
    const endpoint =
      jobContext.mediaFormat === 'NOVEL'
        ? `${aiWorkerBaseUrl}/internal/v1/jobs/process-novel`
        : `${aiWorkerBaseUrl}/internal/v1/jobs/process-manga`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Key': aiWorkerSecret || '',
        },
        body: JSON.stringify({
          jobId: translationJobId,
          attemptNumber,
          sourceDownloadUrl: jobContext.sourceDownloadUrl,
          outputPrefix: `ai/jobs/${translationJobId}/attempt-${attemptNumber}/`,
          sourceLang: jobContext.sourceLang,
          targetLang: jobContext.targetLang,
          inputManifest: jobContext.inputManifest,
        }),
        signal: abortController.signal,
      });

      this.activeAbortControllers.delete(translationJobId);
      this.abortReasons.delete(translationJobId);

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
      const reason = this.abortReasons.get(translationJobId);
      this.abortReasons.delete(translationJobId);

      // Nếu bị hủy bởi User Cancel -> Không retry, không ghi đè FAILED
      if (reason === 'CANCELED') {
        this.logger.warn(
          `[BullMQ] TranslationJob ${translationJobId} đã bị hủy bởi người dùng. Bỏ qua retry.`,
        );
        return { canceled: true };
      }

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
