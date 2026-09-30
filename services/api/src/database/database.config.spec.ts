import { buildPostgresConnectionOptions } from './database.config';

describe('buildPostgresConnectionOptions (Database Config Parity & Contract)', () => {
  it('should configure extra.ssl matching ssl when ssl=true', () => {
    const options = buildPostgresConnectionOptions({
      databaseUrl: 'postgresql://user:pass@pooler.supabase.com:5432/postgres',
      ssl: true,
    });

    expect(options.url).toBe('postgresql://user:pass@pooler.supabase.com:5432/postgres');
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
    expect(options.extra).toBeDefined();
    expect(options.extra?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should configure extra.ssl matching ssl when ssl="require"', () => {
    const options = buildPostgresConnectionOptions({
      host: 'localhost',
      port: 5432,
      username: 'user',
      password: 'pwd',
      database: 'db',
      ssl: 'require',
    });

    expect(options.host).toBe('localhost');
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
    expect(options.extra?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should auto-detect ssl when databaseUrl contains sslmode=require', () => {
    const options = buildPostgresConnectionOptions({
      databaseUrl: 'postgresql://user:pass@db.supabase.com:5432/postgres?sslmode=require',
    });

    expect(options.ssl).toEqual({ rejectUnauthorized: false });
    expect(options.extra?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should leave extra undefined and ssl=false when SSL is not required', () => {
    const options = buildPostgresConnectionOptions({
      host: 'localhost',
      port: 5433,
      username: 'postgres',
      password: 'pwd',
      database: 'omninovel_db',
      ssl: false,
    });

    expect(options.ssl).toBe(false);
    expect(options.extra).toBeUndefined();
  });
});
