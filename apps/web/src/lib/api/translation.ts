import { apiClient } from './client';
import {
  TranslationJobReviewDetailResponse,
  TranslationSegmentDto,
  TranslationJobSegmentsResponse,
  TranslationJobPreviewsResponse,
  PaginatedResponse,
  UpdateTranslationSegmentRequest,
  MaterializationRequestResponse,
  StandardErrorResponse,
  StandardErrorMeta,
  TranslationJobStatus,
  TranslationJobSummaryDto,
  TranslationProjectSummaryDto,
  ManagedStorySummaryDto,
  ApplyTranslationJobRequest,
  ApplyTranslationJobResponse,
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


export interface FetchManagedStoriesQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface FetchTranslationProjectsQuery {
  page?: number;
  limit?: number;
  storyId?: string;
}

export interface FetchTranslationJobsQuery {
  page?: number;
  limit?: number;
  storyId?: string;
  projectId?: string;
  status?: TranslationJobStatus;
  statuses?: readonly TranslationJobStatus[] | TranslationJobStatus[];
  search?: string;
}

export async function fetchManagedStories(
  query: FetchManagedStoriesQuery = {},
): Promise<PaginatedResponse<ManagedStorySummaryDto>> {
  const response = await apiClient.get<PaginatedResponse<ManagedStorySummaryDto>>(
    '/studio/stories',
    { params: query },
  );
  return response.data;
}

export async function fetchTranslationProjects(
  query: FetchTranslationProjectsQuery = {},
): Promise<PaginatedResponse<TranslationProjectSummaryDto>> {
  const response = await apiClient.get<
    PaginatedResponse<TranslationProjectSummaryDto>
  >('/ai/projects', { params: query });
  return response.data;
}

export async function fetchTranslationJobs(
  query: FetchTranslationJobsQuery = {},
): Promise<PaginatedResponse<TranslationJobSummaryDto>> {
  const params = {
    ...query,
    ...(query.statuses && query.statuses.length > 0
      ? { statuses: query.statuses.join(',') }
      : {}),
  };

  const response = await apiClient.get<PaginatedResponse<TranslationJobSummaryDto>>(
    '/ai/jobs',
    { params },
  );
  return response.data;
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

export interface FetchTranslationJobSegmentsQuery {
  page?: number;
  limit?: number;
  pageNumber?: number;
}

/**
 * Fetch paginated segments for a TranslationJob with optional pageNumber filtering
 * GET /api/v1/ai/jobs/:jobId/segments
 */
export async function fetchTranslationJobSegments(
  jobId: string,
  pageOrQuery?: number | FetchTranslationJobSegmentsQuery,
  limit = 50,
  pageNumber?: number,
): Promise<TranslationJobSegmentsResponse> {
  let params: Record<string, any>;

  if (typeof pageOrQuery === 'object' && pageOrQuery !== null) {
    params = {
      page: pageOrQuery.page ?? 1,
      limit: pageOrQuery.limit ?? 50,
      ...(pageOrQuery.pageNumber !== undefined && pageOrQuery.pageNumber !== null
        ? { pageNumber: pageOrQuery.pageNumber }
        : {}),
    };
  } else {
    params = {
      page: typeof pageOrQuery === 'number' ? pageOrQuery : 1,
      limit,
      ...(pageNumber !== undefined && pageNumber !== null ? { pageNumber } : {}),
    };
  }

  const response = await apiClient.get<TranslationJobSegmentsResponse>(
    `/ai/jobs/${jobId}/segments`,
    {
      params,
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

/**
 * Cancel an active TranslationJob
 * POST /api/v1/ai/jobs/:jobId/cancel
 */
export async function cancelTranslationJob(
  jobId: string,
): Promise<{ id: string; status: TranslationJobStatus }> {
  const response = await apiClient.post<{ id: string; status: TranslationJobStatus }>(
    `/ai/jobs/${jobId}/cancel`,
    {},
  );
  return response.data;
}

/**
 * Apply / Publish reviewed TranslationJob
 * POST /api/v1/ai/jobs/:jobId/apply
 */
export async function applyTranslationJob(
  jobId: string,
  request: ApplyTranslationJobRequest,
  idempotencyKey?: string,
): Promise<ApplyTranslationJobResponse> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  const response = await apiClient.post<ApplyTranslationJobResponse>(
    `/ai/jobs/${jobId}/apply`,
    request,
    { headers },
  );
  return response.data;
}

