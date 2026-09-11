import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationJobWorkspaceRevision1700000000013 implements MigrationInterface {
  name = 'AddTranslationJobWorkspaceRevision1700000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD COLUMN IF NOT EXISTS workspace_revision INTEGER NOT NULL DEFAULT 1;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP COLUMN IF EXISTS workspace_revision;
    `);
  }
}
