import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number; // Unix epoch seconds
  limit: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD', '');

    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      lazyConnect: false,
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    if (ttlSeconds) {
      return this.client.set(key, value, 'EX', ttlSeconds);
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async setnx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  // Atomic compare-and-delete lock release bằng Lua script
  async releaseLock(key: string, token: string): Promise<boolean> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const res = await this.client.eval(luaScript, 1, key, token);
    return res === 1;
  }

  // Sliding Window Rate Limiting bằng Lua script nguyên tử với resetTime tính theo request cũ nhất
  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])

      local clearBefore = now - windowMs
      redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)
      local currentRequests = redis.call('ZCARD', key)

      if currentRequests < limit then
        redis.call('ZADD', key, now, now .. ':' .. math.random(10000, 99999))
        redis.call('EXPIRE', key, math.ceil(windowMs / 1000) + 2)
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local oldestScore = tonumber(oldest[2]) or now
        local resetTime = math.ceil((oldestScore + windowMs) / 1000)
        return { 1, limit - currentRequests - 1, resetTime }
      else
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local oldestScore = tonumber(oldest[2]) or now
        local resetTime = math.ceil((oldestScore + windowMs) / 1000)
        return { 0, 0, resetTime }
      end
    `;

    const res = (await this.client.eval(
      luaScript,
      1,
      key,
      now.toString(),
      windowMs.toString(),
      limit.toString(),
    )) as [number, number, number];

    return {
      allowed: res[0] === 1,
      remaining: Math.max(0, res[1]),
      resetTime: res[2],
      limit,
    };
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
