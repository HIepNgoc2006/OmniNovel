import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserPreferencesTable1700000000022 implements MigrationInterface {
  name = 'CreateUserPreferencesTable1700000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key VARCHAR(64) NOT NULL,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key 
        ON user_preferences(user_id, key ASC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_user_preferences_user_key;
      DROP TABLE IF EXISTS user_preferences;
    `);
  }
}
