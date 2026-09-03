import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPhase4DStudioListingIndexes1700000000008
  implements MigrationInterface
{
  name = 'AddPhase4DStudioListingIndexes1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_story_members_user_story
      ON story_members (user_id, story_id);

      CREATE INDEX IF NOT EXISTS idx_translation_jobs_project_created
      ON translation_jobs (project_id, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_translation_jobs_status_created
      ON translation_jobs (status, created_at DESC, id DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_story_members_user_story;
      DROP INDEX IF EXISTS idx_translation_jobs_project_created;
      DROP INDEX IF EXISTS idx_translation_jobs_status_created;
    `);
  }
}
