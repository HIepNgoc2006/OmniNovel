import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit_options';

export type RateLimitScope = 'IP' | 'USER' | 'IP_OR_USER' | 'IP_AND_USER';

export interface RateLimitOptions {
  limit: number; // Số request tối đa
  ttlSeconds: number; // Cửa sổ thời gian tính bằng giây
  keyPrefix?: string; // Tiền tố phân biệt endpoint (auth, anti-leech, uploads...)
  scope?: RateLimitScope; // Phạm vi giới hạn (IP, USER, IP_OR_USER, hoặc IP_AND_USER)
  routeParam?: string; // Tham số route để cô lập hạn ngạch (ví dụ: 'id' cho per-chapter rate limit)
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
