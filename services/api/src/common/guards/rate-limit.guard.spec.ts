import { ExecutionContext, HttpStatus, HttpException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisService } from '../../redis/redis.service';
import { RateLimitOptions } from '../decorators/rate-limit.decorator';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: jest.Mocked<Reflector>;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    redisService = {
      checkRateLimit: jest.fn(),
    } as any;

    guard = new RateLimitGuard(reflector, redisService);
  });

  const createMockContext = (params: Record<string, any> = {}, user: any = { id: 'user-123' }, ip = '127.0.0.1') => {
    const mockRequest = {
      params,
      user,
      ip,
      headers: {},
    };
    const mockResponse = {
      setHeader: jest.fn(),
    };

    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;
  };

  it('phải bỏ qua nếu không có options cấu hình', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const context = createMockContext();

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(redisService.checkRateLimit).not.toHaveBeenCalled();
  });

  it('phải fail predictably (ném InternalServerErrorException) nếu routeParam được yêu cầu nhưng thiếu trong params', async () => {
    const options: RateLimitOptions = {
      limit: 3,
      ttlSeconds: 60,
      keyPrefix: 'chapter_report',
      routeParam: 'id',
      scope: 'USER',
    };
    reflector.getAllAndOverride.mockReturnValue(options);

    const context = createMockContext({}); // params rỗng, thiếu 'id'

    await expect(guard.canActivate(context)).rejects.toThrow(InternalServerErrorException);
    await expect(guard.canActivate(context)).rejects.toThrow(
      "Rate limit routeParam 'id' is missing from request params",
    );
  });

  it('phải phân lập bucket key theo routeParam (key isolation giữa các chapters)', async () => {
    const options: RateLimitOptions = {
      limit: 3,
      ttlSeconds: 60,
      keyPrefix: 'chapter_report',
      routeParam: 'id',
      scope: 'USER',
    };
    reflector.getAllAndOverride.mockReturnValue(options);

    redisService.checkRateLimit.mockResolvedValue({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetTime: Math.floor(Date.now() / 1000) + 60,
    });

    // Request chapter A
    const contextA = createMockContext({ id: 'chapter-A' }, { id: 'user-1' });
    await guard.canActivate(contextA);
    expect(redisService.checkRateLimit).toHaveBeenCalledWith(
      'ratelimit:chapter_report:id_chapter-A:user:user-1',
      3,
      60,
    );

    // Request chapter B
    const contextB = createMockContext({ id: 'chapter-B' }, { id: 'user-1' });
    await guard.canActivate(contextB);
    expect(redisService.checkRateLimit).toHaveBeenCalledWith(
      'ratelimit:chapter_report:id_chapter-B:user:user-1',
      3,
      60,
    );
  });

  it('phải ném 429 TOO_MANY_REQUESTS kèm retryAfter khi vượt quá limit', async () => {
    const options: RateLimitOptions = {
      limit: 3,
      ttlSeconds: 60,
      keyPrefix: 'chapter_report',
      routeParam: 'id',
      scope: 'USER',
    };
    reflector.getAllAndOverride.mockReturnValue(options);

    const nowSec = Math.floor(Date.now() / 1000);
    redisService.checkRateLimit.mockResolvedValue({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetTime: nowSec + 45,
    });

    const context = createMockContext({ id: 'chapter-A' }, { id: 'user-1' });

    try {
      await guard.canActivate(context);
      fail('Expected guard to throw HttpException');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const httpErr = err as HttpException;
      expect(httpErr.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const response = httpErr.getResponse() as any;
      expect(response.code).toBe('TOO_MANY_REQUESTS');
      expect(response.retryAfter).toBeGreaterThanOrEqual(44);
      expect(response.retryAfter).toBeLessThanOrEqual(46);
    }
  });
});
