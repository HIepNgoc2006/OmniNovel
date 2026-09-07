import { z } from 'zod';

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(8000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_BASE_URL: z.string().default('http://localhost:8000'),
    WEB_BASE_URL: z.string().default('http://localhost:3000'),

    // PostgreSQL
    DB_HOST: z.string().default('localhost'),
    DB_PORT: z.coerce.number().default(5433),
    DB_USER: z.string().default('postgres'),
    DB_PASSWORD: z.string().default('postgres_password_secure'),
    DB_NAME: z.string().default('omninovel_db'),

    // Redis
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().default(6379),
    REDIS_PASSWORD: z.string().optional().default(''),

    // MinIO
    MINIO_ENDPOINT: z.string().default('localhost'),
    MINIO_PORT: z.coerce.number().default(9000),
    MINIO_USE_SSL: z.string().transform((v) => v === 'true').default('false'),
    MINIO_ACCESS_KEY: z.string().default('minioadmin'),
    MINIO_SECRET_KEY: z.string().default('minioadmin'),
    MINIO_BUCKET_MANGA: z.string().default('manga-media'),
    MINIO_BUCKET_NOVEL: z.string().default('novel-media'),

    // Auth & Security (Access Token 15m)
    JWT_SECRET: z.string().default('super_secret_jwt_key_omninovel_2026'),
    JWT_EXPIRATION: z.string().default('15m'),
    JWT_REFRESH_SECRET: z.string().default('super_secret_refresh_jwt_key_2026'),
    JWT_REFRESH_EXPIRATION: z.string().default('7d'),

    // AI Worker Service (Internal RPC)
    AI_WORKER_BASE_URL: z.string().default('http://localhost:8001'),
    AI_WORKER_SECRET: z.string().default('internal_ai_worker_secret_secure_2026'),
    AI_WORKER_MATERIALIZATION_TIMEOUT_MS: z.coerce.number().default(120000),
  })
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        const isDefaultJwt = data.JWT_SECRET.includes('super_secret');
        const isDefaultRefresh = data.JWT_REFRESH_SECRET.includes('super_secret');
        const isDefaultDbPass = data.DB_PASSWORD === 'postgres_password_secure';
        const isDefaultAiSecret = data.AI_WORKER_SECRET.includes('internal_ai_worker_secret');
        if (isDefaultJwt || isDefaultRefresh || isDefaultDbPass || isDefaultAiSecret) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        'CẢNH BÁO AN NINH: Không được phép sử dụng mật khẩu/secret mặc định trên môi trường Production.',
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Environment validation error: ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
