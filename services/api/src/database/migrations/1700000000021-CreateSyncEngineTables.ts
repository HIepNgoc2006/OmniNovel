import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSyncEngineTables1700000000021 implements MigrationInterface {
  name = 'CreateSyncEngineTables1700000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Bảng Quản lý Trạng thái Revision và GC Watermark của User
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_sync_state (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        current_sync_revision BIGINT NOT NULL DEFAULT 0,
        min_active_revision BIGINT NOT NULL DEFAULT 0,
        last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_sync_revision_monotonic CHECK (min_active_revision <= current_sync_revision)
      );
    `);

    // 2. Nhật ký đồng bộ Delta
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_change_log (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        client_id VARCHAR(64) NOT NULL,
        mutation_id UUID NOT NULL,
        domain VARCHAR(32) NOT NULL,
        entity_id VARCHAR(128) NOT NULL,
        operation VARCHAR(16) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_sync_change_log_user_revision UNIQUE (user_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_sync_change_log_pull 
        ON sync_change_log(user_id, revision ASC);

      CREATE INDEX IF NOT EXISTS idx_sync_change_log_gc 
        ON sync_change_log(user_id, created_at ASC);
    `);

    // 3. Bảng Tombstone bảo vệ chống phục sinh dữ liệu
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_tombstones (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        domain VARCHAR(32) NOT NULL,
        entity_id VARCHAR(128) NOT NULL,
        deleted_at_revision BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, domain, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sync_tombstones_user_rev 
        ON sync_tombstones(user_id, deleted_at_revision ASC);
    `);

    // 4. Bảng Sổ cái Biên nhận Khả trùng Bền vững
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sync_mutation_receipts (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id VARCHAR(64) NOT NULL,
        mutation_id UUID NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        assigned_revision BIGINT,
        response_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, client_id, mutation_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sync_mutation_receipts_lookup 
        ON sync_mutation_receipts(user_id, client_id, mutation_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_sync_mutation_receipts_lookup;
      DROP TABLE IF EXISTS sync_mutation_receipts;

      DROP INDEX IF EXISTS idx_sync_tombstones_user_rev;
      DROP TABLE IF EXISTS sync_tombstones;

      DROP INDEX IF EXISTS idx_sync_change_log_gc;
      DROP INDEX IF EXISTS idx_sync_change_log_pull;
      DROP TABLE IF EXISTS sync_change_log;

      DROP TABLE IF EXISTS user_sync_state;
    `);
  }
}
