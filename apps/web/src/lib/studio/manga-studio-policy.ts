import {
  TranslationJobStatus,
  MediaFormat,
  ReviewSummaryDto,
  StandardErrorMeta,
} from '@omninovel/shared';
import { parseApiError, ParsedApiError } from '../api/translation';

export type WorkspaceMode =
  | 'UNSUPPORTED_FORMAT'
  | 'REVIEWABLE'
  | 'APPLIED'
  | 'PIPELINE_MONITOR';

export interface WorkspaceModeResult {
  mode: WorkspaceMode;
  canPreview: boolean;
  canEdit: boolean;
  canMaterialize: boolean;
  message?: string;
  status?: TranslationJobStatus;
}

/**
 * Determine the workspace operational mode based on job status and media format.
 * Fail-closed: Only COMIC in READY_FOR_REVIEW allows preview, edit, and materialization.
 * APPLIED preserves result count view but STRICTLY blocks mutation, preview, and materialization.
 */
export function getMangaStudioWorkspaceMode(
  jobStatus: TranslationJobStatus,
  mediaFormat: MediaFormat,
): WorkspaceModeResult {
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

/**
 * Materialization freshness evaluator (#157)
 * Invariant: reviewRevision > materializedRevision indicates stale artifact needing re-render.
 */
export function computeMaterializationFreshness(
  reviewRevision: number,
  materializedRevision: number,
): { isFresh: boolean; needsMaterialize: boolean } {
  if (reviewRevision > materializedRevision) {
    return { isFresh: false, needsMaterialize: true };
  }
  return { isFresh: true, needsMaterialize: false };
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
      type: 'OTHER';
      code: string;
      message: string;
    };

/**
 * Differentiate between 409 VERSION_CONFLICT and 409 NOT_REVIEWABLE
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

  return {
    type: 'OTHER',
    code: parsed.code,
    message: parsed.message,
  };
}
