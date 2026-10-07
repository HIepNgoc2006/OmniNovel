import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '../../redis/redis.service';
import { GuestClaim, GuestClaimStatusEnum } from './entities/guest-claim.entity';
import {
  PrepareGuestClaimDto,
  CanonicalReadingMode,
} from './dto/prepare-guest-claim.dto';
import {
  CommitGuestClaimDto,
  ConflictResolution,
} from './dto/commit-guest-claim.dto';
import {
  GuestClaimPreviewResponseDto,
  GuestClaimCommitResponseDto,
  GuestClaimStatusResponseDto,
  ReadingProgressConflictDetail,
} from './dto/guest-claim-response.dto';

@Injectable()
export class GuestClaimService {
  private readonly logger = new Logger(GuestClaimService.name);

  constructor(
    @InjectRepository(GuestClaim)
    private readonly guestClaimRepo: Repository<GuestClaim>,
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Helper tính toán fingerprint trạng thái Cloud một cách deterministic
   */
  private computeCloudFingerprint(cloudState: {
    bookmarks: string[];
    tombstones: { storyId: string; epoch: number }[];
    readStates: { chapterId: string; maxProgress: number }[];
    progress: {
      storyId: string;
      chapterId: string;
      readingMode: string;
      pageIndex: number;
      scrollPosition: number;
      progressPercentage: number;
      anchorBlockId: string | null;
      textOffset: number;
    }[];
  }): string {
    const canonicalObject = {
      bookmarks: [...cloudState.bookmarks].sort(),
      tombstones: [...cloudState.tombstones].sort((a, b) =>
        a.storyId.localeCompare(b.storyId),
      ),
      readStates: [...cloudState.readStates].sort((a, b) =>
        a.chapterId.localeCompare(b.chapterId),
      ),
      progress: [...cloudState.progress].sort((a, b) =>
        a.storyId.localeCompare(b.storyId),
      ),
    };
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(canonicalObject))
      .digest('hex');
  }

  /**
   * Truy vấn Cloud State của User cho danh sách Story/Chapter được cung cấp
   */
  private async fetchCloudState(
    runner: QueryRunner,
    userId: string,
    storyIds: string[],
    chapterIds: string[],
    lockForUpdate = false,
  ) {
    const forUpdateClause = lockForUpdate ? ' FOR UPDATE' : '';

    // 1. Bookmarks
    let bookmarksRows: { story_id: string }[] = [];
    if (storyIds.length > 0) {
      bookmarksRows = await runner.query(
        `SELECT story_id FROM bookmarks WHERE user_id = $1 AND story_id = ANY($2)${forUpdateClause}`,
        [userId, storyIds],
      );
    } else {
      bookmarksRows = await runner.query(
        `SELECT story_id FROM bookmarks WHERE user_id = $1${forUpdateClause}`,
        [userId],
      );
    }

    // 2. Tombstones
    let tombstoneRows: { story_id: string; epoch: number }[] = [];
    if (storyIds.length > 0) {
      tombstoneRows = await runner.query(
        `SELECT story_id, epoch FROM reading_history_tombstones WHERE user_id = $1 AND story_id = ANY($2)${forUpdateClause}`,
        [userId, storyIds],
      );
    } else {
      tombstoneRows = await runner.query(
        `SELECT story_id, epoch FROM reading_history_tombstones WHERE user_id = $1${forUpdateClause}`,
        [userId],
      );
    }

    // 3. Chapter Read States
    let readStatesRows: { chapter_id: string; max_progress_percentage: string | number }[] = [];
    if (chapterIds.length > 0) {
      readStatesRows = await runner.query(
        `SELECT chapter_id, max_progress_percentage FROM chapter_read_states WHERE user_id = $1 AND chapter_id = ANY($2)${forUpdateClause}`,
        [userId, chapterIds],
      );
    } else {
      readStatesRows = await runner.query(
        `SELECT chapter_id, max_progress_percentage FROM chapter_read_states WHERE user_id = $1${forUpdateClause}`,
        [userId],
      );
    }

    // 4. Reading Progress
    let progressRows: {
      story_id: string;
      chapter_id: string;
      reading_mode: string;
      page_index: number;
      scroll_position: string | number;
      progress_percentage: string | number;
      anchor_block_id: string | null;
      text_offset: number;
      updated_at: Date;
    }[] = [];
    if (storyIds.length > 0) {
      progressRows = await runner.query(
        `SELECT story_id, chapter_id, reading_mode, page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at FROM reading_progress WHERE user_id = $1 AND story_id = ANY($2)${forUpdateClause}`,
        [userId, storyIds],
      );
    } else {
      progressRows = await runner.query(
        `SELECT story_id, chapter_id, reading_mode, page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at FROM reading_progress WHERE user_id = $1${forUpdateClause}`,
        [userId],
      );
    }

    return {
      bookmarksRows,
      tombstoneRows,
      readStatesRows,
      progressRows,
    };
  }

  /**
   * Phương thức 1: Chuẩn bị claim dữ liệu khách (PREPARE)
   */
  async prepareClaim(
    userId: string,
    dto: PrepareGuestClaimDto,
  ): Promise<GuestClaimPreviewResponseDto> {
    // 1. Rate Limit: 10 requests / minute / user
    const rateLimitKey = `rate_limit:claim_prepare:${userId}`;
    const rateLimit = await this.redisService.checkRateLimit(rateLimitKey, 10, 60);
    if (!rateLimit.allowed) {
      throw new HttpException(
        'Too many claim requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      // 2. Validate Foreign Keys & Invariants (Stories, Chapters, ChapterVersions, Publication States)
      const allStoryIds = Array.from(
        new Set([
          ...dto.bookmarks.map((b) => b.storyId),
          ...dto.history.map((h) => h.storyId),
          ...dto.progress.map((p) => p.storyId),
        ]),
      );

      const allChapterIds = Array.from(
        new Set([
          ...dto.history.map((h) => h.chapterId),
          ...dto.progress.map((p) => p.chapterId),
        ]),
      );

      // 2.1 Stories existence & publication/visibility state
      if (allStoryIds.length > 0) {
        const storiesExist: { id: string; visibility: string; status: string }[] =
          await runner.query(
            `SELECT id, visibility, status FROM stories WHERE id = ANY($1)`,
            [allStoryIds],
          );
        const storyMap = new Map(storiesExist.map((s) => [s.id, s]));

        for (const sId of allStoryIds) {
          const story = storyMap.get(sId);
          if (!story) {
            throw new BadRequestException(
              `Referenced storyId ${sId} does not exist`,
            );
          }
          if (story.visibility === 'PRIVATE') {
            throw new BadRequestException(
              `Referenced story ${sId} is private and cannot be claimed`,
            );
          }
          if (story.status === 'CANCELLED') {
            throw new BadRequestException(
              `Referenced story ${sId} is cancelled and cannot be claimed`,
            );
          }
        }
      }

      // 2.2 Chapters existence, story ownership & publication status
      if (allChapterIds.length > 0) {
        const chaptersExist: {
          id: string;
          story_id: string;
          has_published_version: boolean;
        }[] = await runner.query(
          `SELECT c.id, se.story_id,
                  (
                    EXISTS (
                      SELECT 1 FROM chapter_versions cv
                      WHERE cv.chapter_id = c.id AND cv.is_published = TRUE
                    )
                  ) AS has_published_version
           FROM chapters c
           JOIN story_editions se ON se.id = c.story_edition_id
           WHERE c.id = ANY($1)`,
          [allChapterIds],
        );
        const chapterMap = new Map(chaptersExist.map((c) => [c.id, c]));

        for (const cId of allChapterIds) {
          const chapter = chapterMap.get(cId);
          if (!chapter) {
            throw new BadRequestException(
              `Referenced chapterId ${cId} does not exist`,
            );
          }
          if (!chapter.has_published_version) {
            throw new BadRequestException(
              `Referenced chapter ${cId} is not published and cannot be claimed`,
            );
          }
        }

        for (const h of dto.history) {
          const chapter = chapterMap.get(h.chapterId);
          if (!chapter || chapter.story_id !== h.storyId) {
            throw new BadRequestException(
              `Chapter ${h.chapterId} does not belong to story ${h.storyId}`,
            );
          }
        }

        for (const p of dto.progress) {
          const chapter = chapterMap.get(p.chapterId);
          if (!chapter || chapter.story_id !== p.storyId) {
            throw new BadRequestException(
              `Chapter ${p.chapterId} does not belong to story ${p.storyId}`,
            );
          }
        }
      }

      // 2.3 Chapter Versions preflight (if specified in progress)
      const progressWithVersions = dto.progress.filter((p) => Boolean(p.chapterVersionId));
      if (progressWithVersions.length > 0) {
        const allVersionIds = Array.from(
          new Set(progressWithVersions.map((p) => p.chapterVersionId!)),
        );

        const versionsExist: {
          id: string;
          chapter_id: string;
          story_id: string;
          is_published: boolean;
        }[] = await runner.query(
          `SELECT cv.id, cv.chapter_id, se.story_id, cv.is_published
           FROM chapter_versions cv
           JOIN chapters c ON c.id = cv.chapter_id
           JOIN story_editions se ON se.id = c.story_edition_id
           WHERE cv.id = ANY($1)`,
          [allVersionIds],
        );
        const versionMap = new Map(versionsExist.map((v) => [v.id, v]));

        for (const p of progressWithVersions) {
          const vId = p.chapterVersionId!;
          const version = versionMap.get(vId);

          if (!version) {
            throw new BadRequestException(
              `Referenced chapterVersionId ${vId} does not exist`,
            );
          }
          if (version.chapter_id !== p.chapterId) {
            throw new BadRequestException(
              `ChapterVersion ${vId} does not belong to chapter ${p.chapterId}`,
            );
          }
          if (version.story_id !== p.storyId) {
            throw new BadRequestException(
              `ChapterVersion ${vId} does not belong to story ${p.storyId}`,
            );
          }
          if (!version.is_published) {
            throw new BadRequestException(
              `ChapterVersion ${vId} is not published and cannot be claimed`,
            );
          }
        }
      }

      // 3. Query Cloud State
      const {
        bookmarksRows,
        tombstoneRows,
        readStatesRows,
        progressRows,
      } = await this.fetchCloudState(runner, userId, allStoryIds, allChapterIds, false);

      const cloudBookmarkSet = new Set(bookmarksRows.map((b) => b.story_id));
      const cloudTombstoneSet = new Set(tombstoneRows.map((t) => t.story_id));
      const cloudReadStatesMap = new Map(
        readStatesRows.map((r) => [r.chapter_id, Number(r.max_progress_percentage)]),
      );
      const cloudProgressMap = new Map(
        progressRows.map((p) => [p.story_id, p]),
      );

      // 4. Tính toán fingerprint
      const stateFingerprint = this.computeCloudFingerprint({
        bookmarks: bookmarksRows.map((b) => b.story_id),
        tombstones: tombstoneRows.map((t) => ({
          storyId: t.story_id,
          epoch: t.epoch,
        })),
        readStates: readStatesRows.map((r) => ({
          chapterId: r.chapter_id,
          maxProgress: Number(r.max_progress_percentage),
        })),
        progress: progressRows.map((p) => ({
          storyId: p.story_id,
          chapterId: p.chapter_id,
          readingMode: p.reading_mode,
          pageIndex: Number(p.page_index),
          scrollPosition: Number(p.scroll_position),
          progressPercentage: Number(p.progress_percentage),
          anchorBlockId: p.anchor_block_id,
          textOffset: Number(p.text_offset),
        })),
      });

      // 5. Diff & Phát hiện xung đột (Mode-Aware Comparator)
      let bookmarksToImport = 0;
      for (const b of dto.bookmarks) {
        if (!cloudBookmarkSet.has(b.storyId)) {
          bookmarksToImport++;
        }
      }

      let readStatesIgnoredAntiResurrectionCount = 0;
      let historyToImport = 0;
      const seenGuestChapters = new Set<string>();

      for (const h of dto.history) {
        if (cloudTombstoneSet.has(h.storyId)) {
          readStatesIgnoredAntiResurrectionCount++;
          continue;
        }

        if (seenGuestChapters.has(h.chapterId)) {
          continue;
        }
        seenGuestChapters.add(h.chapterId);

        const cloudMax = cloudReadStatesMap.get(h.chapterId);
        if (cloudMax === undefined || h.progressPercentage > cloudMax) {
          historyToImport++;
        }
      }

      let progressToImport = 0;
      const conflicts: ReadingProgressConflictDetail[] = [];

      for (const p of dto.progress) {
        if (cloudTombstoneSet.has(p.storyId)) {
          readStatesIgnoredAntiResurrectionCount++;
          continue;
        }

        const cloudProg = cloudProgressMap.get(p.storyId);
        if (!cloudProg) {
          progressToImport++;
          continue;
        }

        // Mode-Aware Comparator
        let isConflict = false;
        if (
          cloudProg.chapter_id !== p.chapterId ||
          cloudProg.reading_mode !== p.readingMode
        ) {
          isConflict = true;
        } else {
          if (p.readingMode === CanonicalReadingMode.PAGED) {
            if (Number(cloudProg.page_index) !== p.pageIndex) {
              isConflict = true;
            }
          } else if (p.readingMode === CanonicalReadingMode.WEBTOON) {
            const scrollDiff = Math.abs(
              Number(cloudProg.scroll_position) - p.scrollPosition,
            );
            const pctDiff = Math.abs(
              Number(cloudProg.progress_percentage) - p.progressPercentage,
            );
            if (scrollDiff > 1 || pctDiff > 0.05) {
              isConflict = true;
            }
          } else if (p.readingMode === CanonicalReadingMode.NOVEL) {
            if (
              (cloudProg.anchor_block_id || null) !== (p.anchorBlockId || null) ||
              Number(cloudProg.text_offset) !== (p.textOffset || 0)
            ) {
              isConflict = true;
            }
          }
        }

        if (isConflict) {
          conflicts.push({
            storyId: p.storyId,
            cloudProgress: {
              chapterId: cloudProg.chapter_id,
              readingMode: cloudProg.reading_mode,
              pageIndex: Number(cloudProg.page_index),
              scrollPosition: Number(cloudProg.scroll_position),
              progressPercentage: Number(cloudProg.progress_percentage),
              anchorBlockId: cloudProg.anchor_block_id,
              textOffset: Number(cloudProg.text_offset),
              updatedAt: new Date(cloudProg.updated_at).toISOString(),
            },
            guestProgress: {
              chapterId: p.chapterId,
              readingMode: p.readingMode,
              pageIndex: p.pageIndex,
              scrollPosition: p.scrollPosition,
              progressPercentage: p.progressPercentage,
              anchorBlockId: p.anchorBlockId || null,
              textOffset: p.textOffset || 0,
              updatedAt: p.updatedAt || new Date().toISOString(),
            },
          });
        }
      }

      const claimId = uuidv4();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút
      const payloadHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(dto))
        .digest('hex');

      const previewData: GuestClaimPreviewResponseDto & { payload: PrepareGuestClaimDto } = {
        claimId,
        status: 'PREPARED',
        stateFingerprint,
        expiresAt: expiresAt.toISOString(),
        bookmarksToImport,
        historyToImport,
        progressToImport,
        conflictsCount: conflicts.length,
        readStatesIgnoredAntiResurrectionCount,
        conflicts,
        payload: dto,
      };

      await this.guestClaimRepo.save({
        claimId,
        userId,
        guestProfileId: dto.guestProfileId,
        payloadHash,
        stateFingerprint,
        status: GuestClaimStatusEnum.PREPARED,
        previewData,
        expiresAt,
      });

      // Cache claim metadata trong Redis
      await this.redisService.set(
        `claim_meta:${claimId}`,
        JSON.stringify({ userId, stateFingerprint, expiresAt: expiresAt.toISOString() }),
        900,
      );

      const clientPreview: GuestClaimPreviewResponseDto = {
        claimId,
        status: 'PREPARED',
        stateFingerprint,
        expiresAt: expiresAt.toISOString(),
        bookmarksToImport,
        historyToImport,
        progressToImport,
        conflictsCount: conflicts.length,
        readStatesIgnoredAntiResurrectionCount,
        conflicts,
      };

      return clientPreview;
    } finally {
      await runner.release();
    }
  }

  /**
   * Phương thức 2: Thực thi merge claim dữ liệu (COMMIT)
   */
  async commitClaim(
    userId: string,
    claimId: string,
    dto: CommitGuestClaimDto,
  ): Promise<GuestClaimCommitResponseDto> {
    // 1. Best-effort Redis Distributed Lock
    const lockKey = `claim_lock:${claimId}`;
    const lockToken = uuidv4();
    let lockAcquired = false;
    try {
      lockAcquired = await this.redisService.setnx(lockKey, lockToken, 15);
    } catch (e: any) {
      this.logger.warn(`Redis lock unavailable, fallback to DB lock: ${e?.message}`);
    }

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // 2. Lock & Check Claim Record (EntityManager with pessimistic_write lock + raw SQL fallback)
      let claim: GuestClaim | null = null;
      if (runner.manager && typeof runner.manager.findOne === 'function') {
        claim = await runner.manager.findOne(GuestClaim, {
          where: { claimId },
          lock: { mode: 'pessimistic_write' },
        });
      }
      if (!claim) {
        const claimRows: GuestClaim[] = await runner.query(
          `SELECT * FROM guest_claims WHERE claim_id = $1 FOR UPDATE`,
          [claimId],
        );
        if (claimRows && claimRows.length > 0) {
          claim = claimRows[0];
        }
      }

      if (!claim) {
        throw new NotFoundException(`Claim ${claimId} not found`);
      }

      // Safe accessors supporting both hydrated TypeORM Entity and raw PostgreSQL snake_case row
      const claimUserId = claim.userId ?? (claim as any).user_id;
      const claimIdVal = claim.claimId ?? (claim as any).claim_id;
      const claimStatus = claim.status;
      const claimStateFingerprint =
        claim.stateFingerprint ?? (claim as any).state_fingerprint;
      const claimPreviewData =
        claim.previewData ?? (claim as any).preview_data;
      const claimResultSummary =
        claim.resultSummary ?? (claim as any).result_summary;
      const claimExpiresAt = claim.expiresAt ?? (claim as any).expires_at;
      const claimCommittedAt = claim.committedAt ?? (claim as any).committed_at;

      if (claimUserId !== userId) {
        throw new ForbiddenException('You do not own this claim');
      }

      // Idempotency First: Nếu đã COMMITTED, trả kết quả đã lưu vĩnh viễn (200 OK)
      if (claimStatus === GuestClaimStatusEnum.COMMITTED) {
        await runner.rollbackTransaction();
        return {
          claimId: claimIdVal,
          status: 'COMMITTED',
          committedAt: claimCommittedAt
            ? new Date(claimCommittedAt).toISOString()
            : new Date().toISOString(),
          summary: claimResultSummary || {
            bookmarksImported: 0,
            historyMerged: 0,
            progressUpdated: 0,
            conflictsResolved: 0,
          },
        };
      }

      if (claimStatus === GuestClaimStatusEnum.ABORTED) {
        throw new BadRequestException('Claim was aborted');
      }

      const now = new Date();
      if (
        claimStatus === GuestClaimStatusEnum.PREPARED &&
        now > new Date(claimExpiresAt)
      ) {
        await runner.query(
          `UPDATE guest_claims SET status = 'EXPIRED', updated_at = NOW() WHERE claim_id = $1`,
          [claimId],
        );
        await runner.commitTransaction();
        throw new HttpException('Claim has expired', HttpStatus.GONE);
      }

      // 3. Triệt tiêu TOCTOU Race Window: Khóa Advisory & Domain Rows
      await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `user_claim:${userId}`,
      ]);

      // Ensure epoch counter row
      await runner.query(
        `INSERT INTO reading_history_epoch_counters (user_id, epoch, updated_at)
         VALUES ($1, 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );

      // Lock epoch counter
      await runner.query(
        `SELECT epoch FROM reading_history_epoch_counters WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );

      const storedPayload: PrepareGuestClaimDto =
        claimPreviewData?.payload || claimPreviewData;

      const storyIds = Array.from(
        new Set([
          ...(storedPayload.bookmarks || []).map((b) => b.storyId),
          ...(storedPayload.history || []).map((h) => h.storyId),
          ...(storedPayload.progress || []).map((p) => p.storyId),
        ]),
      );

      const chapterIds = Array.from(
        new Set([
          ...(storedPayload.history || []).map((h) => h.chapterId),
          ...(storedPayload.progress || []).map((p) => p.chapterId),
        ]),
      );

      // Khóa và fetch Cloud State hiện tại dưới lock FOR UPDATE
      const {
        bookmarksRows,
        tombstoneRows,
        readStatesRows,
        progressRows,
      } = await this.fetchCloudState(runner, userId, storyIds, chapterIds, true);

      // Tính lại current fingerprint
      const currentFingerprint = this.computeCloudFingerprint({
        bookmarks: bookmarksRows.map((b) => b.story_id),
        tombstones: tombstoneRows.map((t) => ({
          storyId: t.story_id,
          epoch: t.epoch,
        })),
        readStates: readStatesRows.map((r) => ({
          chapterId: r.chapter_id,
          maxProgress: Number(r.max_progress_percentage),
        })),
        progress: progressRows.map((p) => ({
          storyId: p.story_id,
          chapterId: p.chapter_id,
          readingMode: p.reading_mode,
          pageIndex: Number(p.page_index),
          scrollPosition: Number(p.scroll_position),
          progressPercentage: Number(p.progress_percentage),
          anchorBlockId: p.anchor_block_id,
          textOffset: Number(p.text_offset),
        })),
      });

      if (
        currentFingerprint !== claimStateFingerprint ||
        dto.expectedStateFingerprint !== claimStateFingerprint
      ) {
        throw new ConflictException(
          'CLAIM_STALE_REPREPARE: Cloud state changed since claim preparation',
        );
      }

      // 4. Merge Dữ Liệu
      const summary = {
        bookmarksImported: 0,
        historyMerged: 0,
        progressUpdated: 0,
        conflictsResolved: 0,
      };

      const tombstoneSet = new Set(tombstoneRows.map((t) => t.story_id));

      // 4.1 Bookmarks Merge
      for (const b of storedPayload.bookmarks || []) {
        const insertRes = await runner.query(
          `INSERT INTO bookmarks (user_id, story_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id, story_id) DO NOTHING`,
          [userId, b.storyId],
        );
        if (insertRes && insertRes[1] > 0) {
          summary.bookmarksImported++;
        }
      }

      // 4.2 History Merge (Anti-Resurrection: loại bỏ story có tombstone)
      for (const h of storedPayload.history || []) {
        if (tombstoneSet.has(h.storyId)) {
          continue;
        }

        await runner.query(
          `INSERT INTO chapter_read_states (user_id, chapter_id, max_progress_percentage, completed_at, last_read_at)
           VALUES ($1, $2, $3, CASE WHEN $3 >= 100 THEN NOW() ELSE NULL END, NOW())
           ON CONFLICT (user_id, chapter_id) DO UPDATE SET
             max_progress_percentage = GREATEST(chapter_read_states.max_progress_percentage, EXCLUDED.max_progress_percentage),
             completed_at = COALESCE(chapter_read_states.completed_at, EXCLUDED.completed_at),
             last_read_at = NOW()`,
          [userId, h.chapterId, h.progressPercentage],
        );
        summary.historyMerged++;
      }

      // 4.3 Reading Progress Merge (1-based pageIndex >= 1)
      const conflictList: ReadingProgressConflictDetail[] =
        claimPreviewData?.conflicts || [];
      const conflictStoryIds = new Set(conflictList.map((c) => c.storyId));

      for (const p of storedPayload.progress || []) {
        if (tombstoneSet.has(p.storyId)) {
          continue;
        }

        const hasConflict = conflictStoryIds.has(p.storyId);
        if (hasConflict) {
          summary.conflictsResolved++;
          const decision =
            dto.conflictDecisions?.[p.storyId] || ConflictResolution.KEEP_CLOUD;

          if (decision === ConflictResolution.KEEP_CLOUD) {
            // Giữ nguyên Cloud progress, không ghi đè
            continue;
          }
        }

        // Áp dụng Guest Progress (hoặc khi quyết định USE_GUEST, hoặc không conflict)
        const safePageIndex = Math.max(1, p.pageIndex || 1);

        await runner.query(
          `INSERT INTO reading_progress (
             user_id, story_id, chapter_id, chapter_version_id, reading_mode,
             progress_percentage, scroll_position, page_index, anchor_block_id,
             text_offset, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
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
            p.storyId,
            p.chapterId,
            p.chapterVersionId || null,
            p.readingMode,
            p.progressPercentage,
            p.scrollPosition,
            safePageIndex,
            p.anchorBlockId || null,
            p.textOffset || 0,
          ],
        );
        summary.progressUpdated++;
      }

      // 5. Cập nhật Sổ cái Ledger
      const committedAt = new Date();
      await runner.query(
        `UPDATE guest_claims
         SET status = 'COMMITTED',
             result_summary = $1,
             conflict_decisions = $2,
             committed_at = $3,
             updated_at = NOW()
         WHERE claim_id = $4`,
        [
          JSON.stringify(summary),
          JSON.stringify(dto.conflictDecisions || {}),
          committedAt,
          claimId,
        ],
      );

      await runner.commitTransaction();

      return {
        claimId,
        status: 'COMMITTED',
        committedAt: committedAt.toISOString(),
        summary,
      };
    } catch (err) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw err;
    } finally {
      await runner.release();
      if (lockAcquired) {
        try {
          await this.redisService.releaseLock(lockKey, lockToken);
        } catch (e: any) {
          this.logger.warn(`Failed to release redis lock: ${e?.message}`);
        }
      }
    }
  }

  /**
   * Phương thức 3: Kiểm tra trạng thái Claim (STATUS)
   */
  async getClaimStatus(
    userId: string,
    claimId: string,
  ): Promise<GuestClaimStatusResponseDto> {
    const claim = await this.guestClaimRepo.findOne({
      where: { claimId },
    });

    if (!claim) {
      throw new NotFoundException(`Claim ${claimId} not found`);
    }

    const claimUserId = claim.userId ?? (claim as any).user_id;
    const claimIdVal = claim.claimId ?? (claim as any).claim_id;
    const claimStatus = claim.status;
    const claimStateFingerprint =
      claim.stateFingerprint ?? (claim as any).state_fingerprint;
    const claimPreviewData =
      claim.previewData ?? (claim as any).preview_data;
    const claimResultSummary =
      claim.resultSummary ?? (claim as any).result_summary;
    const claimCreatedAt = claim.createdAt ?? (claim as any).created_at;
    const claimExpiresAt = claim.expiresAt ?? (claim as any).expires_at;
    const claimCommittedAt = claim.committedAt ?? (claim as any).committed_at;

    if (claimUserId !== userId) {
      throw new ForbiddenException('You do not own this claim');
    }

    const preview = { ...claimPreviewData };
    if (preview.payload) {
      delete preview.payload;
    }

    return {
      claimId: claimIdVal,
      status: claimStatus,
      stateFingerprint: claimStateFingerprint,
      createdAt: new Date(claimCreatedAt).toISOString(),
      expiresAt: new Date(claimExpiresAt).toISOString(),
      committedAt: claimCommittedAt ? new Date(claimCommittedAt).toISOString() : null,
      previewData: preview,
      resultSummary: claimResultSummary,
    };
  }
}
