import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUploadSessionsTable1700000000001 implements MigrationInterface {
  name = 'CreateUploadSessionsTable1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS upload_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
        chapter_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
        file_type VARCHAR(50) NOT NULL,
        expected_size BIGINT NOT NULL,
        quarantine_key VARCHAR(255) NOT NULL,
        final_key VARCHAR(255),
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VALIDATING', 'PROMOTED', 'FAILED', 'EXPIRED')),
        error_message TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        completed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_upload_sessions_edition ON upload_sessions(story_edition_id);
      CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS upload_sessions CASCADE;
    `);
  }
}
