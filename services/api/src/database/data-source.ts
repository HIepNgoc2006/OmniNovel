import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { buildPostgresConnectionOptions } from './database.config';

// Quy tắc ưu tiên biến môi trường:
// 1. OS / Docker / CI injected env (process.env) - mức ưu tiên cao nhất, tuyệt đối KHÔNG override.
// 2. Explicit env file (nếu MIGRATION_ENV_FILE được chỉ định rõ ràng).
// 3. Local env fallback (.env ở các đường dẫn thông thường, chỉ điền các giá trị còn thiếu).
if (process.env.MIGRATION_ENV_FILE) {
  const explicitPath = path.resolve(process.cwd(), process.env.MIGRATION_ENV_FILE);
  if (fs.existsSync(explicitPath)) {
    dotenv.config({ path: explicitPath });
  }
}

const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];

if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('Camera_AI')) {
  delete process.env.DATABASE_URL;
}

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }
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

export const AppDataSource = new DataSource({
  type: 'postgres',
  ...pgOptions,
  synchronize: false, // Bắt buộc false theo ADR-011
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : false,
  entities: [path.join(__dirname, '../**/*.entity{.ts,.js}')],
  migrations: [path.join(__dirname, './migrations/*{.ts,.js}')],
});
