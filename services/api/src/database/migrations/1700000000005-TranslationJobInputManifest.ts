import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranslationJobInputManifest1700000000005
  implements MigrationInterface
{
  name = 'TranslationJobInputManifest1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "translation_jobs" ADD COLUMN IF NOT EXISTS "input_manifest" JSONB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "translation_jobs" DROP COLUMN IF EXISTS "input_manifest"`,
    );
  }
}
