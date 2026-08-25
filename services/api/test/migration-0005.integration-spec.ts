import { DataSource } from 'typeorm';
import { TranslationJobInputManifest1700000000005 } from '../src/database/migrations/1700000000005-TranslationJobInputManifest';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

describe('Migration 0005: TranslationJobInputManifest (Integration)', () => {
  let dataSource: DataSource;
  const migration = new TranslationJobInputManifest1700000000005();

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5433', 10),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres_password_secure',
      database: process.env.DB_NAME || 'omninovel_db',
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('should verify migration up() adds input_manifest jsonb column', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration.up(queryRunner);

      const colInfo = await queryRunner.query(
        `SELECT column_name, data_type, is_nullable 
         FROM information_schema.columns 
         WHERE table_name = 'translation_jobs' AND column_name = 'input_manifest'`,
      );

      expect(colInfo.length).toBe(1);
      expect(colInfo[0].data_type).toBe('jsonb');
      expect(colInfo[0].is_nullable).toBe('YES');
    } finally {
      await queryRunner.release();
    }
  });

  it('should verify down() drops input_manifest, and re-running up() restores it', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // 1. Run down()
      await migration.down(queryRunner);

      const colInfoAfterDown = await queryRunner.query(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = 'translation_jobs' AND column_name = 'input_manifest'`,
      );
      expect(colInfoAfterDown.length).toBe(0);

      // 2. Re-run up()
      await migration.up(queryRunner);

      const colInfoAfterUp = await queryRunner.query(
        `SELECT column_name, data_type 
         FROM information_schema.columns 
         WHERE table_name = 'translation_jobs' AND column_name = 'input_manifest'`,
      );
      expect(colInfoAfterUp.length).toBe(1);
      expect(colInfoAfterUp[0].data_type).toBe('jsonb');
    } finally {
      await queryRunner.release();
    }
  });
});
