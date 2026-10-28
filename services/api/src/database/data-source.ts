import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { buildPostgresConnectionOptions } from './database.config';
import {
  validateEnvironmentConflicts,
  validateTestDatabaseTarget,
} from '../common/guards/test-isolation-guard';

// Quy tắc ưu tiên biến môi trường:
// 1. OS / Docker / CI injected env (process.env) - mức ưu tiên cao nhất, tuyệt đối KHÔNG override.
// 2. Explicit env file (nếu MIGRATION_ENV_FILE được chỉ định rõ ràng).
// 3. Local env fallback (.env ở các đường dẫn thông thường, chỉ điền các giá trị còn thiếu).
const initialNodeEnv = process.env.NODE_ENV;

if (process.env.MIGRATION_ENV_FILE) {
  const explicitPath = path.resolve(process.cwd(), process.env.MIGRATION_ENV_FILE);
  if (fs.existsSync(explicitPath)) {
    dotenv.config({ path: explicitPath, override: true });
  }
  // Invariant: MIGRATION_ENV_FILE is NEVER allowed to override NODE_ENV away from 'test' to bypass isolation guard
  if (initialNodeEnv === 'test' && process.env.NODE_ENV !== 'test') {
    process.env.NODE_ENV = 'test';
    throw new Error(
      `FATAL_TEST_ISOLATION_BREACH: MIGRATION_ENV_FILE attempted to override NODE_ENV away from 'test' to '${process.env.NODE_ENV}'. Test mode cannot be bypassed.`,
    );
  }
} else if (process.env.NODE_ENV !== 'test') {
  const candidateEnvPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ];

  for (const envPath of candidateEnvPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }
}

if (process.env.NODE_ENV === 'test') {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    // Purge ambient non-test DATABASE_URL so discrete test env vars take effect
    delete process.env.DATABASE_URL;
  }
  validateEnvironmentConflicts(process.env);
}

const pgOptions = buildPostgresConnectionOptions({
  databaseUrl: process.env.DATABASE_URL,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL,
});

// Fail-closed verification on effective connection target before creating DataSource
if (process.env.NODE_ENV === 'test') {
  validateTestDatabaseTarget({
    url: pgOptions.url,
    host: pgOptions.host,
    port: pgOptions.port,
    database: pgOptions.database,
  });
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  ...pgOptions,
  synchronize: false, // Bắt buộc false theo ADR-011
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : false,
  entities: [path.join(__dirname, '../**/*.entity{.ts,.js}')],
  migrations: [path.join(__dirname, './migrations/*{.ts,.js}')],
});
