import { CreateTranslationJobRequest } from '@omninovel/shared';
import {
  parseApiError,
  ParsedApiError as BaseParsedApiError,
} from '../api/translation';

export const EXTERNAL_PROVIDERS = [
  'OPENAI',
  'DEEPL',
  'GEMINI',
  'CLAUDE',
] as const;

export const LOCAL_PROVIDERS = ['MOCK', 'LOCAL', 'LOCAL_LLM'] as const;

export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number];
export type TranslationProvider = ExternalProvider | LocalProvider | string;

export interface JobCreationFormData {
  chapterVersionId?: string;
  sourceLang?: string;
  targetLang?: string;
  provider?: string;
  externalConsent?: boolean;
}

export interface JobCreationFormErrors {
  chapterVersionId?: string;
  sourceLang?: string;
  targetLang?: string;
  provider?: string;
  externalConsent?: string;
  general?: string;
}

export interface FrozenJobSubmission {
  idempotencyKey: string;
  payload: CreateTranslationJobRequest;
}

export type JobCreationLifecycleState =
  | 'IDLE'
  | 'SUBMITTING'
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED';

export interface ParsedJobCreationError extends BaseParsedApiError {
  isAmbiguous: boolean;
}

export function isExternalProvider(provider?: string): boolean {
  if (!provider) return false;
  const normalized = provider.trim().toUpperCase();
  return (EXTERNAL_PROVIDERS as readonly string[]).includes(normalized);
}

export function requiresExternalConsent(provider?: string): boolean {
  return isExternalProvider(provider);
}

export function validateJobCreationForm(form: JobCreationFormData): {
  isValid: boolean;
  errors: JobCreationFormErrors;
} {
  const errors: JobCreationFormErrors = {};

  if (!form.chapterVersionId || !form.chapterVersionId.trim()) {
    errors.chapterVersionId =
      'Vui lòng chọn phiên bản nguồn (ChapterVersion).';
  }

  if (!form.sourceLang || !form.sourceLang.trim()) {
    errors.sourceLang = 'Vui lòng chọn ngôn ngữ nguồn.';
  }

  if (!form.targetLang || !form.targetLang.trim()) {
    errors.targetLang = 'Vui lòng chọn ngôn ngữ đích.';
  }

  if (
    form.sourceLang &&
    form.targetLang &&
    form.sourceLang.trim().toLowerCase() ===
      form.targetLang.trim().toLowerCase()
  ) {
    errors.targetLang = 'Ngôn ngữ đích không được trùng với ngôn ngữ nguồn.';
  }

  if (isExternalProvider(form.provider) && form.externalConsent !== true) {
    errors.externalConsent = `Vui lòng xác nhận sự đồng ý chuyển dữ liệu sang nhà cung cấp bên thứ ba (${form.provider}).`;
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

export function shouldReuseIdempotencyKey(
  previous: FrozenJobSubmission | null,
  currentPayload: CreateTranslationJobRequest,
  isAmbiguous: boolean,
): boolean {
  if (!previous || !isAmbiguous) {
    return false;
  }

  const prev = previous.payload;
  return (
    prev.chapterVersionId === currentPayload.chapterVersionId &&
    prev.sourceLang === currentPayload.sourceLang &&
    prev.targetLang === currentPayload.targetLang &&
    (prev.provider || 'MOCK') === (currentPayload.provider || 'MOCK') &&
    Boolean(prev.externalConsent) === Boolean(currentPayload.externalConsent)
  );
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

export function classifyJobCreationError(
  error: unknown,
): ParsedJobCreationError {
  const parsed = parseApiError(error);
  const isServerAmbiguous =
    typeof parsed.status === 'number' &&
    parsed.status >= 500 &&
    parsed.status <= 599;

  const isAmbiguous = isServerAmbiguous || isTransportAmbiguity(error);

  let mappedMessage = parsed.message;

  if (isAmbiguous) {
    mappedMessage =
      'Yêu cầu chưa xác định kết quả do sự cố mạng hoặc máy chủ phản hồi chậm. Vui lòng bấm Thử lại để gửi lại cùng Idempotency Key.';
  } else if (parsed.status === 400) {
    if (parsed.code === 'EXTERNAL_PROVIDER_CONSENT_REQUIRED') {
      mappedMessage =
        'Dịch vụ yêu cầu sự đồng ý (externalConsent = true) trước khi gửi văn bản sang nhà cung cấp bên thứ ba.';
    } else if (parsed.code === 'SOURCE_LANGUAGE_MISMATCH') {
      mappedMessage =
        'Ngôn ngữ nguồn không khớp với ngôn ngữ của bản gốc ChapterVersion.';
    } else if (parsed.code === 'IDENTICAL_LANGUAGES') {
      mappedMessage = 'Ngôn ngữ đích không được trùng với ngôn ngữ nguồn.';
    } else if (parsed.code === 'IDEMPOTENCY_KEY_REQUIRED') {
      mappedMessage =
        'Header Idempotency-Key là bắt buộc theo chuẩn API Contract.';
    }
  } else if (parsed.status === 403) {
    mappedMessage =
      'Bạn không có quyền khởi tạo bản dịch cho bộ truyện này (Yêu cầu vai trò Translator/Editor/Owner).';
  } else if (parsed.status === 404) {
    mappedMessage =
      'Không tìm thấy thông tin bộ truyện, chương hoặc phiên bản nguồn được chọn.';
  } else if (parsed.status === 409) {
    mappedMessage =
      'Xung đột dữ liệu source artifact hoặc upload session.';
  }

  return {
    ...parsed,
    message: mappedMessage,
    isAmbiguous,
  };
}
