import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserPurgeAndNormalizeRewardTransactions1700000000019 implements MigrationInterface {
  name = 'AddUserPurgeAndNormalizeRewardTransactions1700000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Thêm cột scheduled_purge_at vào bảng users phục vụ Grace Period 30 ngày
    await queryRunner.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS scheduled_purge_at TIMESTAMPTZ NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_scheduled_purge_at 
      ON users(scheduled_purge_at) WHERE is_deleted = true;
    `);

    // 2. Chuẩn hóa bảng reward_transactions:
    // - Drop Foreign Key cũ (ON DELETE RESTRICT)
    // - Cho phép user_id nullable
    // - Thêm cột anonymized_subject_hash CHAR(64) NULL
    // - Thêm Foreign Key mới ON DELETE SET NULL
    await queryRunner.query(`
      DO $$
      DECLARE
        fk_record RECORD;
      BEGIN
        FOR fk_record IN (
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = 'reward_transactions'
            AND kcu.column_name = 'user_id'
        ) LOOP
          EXECUTE 'ALTER TABLE reward_transactions DROP CONSTRAINT ' || quote_ident(fk_record.constraint_name);
        END LOOP;
      END $$;

      ALTER TABLE reward_transactions 
      ALTER COLUMN user_id DROP NOT NULL;

      ALTER TABLE reward_transactions 
      ADD COLUMN IF NOT EXISTS anonymized_subject_hash CHAR(64) NULL;

      ALTER TABLE reward_transactions 
      ADD CONSTRAINT fk_reward_transactions_user_id 
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE reward_transactions DROP CONSTRAINT IF EXISTS fk_reward_transactions_user_id;
      ALTER TABLE reward_transactions DROP COLUMN IF EXISTS anonymized_subject_hash;
      DELETE FROM reward_transactions WHERE user_id IS NULL;
      ALTER TABLE reward_transactions ALTER COLUMN user_id SET NOT NULL;
      ALTER TABLE reward_transactions 
      ADD CONSTRAINT reward_transactions_user_id_fkey 
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

      DROP INDEX IF EXISTS idx_users_scheduled_purge_at;
      ALTER TABLE users DROP COLUMN IF EXISTS scheduled_purge_at;
    `);
  }
}
