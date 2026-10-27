import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

/**
 * OmniNovel Fail-Closed Database Test Isolation Guard (Task P1-A)
 *
 * Strict zero-trust protection guaranteeing that automated tests & migrations
 * run EXCLUSIVELY against a dedicated, isolated test database instance.
 *
 * Invariants:
 * 1. Dedicated Test Host allowlist: 127.0.0.1, localhost, ::1, or omninovel-test-postgres.
 *    (Generic aliases 'postgres' and 'omninovel-dev-postgres' are strictly blocked).
 * 2. Dedicated Test Port:
 *    - Loopback (127.0.0.1, localhost, ::1) must use port 55433.
 *    - Container service (omninovel-test-postgres) must use port 5432 or 55433.
 *    - Development port 5433 is strictly blocked.
 * 3. Dedicated Test Database Name:
 *    - Must strictly match 'omninovel_test'.
 *    - 'omninovel_db', 'omninovel_prod', 'production', or any non-test DB is strictly blocked.
 * 4. Conflict Rejection:
 *    - Conflicts between TEST_DATABASE_URL and discrete env variables trigger fatal error.
 * 5. Sanitized Errors:
 *    - Credentials/passwords are stripped from any error message.
 * 6. Live Database Identity Verification:
 *    - Validates current_database() === 'omninovel_test' before allowing destructive operations.
 */

export const ALLOWED_TEST_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'omninovel-test-postgres',
]);

export const FORBIDDEN_DEV_PORTS = new Set([5433, '5433']);

export const EXPECTED_LOOPBACK_TEST_PORT = 55433;

export const ALLOWED_TEST_DATABASES = new Set([
  'omninovel_test',
]);

export const FORBIDDEN_HOST_PATTERNS = [
  'supabase.co',
  'supabase.com',
  'aws.com',
  'amazonaws.com',
  'pooler',
  'neon.tech',
  'elephantsql.com',
  'azure.com',
  'gcp',
  'cloud',
];

export interface DbTargetCheck {
  host?: string;
  port?: number | string;
  database?: string;
  url?: string;
}

export function sanitizeConnectionTarget(rawUrlOrHost: string): string {
  if (!rawUrlOrHost) return '';
  try {
    if (rawUrlOrHost.includes('://')) {
      const u = new URL(rawUrlOrHost);
      if (u.password) {
        u.password = '***';
      }
      return u.toString();
    }
    return rawUrlOrHost;
  } catch {
    return rawUrlOrHost.replace(/:\/\/[^:]+:([^@]+)@/, '://***:***@');
  }
}

export function validateTestDatabaseTarget(target: DbTargetCheck): void {
  // 1. If full URL is provided, validate both components and raw string
  if (target.url) {
    const rawUrl = target.url.trim();
    if (!rawUrl) return;

    const sanitizedUrl = sanitizeConnectionTarget(rawUrl);
    const lower = rawUrl.toLowerCase();
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (lower.includes(pattern)) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Prohibited remote/cloud database pattern '${pattern}' detected in test connection URL (${sanitizedUrl}). Automated tests must strictly run on local isolated test container.`
        );
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
      if (!parsed.protocol.startsWith('postgres') || !parsed.hostname) {
        throw new Error('Invalid protocol or missing host');
      }
    } catch {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Malformed database connection URL: '${sanitizedUrl}'.`
      );
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = parsed.port ? Number(parsed.port) : 5432;
    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();

    // Check host
    if (host === 'omninovel-dev-postgres' || host === 'postgres') {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Host alias '${host}' is reserved for development or ambiguous container networking. E2E tests must strictly target '127.0.0.1' or dedicated 'omninovel-test-postgres'.`
      );
    }
    if (!ALLOWED_TEST_HOSTS.has(host)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Database host '${host}' is not in the allowed test hosts allowlist (${Array.from(ALLOWED_TEST_HOSTS).join(', ')}). Remote/cloud/external execution is strictly prohibited.`
      );
    }

    // Check port
    if (FORBIDDEN_DEV_PORTS.has(port)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Target port '${port}' is the development PostgreSQL port. E2E tests must strictly use dedicated test port ${EXPECTED_LOOPBACK_TEST_PORT}.`
      );
    }
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      if (port !== EXPECTED_LOOPBACK_TEST_PORT) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Loopback test host '${host}' must bind to dedicated test port ${EXPECTED_LOOPBACK_TEST_PORT}, found '${port}'.`
        );
      }
    } else if (host === 'omninovel-test-postgres') {
      if (port !== 5432 && port !== EXPECTED_LOOPBACK_TEST_PORT) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Container host 'omninovel-test-postgres' must use port 5432 or ${EXPECTED_LOOPBACK_TEST_PORT}, found '${port}'.`
        );
      }
    }

    // Check database name
    if (dbName === 'omninovel_db') {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Target database '${dbName}' is the active development database. E2E tests must strictly use dedicated 'omninovel_test'.`
      );
    }
    if (dbName === 'production' || dbName.includes('prod_') || dbName.includes('_prod') || dbName.endsWith('_production')) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Prohibited database name '${dbName}' contains production identifier.`
      );
    }
    if (!ALLOWED_TEST_DATABASES.has(dbName)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Target database '${dbName}' is not in the allowed test databases list (${Array.from(ALLOWED_TEST_DATABASES).join(', ')}).`
      );
    }
  }

  // 2. Validate explicit host if provided
  if (target.host) {
    const host = target.host.trim().toLowerCase();
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (host.includes(pattern)) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Prohibited remote/cloud pattern '${pattern}' detected in DB host '${host}'.`
        );
      }
    }
    if (host === 'omninovel-dev-postgres' || host === 'postgres') {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Host alias '${host}' is reserved for development or ambiguous container networking. E2E tests must strictly target '127.0.0.1' or dedicated 'omninovel-test-postgres'.`
      );
    }
    if (!ALLOWED_TEST_HOSTS.has(host)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: DB host '${host}' is not in the allowed test hosts allowlist (${Array.from(ALLOWED_TEST_HOSTS).join(', ')}).`
      );
    }

    // If port is also provided with host
    if (target.port !== undefined && target.port !== null && target.port !== '') {
      const port = Number(target.port);
      if (FORBIDDEN_DEV_PORTS.has(port)) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Target port '${port}' is the development PostgreSQL port. E2E tests must strictly use dedicated test port ${EXPECTED_LOOPBACK_TEST_PORT}.`
        );
      }
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        if (port !== EXPECTED_LOOPBACK_TEST_PORT) {
          throw new Error(
            `FATAL_TEST_ISOLATION_BREACH: Loopback test host '${host}' must bind to dedicated test port ${EXPECTED_LOOPBACK_TEST_PORT}, found '${port}'.`
          );
        }
      } else if (host === 'omninovel-test-postgres') {
        if (port !== 5432 && port !== EXPECTED_LOOPBACK_TEST_PORT) {
          throw new Error(
            `FATAL_TEST_ISOLATION_BREACH: Container host 'omninovel-test-postgres' must use port 5432 or ${EXPECTED_LOOPBACK_TEST_PORT}, found '${port}'.`
          );
        }
      }
    }
  }

  // 3. Validate explicit database name if provided
  if (target.database) {
    const db = target.database.trim().toLowerCase();
    if (db === 'omninovel_db') {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Target database '${db}' is the active development database. E2E tests must strictly use dedicated 'omninovel_test'.`
      );
    }
    if (db === 'production' || db.includes('prod_') || db.includes('_prod') || db.endsWith('_production')) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Database name '${db}' contains production identifier.`
      );
    }
    if (!ALLOWED_TEST_DATABASES.has(db)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Target database '${db}' is not in the allowed test databases list (${Array.from(ALLOWED_TEST_DATABASES).join(', ')}).`
      );
    }
  }
}

export function validateEnvironmentConflicts(env: Record<string, string | undefined> = process.env): void {
  // 1. If TEST_DATABASE_URL is set, verify consistency with TEST_DB_*
  if (env.TEST_DATABASE_URL) {
    const parsed = new URL(env.TEST_DATABASE_URL);
    const parsedHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const parsedPort = parsed.port ? Number(parsed.port) : 5432;
    const parsedDb = parsed.pathname.replace(/^\//, '').toLowerCase();

    if (env.TEST_DB_HOST && env.TEST_DB_HOST.trim().toLowerCase() !== parsedHost) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Conflicting test database host between TEST_DATABASE_URL ('${parsedHost}') and TEST_DB_HOST ('${env.TEST_DB_HOST}').`
      );
    }
    if (env.TEST_DB_PORT && Number(env.TEST_DB_PORT) !== parsedPort) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Conflicting test database port between TEST_DATABASE_URL ('${parsedPort}') and TEST_DB_PORT ('${env.TEST_DB_PORT}').`
      );
    }
    if (env.TEST_DB_NAME && env.TEST_DB_NAME.trim().toLowerCase() !== parsedDb) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Conflicting test database name between TEST_DATABASE_URL ('${parsedDb}') and TEST_DB_NAME ('${env.TEST_DB_NAME}').`
      );
    }
  }

  // 2. Validate MIGRATION_ENV_FILE if specified
  if (env.MIGRATION_ENV_FILE) {
    const resolvedPath = path.resolve(process.cwd(), env.MIGRATION_ENV_FILE);
    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const lower = content.toLowerCase();
      if (
        lower.includes('5433') ||
        lower.includes('omninovel_db') ||
        lower.includes('supabase') ||
        lower.includes('prod')
      ) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: MIGRATION_ENV_FILE '${env.MIGRATION_ENV_FILE}' references development or production database credentials.`
        );
      }
    }
  }
}

export async function verifyTestDatabaseIdentity(options?: {
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  database?: string;
}): Promise<{ database: string; markerVerified: boolean }> {
  const host = options?.host || process.env.DB_HOST || process.env.TEST_DB_HOST || '127.0.0.1';
  const port = Number(options?.port || process.env.DB_PORT || process.env.TEST_DB_PORT || EXPECTED_LOOPBACK_TEST_PORT);
  const user = options?.user || process.env.DB_USER || process.env.TEST_DB_USER || 'postgres';
  const password = options?.password || process.env.DB_PASSWORD || process.env.TEST_DB_PASSWORD || 'postgres_password_secure';
  const database = options?.database || process.env.DB_NAME || process.env.TEST_DB_NAME || 'omninovel_test';

  // 1. Static validation check
  validateTestDatabaseTarget({ host, port, database });

  // 2. Connect and query current_database()
  const client = new Client({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    const res = await client.query('SELECT current_database();');
    const actualDb = res.rows[0]?.current_database;

    if (actualDb !== 'omninovel_test') {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Connected database identity '${actualDb}' does not match expected test database 'omninovel_test'. Execution aborted to protect non-test database.`
      );
    }

    // 3. Check or create identity marker table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _omninovel_test_isolation_marker (
        id serial primary key,
        marker text unique not null,
        verified_at timestamptz default now()
      );
    `);
    await client.query(`
      INSERT INTO _omninovel_test_isolation_marker (marker)
      VALUES ('omninovel-e2e-isolation-verified')
      ON CONFLICT (marker) DO UPDATE SET verified_at = now();
    `);

    return { database: actualDb, markerVerified: true };
  } catch (err: any) {
    if (err.message?.includes('FATAL_TEST_ISOLATION_BREACH')) {
      throw err;
    }
    throw new Error(
      `FATAL_TEST_ISOLATION_BREACH: Dedicated test database unavailable at ${host}:${port}/${database}. Cannot run automated tests without dedicated test database. Error: ${err.message}`
    );
  } finally {
    try {
      await client.end();
    } catch {
      // ignore client end error
    }
  }
}
