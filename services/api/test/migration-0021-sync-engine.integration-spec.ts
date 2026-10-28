import { DataSource } from 'typeorm';
import { CreateSyncEngineTables1700000000021 } from '../src/database/migrations/1700000000021-CreateSyncEngineTables';
import {
  validateTestDatabaseTarget,
  verifyTestDatabaseIdentity,
  bootstrapTestDatabaseMarker,
  EXPECTED_LOOPBACK_TEST_PORT,
} from '../src/common/guards/test-isolation-guard';
import { buildPostgresConnectionOptions } from '../src/database/database.config';
import { UserSyncState } from '../src/modules/sync/entities/user-sync-state.entity';
import { SyncChangeLog } from '../src/modules/sync/entities/sync-change-log.entity';
import { SyncTombstone } from '../src/modules/sync/entities/sync-tombstone.entity';
import { SyncMutationReceipt } from '../src/modules/sync/entities/sync-mutation-receipt.entity';
import { User } from '../src/modules/users/entities/user.entity';

import * as path from 'path';

describe('Migration 0021: CreateSyncEngineTables (Integration - Phase 7C.1)', () => {
  let dataSource: DataSource;
  const migration = new CreateSyncEngineTables1700000000021();

  const targetHost = process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1';
  const targetPort = Number(
    process.env.TEST_DB_PORT || process.env.DB_PORT || EXPECTED_LOOPBACK_TEST_PORT,
  );
  const targetDb = process.env.TEST_DB_NAME || process.env.DB_NAME || 'omninovel_test';
  const targetUser = process.env.TEST_DB_USER || process.env.DB_USER || 'postgres';
  const targetPassword =
    process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres_password_secure';

  beforeAll(async () => {
    // 1. Strict Fail-Closed Verification before opening connection
    validateTestDatabaseTarget({
      host: targetHost,
      port: targetPort,
      database: targetDb,
    });

    // 2. Verify identity marker and current_database() === 'omninovel_test'
    await bootstrapTestDatabaseMarker({
      host: targetHost,
      port: targetPort,
      database: targetDb,
      user: targetUser,
      password: targetPassword,
    });
    await verifyTestDatabaseIdentity({
      host: targetHost,
      port: targetPort,
      database: targetDb,
      user: targetUser,
      password: targetPassword,
    });

    // 3. Build connection strictly for isolated test database
    const pgOptions = buildPostgresConnectionOptions({
      host: targetHost,
      port: targetPort,
      username: targetUser,
      password: targetPassword,
      database: targetDb,
      ssl: false,
    });

    dataSource = new DataSource({
      type: 'postgres',
      ...pgOptions,
      synchronize: false,
      logging: false,
      entities: [path.join(__dirname, '../src/**/*.entity.ts')],
    });

    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('MIG-01: should apply up() and create all 4 sync tables with correct columns and constraints', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // Run up()
      await migration.up(queryRunner);

      // 1. Verify user_sync_state
      const userSyncCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'user_sync_state'`,
      );
      const userSyncColNames = userSyncCols.map((c: any) => c.column_name);
      expect(userSyncColNames).toContain('user_id');
      expect(userSyncColNames).toContain('current_sync_revision');
      expect(userSyncColNames).toContain('min_active_revision');
      expect(userSyncColNames).toContain('last_synced_at');
      expect(userSyncColNames).toContain('created_at');

      // 2. Verify sync_change_log
      const changeLogCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sync_change_log'`,
      );
      const changeLogColNames = changeLogCols.map((c: any) => c.column_name);
      expect(changeLogColNames).toContain('id');
      expect(changeLogColNames).toContain('user_id');
      expect(changeLogColNames).toContain('revision');
      expect(changeLogColNames).toContain('client_id');
      expect(changeLogColNames).toContain('mutation_id');
      expect(changeLogColNames).toContain('domain');
      expect(changeLogColNames).toContain('entity_id');
      expect(changeLogColNames).toContain('operation');
      expect(changeLogColNames).toContain('payload');
      expect(changeLogColNames).toContain('created_at');

      // 3. Verify sync_tombstones
      const tombstoneCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sync_tombstones'`,
      );
      const tombstoneColNames = tombstoneCols.map((c: any) => c.column_name);
      expect(tombstoneColNames).toContain('user_id');
      expect(tombstoneColNames).toContain('domain');
      expect(tombstoneColNames).toContain('entity_id');
      expect(tombstoneColNames).toContain('deleted_at_revision');
      expect(tombstoneColNames).toContain('created_at');

      // 4. Verify sync_mutation_receipts
      const receiptCols = await queryRunner.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sync_mutation_receipts'`,
      );
      const receiptColNames = receiptCols.map((c: any) => c.column_name);
      expect(receiptColNames).toContain('user_id');
      expect(receiptColNames).toContain('client_id');
      expect(receiptColNames).toContain('mutation_id');
      expect(receiptColNames).toContain('payload_hash');
      expect(receiptColNames).toContain('status');
      expect(receiptColNames).toContain('assigned_revision');
      expect(receiptColNames).toContain('response_meta');
      expect(receiptColNames).toContain('created_at');

      // 5. Verify Indexes
      const indexes = await queryRunner.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'sync_%' OR tablename = 'user_sync_state'`,
      );
      const indexNames = indexes.map((i: any) => i.indexname);
      expect(indexNames).toContain('idx_sync_change_log_pull');
      expect(indexNames).toContain('idx_sync_change_log_gc');
      expect(indexNames).toContain('idx_sync_tombstones_user_rev');
      expect(indexNames).toContain('idx_sync_mutation_receipts_lookup');

      // 6. Verify Unique Constraint on sync_change_log(user_id, revision)
      const uqConstraint = await queryRunner.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'uq_sync_change_log_user_revision'`,
      );
      expect(uqConstraint.length).toBe(1);

      // 7. Verify Check Constraint on user_sync_state
      const chkConstraint = await queryRunner.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'chk_sync_revision_monotonic'`,
      );
      expect(chkConstraint.length).toBe(1);
    } finally {
      await queryRunner.release();
    }
  });

  it('MIG-02: should enforce chk_sync_revision_monotonic check constraint fail-closed', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // Create a temporary test user
      const uRes = await queryRunner.query(
        `INSERT INTO users (username, email, password_hash, role, is_active)
         VALUES ('sync_chk_user_${Date.now()}', 'sync_chk_${Date.now()}@example.com', 'hash', 'READER', true)
         RETURNING id`,
      );
      const testUserId = uRes[0].id;

      // Valid insert: min_active_revision <= current_sync_revision (0 <= 10)
      await queryRunner.query(
        `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision)
         VALUES ($1, 10, 0)`,
        [testUserId],
      );

      // Invalid update: min_active_revision (15) > current_sync_revision (10) MUST fail
      await expect(
        queryRunner.query(
          `UPDATE user_sync_state SET min_active_revision = 15 WHERE user_id = $1`,
          [testUserId],
        ),
      ).rejects.toThrow(/chk_sync_revision_monotonic/);

      // Clean up test user (cascades to user_sync_state)
      await queryRunner.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    } finally {
      await queryRunner.release();
    }
  });

  it('MIG-03: should enforce unique constraint uq_sync_change_log_user_revision fail-closed', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      const uRes = await queryRunner.query(
        `INSERT INTO users (username, email, password_hash, role, is_active)
         VALUES ('sync_uq_user_${Date.now()}', 'sync_uq_${Date.now()}@example.com', 'hash', 'READER', true)
         RETURNING id`,
      );
      const testUserId = uRes[0].id;

      // First change log entry at revision 1
      await queryRunner.query(
        `INSERT INTO sync_change_log (user_id, revision, client_id, mutation_id, domain, entity_id, operation, payload)
         VALUES ($1, 1, 'client-1', '00000000-0000-0000-0000-000000000001', 'BOOKMARK', 'story-1', 'UPSERT', '{}'::jsonb)`,
        [testUserId],
      );

      // Duplicate revision 1 for same user MUST fail
      await expect(
        queryRunner.query(
          `INSERT INTO sync_change_log (user_id, revision, client_id, mutation_id, domain, entity_id, operation, payload)
           VALUES ($1, 1, 'client-2', '00000000-0000-0000-0000-000000000002', 'BOOKMARK', 'story-2', 'UPSERT', '{}'::jsonb)`,
          [testUserId],
        ),
      ).rejects.toThrow(/uq_sync_change_log_user_revision/);

      await queryRunner.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
    } finally {
      await queryRunner.release();
    }
  });

  it('MIG-04: should support 64-bit BIGINTs (> 2^53 - 1) via TypeORM Entities without precision loss', async () => {
    const userRepo = dataSource.getRepository(User);
    const syncStateRepo = dataSource.getRepository(UserSyncState);
    const changeLogRepo = dataSource.getRepository(SyncChangeLog);
    const tombstoneRepo = dataSource.getRepository(SyncTombstone);
    const receiptRepo = dataSource.getRepository(SyncMutationReceipt);

    // 1. Create test user
    const user = userRepo.create({
      username: `bigint_test_${Date.now()}`,
      email: `bigint_${Date.now()}@example.com`,
      passwordHash: 'hash',
    });
    await userRepo.save(user);

    try {
      // 2. Test UserSyncState with large 64-bit revision > 2^53 - 1
      const largeRev = '9007199254740995'; // > Number.MAX_SAFE_INTEGER
      const syncState = syncStateRepo.create({
        userId: user.id,
        currentSyncRevision: largeRev,
        minActiveRevision: '9007199254740000',
      });
      await syncStateRepo.save(syncState);

      const loadedSyncState = await syncStateRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(loadedSyncState.currentSyncRevision).toBe(largeRev);
      expect(typeof loadedSyncState.currentSyncRevision).toBe('string');
      expect(loadedSyncState.minActiveRevision).toBe('9007199254740000');

      // 3. Test SyncChangeLog with large 64-bit revision
      const log = changeLogRepo.create({
        userId: user.id,
        revision: largeRev,
        clientId: 'web-client-test',
        mutationId: '550e8400-e29b-41d4-a716-446655440000',
        domain: 'PROGRESS',
        entityId: 'story-1:chap-1',
        operation: 'UPSERT',
        payload: { progress: 70, chapterVersionId: 'v1' },
      });
      await changeLogRepo.save(log);

      const loadedLog = await changeLogRepo.findOneByOrFail({
        userId: user.id,
        revision: largeRev,
      });
      expect(loadedLog.revision).toBe(largeRev);
      expect(loadedLog.payload).toEqual({
        progress: 70,
        chapterVersionId: 'v1',
      });

      // 4. Test SyncTombstone with large 64-bit deleted_at_revision
      const tombstone = tombstoneRepo.create({
        userId: user.id,
        domain: 'BOOKMARK',
        entityId: 'story-999',
        deletedAtRevision: largeRev,
      });
      await tombstoneRepo.save(tombstone);

      const loadedTombstone = await tombstoneRepo.findOneByOrFail({
        userId: user.id,
        domain: 'BOOKMARK',
        entityId: 'story-999',
      });
      expect(loadedTombstone.deletedAtRevision).toBe(largeRev);

      // 5. Test SyncMutationReceipt with assignedRevision
      const receipt = receiptRepo.create({
        userId: user.id,
        clientId: 'web-client-test',
        mutationId: '550e8400-e29b-41d4-a716-446655440000',
        payloadHash:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status: 'APPLIED',
        assignedRevision: largeRev,
        responseMeta: { source: 'unit-test' },
      });
      await receiptRepo.save(receipt);

      const loadedReceipt = await receiptRepo.findOneByOrFail({
        userId: user.id,
        clientId: 'web-client-test',
        mutationId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(loadedReceipt.assignedRevision).toBe(largeRev);
      expect(loadedReceipt.status).toBe('APPLIED');

      // 6. Verify Cascade Delete
      await userRepo.delete(user.id);

      const remainingState = await syncStateRepo.findOneBy({ userId: user.id });
      const remainingLogs = await changeLogRepo.findBy({ userId: user.id });
      const remainingTombstones = await tombstoneRepo.findBy({
        userId: user.id,
      });
      const remainingReceipts = await receiptRepo.findBy({ userId: user.id });

      expect(remainingState).toBeNull();
      expect(remainingLogs.length).toBe(0);
      expect(remainingTombstones.length).toBe(0);
      expect(remainingReceipts.length).toBe(0);
    } finally {
      // Ensure test user cleanup if assertion failed before delete
      await userRepo.delete(user.id).catch(() => {});
    }
  });

  it('MIG-05: should cleanly revert via down() and re-apply via up()', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      // 1. Revert down()
      await migration.down(queryRunner);

      // Verify all tables dropped
      const checkTablesAfterDown = await queryRunner.query(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' 
           AND table_name IN ('user_sync_state', 'sync_change_log', 'sync_tombstones', 'sync_mutation_receipts')`,
      );
      expect(checkTablesAfterDown.length).toBe(0);

      // Verify indexes dropped
      const checkIndexesAfterDown = await queryRunner.query(
        `SELECT indexname FROM pg_indexes 
         WHERE schemaname = 'public' 
           AND indexname IN ('idx_sync_change_log_pull', 'idx_sync_change_log_gc', 'idx_sync_tombstones_user_rev', 'idx_sync_mutation_receipts_lookup')`,
      );
      expect(checkIndexesAfterDown.length).toBe(0);

      // 2. Re-apply up() to restore schema
      await migration.up(queryRunner);

      const checkTablesAfterReUp = await queryRunner.query(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' 
           AND table_name IN ('user_sync_state', 'sync_change_log', 'sync_tombstones', 'sync_mutation_receipts')`,
      );
      expect(checkTablesAfterReUp.length).toBe(4);
    } finally {
      await queryRunner.release();
    }
  });
});
