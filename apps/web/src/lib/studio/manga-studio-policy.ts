import {
  TranslationJobStatus,
  MediaFormat,
  ReviewSummaryDto,
  StandardErrorMeta,
} from '@omninovel/shared';
import { parseApiError } from '../api/translation';

export type WorkspaceMode =
  | 'UNSUPPORTED_FORMAT'
  | 'REVIEWABLE'
  | 'COUNT_UNAVAILABLE'
  | 'APPLIED'
  | 'TERMINAL_STATE'
  | 'PIPELINE_MONITOR'
  | 'RECONCILIATION_REQUIRED';

export function isValidWorkspaceRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export interface WorkspaceModeResult {
  mode: WorkspaceMode;
  canPreview: boolean;
  canEdit: boolean;
  canMaterialize: boolean;
  message?: string;
  status?: TranslationJobStatus;
}

export interface GetMangaStudioWorkspaceModeOptions {
  jobStatus: TranslationJobStatus;
  mediaFormat: MediaFormat;
  resultPageCount?: number | null;
}

/**
 * Determine the workspace operational mode based on job status, media format, and authoritative page count.
 * Fail-closed policy:
 * - Non-COMIC: UNSUPPORTED_FORMAT (handoff to Novel Studio)
 * - READY_FOR_REVIEW:
 *     - If resultPageCount is valid safe positive integer (> 0): REVIEWABLE (preview, edit, materialize allowed)
 *     - If resultPageCount is null or invalid: COUNT_UNAVAILABLE (STRICTLY block previews, edits, materialization)
 * - APPLIED: APPLIED (read-only metadata, strictly block mutations, previews, and materialization)
 * - FAILED, CANCELED, EXPIRED: TERMINAL_STATE (no active pipeline, no false waiting prompt)
 * - QUEUED, PREPROCESSING, OCR, TRANSLATING, INPAINTING, TYPESETTING, QUALITY_CHECK: PIPELINE_MONITOR
 */
export function getMangaStudioWorkspaceMode(
  jobStatusOrOptions: TranslationJobStatus | GetMangaStudioWorkspaceModeOptions,
  mediaFormatArg?: MediaFormat,
  resultPageCountArg?: number | null,
): WorkspaceModeResult {
  let jobStatus: TranslationJobStatus;
  let mediaFormat: MediaFormat;
  let resultPageCount: number | null | undefined;

  if (typeof jobStatusOrOptions === 'object' && jobStatusOrOptions !== null) {
    jobStatus = jobStatusOrOptions.jobStatus;
    mediaFormat = jobStatusOrOptions.mediaFormat;
    resultPageCount = jobStatusOrOptions.resultPageCount;
  } else {
    jobStatus = jobStatusOrOptions;
    mediaFormat = mediaFormatArg!;
    resultPageCount = resultPageCountArg;
  }

  if (mediaFormat !== MediaFormat.COMIC) {
    return {
      mode: 'UNSUPPORTED_FORMAT',
      canPreview: false,
      canEdit: false,
      canMaterialize: false,
      message:
        'Tác phẩm này là định dạng Tiểu thuyết (Novel/Text). Vui lòng sử dụng Novel Translation Studio.',
    };
  }

  if (jobStatus === TranslationJobStatus.READY_FOR_REVIEW) {
    // Strict requirement: Authoritative result page count must be a positive integer
    const isValidCount =
      typeof resultPageCount === 'number' &&
      Number.isSafeInteger(resultPageCount) &&
      resultPageCount > 0;

    if (!isValidCount) {
      return {
        mode: 'COUNT_UNAVAILABLE',
        canPreview: false,
        canEdit: false,
        canMaterialize: false,
        message:
          'Chưa có thông tin số trang kết xuất hợp lệ từ máy chủ. Không gian duyệt tạm thời chưa sẵn sàng, vui lòng thử lại sau.',
        status: jobStatus,
      };
    }

    return {
      mode: 'REVIEWABLE',
      canPreview: true,
      canEdit: true,
      canMaterialize: true,
      status: jobStatus,
    };
  }

  if (jobStatus === TranslationJobStatus.APPLIED) {
    return {
      mode: 'APPLIED',
      canPreview: false,
      canEdit: false,
      canMaterialize: false,
      message:
        'Bản dịch đã được áp dụng (APPLIED) vào phiên bản chính của tác phẩm. Workspace ở chế độ chỉ đọc, không thể chỉnh sửa, xem preview động hoặc kết xuất lại.',
      status: jobStatus,
    };
  }

  // Terminal states (finished with failure or cancellation)
  if (
    jobStatus === TranslationJobStatus.FAILED ||
    jobStatus === TranslationJobStatus.CANCELED ||
    jobStatus === TranslationJobStatus.EXPIRED
  ) {
    return {
      mode: 'TERMINAL_STATE',
      canPreview: false,
      canEdit: false,
      canMaterialize: false,
      message: `Job dịch đã kết thúc ở trạng thái ${jobStatus}. Vui lòng tạo job mới nếu muốn tiếp tục quy trình dịch thuật.`,
      status: jobStatus,
    };
  }

  // Active in-progress pipeline monitor
  return {
    mode: 'PIPELINE_MONITOR',
    canPreview: false,
    canEdit: false,
    canMaterialize: false,
    message: `Job đang trong tiến trình xử lý tự động (${jobStatus}). Vui lòng chờ hoàn tất để tiến hành duyệt bản dịch.`,
    status: jobStatus,
  };
}

/**
 * Authoritative page count extractor.
 * Strict invariant: Only return reviewSummary.resultPageCount if it is a positive safe integer.
 * MUST NEVER fallback to OCR pageCount or fallback to 1.
 */
export function computeAuthoritativePageCount(
  reviewSummary?: ReviewSummaryDto | null,
): { pageCount: number | null; isAvailable: boolean } {
  if (!reviewSummary) {
    return { pageCount: null, isAvailable: false };
  }

  const rCount = reviewSummary.resultPageCount;
  if (typeof rCount === 'number' && Number.isSafeInteger(rCount) && rCount > 0) {
    return { pageCount: rCount, isAvailable: true };
  }

  return { pageCount: null, isAvailable: false };
}

export type FreshnessStatus =
  | 'FRESH'
  | 'STALE'
  | 'INVARIANT_VIOLATION'
  | 'UNKNOWN';

export interface MaterializationFreshnessResult {
  isFresh: boolean;
  needsMaterialize: boolean;
  status: FreshnessStatus;
  message?: string;
}

/**
 * Materialization freshness evaluator (#157)
 * Strictly enforces authoritative invariant rules:
 * - reviewRevision > materializedRevision: STALE (needs re-render)
 * - reviewRevision === materializedRevision (and >= 0): FRESH
 * - materializedRevision > reviewRevision: INVARIANT_VIOLATION (not fresh, invalid state)
 * - nullish / missing values: UNKNOWN
 */
export function computeMaterializationFreshness(
  reviewRevision?: number | null,
  materializedRevision?: number | null,
): MaterializationFreshnessResult {
  if (
    typeof reviewRevision !== 'number' ||
    typeof materializedRevision !== 'number' ||
    !Number.isSafeInteger(reviewRevision) ||
    !Number.isSafeInteger(materializedRevision) ||
    reviewRevision < 0 ||
    materializedRevision < 0
  ) {
    return {
      isFresh: false,
      needsMaterialize: false,
      status: 'UNKNOWN',
      message: 'Thông tin phiên bản chưa xác định.',
    };
  }

  if (materializedRevision > reviewRevision) {
    return {
      isFresh: false,
      needsMaterialize: false,
      status: 'INVARIANT_VIOLATION',
      message:
        'Lỗi bất biến phiên bản: materializedRevision không thể lớn hơn reviewRevision.',
    };
  }

  if (reviewRevision > materializedRevision) {
    return {
      isFresh: false,
      needsMaterialize: true,
      status: 'STALE',
      message: 'Bản kết xuất cũ hơn bản chỉnh sửa, cần kết xuất lại.',
    };
  }

  return {
    isFresh: true,
    needsMaterialize: false,
    status: 'FRESH',
    message: 'Bản kết xuất đã đồng bộ với bản chỉnh sửa mới nhất.',
  };
}

export type ConflictClassification =
  | {
      type: 'VERSION_CONFLICT';
      currentVersion?: number;
      expectedVersion?: number;
      message: string;
      meta?: StandardErrorMeta;
    }
  | {
      type: 'NOT_REVIEWABLE';
      message: string;
    }
  | {
      type: 'REVISION_INVARIANT_VIOLATION';
      message: string;
      meta?: StandardErrorMeta;
    }
  | {
      type: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS';
      message: string;
    }
  | {
      type: 'OTHER';
      code: string;
      message: string;
    };

/**
 * Differentiate between 409 VERSION_CONFLICT, 409 NOT_REVIEWABLE, 409 REVISION_INVARIANT_VIOLATION, and 409 PREVIEWS_NOT_AVAILABLE_FOR_STATUS
 * Uses allowlisted backend error.meta fields.
 */
export function classifyConflictError(error: unknown): ConflictClassification {
  const parsed = parseApiError(error);

  if (parsed.code === 'VERSION_CONFLICT') {
    return {
      type: 'VERSION_CONFLICT',
      currentVersion: parsed.meta?.currentVersion,
      expectedVersion: parsed.meta?.expectedVersion,
      message: parsed.message,
      meta: parsed.meta,
    };
  }

  if (parsed.code === 'NOT_REVIEWABLE') {
    return {
      type: 'NOT_REVIEWABLE',
      message: parsed.message,
    };
  }

  if (parsed.code === 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS') {
    return {
      type: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
      message: parsed.message,
    };
  }

  if (parsed.code === 'REVISION_INVARIANT_VIOLATION') {
    return {
      type: 'REVISION_INVARIANT_VIOLATION',
      message: parsed.message,
      meta: parsed.meta,
    };
  }

  return {
    type: 'OTHER',
    code: parsed.code,
    message: parsed.message,
  };
}
