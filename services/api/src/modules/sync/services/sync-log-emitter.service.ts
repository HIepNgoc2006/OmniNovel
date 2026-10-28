import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';

export interface SyncLogEmitParams {
  userId: string;
  clientId?: string;
  mutationId?: string;
  domain: SyncDomain;
  entityId: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
}

@Injectable()
export class SyncLogEmitter {
  private readonly logger = new Logger(SyncLogEmitter.name);

  /**
   * Đảm bảo bản ghi user_sync_state tồn tại và khóa dòng FOR UPDATE
   * để thiết lập trật tự khóa nhất quán (Lock Hierarchy Level 1)
   * chống deadlock trên mọi giao dịch ghi thư viện.
   */
  async lockAndAcquireUserSyncState(
    manager: EntityManager,
    userId: string,
  ): Promise<{ currentSyncRevision: bigint; minActiveRevision: bigint }> {
    // 1. Đảm bảo dòng tồn tại
    await manager.query(
      `INSERT INTO user_sync_state (user_id, current_sync_revision, min_active_revision, last_synced_at, created_at)
       VALUES ($1, 0, 0, NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );

    // 2. Khóa dòng FOR UPDATE
    const rows = await manager.query(
      `SELECT current_sync_revision, min_active_revision
       FROM user_sync_state
       WHERE user_id = $1
       FOR UPDATE`,
      [userId],
    );

    const firstRow = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : rows?.[0];
    return {
      currentSyncRevision: BigInt(firstRow?.current_sync_revision ?? firstRow?.currentSyncRevision ?? 0),
      minActiveRevision: BigInt(firstRow?.min_active_revision ?? firstRow?.minActiveRevision ?? 0),
    };
  }

  /**
   * Phát sinh bản ghi thay đổi Delta vào sync_change_log bên trong giao dịch hiện tại.
   * Monotonically bumps current_sync_revision và cập nhật sync_tombstones nếu là DELETE.
   */
  async emit(
    manager: EntityManager,
    params: SyncLogEmitParams,
  ): Promise<string> {
    const results = await this.emitBatch(manager, params.userId, [params]);
    return results;
  }

  /**
   * Phát sinh hàng loạt bản ghi Delta trong một giao dịch (dành cho Guest Claim merge hoặc bulk import).
   */
  async emitBatch(
    manager: EntityManager,
    userId: string,
    items: Omit<SyncLogEmitParams, 'userId'>[],
  ): Promise<string> {
    if (items.length === 0) {
      const state = await this.lockAndAcquireUserSyncState(manager, userId);
      return state.currentSyncRevision.toString();
    }

    // 1. Lock user_sync_state FOR UPDATE
    await this.lockAndAcquireUserSyncState(manager, userId);

    let finalRevision = 0n;

    for (const item of items) {
      // 2. Monotonically tăng revision
      const updateRes = await manager.query(
        `UPDATE user_sync_state
         SET current_sync_revision = current_sync_revision + 1,
             last_synced_at = NOW()
         WHERE user_id = $1
         RETURNING current_sync_revision`,
        [userId],
      );

      const updateRow = Array.isArray(updateRes) && Array.isArray(updateRes[0]) ? updateRes[0][0] : updateRes?.[0];
      finalRevision = BigInt(updateRow?.current_sync_revision ?? updateRow?.currentSyncRevision ?? 0);
      const revisionStr = finalRevision.toString();
      const clientId = item.clientId || 'server-core-api';
      const mutationId = item.mutationId || uuidv4();

      // 3. Insert sync_change_log
      await manager.query(
        `INSERT INTO sync_change_log (
           user_id, revision, client_id, mutation_id, domain, entity_id, operation, payload, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, NOW()
         )`,
        [
          userId,
          revisionStr,
          clientId,
          mutationId,
          item.domain,
          item.entityId,
          item.operation,
          JSON.stringify(item.payload || {}),
        ],
      );

      // 4. Nếu là thao tác DELETE, ghi nhận vào sync_tombstones để bảo vệ anti-resurrection
      if (item.operation === SyncOperation.DELETE) {
        await manager.query(
          `INSERT INTO sync_tombstones (
             user_id, domain, entity_id, deleted_at_revision, created_at
           ) VALUES (
             $1, $2, $3, $4, NOW()
           )
           ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
             deleted_at_revision = EXCLUDED.deleted_at_revision,
             created_at = NOW()`,
          [userId, item.domain, item.entityId, revisionStr],
        );
      }
    }

    return finalRevision.toString();
  }
}
