import { MetricsService } from '../metrics.service';

describe('MetricsService (Gate 6.4.4)', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should initialize default prom-client process metrics', async () => {
    const exposition = await service.getMetrics();
    expect(exposition).toContain('process_resident_memory_bytes');
    expect(exposition).toContain('nodejs_eventloop_lag_seconds');
  });

  it('should record HTTP requests with counter and histogram', async () => {
    service.recordHttpRequest('GET', '/api/v1/stories/:id', 200, 0.045);

    const exposition = await service.getMetrics();
    expect(exposition).toContain('http_requests_total{method="GET",route="/api/v1/stories/:id",status_code="200"} 1');
    expect(exposition).toContain('http_request_duration_seconds_bucket');
    expect(exposition).toContain('http_request_duration_seconds_count{method="GET",route="/api/v1/stories/:id",status_code="200"} 1');
  });

  it('should reflect all 3 queues in bullmq gauges with queue label', async () => {
    service.updateQueueMetrics('translation', {
      active: 2,
      waiting: 5,
      failed: 1,
      completed: 10,
      delayed: 0,
    });

    service.updateQueueMetrics('translation-materialization', {
      active: 1,
      waiting: 0,
      failed: 0,
      completed: 4,
      delayed: 0,
    });

    service.updateQueueMetrics('chapter-packaging', {
      active: 0,
      waiting: 3,
      failed: 0,
      completed: 12,
      delayed: 0,
    });

    const exposition = await service.getMetrics();

    // Verify queue label semantics
    expect(exposition).toContain('bullmq_jobs_active{queue="translation"} 2');
    expect(exposition).toContain('bullmq_jobs_waiting{queue="translation"} 5');
    expect(exposition).toContain('bullmq_jobs_failed{queue="translation"} 1');

    expect(exposition).toContain('bullmq_jobs_active{queue="translation-materialization"} 1');
    expect(exposition).toContain('bullmq_jobs_completed{queue="translation-materialization"} 4');

    expect(exposition).toContain('bullmq_jobs_waiting{queue="chapter-packaging"} 3');
    expect(exposition).toContain('bullmq_jobs_completed{queue="chapter-packaging"} 12');
  });

  it('should execute registered async collector hook on getMetrics()', async () => {
    let hookExecuted = false;
    service.registerCollectCallback(async () => {
      hookExecuted = true;
      service.updateQueueMetrics('translation', {
        active: 9,
        waiting: 0,
        failed: 0,
        completed: 0,
        delayed: 0,
      });
    });

    const exposition = await service.getMetrics();
    expect(hookExecuted).toBe(true);
    expect(exposition).toContain('bullmq_jobs_active{queue="translation"} 9');
  });

  it('should initialize and update BullMQ collection status gauges (P1)', async () => {
    let exposition = await service.getMetrics();
    expect(exposition).toContain('bullmq_metrics_collection_success{queue="translation"} 1');
    expect(exposition).toContain('bullmq_metrics_last_success_timestamp_seconds{queue="translation"}');

    // Simulate failure on translation queue scrape (e.g. Redis disconnect)
    service.recordQueueCollectionStatus('translation', false);

    exposition = await service.getMetrics();
    expect(exposition).toContain('bullmq_metrics_collection_success{queue="translation"} 0');
  });
});
