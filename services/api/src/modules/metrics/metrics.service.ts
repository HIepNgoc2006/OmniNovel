import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as client from 'prom-client';

export interface QueueJobCounts {
  active: number;
  waiting: number;
  failed: number;
  completed: number;
  delayed: number;
}

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry: client.Registry;

  private readonly httpRequestsTotal: client.Counter<'method' | 'route' | 'status_code'>;
  private readonly httpRequestDuration: client.Histogram<'method' | 'route' | 'status_code'>;

  private readonly bullmqJobsActive: client.Gauge<'queue'>;
  private readonly bullmqJobsWaiting: client.Gauge<'queue'>;
  private readonly bullmqJobsFailed: client.Gauge<'queue'>;
  private readonly bullmqJobsCompleted: client.Gauge<'queue'>;
  private readonly bullmqJobsDelayed: client.Gauge<'queue'>;
  private readonly bullmqCollectionSuccess: client.Gauge<'queue'>;
  private readonly bullmqLastSuccessTimestamp: client.Gauge<'queue'>;

  private collectCallbacks: (() => Promise<void>)[] = [];

  constructor() {
    this.registry = new client.Registry();

    // 1. Process & Node.js default metrics (RSS memory, heap, event loop lag, CPU)
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: '',
    });

    // 2. HTTP Request Counter (RED: Rate & Errors)
    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total count of processed HTTP requests by method, normalized route and status code',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // 3. HTTP Request Latency Histogram (RED: Duration)
    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds for percentile calculations (p50, p95, p99)',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // 4. BullMQ Gauges with explicit 'queue' label
    this.bullmqJobsActive = new client.Gauge({
      name: 'bullmq_jobs_active',
      help: 'Number of active BullMQ jobs currently being processed',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.bullmqJobsWaiting = new client.Gauge({
      name: 'bullmq_jobs_waiting',
      help: 'Number of waiting BullMQ jobs queued for execution',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.bullmqJobsFailed = new client.Gauge({
      name: 'bullmq_jobs_failed',
      help: 'Number of failed BullMQ jobs',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.bullmqJobsCompleted = new client.Gauge({
      name: 'bullmq_jobs_completed',
      help: 'Number of completed BullMQ jobs in history',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.bullmqJobsDelayed = new client.Gauge({
      name: 'bullmq_jobs_delayed',
      help: 'Number of delayed BullMQ jobs scheduled for future run',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    // 5. BullMQ Collector Health & Freshness Gauges (P1 Remediation)
    this.bullmqCollectionSuccess = new client.Gauge({
      name: 'bullmq_metrics_collection_success',
      help: 'Status of BullMQ metrics collection for queue (1 = success, 0 = failure / Redis down)',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.bullmqLastSuccessTimestamp = new client.Gauge({
      name: 'bullmq_metrics_last_success_timestamp_seconds',
      help: 'Unix timestamp in seconds of last successful BullMQ metrics scrape for queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    // Initialize the 3 core queues to 0 so gauges exist in exposition output from startup
    const initialQueues = ['translation', 'translation-materialization', 'chapter-packaging'];
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const q of initialQueues) {
      this.updateQueueMetrics(q, {
        active: 0,
        waiting: 0,
        failed: 0,
        completed: 0,
        delayed: 0,
      });
      this.bullmqCollectionSuccess.set({ queue: q }, 1);
      this.bullmqLastSuccessTimestamp.set({ queue: q }, nowSeconds);
    }
  }

  onModuleDestroy() {
    this.registry.clear();
  }

  /**
   * Registers an async collector hook invoked immediately prior to exposition
   */
  registerCollectCallback(cb: () => Promise<void>): void {
    this.collectCallbacks.push(cb);
  }

  /**
   * Records an HTTP request duration and increments the counter
   */
  recordHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = {
      method: method.toUpperCase(),
      route,
      status_code: statusCode.toString(),
    };
    this.httpRequestsTotal.inc(labels, 1);
    this.httpRequestDuration.observe(labels, durationSeconds);
  }

  /**
   * Updates BullMQ gauge values for a given queue
   */
  updateQueueMetrics(queue: string, counts: QueueJobCounts): void {
    this.bullmqJobsActive.set({ queue }, counts.active);
    this.bullmqJobsWaiting.set({ queue }, counts.waiting);
    this.bullmqJobsFailed.set({ queue }, counts.failed);
    this.bullmqJobsCompleted.set({ queue }, counts.completed);
    this.bullmqJobsDelayed.set({ queue }, counts.delayed);
  }

  /**
   * Records BullMQ collection success status and freshness timestamp (P1)
   */
  recordQueueCollectionStatus(queue: string, success: boolean, timestampSeconds?: number): void {
    this.bullmqCollectionSuccess.set({ queue }, success ? 1 : 0);
    if (success && timestampSeconds !== undefined) {
      this.bullmqLastSuccessTimestamp.set({ queue }, timestampSeconds);
    }
  }

  /**
   * Returns Prometheus exposition text format
   */
  async getMetrics(): Promise<string> {
    for (const cb of this.collectCallbacks) {
      try {
        await cb();
      } catch (err: any) {
        this.logger.warn(`Error running collector callback: ${err?.message || err}`);
      }
    }
    return this.registry.metrics();
  }

  /**
   * Returns standard Prometheus Content-Type header
   */
  get contentType(): string {
    return this.registry.contentType;
  }

  /**
   * Expose registry for testing and inspection
   */
  getRegistry(): client.Registry {
    return this.registry;
  }
}
