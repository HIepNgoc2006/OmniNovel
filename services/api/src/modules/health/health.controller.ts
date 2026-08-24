import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { RedisService } from '../../redis/redis.service';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(
    private redisService: RedisService,
    private dataSource: DataSource,
  ) {}

  @Get('live')
  getLive() {
    return { status: 'UP', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async getReady(@Res() res: Response) {
    let dbStatus = 'DOWN';
    let redisStatus = 'DOWN';

    try {
      if (this.dataSource.isInitialized) {
        await this.dataSource.query('SELECT 1');
        dbStatus = 'UP';
      }
    } catch {
      dbStatus = 'DOWN';
    }

    try {
      const pong = await this.redisService.getClient().ping();
      if (pong === 'PONG') {
        redisStatus = 'UP';
      }
    } catch {
      redisStatus = 'DOWN';
    }

    const isHealthy = dbStatus === 'UP' && redisStatus === 'UP';
    const status = isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(status).json({
      status: isHealthy ? 'UP' : 'DOWN',
      services: {
        database: dbStatus,
        redis: redisStatus,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
