import * as dotenv from 'dotenv';
import * as path from 'path';

/**
 * OmniNovel Core API E2E & Integration Test Isolation Rig (Fail-Closed)
 *
 * Rules:
 * 1. Force NODE_ENV = 'test'.
 * 2. Purge any unauthenticated host or foreign DATABASE_URL from ambient environment.
 * 3. Never allow automated tests to run against production/cloud databases (e.g. Supabase poolers, *.supabase.co).
 * 4. Bind strictly to dedicated TEST_DATABASE_URL or isolated local test container (127.0.0.1:5433 / omninovel_db).
 */
process.env.NODE_ENV = 'test';

// 1. If explicit TEST_DATABASE_URL is set, bind directly to it
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // 2. Load project local .env if available to fetch shared config (JWT, salts, etc.)
  const envPath = path.resolve(__dirname, '../../.env');
  dotenv.config({ path: envPath });

  // 3. Strict fail-closed guard: Disallow running tests against any production, remote pooler, or cloud DB
  const rawDbUrl = (process.env.DATABASE_URL || '').toLowerCase();
  const isCloudOrProdDb =
    rawDbUrl.includes('supabase.com') ||
    rawDbUrl.includes('supabase.co') ||
    rawDbUrl.includes('pooler') ||
    rawDbUrl.includes('prod');

  if (isCloudOrProdDb || process.env.DATABASE_URL) {
    // Set to empty string so dotenv / ConfigModule does not re-read production DATABASE_URL from .env
    process.env.DATABASE_URL = '';
  }

  // 4. Bind to canonical local/CI test database (127.0.0.1:5433 / omninovel_db)
  process.env.DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.TEST_DB_PORT || '5433';
  process.env.DB_USER = process.env.TEST_DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'postgres_password_secure';
  process.env.DB_NAME = process.env.TEST_DB_NAME || 'omninovel_db';
  process.env.DB_SSL = 'false';
}

// Ensure Redis test defaults
process.env.REDIS_HOST = process.env.TEST_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1';
process.env.REDIS_PORT = process.env.TEST_REDIS_PORT || process.env.REDIS_PORT || '6379';
process.env.REDIS_PASSWORD = process.env.TEST_REDIS_PASSWORD || '';
