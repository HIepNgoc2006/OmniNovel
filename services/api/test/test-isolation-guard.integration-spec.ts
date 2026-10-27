import {
  validateTestDatabaseTarget,
  ALLOWED_TEST_HOSTS,
} from '../src/common/guards/test-isolation-guard';

describe('TestIsolationGuard Integration Verification (Setup-E2E Hook)', () => {
  it('should verify that active test environment matches isolation allowlist', () => {
    // Verify current process environment bindings
    const activeHost = process.env.DB_HOST || (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : '');
    expect(ALLOWED_TEST_HOSTS.has(activeHost)).toBe(true);
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should verify reject behavior on remote Supabase URLs before connection', () => {
    const maliciousProdUrl = 'postgresql://postgres.victim:fakepass@db.my-supabase.supabase.co:5432/postgres';
    expect(() => validateTestDatabaseTarget({ url: maliciousProdUrl })).toThrow(
      /FATAL_TEST_ISOLATION_BREACH/,
    );
  });
});
