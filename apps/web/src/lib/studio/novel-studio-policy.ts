import {
  TranslationSegmentDto,
  MediaFormat,
  TranslationJobStatus,
  UpdateTranslationSegmentRequest,
} from '@omninovel/shared';

export interface NovelReviewBlock {
  anchorBlockId: string;
  segments: TranslationSegmentDto[];
  firstSortOrder: number;
  verifiedCount: number;
  segmentCount: number;
  hasError: boolean;
}

export type NovelWorkspaceMode =
  | 'UNSUPPORTED_FORMAT'
  | 'REVIEWABLE'
  | 'APPLIED'
  | 'TERMINAL_STATE'
  | 'PIPELINE_MONITOR';

export interface NovelWorkspaceModeResult {
  mode: NovelWorkspaceMode;
  canEdit: boolean;
  canReview: boolean;
  message?: string;
  status?: TranslationJobStatus;
}

export interface GetNovelStudioWorkspaceModeOptions {
  jobStatus: TranslationJobStatus;
  mediaFormat: MediaFormat | string;
}

export function sortNovelSegmentsDeterministic(
  segments: readonly TranslationSegmentDto[],
): TranslationSegmentDto[] {
  return [...segments].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

export function groupSegmentsByAnchorBlock(
  segments: readonly TranslationSegmentDto[],
): NovelReviewBlock[] {
  const sorted = sortNovelSegmentsDeterministic(segments);
  const blockMap = new Map<string, TranslationSegmentDto[]>();

  for (const segment of sorted) {
    const blockId = segment.anchorBlockId || 'unassigned';
    const existing = blockMap.get(blockId);
    if (existing) {
      existing.push(segment);
    } else {
      blockMap.set(blockId, [segment]);
    }
  }

  const blocks: NovelReviewBlock[] = [];
  for (const [anchorBlockId, blockSegments] of blockMap.entries()) {
    const verifiedCount = blockSegments.filter((s) => s.isHumanVerified).length;
    blocks.push({
      anchorBlockId,
      segments: blockSegments,
      firstSortOrder: blockSegments[0]?.sortOrder ?? 0,
      verifiedCount,
      segmentCount: blockSegments.length,
      hasError: false,
    });
  }

  return blocks.sort((a, b) => {
    if (a.firstSortOrder !== b.firstSortOrder) {
      return a.firstSortOrder - b.firstSortOrder;
    }
    return a.anchorBlockId.localeCompare(b.anchorBlockId);
  });
}

export const NOVEL_SYSTEM_TERMINAL_STATES: readonly TranslationJobStatus[] = [
  TranslationJobStatus.FAILED,
  TranslationJobStatus.CANCELED,
  TranslationJobStatus.EXPIRED,
] as const;

export function getNovelStudioWorkspaceMode({
  jobStatus,
  mediaFormat,
}: GetNovelStudioWorkspaceModeOptions): NovelWorkspaceModeResult {
  if (mediaFormat !== MediaFormat.NOVEL) {
    return {
      mode: 'UNSUPPORTED_FORMAT',
      canEdit: false,
      canReview: false,
      message: 'Tác phẩm này không phải định dạng Tiểu thuyết (Novel).',
      status: jobStatus,
    };
  }

  if (jobStatus === TranslationJobStatus.READY_FOR_REVIEW) {
    return {
      mode: 'REVIEWABLE',
      canEdit: true,
      canReview: true,
      status: jobStatus,
    };
  }

  if (jobStatus === TranslationJobStatus.APPLIED) {
    return {
      mode: 'APPLIED',
      canEdit: false,
      canReview: false,
      message: 'Bản dịch đã được áp dụng vào tác phẩm.',
      status: jobStatus,
    };
  }

  if ((NOVEL_SYSTEM_TERMINAL_STATES as readonly string[]).includes(jobStatus)) {
    return {
      mode: 'TERMINAL_STATE',
      canEdit: false,
      canReview: false,
      message: `Job dịch đã kết thúc ở trạng thái ${jobStatus}.`,
      status: jobStatus,
    };
  }

  return {
    mode: 'PIPELINE_MONITOR',
    canEdit: false,
    canReview: false,
    message: 'Tiến trình dịch tự động đang được xử lý...',
    status: jobStatus,
  };
}

export interface BuildUpdateSegmentPayloadOptions {
  translatedText?: string;
  isHumanVerified?: boolean;
  expectedVersion: number;
}

export function buildUpdateSegmentPayload(
  options: BuildUpdateSegmentPayloadOptions,
): UpdateTranslationSegmentRequest {
  const payload: UpdateTranslationSegmentRequest = {
    expectedVersion: options.expectedVersion,
  };

  if (options.translatedText !== undefined) {
    payload.translatedText = options.translatedText;
  }

  if (options.isHumanVerified !== undefined) {
    payload.isHumanVerified = options.isHumanVerified;
  }

  return payload;
}
