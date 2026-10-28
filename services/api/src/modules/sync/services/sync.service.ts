import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
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

const UUID_ANY_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SNAPSHOT_DOMAINS = [
  'BOOKMARK',
  'PROGRESS',
  'CHAPTER_READ_STATE',
  'PREFERENCE',
] as const;
type SnapshotDomainName = (typeof SNAPSHOT_DOMAINS)[number];

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
    const secret =
      this.configService.get<string>('SYNC_CURSOR_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    if (!secret || typeof secret !== 'string' || secret.trim().length < 16) {
      throw new Error(
        'SYNC_CURSOR_SECRET or JWT_SECRET must be configured with at least 16 characters for HMAC Cursor security',
      );
    }
    this.cursorSecret = secret.trim();
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

    const firstState = Array.isArray(stateRows) && Array.isArray(stateRows[0]) ? stateRows[0][0] : stateRows?.[0];
    const currentServerRevision = firstState
      ? (firstState.current_sync_revision ?? firstState.currentSyncRevision ?? '0').toString()
      : '0';
    const minActiveRevision = firstState
      ? (firstState.min_active_revision ?? firstState.minActiveRevision ?? '0').toString()
      : '0';

    // 2.1 Kiểm tra nếu client yêu cầu revision lớn hơn currentServerRevision (P1-01 / SYNC-10)
    if (afterRevision > BigInt(currentServerRevision)) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'SYNC_REVISION_AHEAD',
        message: `Client revision ${query.after} is ahead of current server revision (${currentServerRevision})`,
        currentServerRevision,
      });
    }

    // 2.2 Kiểm tra nếu client yêu cầu revision cũ hơn min_active_revision (đã bị GC dọn dẹp)
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
   * Kiểm tra xem các domain kế tiếp có bản ghi nào hay không
   */
  private async hasItemsInSubsequentDomains(
    runner: QueryRunner,
    userId: string,
    startIndex: number,
  ): Promise<{ hasMore: boolean; nextDomain: SnapshotDomainName }> {
    for (let i = startIndex; i < SNAPSHOT_DOMAINS.length; i++) {
      const domain = SNAPSHOT_DOMAINS[i];
      let rows: any[] = [];
      if (domain === 'PROGRESS') {
        rows = await runner.query(
          `SELECT 1 FROM reading_progress WHERE user_id = $1 LIMIT 1`,
          [userId],
        );
      } else if (domain === 'CHAPTER_READ_STATE') {
        rows = await runner.query(
          `SELECT 1 FROM chapter_read_states WHERE user_id = $1 LIMIT 1`,
          [userId],
        );
      } else if (domain === 'PREFERENCE') {
        rows = await runner.query(
          `SELECT 1 FROM user_preferences WHERE user_id = $1 LIMIT 1`,
          [userId],
        );
      }
      if (rows && rows.length > 0) {
        return { hasMore: true, nextDomain: domain };
      }
    }
    return { hasMore: false, nextDomain: 'PREFERENCE' };
  }

  /**
   * Endpoint GET /api/v1/sync/snapshot
   * Kéo ảnh chụp toàn bộ thư viện nhất quán với mức cô lập REPEATABLE READ READ ONLY
   * kết hợp Optimistic Snapshot Restart (HTTP 409 SNAPSHOT_INVALIDATED) qua HMAC Cursor
   * và Keyset Pagination thực sự qua các phân vùng miền (P0-01, P0-02, P0-05).
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

      const firstState = Array.isArray(stateRows) && Array.isArray(stateRows[0]) ? stateRows[0][0] : stateRows?.[0];
      const currentServerRevision = firstState
        ? (firstState.current_sync_revision ?? firstState.currentSyncRevision ?? '0').toString()
        : '0';
      const minActiveRevision = firstState
        ? (firstState.min_active_revision ?? firstState.minActiveRevision ?? '0').toString()
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

      // 4. Multi-Domain Keyset Pagination (P0-01)
      const bookmarks: { storyId: string; createdAt: string }[] = [];
      const readingProgress: any[] = [];
      const chapterReadStates: any[] = [];
      const preferences: { key: string; value: unknown; updatedAt: string }[] = [];

      let totalCollected = 0;
      let hasMore = false;
      let nextCursor: string | null = null;

      const startDomain: SnapshotDomainName =
        (decodedCursor?.domain as SnapshotDomainName) || 'BOOKMARK';
      let currentKey: string = decodedCursor?.key || '';
      let domainIndex = SNAPSHOT_DOMAINS.indexOf(startDomain);
      if (domainIndex === -1) domainIndex = 0;

      while (totalCollected < limit && domainIndex < SNAPSHOT_DOMAINS.length) {
        const currentDomain = SNAPSHOT_DOMAINS[domainIndex];
        const quota = limit - totalCollected;

        if (currentDomain === 'BOOKMARK') {
          const rows: { story_id: string; created_at: Date }[] = await runner.query(
            `SELECT story_id, created_at
             FROM bookmarks
             WHERE user_id = $1 AND ($2 = '' OR story_id::text > $2)
             ORDER BY story_id ASC
             LIMIT $3`,
            [userId, currentKey, quota + 1],
          );

          if (rows.length > quota) {
            hasMore = true;
            const paged = rows.slice(0, quota);
            for (const r of paged) {
              bookmarks.push({
                storyId: r.story_id,
                createdAt: new Date(r.created_at).toISOString(),
              });
            }
            totalCollected += paged.length;
            const lastItem = paged[paged.length - 1];
            nextCursor = HmacCursorHelper.generateCursor(
              {
                userId,
                snapshotRevision,
                domain: 'BOOKMARK',
                key: lastItem.story_id,
              },
              this.cursorSecret,
            );
            break;
          } else {
            for (const r of rows) {
              bookmarks.push({
                storyId: r.story_id,
                createdAt: new Date(r.created_at).toISOString(),
              });
            }
            totalCollected += rows.length;
            if (totalCollected === limit) {
              const checkNext = await this.hasItemsInSubsequentDomains(runner, userId, domainIndex + 1);
              if (checkNext.hasMore) {
                hasMore = true;
                nextCursor = HmacCursorHelper.generateCursor(
                  {
                    userId,
                    snapshotRevision,
                    domain: checkNext.nextDomain,
                    key: '',
                  },
                  this.cursorSecret,
                );
              }
              break;
            }
            domainIndex++;
            currentKey = '';
          }
        } else if (currentDomain === 'PROGRESS') {
          const rows: any[] = await runner.query(
            `SELECT story_id, chapter_id, chapter_version_id, reading_mode,
                    page_index, scroll_position, progress_percentage, anchor_block_id, text_offset
             FROM reading_progress
             WHERE user_id = $1 AND ($2 = '' OR story_id::text > $2)
             ORDER BY story_id ASC
             LIMIT $3`,
            [userId, currentKey, quota + 1],
          );

          if (rows.length > quota) {
            hasMore = true;
            const paged = rows.slice(0, quota);
            for (const p of paged) {
              readingProgress.push({
                storyId: p.story_id,
                chapterId: p.chapter_id,
                chapterVersionId: p.chapter_version_id,
                readingMode: p.reading_mode,
                pageIndex: Number(p.page_index),
                scrollPosition: Number(p.scroll_position),
                progressPercentage: Number(p.progress_percentage),
                anchorBlockId: p.anchor_block_id,
                textOffset: p.text_offset !== null ? Number(p.text_offset) : null,
              });
            }
            totalCollected += paged.length;
            const lastItem = paged[paged.length - 1];
            nextCursor = HmacCursorHelper.generateCursor(
              {
                userId,
                snapshotRevision,
                domain: 'PROGRESS',
                key: lastItem.story_id,
              },
              this.cursorSecret,
            );
            break;
          } else {
            for (const p of rows) {
              readingProgress.push({
                storyId: p.story_id,
                chapterId: p.chapter_id,
                chapterVersionId: p.chapter_version_id,
                readingMode: p.reading_mode,
                pageIndex: Number(p.page_index),
                scrollPosition: Number(p.scroll_position),
                progressPercentage: Number(p.progress_percentage),
                anchorBlockId: p.anchor_block_id,
                textOffset: p.text_offset !== null ? Number(p.text_offset) : null,
              });
            }
            totalCollected += rows.length;
            if (totalCollected === limit) {
              const checkNext = await this.hasItemsInSubsequentDomains(runner, userId, domainIndex + 1);
              if (checkNext.hasMore) {
                hasMore = true;
                nextCursor = HmacCursorHelper.generateCursor(
                  {
                    userId,
                    snapshotRevision,
                    domain: checkNext.nextDomain,
                    key: '',
                  },
                  this.cursorSecret,
                );
              }
              break;
            }
            domainIndex++;
            currentKey = '';
          }
        } else if (currentDomain === 'CHAPTER_READ_STATE') {
          // P0-05: GREATEST(COALESCE(st.epoch, 0), COALESCE(gt.epoch, 0)) AS story_history_epoch
          const rows: any[] = await runner.query(
            `SELECT crs.chapter_id, se.story_id, crs.last_version_id,
                    crs.max_progress_percentage, crs.completed_at, crs.last_read_at,
                    GREATEST(COALESCE(st.epoch, 0), COALESCE(gt.epoch, 0)) AS story_history_epoch
             FROM chapter_read_states crs
             JOIN chapters c ON c.id = crs.chapter_id
             JOIN story_editions se ON se.id = c.story_edition_id
             LEFT JOIN reading_history_tombstones st 
               ON st.user_id = crs.user_id AND st.story_id = se.story_id
             LEFT JOIN reading_history_tombstones gt 
               ON gt.user_id = crs.user_id AND gt.story_id = '00000000-0000-0000-0000-000000000000'::uuid
             WHERE crs.user_id = $1 AND ($2 = '' OR crs.chapter_id::text > $2)
             ORDER BY crs.chapter_id ASC
             LIMIT $3`,
            [userId, currentKey, quota + 1],
          );

          if (rows.length > quota) {
            hasMore = true;
            const paged = rows.slice(0, quota);
            for (const r of paged) {
              chapterReadStates.push({
                chapterId: r.chapter_id,
                storyId: r.story_id,
                chapterVersionId: r.last_version_id,
                maxProgressPercentage: Number(r.max_progress_percentage),
                completedAt: r.completed_at
                  ? new Date(r.completed_at).toISOString()
                  : null,
                lastReadAt: new Date(r.last_read_at).toISOString(),
                storyHistoryEpoch: Number(r.story_history_epoch),
              });
            }
            totalCollected += paged.length;
            const lastItem = paged[paged.length - 1];
            nextCursor = HmacCursorHelper.generateCursor(
              {
                userId,
                snapshotRevision,
                domain: 'CHAPTER_READ_STATE',
                key: lastItem.chapter_id,
              },
              this.cursorSecret,
            );
            break;
          } else {
            for (const r of rows) {
              chapterReadStates.push({
                chapterId: r.chapter_id,
                storyId: r.story_id,
                chapterVersionId: r.last_version_id,
                maxProgressPercentage: Number(r.max_progress_percentage),
                completedAt: r.completed_at
                  ? new Date(r.completed_at).toISOString()
                  : null,
                lastReadAt: new Date(r.last_read_at).toISOString(),
                storyHistoryEpoch: Number(r.story_history_epoch),
              });
            }
            totalCollected += rows.length;
            if (totalCollected === limit) {
              const checkNext = await this.hasItemsInSubsequentDomains(runner, userId, domainIndex + 1);
              if (checkNext.hasMore) {
                hasMore = true;
                nextCursor = HmacCursorHelper.generateCursor(
                  {
                    userId,
                    snapshotRevision,
                    domain: checkNext.nextDomain,
                    key: '',
                  },
                  this.cursorSecret,
                );
              }
              break;
            }
            domainIndex++;
            currentKey = '';
          }
        } else if (currentDomain === 'PREFERENCE') {
          // P0-02: Bảng user_preferences chính danh
          const rows: { key: string; value: unknown; updated_at: Date }[] =
            await runner.query(
              `SELECT key, value, updated_at
               FROM user_preferences
               WHERE user_id = $1 AND ($2 = '' OR key > $2)
               ORDER BY key ASC
               LIMIT $3`,
              [userId, currentKey, quota + 1],
            );

          if (rows.length > quota) {
            hasMore = true;
            const paged = rows.slice(0, quota);
            for (const pref of paged) {
              preferences.push({
                key: pref.key,
                value: pref.value,
                updatedAt: new Date(pref.updated_at).toISOString(),
              });
            }
            totalCollected += paged.length;
            const lastItem = paged[paged.length - 1];
            nextCursor = HmacCursorHelper.generateCursor(
              {
                userId,
                snapshotRevision,
                domain: 'PREFERENCE',
                key: lastItem.key,
              },
              this.cursorSecret,
            );
            break;
          } else {
            for (const pref of rows) {
              preferences.push({
                key: pref.key,
                value: pref.value,
                updatedAt: new Date(pref.updated_at).toISOString(),
              });
            }
            totalCollected += rows.length;
            hasMore = false;
            nextCursor = null;
            break;
          }
        }
      }

      await runner.commitTransaction();

      return {
        snapshotRevision,
        minActiveRevision,
        hasMore,
        nextCursor,
        data: {
          bookmarks,
          readingProgress,
          chapterReadStates,
          preferences,
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
        // P0-04 Bước 1: Tính Full Mutation Canonical Hash theo chuẩn JCS RFC 8785 TRƯỚC
        const canonicalHash = computeCanonicalMutationHash(mutation);

        // P0-04 Bước 2: Tra cứu Sổ cái Biên nhận Bền vững (sync_mutation_receipts) TRƯỚC
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
              message: receipt.response_meta?.message || 'Mutation previously rejected; returned durable receipt',
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

        // P0-04 Bước 3: Chưa có biên nhận (Fresh Mutation) ➔ Kiểm tra tính hợp lệ của baseServerRevision
        const baseRev = BigInt(mutation.baseServerRevision);

        if (baseRev > currentServerRev) {
          const reason = 'BASE_REVISION_AHEAD_OF_SERVER';
          const message = `baseServerRevision (${mutation.baseServerRevision}) is greater than current server revision (${currentServerRev})`;

          // Lưu bền vững receipt bị từ chối
          await runner.query(
            `INSERT INTO sync_mutation_receipts (
               user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta, created_at
             ) VALUES ($1, $2, $3, $4, 'REJECTED_STALE', NULL, $5, NOW())`,
            [
              userId,
              mutation.clientId,
              mutation.mutationId,
              canonicalHash,
              JSON.stringify({ reason, message }),
            ],
          );

          results.push({
            mutationId: mutation.mutationId,
            status: 'REJECTED_STALE',
            assignedRevision: null,
            reason,
            message,
          });
          continue;
        }

        if (baseRev < minActiveRev) {
          const reason = 'BASE_REVISION_EXPIRED';
          const message = `baseServerRevision (${mutation.baseServerRevision}) is older than minActiveRevision (${minActiveRev}); full resync required`;

          // Lưu bền vững receipt bị từ chối
          await runner.query(
            `INSERT INTO sync_mutation_receipts (
               user_id, client_id, mutation_id, payload_hash, status, assigned_revision, response_meta, created_at
             ) VALUES ($1, $2, $3, $4, 'REJECTED_STALE', NULL, $5, NOW())`,
            [
              userId,
              mutation.clientId,
              mutation.mutationId,
              canonicalHash,
              JSON.stringify({ reason, message }),
            ],
          );

          results.push({
            mutationId: mutation.mutationId,
            status: 'REJECTED_STALE',
            assignedRevision: null,
            reason,
            message,
          });
          continue;
        }

        // 2.4 Lấy dữ liệu phân xử xung đột từ CSDL
        let tombstoneRevision: string | null = null;
        if (mutation.domain === SyncDomain.PROGRESS) {
          const storyIdForTombstone =
            (mutation.payload as any)?.storyId ||
            (mutation.entityId.includes(':')
              ? mutation.entityId.split(':')[0]
              : mutation.entityId);

          const tombstoneRows = await runner.query(
            `SELECT MAX(deleted_at_revision) AS "maxDeletedAtRevision"
             FROM sync_tombstones
             WHERE user_id = $1
               AND (
                 (domain = 'PROGRESS' AND entity_id IN ($2, $3))
                 OR (domain = 'HISTORY' AND entity_id IN ($2, '00000000-0000-0000-0000-000000000000', 'all'))
               )`,
            [userId, storyIdForTombstone, mutation.entityId],
          );
          if (
            tombstoneRows.length > 0 &&
            tombstoneRows[0].maxDeletedAtRevision !== null &&
            tombstoneRows[0].maxDeletedAtRevision !== undefined
          ) {
            tombstoneRevision =
              tombstoneRows[0].maxDeletedAtRevision.toString();
          }
        } else {
          const tombstoneRows = await runner.query(
            `SELECT deleted_at_revision
             FROM sync_tombstones
             WHERE user_id = $1 AND domain = $2 AND entity_id = $3`,
            [userId, mutation.domain, mutation.entityId],
          );
          if (tombstoneRows.length > 0) {
            tombstoneRevision = tombstoneRows[0].deleted_at_revision.toString();
          }
        }

        // Tra cứu effective history epoch cho domain HISTORY hoặc PROGRESS (P0-05)
        let effectiveHistoryEpoch = 0;
        const storyIdForEpoch =
          (mutation.payload as any)?.storyId || mutation.entityId;

        if (
          mutation.domain === SyncDomain.HISTORY ||
          mutation.domain === SyncDomain.PROGRESS
        ) {
          if (storyIdForEpoch && UUID_ANY_REGEX.test(storyIdForEpoch)) {
            const epochRows = await runner.query(
              `SELECT COALESCE(MAX(epoch), 0) AS "effectiveEpoch"
               FROM reading_history_tombstones
               WHERE user_id = $1 AND story_id IN ($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
              [userId, storyIdForEpoch],
            );
            if (epochRows.length > 0) {
              effectiveHistoryEpoch = Number(epochRows[0].effectiveEpoch);
            }
          }
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

        // Cập nhật CSDL miền tương ứng (P0-02, P0-03, P0-06, P1-06)
        if (mutation.domain === SyncDomain.BOOKMARK) {
          if (mutation.operation === SyncOperation.UPSERT) {
            const insertRes = await runner.query(
              `INSERT INTO bookmarks (user_id, story_id, created_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (user_id, story_id) DO NOTHING
               RETURNING user_id`,
              [userId, mutation.entityId],
            );
            const rows = Array.isArray(insertRes) && Array.isArray(insertRes[0]) ? insertRes[0] : insertRes;
            if (rows && rows.length > 0) {
              await runner.query(
                `UPDATE stories SET followers_count = followers_count + 1 WHERE id = $1`,
                [mutation.entityId],
              );
            }
          } else if (mutation.operation === SyncOperation.DELETE) {
            const deleteRes = await runner.query(
              `DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2 RETURNING user_id`,
              [userId, mutation.entityId],
            );
            const rows = Array.isArray(deleteRes) && Array.isArray(deleteRes[0]) ? deleteRes[0] : deleteRes;
            if (rows && rows.length > 0) {
              await runner.query(
                `UPDATE stories SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1`,
                [mutation.entityId],
              );
            }
          }
        } else if (mutation.domain === SyncDomain.PROGRESS) {
          const payload = (resolution.resolvedPayload ||
            mutation.payload) as Record<string, any>;
          if (mutation.operation === SyncOperation.UPSERT) {
            const progressPercentage = Math.min(100, Math.max(0, Number(payload.progressPercentage) || 0));
            const completedAt = progressPercentage >= 80 ? new Date() : null;

            // 1. Cập nhật reading_progress
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
                progressPercentage,
                payload.scrollPosition,
                payload.pageIndex,
                payload.anchorBlockId || null,
                payload.textOffset || null,
              ],
            );

            // 2. Mirror cập nhật sang chapter_read_states (P0-06, P1-06)
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
          } else if (mutation.operation === SyncOperation.DELETE) {
            await runner.query(
              `DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
              [userId, mutation.entityId],
            );
          }
        } else if (mutation.domain === SyncDomain.HISTORY) {
          const payload = mutation.payload as Record<string, any>;
          if (mutation.operation === SyncOperation.UPSERT) {
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
          } else if (mutation.operation === SyncOperation.DELETE) {
            // P0-03: HISTORY DELETE đúng ngữ nghĩa theo Phase 7B
            const counterRes = await runner.query(
              `INSERT INTO reading_history_epoch_counters (user_id, epoch, updated_at)
               VALUES ($1, 1, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 epoch = reading_history_epoch_counters.epoch + 1,
                 updated_at = NOW()
               RETURNING epoch`,
              [userId],
            );
            const counterRow = Array.isArray(counterRes) && Array.isArray(counterRes[0]) ? counterRes[0][0] : counterRes?.[0];
            const newEpoch = Number(counterRow?.epoch ?? 1);

            if (
              mutation.entityId === '00000000-0000-0000-0000-000000000000' ||
              mutation.entityId === 'all'
            ) {
              // Xóa toàn bộ lịch sử
              await runner.query(`DELETE FROM reading_progress WHERE user_id = $1`, [userId]);
              await runner.query(`DELETE FROM chapter_read_states WHERE user_id = $1`, [userId]);
              await runner.query(
                `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
                 VALUES ($1, '00000000-0000-0000-0000-000000000000'::uuid, $2, NOW())
                 ON CONFLICT (user_id, story_id) DO UPDATE SET
                   epoch = EXCLUDED.epoch,
                   deleted_at = NOW()`,
                [userId, newEpoch],
              );
            } else {
              // Xóa lịch sử theo truyện
              await runner.query(
                `DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
                [userId, mutation.entityId],
              );
              await runner.query(
                `DELETE FROM chapter_read_states
                 WHERE user_id = $1 AND chapter_id IN (
                   SELECT c.id FROM chapters c
                   JOIN story_editions se ON se.id = c.story_edition_id
                   WHERE se.story_id = $2
                 )`,
                [userId, mutation.entityId],
              );
              await runner.query(
                `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, story_id) DO UPDATE SET
                   epoch = EXCLUDED.epoch,
                   deleted_at = NOW()`,
                [userId, mutation.entityId, newEpoch],
              );
            }
          }
        } else if (mutation.domain === SyncDomain.PREFERENCE) {
          // P0-02: Cập nhật authoritative table user_preferences
          const payload = (resolution.resolvedPayload || mutation.payload) as Record<string, any>;
          const preferenceKey = (payload?.key || mutation.entityId).trim();

          if (mutation.operation === SyncOperation.UPSERT) {
            await runner.query(
              `INSERT INTO user_preferences (user_id, key, value, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (user_id, key) DO UPDATE SET
                 value = EXCLUDED.value,
                 updated_at = NOW()`,
              [userId, preferenceKey, JSON.stringify(payload.value)],
            );
          } else if (mutation.operation === SyncOperation.DELETE) {
            await runner.query(
              `DELETE FROM user_preferences WHERE user_id = $1 AND key = $2`,
              [userId, preferenceKey],
            );
          }
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
          const tombstoneEntityId =
            mutation.domain === SyncDomain.HISTORY && mutation.entityId === 'all'
              ? '00000000-0000-0000-0000-000000000000'
              : mutation.entityId;

          await runner.query(
            `INSERT INTO sync_tombstones (
               user_id, domain, entity_id, deleted_at_revision, created_at
             ) VALUES (
               $1, $2, $3, $4, NOW()
             )
             ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
               deleted_at_revision = EXCLUDED.deleted_at_revision,
               created_at = NOW()`,
            [userId, mutation.domain, tombstoneEntityId, assignedRevStr],
          );

          if (mutation.domain === SyncDomain.HISTORY && mutation.entityId === 'all') {
            await runner.query(
              `INSERT INTO sync_tombstones (
                 user_id, domain, entity_id, deleted_at_revision, created_at
               ) VALUES (
                 $1, $2, 'all', $3, NOW()
               )
               ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
                 deleted_at_revision = EXCLUDED.deleted_at_revision,
                 created_at = NOW()`,
              [userId, mutation.domain, assignedRevStr],
            );
          }
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

