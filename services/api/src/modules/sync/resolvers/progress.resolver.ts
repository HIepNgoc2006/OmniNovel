import { Injectable } from '@nestjs/common';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';

@Injectable()
export class ProgressConflictResolver implements IConflictResolver {
  readonly domain = SyncDomain.PROGRESS;

  resolve(context: ConflictResolverContext): ConflictResolutionResult {
    const {
      mutation,
      existingRecord,
      tombstoneRevision,
      effectiveHistoryEpoch = 0,
    } = context;

    if (mutation.operation === SyncOperation.DELETE) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Reading progress cleared',
      };
    }

    const payload = mutation.payload as Record<string, any>;

    // 1. Anti-Resurrection Guard: Kiểm tra nếu có tombstone (PROGRESS hoặc HISTORY clear)
    // với deleted_at_revision > baseServerRevision (P0-07)
    if (tombstoneRevision !== null && tombstoneRevision !== undefined) {
      const tombstoneRev = BigInt(tombstoneRevision);
      const baseRev = BigInt(mutation.baseServerRevision);

      if (baseRev < tombstoneRev) {
        return {
          status: 'REJECTED_TOMBSTONE',
          reason: 'TOMBSTONE_CONFLICT',
          message: `Reading progress was deleted by a history clear operation at revision ${tombstoneRevision} which is > client base revision ${mutation.baseServerRevision}`,
          metadata: {
            tombstoneRevision,
            baseServerRevision: mutation.baseServerRevision,
          },
          assignedRevision: null,
        };
      }
    }

    // 2. Anti-Resurrection Guard: Kiểm tra epoch nếu client gửi kèm observedHistoryEpoch (P0-07)
    if (
      payload?.observedHistoryEpoch !== undefined &&
      payload?.observedHistoryEpoch !== null
    ) {
      const observedEpoch = Number(payload.observedHistoryEpoch);
      if (observedEpoch < effectiveHistoryEpoch) {
        return {
          status: 'REJECTED_TOMBSTONE',
          reason: 'STALE_HISTORY_EPOCH',
          message: `Reading progress epoch (${observedEpoch}) is older than effective history epoch (${effectiveHistoryEpoch})`,
          metadata: {
            observedEpoch,
            effectiveEpoch: effectiveHistoryEpoch,
          },
          assignedRevision: null,
        };
      }
    }

    const incomingPercentage = Number(payload.progressPercentage ?? 0);
    const forceRewind = Boolean(payload.forceRewind);

    if (!existingRecord) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Initial reading progress accepted',
      };
    }

    const existingPercentage = Number(
      existingRecord.progressPercentage ??
        existingRecord.progress_percentage ??
        0,
    );
    const existingChapterId =
      existingRecord.chapterId ?? existingRecord.chapter_id;
    const incomingChapterId = payload.chapterId;

    const existingVersionId =
      existingRecord.chapterVersionId ??
      existingRecord.chapter_version_id ??
      null;
    const incomingVersionId = payload.chapterVersionId ?? null;
    const fallbackStoryId = payload.storyId ?? mutation.entityId;

    // Trường hợp 1: Cùng chương và cùng layout version
    if (
      existingChapterId === incomingChapterId &&
      existingVersionId === incomingVersionId
    ) {
      if (incomingPercentage < existingPercentage) {
        if (forceRewind) {
          return {
            status: 'APPLIED',
            assignedRevision: null,
            message: 'Reading progress rewound with explicit forceRewind flag',
          };
        }

        // Monotonic forward progress invariant: bảo toàn đầy đủ bản ghi server thắng cuộc
        return {
          status: 'CONFLICT_MERGED',
          reason: 'MONOTONIC_PROGRESS_PRESERVED',
          message: `Server preserved higher progress percentage (${existingPercentage} > ${incomingPercentage})`,
          resolvedPayload: this.buildServerWinningPayload(
            existingRecord,
            fallbackStoryId,
            existingChapterId,
            existingVersionId,
            existingPercentage,
          ),
          assignedRevision: null,
        };
      }

      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Forward reading progress accepted',
      };
    }

    // Trường hợp 2: Khác phiên bản chương (Version layout mismatch)
    if (
      existingChapterId === incomingChapterId &&
      existingVersionId !== incomingVersionId
    ) {
      // Bố cục phiên bản khác nhau: Tuyệt đối không so sánh pageIndex hoặc scrollPosition trực tiếp.
      // Bảo vệ chống vô tình hạ thấp tiến độ từ client mang version cũ nếu không có cờ forceRewind.
      if (incomingPercentage < existingPercentage && !forceRewind) {
        return {
          status: 'CONFLICT_MERGED',
          reason: 'MONOTONIC_PROGRESS_PRESERVED',
          message: `Version layout mismatch: Server preserved higher completion state (${existingPercentage}% on version '${existingVersionId}' > ${incomingPercentage}% on version '${incomingVersionId}')`,
          resolvedPayload: this.buildServerWinningPayload(
            existingRecord,
            fallbackStoryId,
            existingChapterId,
            existingVersionId,
            existingPercentage,
          ),
          assignedRevision: null,
        };
      }

      // Nếu tiến độ phiên bản mới cao hơn hoặc bằng, hoặc người dùng chủ động tua lại với forceRewind:
      // Chấp nhận con trỏ và bố cục của phiên bản mới một cách xác định.
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: forceRewind
          ? 'Version layout switch accepted with explicit forceRewind'
          : 'Version layout mismatch resolved by advancing to new version layout progress',
      };
    }

    // Trường hợp 3: Khác chương
    if (forceRewind) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Chapter rewound with explicit forceRewind flag',
      };
    }

    return {
      status: 'APPLIED',
      assignedRevision: null,
      message: 'Chapter transition accepted',
    };
  }

  private buildServerWinningPayload(
    existingRecord: Record<string, any>,
    fallbackStoryId: string,
    existingChapterId: string,
    existingVersionId: string | null,
    existingPercentage: number,
  ): Record<string, unknown> {
    const rawPageIndex = existingRecord.pageIndex ?? existingRecord.page_index;
    const rawScrollPosition =
      existingRecord.scrollPosition ?? existingRecord.scroll_position;
    const rawTextOffset =
      existingRecord.textOffset ?? existingRecord.text_offset ?? null;

    return {
      storyId:
        existingRecord.storyId ?? existingRecord.story_id ?? fallbackStoryId,
      chapterId: existingChapterId,
      chapterVersionId: existingVersionId,
      readingMode: existingRecord.readingMode ?? existingRecord.reading_mode,
      pageIndex:
        rawPageIndex !== undefined && rawPageIndex !== null
          ? Number(rawPageIndex)
          : undefined,
      scrollPosition:
        rawScrollPosition !== undefined && rawScrollPosition !== null
          ? Number(rawScrollPosition)
          : undefined,
      progressPercentage: existingPercentage,
      anchorBlockId:
        existingRecord.anchorBlockId ?? existingRecord.anchor_block_id ?? null,
      textOffset: rawTextOffset !== null ? Number(rawTextOffset) : null,
    };
  }
}
