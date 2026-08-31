import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReadingProgress1700000000007
  implements MigrationInterface
{
  name = 'AddReadingProgress1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reading_progress (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        chapter_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
        reading_mode VARCHAR(20) DEFAULT 'WEBTOON',
        progress_percentage NUMERIC(5,2) DEFAULT 0,
        scroll_position NUMERIC(10,2) DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, story_id)
      );

      CREATE TABLE IF NOT EXISTS chapter_read_states (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        last_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
        max_progress_percentage NUMERIC(5,2) DEFAULT 0,
        completed_at TIMESTAMPTZ,
        last_read_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, chapter_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reading_progress_user_updated ON reading_progress (user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chapter_read_states_user_last_read ON chapter_read_states (user_id, last_read_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS chapter_read_states;
      DROP TABLE IF EXISTS reading_progress;
    `);
  }
}
