import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationJobApplyMode1700000000014
  implements MigrationInterface
{
  name = 'AddTranslationJobApplyMode1700000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD COLUMN apply_mode VARCHAR(50) NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD CONSTRAINT chk_translation_jobs_apply_mode
      CHECK (
        apply_mode IS NULL OR
        apply_mode IN ('OVERWRITE_ACTIVE_VERSION', 'CREATE_ALTERNATE_VERSION')
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP CONSTRAINT IF EXISTS chk_translation_jobs_apply_mode;
    `);
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP COLUMN IF EXISTS apply_mode;
    `);
  }
}
