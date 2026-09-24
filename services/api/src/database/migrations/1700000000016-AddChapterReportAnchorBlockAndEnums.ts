import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChapterReportAnchorBlockAndEnums1700000000016
  implements MigrationInterface
{
  name = 'AddChapterReportAnchorBlockAndEnums1700000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- 1. Allow optional description
      ALTER TABLE chapter_error_reports ALTER COLUMN description DROP NOT NULL;
      ALTER TABLE chapter_error_reports ALTER COLUMN description SET DEFAULT '';

      -- 2. Add chapter_version_id foreign key
      ALTER TABLE chapter_error_reports 
        ADD COLUMN IF NOT EXISTS chapter_version_id UUID NULL 
        REFERENCES chapter_versions(id) ON DELETE SET NULL;

      -- 3. Add anchor_block_id for novel reader
      ALTER TABLE chapter_error_reports 
        ADD COLUMN IF NOT EXISTS anchor_block_id VARCHAR(100) NULL;

      -- 4. Constraint page_number >= 1
      ALTER TABLE chapter_error_reports 
        DROP CONSTRAINT IF EXISTS chapter_error_reports_page_number_check;
      ALTER TABLE chapter_error_reports 
        ADD CONSTRAINT chapter_error_reports_page_number_check 
        CHECK (page_number IS NULL OR page_number >= 1);

      -- 5. Expand error_type constraint to 7 canonical enums
      ALTER TABLE chapter_error_reports 
        DROP CONSTRAINT IF EXISTS chapter_error_reports_error_type_check;
      ALTER TABLE chapter_error_reports 
        ADD CONSTRAINT chapter_error_reports_error_type_check 
        CHECK (error_type IN (
          'IMAGE_CORRUPT',
          'WRONG_ORDER',
          'TRANSLATION_ERROR',
          'TYPO',
          'COPYRIGHT_INFRINGEMENT',
          'INAPPROPRIATE_CONTENT',
          'OTHER'
        ));

      -- 6. Performance index for concurrency duplicate checks
      CREATE INDEX IF NOT EXISTS idx_chapter_error_reports_dup_check 
        ON chapter_error_reports (reporter_id, chapter_id, chapter_version_id, error_type, status, created_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_chapter_error_reports_dup_check;

      ALTER TABLE chapter_error_reports 
        DROP CONSTRAINT IF EXISTS chapter_error_reports_error_type_check;
      ALTER TABLE chapter_error_reports 
        ADD CONSTRAINT chapter_error_reports_error_type_check 
        CHECK (error_type IN (
          'IMAGE_CORRUPT',
          'WRONG_ORDER',
          'TRANSLATION_ERROR',
          'TYPO',
          'COPYRIGHT_INFRINGEMENT',
          'OTHER'
        ));

      ALTER TABLE chapter_error_reports 
        DROP CONSTRAINT IF EXISTS chapter_error_reports_page_number_check;

      ALTER TABLE chapter_error_reports 
        DROP COLUMN IF EXISTS anchor_block_id;
      ALTER TABLE chapter_error_reports 
        DROP COLUMN IF EXISTS chapter_version_id;

      -- Normalize any NULL description before setting NOT NULL
      UPDATE chapter_error_reports SET description = '' WHERE description IS NULL;
      ALTER TABLE chapter_error_reports ALTER COLUMN description SET NOT NULL;
    `);
  }
}
