import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationSegmentReviewVersion1700000000011 implements MigrationInterface {
  name = 'AddTranslationSegmentReviewVersion1700000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_segments
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_segments
      DROP COLUMN IF EXISTS version;
    `);
  }
}
