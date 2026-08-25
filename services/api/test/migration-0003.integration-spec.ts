import { DataSource } from 'typeorm';
import { TranslationJobOrchestration1700000000003 } from '../src/database/migrations/1700000000003-TranslationJobOrchestration';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

describe('Migration 0003: TranslationJobOrchestration (Integration)', () => {
  let dataSource: DataSource;
  const migration = new TranslationJobOrchestration1700000000003();

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

  it('should verify migration up() applied columns, indexes and constraints correctly', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // 1. Kiểm tra bảng translation_projects
      const projectCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'translation_projects'`,
      );
      const projectColNames = projectCols.map((c: any) => c.column_name);
      expect(projectColNames).toContain('story_edition_id');
      expect(projectColNames).toContain('source_language');
      expect(projectColNames).toContain('target_language');

      // 2. Kiểm tra bảng translation_jobs
      const jobCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'translation_jobs'`,
      );
      const jobColNames = jobCols.map((c: any) => c.column_name);
      expect(jobColNames).toContain('source_upload_session_id');
      expect(jobColNames).toContain('created_by');
      expect(jobColNames).toContain('idempotency_key');
      expect(jobColNames).toContain('apply_idempotency_key');
      expect(jobColNames).toContain('result_manifest');
      expect(jobColNames).toContain('last_sequence');

      // 3. Kiểm tra UNIQUE constraint
      const constraints = await queryRunner.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'uq_translation_job_user_idemp'`,
      );
      expect(constraints.length).toBeGreaterThan(0);
    } finally {
      await queryRunner.release();
    }
  });

  it('should successfully run down() and revert cleanly, then run up() again', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // Test down()
      await migration.down(queryRunner);

      // Verify columns and constraints dropped
      const checkColsAfterDown = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'translation_jobs' AND column_name = 'result_manifest'`,
      );
      expect(checkColsAfterDown.length).toBe(0);

      // Re-run up()
      await migration.up(queryRunner);

      const checkColsAfterUp = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'translation_jobs' AND column_name = 'result_manifest'`,
      );
      expect(checkColsAfterUp.length).toBe(1);
    } finally {
      await queryRunner.release();
    }
  });
});
