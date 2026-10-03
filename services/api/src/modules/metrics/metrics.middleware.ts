import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { MetricsService } from './metrics.service';
import { normalizeRoute } from './utils/route-normalizer';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metricsService: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // Exclude scraper calls to /metrics itself
    if (req.path === '/metrics' || req.originalUrl === '/metrics') {
      return next();
    }

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const elapsedNs = process.hrtime.bigint() - start;
      const durationSeconds = Number(elapsedNs) / 1e9;
      const route = normalizeRoute(req);
      const statusCode = res.statusCode || 200;

      this.metricsService.recordHttpRequest(req.method, route, statusCode, durationSeconds);
    });

    next();
  }
}
