import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService, RateLimitResult } from '../../redis/redis.service';
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

    // 1. Xác định Client IP an toàn (Chặn IP spoofing qua arbitrary X-Forwarded-For trong Production)
    const isProd = process.env.NODE_ENV === 'production';
    const clientIp = isProd
      ? request.ip || '127.0.0.1'
      : (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        request.ip ||
        '127.0.0.1';

    const userId = request.user?.id;
    let prefix = options.keyPrefix || 'global';

    // Xử lý routeParam để cô lập bucket theo tài nguyên (ví dụ: per-chapter)
    // Nếu decorator yêu cầu routeParam mà param không tồn tại trong request: fail predictably
    if (options.routeParam) {
      const paramVal = request.params?.[options.routeParam];
      if (!paramVal) {
        throw new InternalServerErrorException(
          `Rate limit routeParam '${options.routeParam}' is missing from request params`,
        );
      }
      prefix = `${prefix}:${options.routeParam}_${paramVal}`;
    }

    const scope = options.scope || 'IP_OR_USER';

    let primaryResult: RateLimitResult;

    // 2. Phân xử Semantics theo đúng Scope đã định nghĩa
    if (scope === 'USER') {
      if (!userId) {
        return true;
      }
      const userKey = `ratelimit:${prefix}:user:${userId}`;
      primaryResult = await this.redisService.checkRateLimit(
        userKey,
        options.limit,
        options.ttlSeconds,
      );
    } else if (scope === 'IP') {
      const ipKey = `ratelimit:${prefix}:ip:${clientIp}`;
      primaryResult = await this.redisService.checkRateLimit(
        ipKey,
        options.limit,
        options.ttlSeconds,
      );
    } else if (scope === 'IP_OR_USER') {
      const key = userId
        ? `ratelimit:${prefix}:user:${userId}`
        : `ratelimit:${prefix}:ip:${clientIp}`;
      primaryResult = await this.redisService.checkRateLimit(
        key,
        options.limit,
        options.ttlSeconds,
      );
    } else if (scope === 'IP_AND_USER') {
      // Đúng nghĩa IP_AND_USER: Enforce đồng thời cả 2 bucket (User quota VÀ IP quota)
      const ipKey = `ratelimit:${prefix}:ip:${clientIp}`;
      const ipResult = await this.redisService.checkRateLimit(
        ipKey,
        options.limit * 2, // IP bucket rộng hơn cho trường hợp nhiều user chung NAT/Proxy
        options.ttlSeconds,
      );

      if (userId) {
        const userKey = `ratelimit:${prefix}:user:${userId}`;
        const userResult = await this.redisService.checkRateLimit(
          userKey,
          options.limit,
          options.ttlSeconds,
        );

        if (!userResult.allowed || !ipResult.allowed) {
          primaryResult = !userResult.allowed ? userResult : ipResult;
        } else {
          primaryResult = userResult;
        }
      } else {
        primaryResult = ipResult;
      }
    } else {
      const key = `ratelimit:${prefix}:ip:${clientIp}`;
      primaryResult = await this.redisService.checkRateLimit(
        key,
        options.limit,
        options.ttlSeconds,
      );
    }

    // Gắn Headers theo tiêu chuẩn RFC 6585 & IETF RateLimit Headers
    response.setHeader('X-RateLimit-Limit', primaryResult.limit.toString());
    response.setHeader('X-RateLimit-Remaining', primaryResult.remaining.toString());
    response.setHeader('X-RateLimit-Reset', primaryResult.resetTime.toString());

    if (!primaryResult.allowed) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const retryAfter = Math.max(1, primaryResult.resetTime - nowSeconds);
      response.setHeader('Retry-After', retryAfter.toString());

      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: `Bạn đã vượt quá giới hạn tần suất yêu cầu (${primaryResult.limit} req / ${options.ttlSeconds}s). Vui lòng thử lại sau ${retryAfter} giây.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
