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
    const { mutation, existingRecord } = context;

    if (mutation.operation === SyncOperation.DELETE) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Reading progress cleared',
      };
    }

    const payload = mutation.payload as Record<string, any>;
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
      existingRecord.chapterVersionId ?? existingRecord.chapter_version_id;
    const incomingVersionId = payload.chapterVersionId;

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

        // Monotonic forward progress invariant: bảo toàn vị trí đọc lớn hơn
        return {
          status: 'CONFLICT_MERGED',
          reason: 'MONOTONIC_PROGRESS_PRESERVED',
          message: `Server preserved higher progress percentage (${existingPercentage} > ${incomingPercentage})`,
          resolvedPayload: {
            ...payload,
            pageIndex: existingRecord.pageIndex ?? existingRecord.page_index,
            scrollPosition:
              existingRecord.scrollPosition ?? existingRecord.scroll_position,
            progressPercentage: existingPercentage,
          },
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
          resolvedPayload: {
            storyId: payload.storyId,
            chapterId: existingChapterId,
            chapterVersionId: existingVersionId,
            readingMode:
              existingRecord.readingMode ?? existingRecord.reading_mode,
            pageIndex: existingRecord.pageIndex ?? existingRecord.page_index,
            scrollPosition:
              existingRecord.scrollPosition ?? existingRecord.scroll_position,
            progressPercentage: existingPercentage,
            anchorBlockId:
              existingRecord.anchorBlockId ?? existingRecord.anchor_block_id ?? null,
            textOffset:
              existingRecord.textOffset ?? existingRecord.text_offset ?? null,
          },
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
}
