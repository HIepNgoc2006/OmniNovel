import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranslationSegmentOcrSemantics1700000000004
  implements MigrationInterface
{
  name = 'TranslationSegmentOcrSemantics1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "translation_segments" ALTER COLUMN "confidence" DROP DEFAULT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "translation_segments" ALTER COLUMN "confidence" SET DEFAULT 0.950`,
    );
  }
}
