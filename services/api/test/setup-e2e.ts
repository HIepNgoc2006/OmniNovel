import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  validateTestDatabaseTarget,
  validateEnvironmentConflicts,
  EXPECTED_LOOPBACK_TEST_PORT,
} from '../src/common/guards/test-isolation-guard';

/**
 * OmniNovel Core API E2E & Integration Test Isolation Rig (Fail-Closed)
 *
 * Rules:
 * 1. Force NODE_ENV = 'test'.
 * 2. Purge any unauthenticated host or foreign DATABASE_URL from ambient environment.
 * 3. Never allow automated tests to run against production/cloud or development databases.
 * 4. Strictly validate all destination hosts and URLs against ALLOWED_TEST_HOSTS allowlist before binding.
 * 5. Bind strictly to dedicated validated TEST_DATABASE_URL or isolated local test container (127.0.0.1:55433 / omninovel_test).
 * 6. Detect and reject environment variable conflicts fail-closed.
 * 7. Force storage variables to local MinIO in test mode (preventing ambient R2 leakage from local .env).
 */
process.env.NODE_ENV = 'test';

// Check for conflicting environment variables
validateEnvironmentConflicts(process.env);

// 1. If explicit TEST_DATABASE_URL is set, strictly validate destination against allowlist
if (process.env.TEST_DATABASE_URL) {
  validateTestDatabaseTarget({ url: process.env.TEST_DATABASE_URL });
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // 2. Load project local .env if available to fetch shared config (JWT, salts, etc.)
  const envPath = path.resolve(__dirname, '../../.env');
  dotenv.config({ path: envPath });

  // 3. Strict fail-closed guard: Disallow running tests against any ambient production/dev DATABASE_URL
  const rawDbUrl = (process.env.DATABASE_URL || '').toLowerCase();
  if (rawDbUrl) {
    // Purge ambient DATABASE_URL so dotenv / ConfigModule does not read remote/production poolers
    process.env.DATABASE_URL = '';
  }

  // 4. Validate destination host and database name against strict local allowlist
  const targetHost = process.env.TEST_DB_HOST || '127.0.0.1';
  const targetPort = process.env.TEST_DB_PORT || String(EXPECTED_LOOPBACK_TEST_PORT);
  const targetDb = process.env.TEST_DB_NAME || 'omninovel_test';

  validateTestDatabaseTarget({ host: targetHost, port: targetPort, database: targetDb });

  process.env.DB_HOST = targetHost;
  process.env.DB_PORT = targetPort;
  process.env.DB_USER = process.env.TEST_DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'postgres_password_secure';
  process.env.DB_NAME = targetDb;
  process.env.DB_SSL = 'false';
}

// Force test storage provider to local MinIO (override any ambient R2 settings from .env)
process.env.STORAGE_PROVIDER = 'minio';
process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.S3_ACCESS_KEY_ID = process.env.MINIO_ACCESS_KEY || 'minioadmin';
process.env.S3_SECRET_ACCESS_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
process.env.S3_BUCKET_MANGA = 'manga-media';
process.env.S3_BUCKET_NOVEL = 'novel-media';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.S3_REGION = 'us-east-1';

process.env.MINIO_ENDPOINT = process.env.TEST_MINIO_ENDPOINT || '127.0.0.1';
process.env.MINIO_PORT = process.env.TEST_MINIO_PORT || '9000';
process.env.MINIO_USE_SSL = 'false';
process.env.MINIO_ACCESS_KEY = process.env.TEST_MINIO_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || 'minioadmin';
process.env.MINIO_SECRET_KEY = process.env.TEST_MINIO_SECRET_KEY || process.env.MINIO_SECRET_KEY || 'minioadmin';
process.env.MINIO_BUCKET_MANGA = 'manga-media';
process.env.MINIO_BUCKET_NOVEL = 'novel-media';

// Ensure Redis test defaults
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT || process.env.REDIS_PORT || '6379';
process.env.REDIS_PASSWORD = process.env.TEST_REDIS_PASSWORD || '';
