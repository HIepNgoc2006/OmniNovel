import { BullmqMetricsCollector } from '../bullmq-metrics.collector';
import { MetricsService } from '../metrics.service';
import { Queue } from 'bullmq';

describe('BullmqMetricsCollector (Gate 6.4.4)', () => {
  let collector: BullmqMetricsCollector;
  let metricsService: MetricsService;
  let mockTranslationQueue: jest.Mocked<Partial<Queue>>;
  let mockMaterializationQueue: jest.Mocked<Partial<Queue>>;
  let mockPackagingQueue: jest.Mocked<Partial<Queue>>;

  beforeEach(() => {
    metricsService = new MetricsService();
    jest.spyOn(metricsService, 'updateQueueMetrics');
    jest.spyOn(metricsService, 'recordQueueCollectionStatus');

    mockTranslationQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        active: 3,
        waiting: 7,
        failed: 1,
        completed: 25,
        delayed: 2,
      }),
    };

    mockMaterializationQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        active: 1,
        waiting: 2,
        failed: 0,
        completed: 10,
        delayed: 0,
      }),
    };

    mockPackagingQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        active: 0,
        waiting: 4,
        failed: 0,
        completed: 15,
        delayed: 1,
      }),
    };

    collector = new BullmqMetricsCollector(
      mockTranslationQueue as unknown as Queue,
      mockMaterializationQueue as unknown as Queue,
      mockPackagingQueue as unknown as Queue,
      metricsService,
    );
  });

  afterEach(() => {
    metricsService.onModuleDestroy();
  });

  it('should query all 3 queues and update metrics with queue label and success status', async () => {
    await collector.collect();

    expect(mockTranslationQueue.getJobCounts).toHaveBeenCalled();
    expect(mockMaterializationQueue.getJobCounts).toHaveBeenCalled();
    expect(mockPackagingQueue.getJobCounts).toHaveBeenCalled();

    expect(metricsService.updateQueueMetrics).toHaveBeenCalledWith('translation', {
      active: 3,
      waiting: 7,
      failed: 1,
      completed: 25,
      delayed: 2,
    });

    expect(metricsService.updateQueueMetrics).toHaveBeenCalledWith('translation-materialization', {
      active: 1,
      waiting: 2,
      failed: 0,
      completed: 10,
      delayed: 0,
    });

    expect(metricsService.updateQueueMetrics).toHaveBeenCalledWith('chapter-packaging', {
      active: 0,
      waiting: 4,
      failed: 0,
      completed: 15,
      delayed: 1,
    });

    // Verify P1 success status tracking
    expect(metricsService.recordQueueCollectionStatus).toHaveBeenCalledWith('translation', true, expect.any(Number));
    expect(metricsService.recordQueueCollectionStatus).toHaveBeenCalledWith('translation-materialization', true, expect.any(Number));
    expect(metricsService.recordQueueCollectionStatus).toHaveBeenCalledWith('chapter-packaging', true, expect.any(Number));
  });

  it('should handle queue query errors gracefully and mark collection status as false (P1)', async () => {
    mockTranslationQueue.getJobCounts = jest.fn().mockRejectedValue(new Error('Redis connection timeout'));

    await expect(collector.collect()).resolves.not.toThrow();

    expect(metricsService.recordQueueCollectionStatus).toHaveBeenCalledWith('translation', false);
  });
});
