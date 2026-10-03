import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MetricsService } from './metrics.service';

@Injectable()
export class BullmqMetricsCollector implements OnModuleInit {
  private readonly logger = new Logger(BullmqMetricsCollector.name);
  private readonly trackedQueues: { name: string; queue: Queue }[];

  constructor(
    @InjectQueue('translation') private readonly translationQueue: Queue,
    @InjectQueue('translation-materialization') private readonly materializationQueue: Queue,
    @InjectQueue('chapter-packaging') private readonly packagingQueue: Queue,
    private readonly metricsService: MetricsService,
  ) {
    this.trackedQueues = [
      { name: 'translation', queue: this.translationQueue },
      { name: 'translation-materialization', queue: this.materializationQueue },
      { name: 'chapter-packaging', queue: this.packagingQueue },
    ];
  }

  onModuleInit() {
    // Hook into metrics exposition lifecycle
    this.metricsService.registerCollectCallback(async () => {
      await this.collect();
    });

    // Run initial collection in background
    this.collect().catch((err) => {
      this.logger.warn(`Initial BullMQ metrics collection failed (will retry on scrape): ${err.message}`);
    });
  }

  async collect(): Promise<void> {
    for (const { name, queue } of this.trackedQueues) {
      try {
        if (!queue) continue;
        const counts = await queue.getJobCounts('active', 'waiting', 'failed', 'completed', 'delayed');
        this.metricsService.updateQueueMetrics(name, {
          active: counts.active ?? 0,
          waiting: counts.waiting ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          delayed: counts.delayed ?? 0,
        });
      } catch (err: any) {
        this.logger.debug(`Could not query BullMQ queue [${name}]: ${err?.message || err}`);
      }
    }
  }
}
