import {
  validateTestDatabaseTarget,
  verifyTestDatabaseIdentity,
  bootstrapTestDatabaseMarker,
  ALLOWED_TEST_HOSTS,
  EXPECTED_LOOPBACK_TEST_PORT,
} from '../src/common/guards/test-isolation-guard';
import { buildPostgresConnectionOptions } from '../src/database/database.config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

describe('TestIsolationGuard Integration Verification (Setup-E2E & Identity Hook)', () => {
  it('DB-01: should verify active test environment matches isolation allowlist and test port', () => {
    const activeHost = process.env.DB_HOST || '127.0.0.1';
    const activePort = Number(process.env.DB_PORT || EXPECTED_LOOPBACK_TEST_PORT);
    const activeDb = process.env.DB_NAME || 'omninovel_test';

    expect(ALLOWED_TEST_HOSTS.has(activeHost)).toBe(true);
    expect(activePort).toBe(EXPECTED_LOOPBACK_TEST_PORT);
    expect(activeDb).toBe('omninovel_test');
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('DB-03: should verify reject behavior on remote Supabase URLs before connection', () => {
    const maliciousProdUrl = 'postgresql://postgres.victim:fakepass@db.my-supabase.supabase.co:5432/omninovel_test';
    expect(() => validateTestDatabaseTarget({ url: maliciousProdUrl })).toThrow(
      /FATAL_TEST_ISOLATION_BREACH/,
    );
  });

  it('DB-09: should fail-closed when test database is unreachable on non-existent port', async () => {
    // Attempting to verify identity on closed port 59999 must throw fail-closed error
    await expect(
      verifyTestDatabaseIdentity({
        host: '127.0.0.1',
        port: 59999,
        database: 'omninovel_test',
      }),
    ).rejects.toThrow(/FATAL_TEST_ISOLATION_BREACH/);
  });

  it('DB-10: should verify non-interference and enforce dev database rejection', async () => {
    // 1. Static validation must strictly reject dev port and database fail-closed
    expect(() =>
      validateTestDatabaseTarget({
        host: '127.0.0.1',
        port: 5433,
        database: 'omninovel_db',
      }),
    ).toThrow(/development/);

    // 2. Migration options check: buildPostgresConnectionOptions with dev inputs must be blocked
    const devOptions = buildPostgresConnectionOptions({
      host: '127.0.0.1',
      port: 5433,
      database: 'omninovel_db',
    });
    expect(() =>
      validateTestDatabaseTarget({
        host: devOptions.host,
        port: devOptions.port,
        database: devOptions.database,
      }),
    ).toThrow(/Target port '5433' is the development PostgreSQL port/);

    // 3. verifyTestDatabaseIdentity must reject dev port 5433 immediately before connection
    await expect(
      verifyTestDatabaseIdentity({
        host: '127.0.0.1',
        port: 5433,
        database: 'omninovel_test',
      }),
    ).rejects.toThrow(/Target port '5433' is the development PostgreSQL port/);

    // 4. If dev postgres is running locally, verify it is completely isolated and holds omninovel_db
    const devClient = new Client({
      host: '127.0.0.1',
      port: 5433,
      user: 'postgres',
      password: 'postgres_password_secure',
      database: 'omninovel_db',
      connectionTimeoutMillis: 1000,
    });

    let isDevRunning = false;
    try {
      await devClient.connect();
      isDevRunning = true;
    } catch (connErr: any) {
      // In CI or environments where omninovel-dev-postgres is intentionally stopped,
      // verify the error is strictly a socket connection failure (ECONNREFUSED/timeout),
      // NEVER swallowing any unexpected assertion error.
      const isNetworkError =
        connErr.code === 'ECONNREFUSED' ||
        connErr.code === 'ETIMEDOUT' ||
        (connErr.message && (connErr.message.includes('timeout') || connErr.message.includes('Connection terminated')));
      expect(isNetworkError).toBe(true);
    }

    if (isDevRunning) {
      try {
        const res = await devClient.query('SELECT current_database();');
        expect(res.rows[0].current_database).toBe('omninovel_db');
      } finally {
        await devClient.end().catch(() => {});
      }
    }
  });

  it('DB-11: should reject live database identity mismatch when current_database() returns non-test DB', async () => {
    // Mock client.query to simulate an established connection that returns dev or foreign database identity
    const originalQuery = Client.prototype.query;
    const querySpy = jest.spyOn(Client.prototype, 'query').mockImplementation(async function (
      this: Client,
      queryText: any,
      ...args: any[]
    ) {
      if (typeof queryText === 'string' && queryText.includes('current_database()')) {
        return { rows: [{ current_database: 'omninovel_db' }] } as any;
      }
      return originalQuery.apply(this, [queryText, ...args] as any);
    });

    try {
      await expect(
        verifyTestDatabaseIdentity({
          host: '127.0.0.1',
          port: EXPECTED_LOOPBACK_TEST_PORT,
          database: 'omninovel_test',
        }),
      ).rejects.toThrow(
        /FATAL_TEST_ISOLATION_BREACH: Connected database identity 'omninovel_db' does not match expected test database 'omninovel_test'/,
      );
    } finally {
      querySpy.mockRestore();
    }
  });

  it('DB-12: should verify compose test manifest uses separate postgres_test_data volume', () => {
    const composeTestPath = path.resolve(__dirname, '../../../deploy/docker-compose.test.yml');
    expect(fs.existsSync(composeTestPath)).toBe(true);
    const content = fs.readFileSync(composeTestPath, 'utf-8');
    expect(content).toContain('postgres_test_data');
    expect(content).not.toContain('postgres_dev_data');
    expect(content).toContain('55433:5432');
    expect(content).toContain('omninovel-test-postgres');
  });

  it('DB-13: should fail-closed when test isolation marker table is missing or uninitialized', async () => {
    // Querying against a database where marker table does not exist must reject fail-closed
    const originalQuery = Client.prototype.query;
    const querySpy = jest.spyOn(Client.prototype, 'query').mockImplementation(async function (
      this: Client,
      queryText: any,
      ...args: any[]
    ) {
      if (typeof queryText === 'string' && queryText.includes('current_database()')) {
        return { rows: [{ current_database: 'omninovel_test' }] } as any;
      }
      if (typeof queryText === 'string' && queryText.includes('_omninovel_test_isolation_marker')) {
        throw new Error('relation "_omninovel_test_isolation_marker" does not exist');
      }
      return originalQuery.apply(this, [queryText, ...args] as any);
    });

    try {
      await expect(
        verifyTestDatabaseIdentity({
          host: '127.0.0.1',
          port: EXPECTED_LOOPBACK_TEST_PORT,
          database: 'omninovel_test',
          requireMarker: true,
        }),
      ).rejects.toThrow(
        /FATAL_TEST_ISOLATION_BREACH: Test isolation marker table '_omninovel_test_isolation_marker' does not exist/,
      );
    } finally {
      querySpy.mockRestore();
    }
  });

  it('DB-14: should verify marker bootstrap and subsequent identity verification', async () => {
    // 1. bootstrapTestDatabaseMarker creates marker table and row
    const bootstrapRes = await bootstrapTestDatabaseMarker({
      host: '127.0.0.1',
      port: EXPECTED_LOOPBACK_TEST_PORT,
      database: 'omninovel_test',
    });
    expect(bootstrapRes.database).toBe('omninovel_test');
    expect(bootstrapRes.markerCreated).toBe(true);

    // 2. verifyTestDatabaseIdentity strictly verifies pre-existing marker
    const verifyRes = await verifyTestDatabaseIdentity({
      host: '127.0.0.1',
      port: EXPECTED_LOOPBACK_TEST_PORT,
      database: 'omninovel_test',
      requireMarker: true,
    });
    expect(verifyRes.database).toBe('omninovel_test');
    expect(verifyRes.markerVerified).toBe(true);
  });

  it('DB-15: should reject migration configuration targeting development database in test mode', () => {
    // Simulating migration data-source with dev target in test mode
    const testDevOptions = buildPostgresConnectionOptions({
      host: '127.0.0.1',
      port: '5433',
      database: 'omninovel_db',
    });

    expect(() =>
      validateTestDatabaseTarget({
        host: testDevOptions.host,
        port: testDevOptions.port,
        database: testDevOptions.database,
      }),
    ).toThrow(/Target port '5433' is the development PostgreSQL port/);
  });
});
