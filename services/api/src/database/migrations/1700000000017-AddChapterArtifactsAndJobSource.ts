import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChapterArtifactsAndJobSource1700000000017
  implements MigrationInterface
{
  name = 'AddChapterArtifactsAndJobSource1700000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- 1. Create Enums for ChapterArtifact
      DO $$ BEGIN
        CREATE TYPE chapter_artifact_type_enum AS ENUM ('OFFLINE_BUNDLE', 'TRANSLATION_SOURCE');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      DO $$ BEGIN
        CREATE TYPE chapter_artifact_status_enum AS ENUM ('MISSING', 'BUILDING', 'READY', 'FAILED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      -- 2. Create chapter_artifacts Table
      CREATE TABLE IF NOT EXISTS chapter_artifacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chapter_version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
        artifact_type chapter_artifact_type_enum NOT NULL,
        status chapter_artifact_status_enum NOT NULL DEFAULT 'MISSING',
        storage_key VARCHAR(255) NULL,
        file_size_bytes BIGINT NULL,
        sha256_hash VARCHAR(64) NULL,
        manifest_metadata JSONB NULL,
        error_message TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_chapter_version_artifact_type UNIQUE (chapter_version_id, artifact_type)
      );

      CREATE INDEX IF NOT EXISTS idx_chapter_artifacts_version_lookup 
        ON chapter_artifacts (chapter_version_id, artifact_type);

      -- 3. Add source_artifact_id column to translation_jobs
      ALTER TABLE translation_jobs
        ADD COLUMN IF NOT EXISTS source_artifact_id UUID NULL 
        REFERENCES chapter_artifacts(id) ON DELETE SET NULL;

      -- 4. Preflight check: Assert no active/nonterminal jobs have both sources NULL (#165 / #190)
      DO $$
      DECLARE
        dead_active_jobs_count INT;
      BEGIN
        SELECT COUNT(*) INTO dead_active_jobs_count
        FROM translation_jobs
        WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELED', 'APPLIED')
          AND source_upload_session_id IS NULL
          AND source_artifact_id IS NULL;

        IF dead_active_jobs_count > 0 THEN
          RAISE EXCEPTION 'MIGRATION_ABORT: Found % active translation_jobs without canonical source. Clean up before migrating.', dead_active_jobs_count;
        END IF;
      END $$;

      -- 5. Add strict canonical source XOR constraint (NOT VALID for safe rollout)
      ALTER TABLE translation_jobs 
        DROP CONSTRAINT IF EXISTS chk_translation_jobs_canonical_source;

      ALTER TABLE translation_jobs
        ADD CONSTRAINT chk_translation_jobs_canonical_source
        CHECK ( num_nonnulls(source_upload_session_id, source_artifact_id) = 1 ) NOT VALID;

      -- 6. Validate constraint if no legacy violating rows exist
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM translation_jobs 
          WHERE num_nonnulls(source_upload_session_id, source_artifact_id) != 1
        ) THEN
          ALTER TABLE translation_jobs VALIDATE CONSTRAINT chk_translation_jobs_canonical_source;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs 
        DROP CONSTRAINT IF EXISTS chk_translation_jobs_canonical_source;

      ALTER TABLE translation_jobs 
        DROP COLUMN IF EXISTS source_artifact_id;

      DROP TABLE IF EXISTS chapter_artifacts CASCADE;

      DROP TYPE IF EXISTS chapter_artifact_status_enum;
      DROP TYPE IF EXISTS chapter_artifact_type_enum;
    `);
  }
}
