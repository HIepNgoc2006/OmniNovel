import { apiClient } from './client';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobPreviewsResponse,
  PaginatedResponse,
  UpdateTranslationSegmentRequest,
  MaterializationRequestResponse,
  StandardErrorResponse,
  StandardErrorMeta,
} from '@omninovel/shared';
import { AxiosError } from 'axios';

export interface ParsedApiError {
  code: string;
  message: string;
  status?: number;
  meta?: StandardErrorMeta;
  requestId?: string;
  details?: Array<{ field: string; issue: string }>;
}

export function parseApiError(error: unknown): ParsedApiError {
  if (error && typeof error === 'object' && 'isAxiosError' in error) {
    const axiosErr = error as AxiosError<StandardErrorResponse>;
    const errData = axiosErr.response?.data?.error;
    if (errData && typeof errData === 'object') {
      return {
        code: errData.code || 'UNKNOWN_ERROR',
        message: errData.message || axiosErr.message || 'Lỗi không xác định',
        status: axiosErr.response?.status,
        meta: errData.meta,
        requestId: errData.requestId,
        details: errData.details,
      };
    }
    return {
      code: 'HTTP_ERROR',
      message: axiosErr.message || 'Lỗi mạng hoặc HTTP',
      status: axiosErr.response?.status,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'UNHANDLED_ERROR',
      message: error.message,
    };
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: String(error),
  };
}

/**
 * Fetch detailed authoritative metadata and reviewSummary for a TranslationJob
 * GET /api/v1/ai/jobs/:jobId
 */
export async function fetchTranslationJobDetail(
  jobId: string,
): Promise<TranslationJobReviewDetailResponse> {
  const response = await apiClient.get<TranslationJobReviewDetailResponse>(
    `/ai/jobs/${jobId}`,
  );
  return response.data;
}

/**
 * Fetch paginated segments for a TranslationJob
 * GET /api/v1/ai/jobs/:jobId/segments
 */
export async function fetchTranslationJobSegments(
  jobId: string,
  page = 1,
  limit = 50,
): Promise<PaginatedResponse<TranslationSegmentDto>> {
  const response = await apiClient.get<PaginatedResponse<TranslationSegmentDto>>(
    `/ai/jobs/${jobId}/segments`,
    {
      params: { page, limit },
    },
  );
  return response.data;
}

/**
 * Fetch bounded presigned preview URLs for a TranslationJob
 * GET /api/v1/ai/jobs/:jobId/previews
 */
export async function fetchTranslationJobPreviews(
  jobId: string,
  query: { pageNumber?: number; fromPage?: number; toPage?: number },
): Promise<TranslationJobPreviewsResponse> {
  const response = await apiClient.get<TranslationJobPreviewsResponse>(
    `/ai/jobs/${jobId}/previews`,
    {
      params: query,
    },
  );
  return response.data;
}

/**
 * Mutate a single translation segment with optimistic concurrency control (OCC)
 * PATCH /api/v1/ai/jobs/:jobId/segments/:segmentId
 */
export async function updateTranslationSegment(
  jobId: string,
  segmentId: string,
  payload: UpdateTranslationSegmentRequest,
): Promise<TranslationSegmentDto> {
  const response = await apiClient.patch<TranslationSegmentDto>(
    `/ai/jobs/${jobId}/segments/${segmentId}`,
    payload,
  );
  return response.data;
}

/**
 * Request BullMQ materialization / artifact re-render for a TranslationJob
 * POST /api/v1/ai/jobs/:jobId/materializations
 */
export async function requestJobMaterialization(
  jobId: string,
): Promise<MaterializationRequestResponse> {
  const response = await apiClient.post<MaterializationRequestResponse>(
    `/ai/jobs/${jobId}/materializations`,
    {},
  );
  return response.data;
}
