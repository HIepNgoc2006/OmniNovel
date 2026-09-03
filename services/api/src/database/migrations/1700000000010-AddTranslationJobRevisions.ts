import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationJobRevisions1700000000010 implements MigrationInterface {
  name = 'AddTranslationJobRevisions1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD COLUMN IF NOT EXISTS review_revision INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS materialized_revision INTEGER NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP COLUMN IF EXISTS review_revision,
      DROP COLUMN IF EXISTS materialized_revision;
    `);
  }
}
