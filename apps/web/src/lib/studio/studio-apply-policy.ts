import {
  ApplyTranslationJobResponse,
  ApplyTranslationMode,
  TranslationJobStatus,
} from '@omninovel/shared';
import {
  parseApiError,
  ParsedApiError as BaseParsedApiError,
} from '../api/translation';

export interface CanApplyJobParams {
  jobStatus: TranslationJobStatus;
  canApplyPermission: boolean;
  freshnessStatus: string;
  hasUncommittedDrafts: boolean;
  applyInFlight: boolean;
  materializationInFlight: boolean;
}

export type ApplyLifecycleState =
  | 'IDLE'
  | 'SUBMITTING'
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'RECONCILING'
  | 'SUCCEEDED'
  | 'COMMITTED_RECONCILIATION_REQUIRED'
  | 'FAILED';

export interface ParsedApiError extends BaseParsedApiError {
  isAmbiguous: boolean;
}

export interface FrozenApplySubmission {
  idempotencyKey: string;
  mode: ApplyTranslationMode;
}

export type ApplyJobResult =
  | {
      outcome: 'SUCCEEDED';
      response: ApplyTranslationJobResponse;
    }
  | {
      outcome: 'COMMITTED_RECONCILIATION_REQUIRED';
      response: ApplyTranslationJobResponse;
      error: ParsedApiError;
    }
  | {
      outcome: 'SUBMISSION_OUTCOME_UNKNOWN';
      error: ParsedApiError;
    }
  | {
      outcome: 'FAILED';
      error: ParsedApiError;
    };

export function canApplyJob(params: CanApplyJobParams): boolean {
  return (
    params.jobStatus === TranslationJobStatus.READY_FOR_REVIEW &&
    params.canApplyPermission === true &&
    params.freshnessStatus === 'FRESH' &&
    !params.hasUncommittedDrafts &&
    !params.applyInFlight &&
    !params.materializationInFlight
  );
}

export function resolveApplyBlockReason(
  params: CanApplyJobParams,
): string | null {
  if (params.jobStatus !== TranslationJobStatus.READY_FOR_REVIEW) {
    return 'Job chưa ở trạng thái READY_FOR_REVIEW.';
  }
  if (!params.canApplyPermission) {
    return 'Bạn không có quyền xuất bản bản dịch này.';
  }
  if (params.freshnessStatus !== 'FRESH') {
    return 'Artifact chưa đồng bộ với bản chỉnh sửa mới nhất.';
  }
  if (params.hasUncommittedDrafts) {
    return 'Còn thay đổi chưa được lưu.';
  }
  if (params.applyInFlight) {
    return 'Yêu cầu xuất bản đang được xử lý.';
  }
  if (params.materializationInFlight) {
    return 'Đang kết xuất artifact, vui lòng chờ hoàn tất.';
  }
  return null;
}

export function resolvePostApplyReaderUrl(
  storySlug: string,
  response: ApplyTranslationJobResponse,
): string {
  return `/stories/${storySlug}/read/${response.chapterId}?versionId=${encodeURIComponent(
    response.targetVersionId,
  )}`;
}

function isTransportAmbiguity(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    isAxiosError?: boolean;
    response?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (candidate.isAxiosError === true && candidate.response == null) {
    return true;
  }

  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if (
    [
      'ECONNABORTED',
      'ERR_NETWORK',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
    ].includes(code)
  ) {
    return true;
  }

  if (candidate.name === 'AbortError') {
    return true;
  }

  const message =
    typeof candidate.message === 'string'
      ? candidate.message.toLowerCase()
      : '';
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network error') ||
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('connection reset') ||
    message.includes('socket hang up')
  );
}

export function classifyApplyError(error: unknown): ParsedApiError {
  const parsed = parseApiError(error);
  const isServerAmbiguous =
    typeof parsed.status === 'number' &&
    parsed.status >= 500 &&
    parsed.status <= 599;

  return {
    ...parsed,
    isAmbiguous: isServerAmbiguous || isTransportAmbiguity(error),
  };
}
