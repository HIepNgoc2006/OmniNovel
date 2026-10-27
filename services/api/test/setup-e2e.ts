import * as dotenv from 'dotenv';
import * as path from 'path';
import { validateTestDatabaseTarget } from '../src/common/guards/test-isolation-guard';

/**
 * OmniNovel Core API E2E & Integration Test Isolation Rig (Fail-Closed)
 *
 * Rules:
 * 1. Force NODE_ENV = 'test'.
 * 2. Purge any unauthenticated host or foreign DATABASE_URL from ambient environment.
 * 3. Never allow automated tests to run against production/cloud databases (e.g. Supabase poolers, *.supabase.co).
 * 4. Strictly validate all destination hosts and URLs against ALLOWED_TEST_HOSTS allowlist before binding.
 * 5. Bind strictly to dedicated validated TEST_DATABASE_URL or isolated local test container (127.0.0.1:5433 / omninovel_db).
 */
process.env.NODE_ENV = 'test';

// 1. If explicit TEST_DATABASE_URL is set, strictly validate destination against allowlist
if (process.env.TEST_DATABASE_URL) {
  validateTestDatabaseTarget({ url: process.env.TEST_DATABASE_URL });
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // 2. Load project local .env if available to fetch shared config (JWT, salts, etc.)
  const envPath = path.resolve(__dirname, '../../.env');
  dotenv.config({ path: envPath });

  // 3. Strict fail-closed guard: Disallow running tests against any ambient production DATABASE_URL
  const rawDbUrl = (process.env.DATABASE_URL || '').toLowerCase();
  if (rawDbUrl) {
    // Purge ambient DATABASE_URL so dotenv / ConfigModule does not read remote/production poolers
    process.env.DATABASE_URL = '';
  }

  // 4. Validate destination host and database name against strict local allowlist
  const targetHost = process.env.TEST_DB_HOST || '127.0.0.1';
  const targetDb = process.env.TEST_DB_NAME || 'omninovel_db';

  validateTestDatabaseTarget({ host: targetHost, database: targetDb });

  process.env.DB_HOST = targetHost;
  process.env.DB_PORT = process.env.TEST_DB_PORT || '5433';
  process.env.DB_USER = process.env.TEST_DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'postgres_password_secure';
  process.env.DB_NAME = targetDb;
  process.env.DB_SSL = 'false';
}

// Ensure Redis test defaults
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT || process.env.REDIS_PORT || '6379';
process.env.REDIS_PASSWORD = process.env.TEST_REDIS_PASSWORD || '';
