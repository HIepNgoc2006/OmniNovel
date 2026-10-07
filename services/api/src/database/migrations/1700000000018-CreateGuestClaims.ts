import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGuestClaims1700000000018 implements MigrationInterface {
  name = 'CreateGuestClaims1700000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE guest_claim_status AS ENUM ('PREPARED', 'COMMITTED', 'ABORTED', 'EXPIRED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE IF NOT EXISTS guest_claims (
        claim_id UUID PRIMARY KEY,
        user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        anonymized_subject_hash CHAR(64) NULL,
        guest_profile_id UUID NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        state_fingerprint VARCHAR(64) NOT NULL,
        status guest_claim_status NOT NULL DEFAULT 'PREPARED',
        preview_data JSONB NOT NULL,
        conflict_decisions JSONB,
        result_summary JSONB,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        committed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_guest_claims_user_id_status 
        ON guest_claims(user_id, status);

      CREATE INDEX IF NOT EXISTS idx_guest_claims_expires_at 
        ON guest_claims(expires_at) WHERE status = 'PREPARED';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_guest_claims_expires_at;
      DROP INDEX IF EXISTS idx_guest_claims_user_id_status;
      DROP TABLE IF EXISTS guest_claims CASCADE;
      DROP TYPE IF EXISTS guest_claim_status;
    `);
  }
}
