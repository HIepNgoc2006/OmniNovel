import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStoryDiscoveryIndexes1700000000006
  implements MigrationInterface
{
  name = 'AddStoryDiscoveryIndexes1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_stories_title_trgm ON stories USING gin (title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_stories_visibility_format_status ON stories (visibility, media_format, status);
      CREATE INDEX IF NOT EXISTS idx_chapters_edition_published ON chapters (story_edition_id, active_version_id);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks (user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_stories_title_trgm;
      DROP INDEX IF EXISTS idx_stories_visibility_format_status;
      DROP INDEX IF EXISTS idx_chapters_edition_published;
      DROP INDEX IF EXISTS idx_bookmarks_user_id;
    `);
  }
}
