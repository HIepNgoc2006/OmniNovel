import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuestClaimFinalizationData1700000000020 implements MigrationInterface {
  name = 'AddGuestClaimFinalizationData1700000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE guest_claims
      ADD COLUMN IF NOT EXISTS finalization_data JSONB NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE guest_claims
      DROP COLUMN IF EXISTS finalization_data;
    `);
  }
}
