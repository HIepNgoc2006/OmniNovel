export interface PostgresConfigInput {
  databaseUrl?: string;
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean | string;
}

export interface ResolvedPostgresConnectionOptions {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Helper chuẩn hóa cấu hình kết nối PostgreSQL dùng chung giữa Runtime (DatabaseModule)
 * và Migration CLI (data-source.ts).
 *
 * Quy tắc:
 * - Nếu `databaseUrl` có giá trị:
 *     → Dùng `url: databaseUrl`
 *     → `ssl: { rejectUnauthorized: false }` khi `ssl=true` (hoặc `DATABASE_URL` có chứa sslmode=require)
 * - Nếu không có `databaseUrl`:
 *     → Dùng các biến `host, port, username, password, database` cục bộ (mặc định localhost:5433)
 *     → `ssl: { rejectUnauthorized: false }` khi `ssl=true`, ngược lại `false`
 */
export function buildPostgresConnectionOptions(
  input: PostgresConfigInput = {},
): ResolvedPostgresConnectionOptions {
  const isSsl =
    input.ssl === true ||
    input.ssl === 'true' ||
    (typeof input.ssl === 'string' && input.ssl.toLowerCase() === 'require') ||
    (typeof input.databaseUrl === 'string' && input.databaseUrl.includes('sslmode=require'));

  const sslOption = isSsl ? { rejectUnauthorized: false } : false;

  const rawUrl = input.databaseUrl ? input.databaseUrl.trim() : '';
  if (rawUrl.length > 0) {
    return {
      url: rawUrl,
      ssl: sslOption,
    };
  }

  return {
    host: input.host || 'localhost',
    port: input.port ? Number(input.port) : 5433,
    username: input.username || 'postgres',
    password: input.password || 'postgres_password_secure',
    database: input.database || 'omninovel_db',
    ssl: sslOption,
  };
}
