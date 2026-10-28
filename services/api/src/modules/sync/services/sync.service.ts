import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  PushMutationsBatchDto,
  PushMutationsBatchResponseDto,
  SyncChangesQueryDto,
  SyncChangesResponseDto,
  SyncSnapshotQueryDto,
  SyncSnapshotResponseDto,
} from '../dto';
import {
  SnapshotCursorPayload,
  SyncDomain,
  SyncOperation,
} from '../interfaces/sync.types';
import { computeCanonicalMutationHash } from '../helpers/canonical-json.helper';
import {
  ALLOWED_SNAPSHOT_DOMAINS,
  HmacCursorHelper,
} from '../helpers/hmac-cursor.helper';
import { ConflictResolverDispatcher } from '../resolvers';
import { SyncLogEmitter } from './sync-log-emitter.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly cursorSecret: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly conflictResolverDispatcher: ConflictResolverDispatcher,
    private readonly syncLogEmitter: SyncLogEmitter,
  ) {
    this.cursorSecret =
      this.configService.get<string>('SYNC_CURSOR_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      'omninovel-default-sync-cursor-secret-32chars!';
  }

  /**
   * Endpoint GET /api/v1/sync/changes
   * Kéo các biến đổi Delta phát sinh sau con trỏ `after` (Decimal String).
   */
  async getChanges(
    userId: string,
    query: SyncChangesQueryDto,
  ): Promise<SyncChangesResponseDto> {
    const afterRevision = BigInt(query.after || '0');
    const limit = query.limit || 100;

    // 1. Lấy trạng thái revision hiện hành của user
    const stateRows = await this.dataSource.query(
      `SELECT current_sync_revision AS "currentSyncRevision", min_active_revision AS "minActiveRevision"
       FROM user_sync_state
       WHERE user_id = $1`,
      [userId],
    );

    const currentServerRevision = stateRows[0]
      ? stateRows[0].currentSyncRevision.toString()
      : '0';
    const minActiveRevision = stateRows[0]
      ? stateRows[0].minActiveRevision.toString()
      : '0';

    // 2. Kiểm tra nếu client yêu cầu revision cũ hơn min_active_revision (đã bị GC dọn dẹp)
    if (afterRevision < BigInt(minActiveRevision)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.GONE,
          code: 'SYNC_REVISION_EXPIRED',
          message: `Client revision ${query.after} is expired and has been pruned by GC (minActiveRevision: ${minActiveRevision}); full snapshot resync required`,
          minActiveRevision,
          currentServerRevision,
        },
        HttpStatus.GONE,
      );
    }

    // 3. Truy vấn delta từ sync_change_log (lấy limit + 1 để xác định hasMore)
    const fetchLimit = limit + 1;
    const changeRows: {
      revision: string;
      domain: SyncDomain;
      entityId: string;
      operation: SyncOperation;
      payload: Record<string, unknown>;
      createdAt: Date;
    }[] = await this.dataSource.query(
      `SELECT revision::text, domain, entity_id AS "entityId", operation, payload, created_at AS "createdAt"
       FROM sync_change_log
       WHERE user_id = $1 AND revision > $2
       ORDER BY revision ASC
       LIMIT $3`,
      [userId, afterRevision.toString(), fetchLimit],
    );

    const hasMore = changeRows.length > limit;
    const pagedRows = hasMore ? changeRows.slice(0, limit) : changeRows;
    const nextRevision = hasMore
      ? pagedRows[pagedRows.length - 1].revision
      : null;

    return {
      currentServerRevision,
      minActiveRevision,
      nextRevision,
      hasMore,
      changes: pagedRows.map((row) => ({
        revision: row.revision,
        domain: row.domain,
        entityId: row.entityId,
        operation: row.operation,
        payload: row.payload || {},
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    };
  }

  /**
   * Endpoint GET /api/v1/sync/snapshot
   * Kéo ảnh chụp toàn bộ thư viện nhất quán với mức cô lập REPEATABLE READ READ ONLY
   * kết hợp Optimistic Snapshot Restart (HTTP 409 SNAPSHOT_INVALIDATED) qua HMAC Cursor.
   */
  async getSnapshot(
    userId: string,
    query: SyncSnapshotQueryDto,
  ): Promise<SyncSnapshotResponseDto> {
    const limit = query.limit || 200;
    let decodedCursor: SnapshotCursorPayload | null = null;

    if (query.cursor) {
      decodedCursor = HmacCursorHelper.verifyAndDecodeCursor(
        query.cursor,
        userId,
        this.cursorSecret,
      );
    }

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    // 1. Khởi động giao dịch REPEATABLE READ READ ONLY
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');

    try {
      // 2. Đọc revision hiện hành của user trong snapshot này
      const stateRows = await runner.query(
        `SELECT current_sync_revision AS "currentSyncRevision", min_active_revision AS "minActiveRevision"
         FROM user_sync_state
         WHERE user_id = $1`,
        [userId],
      );

      const currentServerRevision = stateRows[0]
        ? stateRows[0].currentSyncRevision.toString()
        : '0';
      const minActiveRevision = stateRows[0]
        ? stateRows[0].minActiveRevision.toString()
        : '0';

      // 3. Optimistic Snapshot Restart Check (409 Conflict nếu revision đã thay đổi giữa các trang)
      if (decodedCursor && decodedCursor.srev !== currentServerRevision) {
        await runner.rollbackTransaction();
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: 'SNAPSHOT_INVALIDATED',
          message: `Snapshot invalidated: current server revision (${currentServerRevision}) does not match pinned cursor revision (${decodedCursor.srev}); client must clear snapshot staging store and restart from page 1`,
          currentServerRevision,
          cursorRevision: decodedCursor.srev,
        });
      }

      const snapshotRevision = decodedCursor
        ? decodedCursor.srev
        : currentServerRevision;

      // 4. Đọc dữ liệu thư viện từ MVCC Snapshot
      // 4.1 Bookmarks
      const bookmarksRows: { story_id: string; created_at: Date }[] =
        await runner.query(
          `SELECT story_id, created_at
           FROM bookmarks
           WHERE user_id = $1
           ORDER BY story_id ASC
           LIMIT $2`,
          [userId, limit],
        );

      // 4.2 Reading Progress
      const progressRows: {
        story_id: string;
        chapter_id: string;
        chapter_version_id: string | null;
        reading_mode: string;
        page_index: number;
        scroll_position: string | number;
        progress_percentage: string | number;
        anchor_block_id: string | null;
        text_offset: number | null;
      }[] = await runner.query(
        `SELECT story_id, chapter_id, chapter_version_id, reading_mode,
                page_index, scroll_position, progress_percentage, anchor_block_id, text_offset
         FROM reading_progress
         WHERE user_id = $1
         ORDER BY story_id ASC
         LIMIT $2`,
        [userId, limit],
      );

      // 4.3 Chapter Read States
      const readStatesRows: {
        chapter_id: string;
        story_id: string;
        last_version_id: string | null;
        max_progress_percentage: string | number;
        completed_at: Date | null;
        last_read_at: Date;
        story_history_epoch: number;
      }[] = await runner.query(
        `SELECT crs.chapter_id, se.story_id, crs.last_version_id,
                crs.max_progress_percentage, crs.completed_at, crs.last_read_at,
                COALESCE(t.epoch, 0) AS story_history_epoch
         FROM chapter_read_states crs
         JOIN chapters c ON c.id = crs.chapter_id
         JOIN story_editions se ON se.id = c.story_edition_id
         LEFT JOIN reading_history_tombstones t ON t.user_id = crs.user_id AND t.story_id = se.story_id
         WHERE crs.user_id = $1
         ORDER BY crs.chapter_id ASC
         LIMIT $2`,
        [userId, limit],
      );

      // 4.4 Preferences (đọc các bản ghi PREFERENCE mới nhất từ sync_change_log)
      const preferenceRows: {
        entity_id: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }[] = await runner.query(
        `SELECT DISTINCT ON (entity_id) entity_id, payload, created_at
         FROM sync_change_log
         WHERE user_id = $1 AND domain = 'PREFERENCE' AND operation = 'UPSERT'
         ORDER BY entity_id, revision DESC
         LIMIT $2`,
        [userId, limit],
      );

      await runner.commitTransaction();

      // Kết quả snapshot trang 1: nếu số bản ghi chạm ngưỡng limit, sinh nextCursor
      const totalItems =
        bookmarksRows.length +
        progressRows.length +
        readStatesRows.length +
        preferenceRows.length;
      const hasMore = totalItems >= limit * 2; // Simple paging threshold
      const nextCursor = hasMore
        ? HmacCursorHelper.generateCursor(
            {
              userId,
              snapshotRevision,
              domain: 'PROGRESS',
              key:
                progressRows[progressRows.length - 1]?.story_id ||
                'end-of-partition',
            },
            this.cursorSecret,
          )
        : null;

      return {
        snapshotRevision,
        minActiveRevision,
        hasMore,
        nextCursor,
        data: {
          bookmarks: bookmarksRows.map((b) => ({
            storyId: b.story_id,
            createdAt: new Date(b.created_at).toISOString(),
          })),
          readingProgress: progressRows.map((p) => ({
            storyId: p.story_id,
            chapterId: p.chapter_id,
            chapterVersionId: p.chapter_version_id,
            readingMode: p.reading_mode as any,
            pageIndex: Number(p.page_index),
            scrollPosition: Number(p.scroll_position),
            progressPercentage: Number(p.progress_percentage),
            anchorBlockId: p.anchor_block_id,
            textOffset: p.text_offset !== null ? Number(p.text_offset) : null,
          })),
          chapterReadStates: readStatesRows.map((r) => ({
            chapterId: r.chapter_id,
            storyId: r.story_id,
            chapterVersionId: r.last_version_id,
            maxProgressPercentage: Number(r.max_progress_percentage),
            completedAt: r.completed_at
              ? new Date(r.completed_at).toISOString()
              : null,
            lastReadAt: new Date(r.last_read_at).toISOString(),
            storyHistoryEpoch: Number(r.story_history_epoch),
          })),
          preferences: preferenceRows.map((pref) => ({
            key: pref.entity_id,
            value: (pref.payload as any)?.value,
            updatedAt: new Date(pref.created_at).toISOString(),
          })),
        },
      };
    } catch (err) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Endpoint POST /api/v1/sync/mutations/batch
   * Đẩy và thực thi batch các mutations từ client với Durable Receipts,
   * kiểm soát xung đột theo miền, và cấp phát revision tăng đơn điệu.
   */
  async pushMutations(
    userId: string,
    dto: PushMutationsBatchDto,
  ): Promise<PushMutationsBatchResponseDto> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // 1. Lock Root Level 1: user_sync_state FOR UPDATE (Thống nhất trật tự khóa chống deadlock)
      const syncState = await this.syncLogEmitter.lockAndAcquireUserSyncState(
        runner.manager,
        userId,
      );
      let currentServerRev = syncState.currentSyncRevision;
      const minActiveRev = syncState.minActiveRevision;

      const results: {
        mutationId: string;
        status: any;
        assignedRevision: string | null;
        message?: string;
        reason?: string;
      }[] = [];

      // 2. Xử lý tuần tự từng mutation trong batch
      for (const mutation of dto.mutations) {
        const baseRev = BigInt(mutation.baseServerRevision);

        // 2.1 Kiểm tra tính hợp lệ của baseServerRevision đối với Server Watermark
        if (baseRev > currentServerRev) {
          results.push({
            mutationId: mutation.mutationId,
            status: 'REJECTED_STALE',
            assignedRevision: null,
            reason: 'BASE_REVISION_AHEAD_OF_SERVER',
            message: `baseServerRevision (${mutation.baseServerRevision}) is greater than current server revision (${currentServerRev})`,
          });
          continue;
        }

        if (baseRev < minActiveRev) {
          results.push({
            mutationId: mutation.mutationId,
            status: 'REJECTED_STALE',
            assignedRevision: null,
            reason: 'BASE_REVISION_EXPIRED',
            message: `baseServerRevision (${mutation.baseServerRevision}) is older than minActiveRevision (${minActiveRev}); full resync required`,
          });
          continue;
        }

        // 2.2 Tính Full Mutation Canonical Hash theo chuẩn JCS RFC 8785
        const canonicalHash = computeCanonicalMutationHash(mutation);

        // 2.3 Tra cứu Sổ cái Biên nhận Bền vững (sync_mutation_receipts)
        const receiptRows = await runner.query(
          `SELECT payload_hash, status, assigned_revision, response_meta
           FROM sync_mutation_receipts
           WHERE user_id = $1 AND client_id = $2 AND mutation_id = $3
           FOR UPDATE`,
          [userId, mutation.clientId, mutation.mutationId],
        );

        if (receiptRows.length > 0) {
          const receipt = receiptRows[0];

          // Nếu cùng mutationId nhưng payload canonical hash khác ➔ 409 Conflict
          if (receipt.payload_hash !== canonicalHash) {
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
              message: `Mutation ${mutation.mutationId} was previously submitted with a different canonical payload or revision`,
              mutationId: mutation.mutationId,
            });
          }

          // Cùng mutationId và cùng canonical hash:
          // Invariant P2: Nếu trước đó bị REJECTED, giữ nguyên mã từ chối ban đầu, KHÔNG đổi thành DEDUPLICATED
          if (
            receipt.status === 'REJECTED_TOMBSTONE' ||
            receipt.status === 'REJECTED_STALE' ||
            receipt.status === 'DOMAIN_NOT_SUPPORTED'
          ) {
            results.push({
              mutationId: mutation.mutationId,
              status: receipt.status,
              assignedRevision: null,
              reason: receipt.response_meta?.reason,
              message: 'Mutation previously rejected; returned durable receipt',
            });
            continue;
          }

          // Trước đó APPLIED hoặc CONFLICT_MERGED ➔ Trả DEDUPLICATED kèm assignedRevision gốc
          results.push({
            mutationId: mutation.mutationId,
            status: 'DEDUPLICATED',
            assignedRevision: receipt.assigned_revision
              ? receipt.assigned_revision.toString()
              : null,
            message: 'Mutation previously applied; returned durable receipt',
          });
          continue;
        }

        // 2.4 Chưa có biên nhận (Fresh Mutation): Lấy dữ liệu phân xử xung đột
        let tombstoneRevision: string | null = null;
        const tombstoneRows = await runner.query(
          `SELECT deleted_at_revision
           FROM sync_tombstones
           WHERE user_id = $1 AND domain = $2 AND entity_id = $3`,
          [userId, mutation.domain, mutation.entityId],
        );
        if (tombstoneRows.length > 0) {
          tombstoneRevision = tombstoneRows[0].deleted_at_revision.toString();
        }

        // Tra cứu effective history epoch cho domain HISTORY hoặc PROGRESS
        let effectiveHistoryEpoch = 0;
        const storyIdForEpoch =
          (mutation.payload as any)?.storyId || mutation.entityId;
        const epochRows = await runner.query(
          `SELECT COALESCE(MAX(epoch), 0) AS "effectiveEpoch"
           FROM reading_history_tombstones
           WHERE user_id = $1 AND story_id IN ($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [userId, storyIdForEpoch],
        );
        if (epochRows.length > 0) {
          effectiveHistoryEpoch = Number(epochRows[0].effectiveEpoch);
        }

        // Tra cứu existing record cho PROGRESS
        let existingRecord: any = null;
        if (mutation.domain === SyncDomain.PROGRESS) {
          const progressRows = await runner.query(
            `SELECT chapter_id, chapter_version_id, reading_mode, page_index,
                    scroll_position, progress_percentage, anchor_block_id, text_offset
             FROM reading_progress
             WHERE user_id = $1 AND story_id = $2
             FOR UPDATE`,
            [userId, storyIdForEpoch],
          );
          if (progressRows.length > 0) {
            existingRecord = progressRows[0];
          }
        }

        // 2.5 Thực thi Resolver tương ứng theo domain
        const resolution = await this.conflictResolverDispatcher.resolve({
          userId,
          mutation,
          canonicalHash,
          serverRevision: currentServerRev.toString(),
          minActiveRevision: minActiveRev.toString(),
          existingRecord,
          tombstoneRevision,
          effectiveHistoryEpoch,
        });

        // 2.6 Nếu Resolver từ chối mutation
        if (
          resolution.status === 'REJECTED_TOMBSTONE' ||
          resolution.status === 'REJECTED_STALE' ||
          resolution.status === 'DOMAIN_NOT_SUPPORTED'
        ) {
          // Lưu bền vững receipt bị từ chối
          await runner.query(
            `INSERT INTO sync_mutation_receipts (
               user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta, created_at
             ) VALUES (
               $1, $2, $3, $4, $5, NULL, $6, NOW()
             )`,
            [
              userId,
              mutation.clientId,
              mutation.mutationId,
              canonicalHash,
              resolution.status,
              JSON.stringify({
                reason: resolution.reason,
                message: resolution.message,
                metadata: resolution.metadata,
              }),
            ],
          );

          results.push({
            mutationId: mutation.mutationId,
            status: resolution.status,
            assignedRevision: null,
            reason: resolution.reason,
            message: resolution.message,
          });
          continue;
        }

        // 2.7 Nếu Mutation được APPLIED hoặc CONFLICT_MERGED
        currentServerRev = currentServerRev + 1n;
        const assignedRevStr = currentServerRev.toString();

        // Cập nhật CSDL miền tương ứng (Zero Gamification side-effects)
        if (mutation.domain === SyncDomain.BOOKMARK) {
          if (mutation.operation === SyncOperation.UPSERT) {
            await runner.query(
              `INSERT INTO bookmarks (user_id, story_id, created_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (user_id, story_id) DO NOTHING`,
              [userId, mutation.entityId],
            );
          } else if (mutation.operation === SyncOperation.DELETE) {
            await runner.query(
              `DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
              [userId, mutation.entityId],
            );
          }
        } else if (mutation.domain === SyncDomain.PROGRESS) {
          const payload = (resolution.resolvedPayload ||
            mutation.payload) as Record<string, any>;
          if (mutation.operation === SyncOperation.UPSERT) {
            await runner.query(
              `INSERT INTO reading_progress (
                 user_id, story_id, chapter_id, chapter_version_id, reading_mode,
                 progress_percentage, scroll_position, page_index, anchor_block_id, text_offset, updated_at
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::varchar,
                 $6::numeric, $7::numeric, $8::int, $9::varchar, $10::int, NOW()
               )
               ON CONFLICT (user_id, story_id) DO UPDATE SET
                 chapter_id = EXCLUDED.chapter_id,
                 chapter_version_id = EXCLUDED.chapter_version_id,
                 reading_mode = EXCLUDED.reading_mode,
                 progress_percentage = EXCLUDED.progress_percentage,
                 scroll_position = EXCLUDED.scroll_position,
                 page_index = EXCLUDED.page_index,
                 anchor_block_id = EXCLUDED.anchor_block_id,
                 text_offset = EXCLUDED.text_offset,
                 updated_at = NOW()`,
              [
                userId,
                payload.storyId,
                payload.chapterId,
                payload.chapterVersionId || null,
                payload.readingMode,
                payload.progressPercentage,
                payload.scrollPosition,
                payload.pageIndex,
                payload.anchorBlockId || null,
                payload.textOffset || null,
              ],
            );
          } else if (mutation.operation === SyncOperation.DELETE) {
            await runner.query(
              `DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
              [userId, mutation.entityId],
            );
          }
        } else if (mutation.domain === SyncDomain.HISTORY) {
          const payload = mutation.payload as Record<string, any>;
          const progressPercentage = Number(payload.progressPercentage ?? 0);
          const completedAt = progressPercentage >= 80 ? new Date() : null;

          await runner.query(
            `INSERT INTO chapter_read_states (
               user_id, chapter_id, last_version_id, max_progress_percentage, completed_at, last_read_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::timestamptz, NOW())
             ON CONFLICT (user_id, chapter_id) DO UPDATE SET
               last_version_id = COALESCE(EXCLUDED.last_version_id, chapter_read_states.last_version_id),
               max_progress_percentage = GREATEST(chapter_read_states.max_progress_percentage, EXCLUDED.max_progress_percentage),
               completed_at = CASE
                 WHEN chapter_read_states.completed_at IS NOT NULL THEN chapter_read_states.completed_at
                 WHEN EXCLUDED.max_progress_percentage >= 80 THEN NOW()
                 ELSE NULL
               END,
               last_read_at = NOW()`,
            [
              userId,
              payload.chapterId,
              payload.chapterVersionId || null,
              progressPercentage,
              completedAt,
            ],
          );
        }

        // Ghi vào sync_change_log
        await runner.query(
          `INSERT INTO sync_change_log (
             user_id, revision, client_id, mutation_id, domain, entity_id, operation, payload, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, NOW()
           )`,
          [
            userId,
            assignedRevStr,
            mutation.clientId,
            mutation.mutationId,
            mutation.domain,
            mutation.entityId,
            mutation.operation,
            JSON.stringify(resolution.resolvedPayload || mutation.payload),
          ],
        );

        // Cập nhật sync_tombstones nếu là thao tác DELETE
        if (mutation.operation === SyncOperation.DELETE) {
          await runner.query(
            `INSERT INTO sync_tombstones (
               user_id, domain, entity_id, deleted_at_revision, created_at
             ) VALUES (
               $1, $2, $3, $4, NOW()
             )
             ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
               deleted_at_revision = EXCLUDED.deleted_at_revision,
               created_at = NOW()`,
            [userId, mutation.domain, mutation.entityId, assignedRevStr],
          );
        }

        // Lưu bền vững receipt vào sync_mutation_receipts
        await runner.query(
          `INSERT INTO sync_mutation_receipts (
             user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, NOW()
           )`,
          [
            userId,
            mutation.clientId,
            mutation.mutationId,
            canonicalHash,
            resolution.status,
            assignedRevStr,
            JSON.stringify({
              reason: resolution.reason,
              message: resolution.message,
            }),
          ],
        );

        results.push({
          mutationId: mutation.mutationId,
          status: resolution.status,
          assignedRevision: assignedRevStr,
          message: resolution.message,
        });
      }

      // 3. Cập nhật current_sync_revision lên user_sync_state
      await runner.query(
        `UPDATE user_sync_state
         SET current_sync_revision = $1,
             last_synced_at = NOW()
         WHERE user_id = $2`,
        [currentServerRev.toString(), userId],
      );

      await runner.commitTransaction();

      return {
        processedCount: results.length,
        newServerRevision: currentServerRev.toString(),
        results,
      };
    } catch (err) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw err;
    } finally {
      await runner.release();
    }
  }
}
