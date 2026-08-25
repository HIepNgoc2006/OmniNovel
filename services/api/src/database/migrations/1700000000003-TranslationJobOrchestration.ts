import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranslationJobOrchestration1700000000003 implements MigrationInterface {
  name = 'TranslationJobOrchestration1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS source_upload_session_id UUID REFERENCES upload_sessions(id) ON DELETE SET NULL;

      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);

      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS apply_idempotency_key VARCHAR(100);

      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS result_manifest JSONB;

      ALTER TABLE translation_jobs 
      ADD COLUMN IF NOT EXISTS last_sequence INT DEFAULT 0;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_translation_job_user_idemp') THEN
          ALTER TABLE translation_jobs 
          ADD CONSTRAINT uq_translation_job_user_idemp UNIQUE (created_by, idempotency_key);
        END IF;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_translation_project_edition_lang') THEN
          ALTER TABLE translation_projects 
          ADD CONSTRAINT uq_translation_project_edition_lang UNIQUE (story_edition_id, source_language, target_language);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_projects DROP CONSTRAINT IF EXISTS uq_translation_project_edition_lang;
      ALTER TABLE translation_jobs DROP CONSTRAINT IF EXISTS uq_translation_job_user_idemp;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS last_sequence;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS result_manifest;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS apply_idempotency_key;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS idempotency_key;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS created_by;
      ALTER TABLE translation_jobs DROP COLUMN IF EXISTS source_upload_session_id;
    `);
  }
}
