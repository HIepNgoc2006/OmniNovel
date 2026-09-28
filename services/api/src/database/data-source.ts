import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { buildPostgresConnectionOptions } from './database.config';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

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
