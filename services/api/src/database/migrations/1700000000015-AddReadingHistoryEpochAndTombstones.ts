import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReadingHistoryEpochAndTombstones1700000000015
  implements MigrationInterface
{
  name = 'AddReadingHistoryEpochAndTombstones1700000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reading_history_epoch_counters (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        epoch INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reading_history_tombstones (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        story_id UUID NOT NULL,
        epoch INT NOT NULL,
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, story_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reading_history_tombstones_user_story 
        ON reading_history_tombstones (user_id, story_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_reading_history_tombstones_user_story;
      DROP TABLE IF EXISTS reading_history_tombstones;
      DROP TABLE IF EXISTS reading_history_epoch_counters;
    `);
  }
}
