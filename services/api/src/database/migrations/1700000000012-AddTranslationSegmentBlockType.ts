import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationSegmentBlockType1700000000012 implements MigrationInterface {
  name = 'AddTranslationSegmentBlockType1700000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE novel_block_type_enum AS ENUM ('HEADING', 'DIALOGUE', 'NARRATION', 'BLOCKQUOTE');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE translation_segments
      ADD COLUMN IF NOT EXISTS block_type novel_block_type_enum;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_segments
      DROP COLUMN IF EXISTS block_type;
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS novel_block_type_enum;
    `);
  }
}
