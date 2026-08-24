import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit_options';

export interface RateLimitOptions {
  limit: number; // Số request tối đa
  ttlSeconds: number; // Cửa sổ thời gian tính bằng giây
  keyPrefix?: string; // Tiền tố phân biệt endpoint (auth, anti-leech, uploads...)
  scope?: 'IP' | 'USER' | 'IP_AND_USER'; // Phạm vi giới hạn
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
