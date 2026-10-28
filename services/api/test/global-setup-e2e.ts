import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  bootstrapTestDatabaseMarker,
  EXPECTED_LOOPBACK_TEST_PORT,
} from '../src/common/guards/test-isolation-guard';

export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';

  const envPath = path.resolve(__dirname, '../../.env');
  dotenv.config({ path: envPath });

  const targetHost = process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1';
  const targetPort = Number(process.env.TEST_DB_PORT || process.env.DB_PORT || EXPECTED_LOOPBACK_TEST_PORT);
  const targetDb = process.env.TEST_DB_NAME || process.env.DB_NAME || 'omninovel_test';
  const targetUser = process.env.TEST_DB_USER || process.env.DB_USER || 'postgres';
  const targetPass = process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres_password_secure';

  await bootstrapTestDatabaseMarker({
    host: targetHost,
    port: targetPort,
    database: targetDb,
    user: targetUser,
    password: targetPass,
  });
}
