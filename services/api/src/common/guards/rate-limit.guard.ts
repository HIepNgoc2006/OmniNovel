import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../redis/redis.service';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from '../decorators/rate-limit.decorator';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return true; // Không cấu hình rate limit riêng -> Bỏ qua
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const clientIp =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.ip ||
      '127.0.0.1';

    const userId = request.user?.id;
    const prefix = options.keyPrefix || 'global';

    let rateLimitKey: string;
    if (options.scope === 'USER' && userId) {
      rateLimitKey = `ratelimit:${prefix}:user:${userId}`;
    } else if (options.scope === 'IP_AND_USER' && userId) {
      rateLimitKey = `ratelimit:${prefix}:user:${userId}`;
    } else {
      rateLimitKey = `ratelimit:${prefix}:ip:${clientIp}`;
    }

    const result = await this.redisService.checkRateLimit(
      rateLimitKey,
      options.limit,
      options.ttlSeconds,
    );

    // Gắn Headers theo tiêu chuẩn RFC 6585 & IETF RateLimit Headers
    response.setHeader('X-RateLimit-Limit', result.limit.toString());
    response.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    response.setHeader('X-RateLimit-Reset', result.resetTime.toString());

    if (!result.allowed) {
      const retryAfter = Math.max(
        1,
        result.resetTime - Math.floor(Date.now() / 1000),
      );
      response.setHeader('Retry-After', retryAfter.toString());

      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: `Bạn đã vượt quá giới hạn tần suất yêu cầu (${options.limit} req / ${options.ttlSeconds}s). Vui lòng thử lại sau ${retryAfter} giây.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
