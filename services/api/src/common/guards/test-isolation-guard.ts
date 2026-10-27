/**
 * OmniNovel Fail-Closed Database Test Isolation Guard
 *
 * Enforces strict, zero-trust protection against automated tests connecting to
 * remote, cloud, or production databases (e.g. Supabase, AWS RDS, Neon, etc.).
 *
 * Invariants:
 * 1. Only loopback addresses (127.0.0.1, localhost, ::1) or isolated container service names
 *    ('postgres', 'omninovel-dev-postgres') are permitted.
 * 2. Explicit blacklist patterns (supabase, pooler, aws, prod, etc.) trigger immediate fail-closed error.
 * 3. Database names containing production identifiers ('prod', 'production') are rejected.
 */

export const ALLOWED_TEST_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'postgres',
  'omninovel-dev-postgres',
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
  database?: string;
  url?: string;
}

export function validateTestDatabaseTarget(target: DbTargetCheck): void {
  // 1. If full URL is provided, validate both components and raw string
  if (target.url) {
    const rawUrl = target.url.trim();
    if (!rawUrl) return;

    const lower = rawUrl.toLowerCase();
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (lower.includes(pattern)) {
        throw new Error(
          `FATAL_TEST_ISOLATION_BREACH: Prohibited remote/cloud database pattern '${pattern}' detected in test connection URL. Automated tests must strictly run on local isolated loopback or container network.`
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
        `FATAL_TEST_ISOLATION_BREACH: Malformed database connection URL: '${rawUrl}'.`
      );
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!ALLOWED_TEST_HOSTS.has(host)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Database host '${host}' is not in the allowed test hosts allowlist (${Array.from(ALLOWED_TEST_HOSTS).join(', ')}). Remote/production execution is strictly prohibited.`
      );
    }

    const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();
    if (dbName === 'production' || dbName.includes('prod_') || dbName.includes('_prod') || dbName.endsWith('_production')) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Prohibited database name '${dbName}' contains production identifier.`
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
    if (!ALLOWED_TEST_HOSTS.has(host)) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: DB host '${host}' is not in the allowed test hosts allowlist (${Array.from(ALLOWED_TEST_HOSTS).join(', ')}).`
      );
    }
  }

  // 3. Validate explicit database name if provided
  if (target.database) {
    const db = target.database.trim().toLowerCase();
    if (db === 'production' || db.includes('prod_') || db.includes('_prod') || db.endsWith('_production')) {
      throw new Error(
        `FATAL_TEST_ISOLATION_BREACH: Database name '${db}' contains production identifier.`
      );
    }
  }
}
