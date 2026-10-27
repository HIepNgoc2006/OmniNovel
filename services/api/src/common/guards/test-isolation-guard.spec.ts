import {
  validateTestDatabaseTarget,
  ALLOWED_TEST_HOSTS,
  FORBIDDEN_HOST_PATTERNS,
} from './test-isolation-guard';

describe('TestIsolationGuard (P1 Fail-Closed Protection)', () => {
  describe('Positive Allowlist Scenarios', () => {
    it('should allow valid local loopback IP 127.0.0.1', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:5433/omninovel_db',
        }),
      ).not.toThrow();
    });

    it('should allow localhost with custom test port', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@localhost:5432/test_db',
        }),
      ).not.toThrow();
    });

    it('should allow IPv6 loopback ::1', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@[::1]:5432/omninovel_test',
        }),
      ).not.toThrow();
    });

    it('should allow Docker container service name "postgres"', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@postgres:5432/omninovel_db',
        }),
      ).not.toThrow();
    });

    it('should allow separate host and database parameters on allowlist', () => {
      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          database: 'omninovel_db',
        }),
      ).not.toThrow();
    });
  });

  describe('Negative Fail-Closed Scenarios (Rejection of Remote & Cloud DBs)', () => {
    it('should reject Supabase cloud pooler connection string', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres.xxx:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);
    });

    it('should reject Supabase direct cloud domain (*.supabase.co)', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);
    });

    it('should reject AWS RDS hostnames (*.rds.amazonaws.com)', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://admin:secret@omninovel-prod.cluster-xyz.ap-southeast-1.rds.amazonaws.com:5432/omninovel',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);
    });

    it('should reject Neon and ElephantSQL cloud databases', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://user:secret@ep-cool-frog-123456.us-east-2.aws.neon.tech/neondb',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);

      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://user:secret@tiny.db.elephantsql.com:5432/mydb',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH/);
    });

    it('should reject arbitrary external IPs and domain names not on allowlist', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@192.168.1.100:5432/omninovel_db',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*allowlist/);

      expect(() =>
        validateTestDatabaseTarget({
          host: '10.0.0.5',
        }),
      ).toThrow(/FATAL_TEST_ISOLATION_BREACH.*allowlist/);
    });

    it('should reject databases with production identifiers', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'postgresql://postgres:secret@127.0.0.1:5432/omninovel_production',
        }),
      ).toThrow(/production identifier/);

      expect(() =>
        validateTestDatabaseTarget({
          host: '127.0.0.1',
          database: 'prod_database',
        }),
      ).toThrow(/production identifier/);
    });

    it('should reject malformed database URLs', () => {
      expect(() =>
        validateTestDatabaseTarget({
          url: 'not-a-valid-url:::123',
        }),
      ).toThrow(/Malformed database connection URL/);
    });
  });
});
