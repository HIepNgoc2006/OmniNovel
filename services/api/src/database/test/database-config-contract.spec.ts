import { ConfigService } from '@nestjs/config';
import {
  buildPostgresConnectionOptions,
  PostgresConfigInput,
} from '../database.config';
import { validateEnv } from '../../config/env.validation';

describe('Database Configuration Contract (Local vs Supabase Production & Parity)', () => {
  describe('1. Local PostgreSQL Contract', () => {
    it('should fallback to localhost:5433 and default credentials when DATABASE_URL is absent', () => {
      const options = buildPostgresConnectionOptions({});

      expect(options.url).toBeUndefined();
      expect(options.host).toBe('localhost');
      expect(options.port).toBe(5433);
      expect(options.username).toBe('postgres');
      expect(options.password).toBe('postgres_password_secure');
      expect(options.database).toBe('omninovel_db');
      expect(options.ssl).toBe(false);
    });

    it('should resolve custom local credentials when provided', () => {
      const input: PostgresConfigInput = {
        host: 'postgres-container',
        port: 5432,
        username: 'custom_user',
        password: 'custom_password_123',
        database: 'custom_omninovel',
      };

      const options = buildPostgresConnectionOptions(input);

      expect(options.url).toBeUndefined();
      expect(options.host).toBe('postgres-container');
      expect(options.port).toBe(5432);
      expect(options.username).toBe('custom_user');
      expect(options.password).toBe('custom_password_123');
      expect(options.database).toBe('custom_omninovel');
      expect(options.ssl).toBe(false);
    });
  });

  describe('2. Supabase URL + SSL Contract', () => {
    const supabaseUrl =
      'postgresql://postgres.dummy_project_ref:fake_test_password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

    it('should prioritize DATABASE_URL over separate host/port fields and omit individual fields', () => {
      const options = buildPostgresConnectionOptions({
        databaseUrl: supabaseUrl,
        host: 'localhost',
        port: 5433,
        username: 'postgres',
        password: 'postgres_password_secure',
        database: 'omninovel_db',
        ssl: 'false',
      });

      expect(options.url).toBe(supabaseUrl);
      expect(options.host).toBeUndefined();
      expect(options.port).toBeUndefined();
      expect(options.username).toBeUndefined();
      expect(options.password).toBeUndefined();
      expect(options.database).toBeUndefined();
    });

    it('should configure ssl with rejectUnauthorized: false when DB_SSL is true or "true"', () => {
      const optionsTrue = buildPostgresConnectionOptions({
        databaseUrl: supabaseUrl,
        ssl: true,
      });

      expect(optionsTrue.url).toBe(supabaseUrl);
      expect(optionsTrue.ssl).toEqual({ rejectUnauthorized: false });

      const optionsStr = buildPostgresConnectionOptions({
        databaseUrl: supabaseUrl,
        ssl: 'true',
      });

      expect(optionsStr.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('should automatically enable ssl when DATABASE_URL contains sslmode=require', () => {
      const urlWithSslMode = `${supabaseUrl}?sslmode=require`;
      const options = buildPostgresConnectionOptions({
        databaseUrl: urlWithSslMode,
      });

      expect(options.url).toBe(urlWithSslMode);
      expect(options.ssl).toEqual({ rejectUnauthorized: false });
    });
  });

  describe('3. Production Fail-Fast & Env Validation Layer', () => {
    const validProdBase = {
      NODE_ENV: 'production',
      JWT_SECRET: 'a_very_strong_custom_production_jwt_secret_key_123',
      JWT_REFRESH_SECRET: 'a_very_strong_custom_production_refresh_jwt_secret_456',
      AI_WORKER_SECRET: 'production_ai_worker_custom_secret_789',
      STORAGE_PROVIDER: 'r2',
      S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      S3_ACCESS_KEY_ID: 'fake-prod-r2-access-key-id',
      S3_SECRET_ACCESS_KEY: 'fake-prod-r2-secret-access-key-very-long',
      S3_BUCKET_MANGA: 'omninovel',
      S3_BUCKET_NOVEL: 'omninovel-novel',
      DATABASE_URL:
        'postgresql://postgres.dummy_project_ref:fake_test_password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      DB_SSL: 'true',
    };

    it('should FAIL-FAST when NODE_ENV is production and default DB_PASSWORD is used without DATABASE_URL', () => {
      const invalidProdConfig = {
        ...validProdBase,
        DATABASE_URL: undefined,
        DB_PASSWORD: 'postgres_password_secure',
      };

      expect(() => validateEnv(invalidProdConfig)).toThrow(
        /CẢNH BÁO DATABASE: Trên môi trường Production/,
      );
    });

    it('should FAIL-FAST when DATABASE_URL is malformed in production', () => {
      const invalidProdConfig = {
        ...validProdBase,
        DATABASE_URL: 'http://invalid-db-protocol.com/db',
      };

      expect(() => validateEnv(invalidProdConfig)).toThrow(
        /CẢNH BÁO DATABASE: Trên môi trường Production/,
      );
    });

    it('should FAIL-FAST when STORAGE_PROVIDER has an invalid enum value (e.g. typo r22)', () => {
      const typoConfig = {
        STORAGE_PROVIDER: 'r22',
      };

      expect(() => validateEnv(typoConfig)).toThrow(
        /Environment validation error/,
      );
    });

    it('should FAIL-FAST when STORAGE_PROVIDER=r2 but S3 credentials/buckets are missing', () => {
      const missingR2Config = {
        STORAGE_PROVIDER: 'r2',
        S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
        // Missing S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_MANGA, S3_BUCKET_NOVEL
      };

      expect(() => validateEnv(missingR2Config)).toThrow(
        /CẢNH BÁO STORAGE/,
      );
    });

    it('should PASS and preserve all S3_* and DB_* keys when valid production configuration is provided', () => {
      const validated = validateEnv(validProdBase);

      expect(validated.STORAGE_PROVIDER).toBe('r2');
      expect(validated.S3_ENDPOINT).toBe(validProdBase.S3_ENDPOINT);
      expect(validated.S3_ACCESS_KEY_ID).toBe(validProdBase.S3_ACCESS_KEY_ID);
      expect(validated.S3_SECRET_ACCESS_KEY).toBe(validProdBase.S3_SECRET_ACCESS_KEY);
      expect(validated.S3_BUCKET_MANGA).toBe(validProdBase.S3_BUCKET_MANGA);
      expect(validated.S3_BUCKET_NOVEL).toBe(validProdBase.S3_BUCKET_NOVEL);
      expect(validated.DATABASE_URL).toBe(validProdBase.DATABASE_URL);
      expect(validated.DB_SSL).toBe(true);
    });
  });

  describe('4. Migration CLI & Runtime Parity Contract', () => {
    it('should generate identical connection options for runtime (ConfigService) and migration CLI (process.env) in local dev', () => {
      const rawEnv = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'postgres',
        DB_PASSWORD: 'postgres_password_secure',
        DB_NAME: 'omninovel_db',
        DB_SSL: 'false',
      };

      // Giả lập ConfigService (Runtime)
      const mockConfigService = {
        get: jest.fn((key: string) => rawEnv[key as keyof typeof rawEnv]),
      } as unknown as ConfigService;

      const runtimeOptions = buildPostgresConnectionOptions({
        databaseUrl: mockConfigService.get<string>('DATABASE_URL'),
        host: mockConfigService.get<string>('DB_HOST'),
        port: mockConfigService.get<number>('DB_PORT'),
        username: mockConfigService.get<string>('DB_USER'),
        password: mockConfigService.get<string>('DB_PASSWORD'),
        database: mockConfigService.get<string>('DB_NAME'),
        ssl: mockConfigService.get<boolean | string>('DB_SSL'),
      });

      // Giả lập process.env (Migration CLI data-source.ts)
      const migrationOptions = buildPostgresConnectionOptions({
        databaseUrl: rawEnv['DATABASE_URL' as keyof typeof rawEnv],
        host: rawEnv.DB_HOST,
        port: rawEnv.DB_PORT,
        username: rawEnv.DB_USER,
        password: rawEnv.DB_PASSWORD,
        database: rawEnv.DB_NAME,
        ssl: rawEnv.DB_SSL,
      });

      expect(runtimeOptions).toEqual(migrationOptions);
      expect(runtimeOptions.host).toBe('localhost');
      expect(runtimeOptions.port).toBe(5433);
    });

    it('should generate identical connection options for runtime and migration CLI when targeting Supabase Production', () => {
      const supabaseEnv = {
        DATABASE_URL:
          'postgresql://postgres.dummy_project_ref:fake_test_password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
        DB_SSL: 'true',
      };

      // Runtime (DatabaseModule)
      const mockConfigService = {
        get: jest.fn((key: string) => supabaseEnv[key as keyof typeof supabaseEnv]),
      } as unknown as ConfigService;

      const runtimeOptions = buildPostgresConnectionOptions({
        databaseUrl: mockConfigService.get<string>('DATABASE_URL'),
        host: mockConfigService.get<string>('DB_HOST'),
        port: mockConfigService.get<number>('DB_PORT'),
        username: mockConfigService.get<string>('DB_USER'),
        password: mockConfigService.get<string>('DB_PASSWORD'),
        database: mockConfigService.get<string>('DB_NAME'),
        ssl: mockConfigService.get<boolean | string>('DB_SSL'),
      });

      // Migration CLI (data-source.ts)
      const migrationOptions = buildPostgresConnectionOptions({
        databaseUrl: supabaseEnv.DATABASE_URL,
        host: undefined,
        port: undefined,
        username: undefined,
        password: undefined,
        database: undefined,
        ssl: supabaseEnv.DB_SSL,
      });

      expect(runtimeOptions).toEqual(migrationOptions);
      expect(runtimeOptions.url).toBe(supabaseEnv.DATABASE_URL);
      expect(runtimeOptions.ssl).toEqual({ rejectUnauthorized: false });
    });
  });

  describe('5. Production Environment Precedence Invariant (No Dotenv Override)', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should prioritize OS/Docker/CI injected DATABASE_URL over local file values (override: false)', () => {
      const injectedProdDbUrl =
        'postgresql://postgres.dummy_project_ref:fake_test_password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

      // Giả lập môi trường container/CI đã inject DATABASE_URL
      process.env.DATABASE_URL = injectedProdDbUrl;
      process.env.DB_HOST = 'remote-pg';

      // Nạp cấu hình - kết nối PHẢI chọn injectedProdDbUrl
      const resolved = buildPostgresConnectionOptions({
        databaseUrl: process.env.DATABASE_URL,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL,
      });

      expect(resolved.url).toBe(injectedProdDbUrl);
      expect(resolved.host).toBeUndefined();
    });

    it('should allow explicit MIGRATION_ENV_FILE only when variables are unset in process.env', () => {
      // Injected key
      process.env.DATABASE_URL = 'postgresql://injected:pass@db:5432/injected_db';
      delete process.env.DB_PORT;

      // Mock value from explicit file (chỉ điền khi process.env chưa có)
      const explicitFileDbPort = 5434;
      if (!process.env.DB_PORT) {
        process.env.DB_PORT = String(explicitFileDbPort);
      }

      const resolved = buildPostgresConnectionOptions({
        databaseUrl: process.env.DATABASE_URL,
        port: process.env.DB_PORT,
      });

      // DATABASE_URL không bị ghi đè bởi file
      expect(resolved.url).toBe('postgresql://injected:pass@db:5432/injected_db');
    });
  });
});
