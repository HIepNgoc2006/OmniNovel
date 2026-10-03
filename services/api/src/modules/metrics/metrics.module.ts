import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { BullmqMetricsCollector } from './bullmq-metrics.collector';
import { MetricsMiddleware } from './metrics.middleware';

@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'translation' },
      { name: 'translation-materialization' },
      { name: 'chapter-packaging' },
    ),
  ],
  controllers: [MetricsController],
  providers: [MetricsService, BullmqMetricsCollector, MetricsMiddleware],
  exports: [MetricsService, MetricsMiddleware],
})
export class MetricsModule {}
