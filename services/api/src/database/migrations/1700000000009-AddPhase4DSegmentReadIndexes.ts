import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPhase4DSegmentReadIndexes1700000000009
  implements MigrationInterface
{
  name = 'AddPhase4DSegmentReadIndexes1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_translation_segments_job_sort_id
      ON translation_segments (job_id, sort_order ASC, id ASC);

      CREATE INDEX IF NOT EXISTS idx_translation_segments_job_page_sort_id
      ON translation_segments (job_id, page_number, sort_order ASC, id ASC);

      CREATE INDEX IF NOT EXISTS idx_translation_jobs_created
      ON translation_jobs (created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_translation_projects_created
      ON translation_projects (created_at DESC, id DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_translation_segments_job_sort_id;
      DROP INDEX IF EXISTS idx_translation_segments_job_page_sort_id;
      DROP INDEX IF EXISTS idx_translation_jobs_created;
      DROP INDEX IF EXISTS idx_translation_projects_created;
    `);
  }
}
