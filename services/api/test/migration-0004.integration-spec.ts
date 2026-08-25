import { DataSource } from 'typeorm';
import { TranslationSegmentOcrSemantics1700000000004 } from '../src/database/migrations/1700000000004-TranslationSegmentOcrSemantics';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

describe('Migration 0004: TranslationSegmentOcrSemantics (Integration)', () => {
  let dataSource: DataSource;
  const migration = new TranslationSegmentOcrSemantics1700000000004();

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

  it('should verify migration up() drops default value on confidence column', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await migration.up(queryRunner);

      const colInfo = await queryRunner.query(
        `SELECT column_name, column_default, is_nullable 
         FROM information_schema.columns 
         WHERE table_name = 'translation_segments' AND column_name = 'confidence'`,
      );

      expect(colInfo.length).toBe(1);
      expect(colInfo[0].column_default).toBeNull();
      expect(colInfo[0].is_nullable).toBe('YES');
    } finally {
      await queryRunner.release();
    }
  });

  it('should verify down() restores default 0.950, and re-running up() drops default again', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // 1. Run down()
      await migration.down(queryRunner);

      const colInfoAfterDown = await queryRunner.query(
        `SELECT column_name, column_default 
         FROM information_schema.columns 
         WHERE table_name = 'translation_segments' AND column_name = 'confidence'`,
      );
      expect(colInfoAfterDown[0].column_default).toMatch(/0\.950/);

      // 2. Re-run up()
      await migration.up(queryRunner);

      const colInfoAfterUp = await queryRunner.query(
        `SELECT column_name, column_default 
         FROM information_schema.columns 
         WHERE table_name = 'translation_segments' AND column_name = 'confidence'`,
      );
      expect(colInfoAfterUp[0].column_default).toBeNull();
    } finally {
      await queryRunner.release();
    }
  });
});
