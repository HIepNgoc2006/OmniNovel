import {
  validateTestDatabaseTarget,
  validateEnvironmentConflicts,
  ALLOWED_TEST_HOSTS,
  ALLOWED_TEST_DATABASES,
  EXPECTED_LOOPBACK_TEST_PORT,
  sanitizeConnectionTarget,
} from './test-isolation-guard';
import * as fs from 'fs';
import * as path from 'path';

describe('TestIsolationGuard (P1 Fail-Closed Protection - Task P1-A)', () => {
  describe('Positive Scenarios (DB-01)', () => {
    it('DB-01: should allow valid dedicated E2E test target on loopback IP 127.0.0.1:55433/omninovel_test', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_test',
        }),
      ).not.toThrow();
    });

    it('DB-01: should allow localhost with dedicated test port 55433 and omninovel_test', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@localhost:55433/omninovel_test',
        }),
      ).not.toThrow();
    });

    it('DB-01: should allow IPv6 loopback [::1]:55433/omninovel_test', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@[::1]:55433/omninovel_test',
        }),
      ).not.toThrow();
    });

    it('DB-01: should allow dedicated test container omninovel-test-postgres with port 5432 and omninovel_test', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@omninovel-test-postgres:5432/omninovel_test',
        }),
      ).not.toThrow();
    });

    it('DB-01: should allow discrete parameters for host, port and database', () => {
      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          port: EXPECTED_LOOPBACK_TEST_PORT,
          database: 'omninovel_test',
        }),
      ).not.toThrow();
    });
  });

  describe('Negative Fail-Closed Scenarios (DB-02 to DB-08)', () => {
    it('DB-02: should strictly block dev database 127.0.0.1:5433/omninovel_db', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:5433/omninovel_db',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*development/);

      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          port: 5433,
          database: 'omninovel_db',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);
    });

    it('DB-03: should strictly block Cloud Supabase or external PostgreSQL URLs', () => {
      // Supabase pooler
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres.xxx:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/omninovel_test',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*remote\/cloud/);

      // Supabase direct
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/omninovel_test',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*remote\/cloud/);

      // AWS RDS
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://admin:secret@omninovel.cluster-xyz.ap-southeast-1.rds.amazonaws.com:5432/omninovel_test',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*remote\/cloud/);

      // Neon / ElephantSQL
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://user:secret@ep-cool-frog-123456.us-east-2.aws.neon.tech/omninovel_test',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*remote\/cloud/);
    });

    it('DB-04: should strictly block URLs with production databases', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_production',
        }),
      ).toThrow(/production identifier/);

      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          port: 55433,
          database: 'omninovel_prod',
        }),
      ).toThrow(/production identifier/);
    });

    it('DB-05: should strictly block correct host with wrong port (5432, 5433, 9999)', () => {
      // Wrong port: 5432 on 127.0.0.1 (must be 55433)
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:5432/omninovel_test',
        }),
      ).toThrow(/dedicated test port 55433/);

      // Dev port: 5433 on 127.0.0.1
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:5433/omninovel_test',
        }),
      ).toThrow(/development PostgreSQL port/);

      // Arbitrary port: 9999 on 127.0.0.1
      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          port: 9999,
          database: 'omninovel_test',
        }),
      ).toThrow(/dedicated test port 55433/);
    });

    it('DB-06: should strictly block correct port with wrong database name', () => {
      // Port 55433 but database is omninovel_db
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_db',
        }),
      ).toThrow(/active development database/);

      // Port 55433 but database is random other_db
      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          port: 55433,
          database: 'other_db',
        }),
      ).toThrow(/not in the allowed test databases list/);
    });

    it('DB-07: should strictly block conflicting TEST_DATABASE_URL and TEST_DB_* configurations', () => {
      // Conflicting port
      expect(() =>
        validateEnvironmentConflicts({
          TEST_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_test',
          TEST_DB_PORT: '5433',
        }),
      ).toThrow(/Conflicting test database port/);

      // Conflicting DB name
      expect(() =>
        validateEnvironmentConflicts({
          TEST_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_test',
          TEST_DB_NAME: 'omninovel_db',
        }),
      ).toThrow(/Conflicting test database name/);

      // Conflicting host
      expect(() =>
        validateEnvironmentConflicts({
          TEST_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:55433/omninovel_test',
          TEST_DB_HOST: 'omninovel-test-postgres',
        }),
      ).toThrow(/Conflicting test database host/);
    });

    it('DB-08: should strictly block MIGRATION_ENV_FILE pointing to development/production DB', () => {
      const tempEnvFile = path.resolve(__dirname, 'temp-dev-migration.env');
      try {
        fs.writeFileSync(tempEnvFile, 'DB_PORT=5433\nDB_NAME=omninovel_db\n', 'utf-8');
        expect(() =>
          validateEnvironmentConflicts({
            MIGRATION_ENV_FILE: tempEnvFile,
          }),
        ).toThrow(/MIGRATION_ENV_FILE.*references development or production/);
      } finally {
        if (fs.existsSync(tempEnvFile)) fs.unlinkSync(tempEnvFile);
      }
    });

    it('should block generic aliases postgres and omninovel-dev-postgres', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@postgres:5432/omninovel_test',
        }),
      ).toThrow(/Host alias 'postgres' is reserved for development/);

      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@omninovel-dev-postgres:5432/omninovel_test',
        }),
      ).toThrow(/Host alias 'omninovel-dev-postgres' is reserved for development/);
    });

    it('should sanitize credentials from error messages', () => {
      const sensitiveUrl = 'postgresql://admin:super_secret_cleartext_password@evil.com:5432/omninovel_test';
      const sanitized = sanitizeConnectionTarget(sensitiveUrl);
      expect(sanitized).not.toContain('super_secret_cleartext_password');
      expect(sanitized).toContain('***');

      try {
        validateTestDatabaseTarget({ url: sensitiveUrl });
      } catch (err: any) {
        expect(err.message).not.toContain('super_secret_cleartext_password');
      }
    });
  });
});
