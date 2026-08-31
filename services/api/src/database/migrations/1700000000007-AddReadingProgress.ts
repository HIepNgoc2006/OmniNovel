import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReadingProgress1700000000007
  implements MigrationInterface
{
  name = 'AddReadingProgress1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS chapter_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL;
      ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS reading_mode VARCHAR(20) DEFAULT 'WEBTOON';
      ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS progress_percentage NUMERIC(5,2) DEFAULT 0;
      ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS scroll_position NUMERIC(10,2) DEFAULT 0;

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
      ALTER TABLE reading_progress DROP COLUMN IF EXISTS scroll_position;
      ALTER TABLE reading_progress DROP COLUMN IF EXISTS progress_percentage;
      ALTER TABLE reading_progress DROP COLUMN IF EXISTS reading_mode;
      ALTER TABLE reading_progress DROP COLUMN IF EXISTS chapter_version_id;
    `);
  }
}
