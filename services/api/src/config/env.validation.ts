import { z } from 'zod';

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(8000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_BASE_URL: z.string().default('http://localhost:8000'),
    WEB_BASE_URL: z.string().default('http://localhost:3000'),

    // PostgreSQL Local
    DB_HOST: z.string().default('localhost'),
    DB_PORT: z.coerce.number().default(5433),
    DB_USER: z.string().default('postgres'),
    DB_PASSWORD: z.string().default('postgres_password_secure'),
    DB_NAME: z.string().default('omninovel_db'),

    // PostgreSQL Cloud / Supabase / SSL
    DATABASE_URL: z.string().optional(),
    DB_SSL: z
      .union([z.boolean(), z.string().transform((v) => v === 'true')])
      .default(false),

    // Redis
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().default(6379),
    REDIS_PASSWORD: z.string().optional().default(''),

    // Storage Provider & S3 / R2 Configuration
    STORAGE_PROVIDER: z.enum(['minio', 'r2']).default('minio'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_BUCKET_MANGA: z.string().optional(),
    S3_BUCKET_NOVEL: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .union([z.boolean(), z.string().transform((v) => v === 'true')])
      .optional(),

    // MinIO Local
    MINIO_ENDPOINT: z.string().default('localhost'),
    MINIO_PORT: z.coerce.number().default(9000),
    MINIO_USE_SSL: z
      .union([z.boolean(), z.string().transform((v) => v === 'true')])
      .default(false),
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
        const isDefaultAiSecret = data.AI_WORKER_SECRET.includes('internal_ai_worker_secret');
        const isMissingRedisPassword = !data.REDIS_PASSWORD || data.REDIS_PASSWORD.trim().length === 0;

        if (isDefaultJwt || isDefaultRefresh || isDefaultAiSecret || isMissingRedisPassword) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        'CẢNH BÁO AN NINH: Không được phép sử dụng JWT_SECRET, JWT_REFRESH_SECRET, AI_WORKER_SECRET mặc định hoặc để trống REDIS_PASSWORD trên môi trường Production.',
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') {
        if (data.DATABASE_URL) {
          return (
            data.DATABASE_URL.startsWith('postgresql://') ||
            data.DATABASE_URL.startsWith('postgres://')
          );
        }
        return data.DB_PASSWORD !== 'postgres_password_secure';
      }
      return true;
    },
    {
      message:
        'CẢNH BÁO DATABASE: Trên môi trường Production, bắt buộc cung cấp DATABASE_URL hợp lệ (postgresql://...) hoặc cấu hình DB_PASSWORD không được dùng giá trị mặc định.',
    },
  )
  .refine(
    (data) => {
      const isR2Required = data.NODE_ENV === 'production' || data.STORAGE_PROVIDER === 'r2';
      if (isR2Required) {
        return !!(
          data.S3_ENDPOINT &&
          data.S3_ACCESS_KEY_ID &&
          data.S3_SECRET_ACCESS_KEY &&
          data.S3_BUCKET_MANGA &&
          data.S3_BUCKET_NOVEL
        );
      }
      return true;
    },
    {
      message:
        'CẢNH BÁO STORAGE: Khi NODE_ENV=production hoặc STORAGE_PROVIDER=r2, bắt buộc cung cấp đầy đủ: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_MANGA, S3_BUCKET_NOVEL.',
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
