import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchTranslationJobDetail,
  fetchTranslationJobSegments,
  fetchTranslationJobPreviews,
  updateTranslationSegment,
  requestJobMaterialization,
  cancelTranslationJob,
  fetchManagedStories,
  fetchTranslationProjects,
  fetchTranslationJobs,
  parseApiError,
} from '../lib/api/translation';
import { apiClient } from '../lib/api/client';
import { TranslationJobStatus } from '@omninovel/shared';

describe('Translation API Client & Error Parsing (#149 RED 0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Endpoint paths and parameters', () => {
    it('fetchManagedStories calls canonical GET /studio/stories', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({
        data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } },
      } as any);
      await fetchManagedStories({ page: 1, limit: 20, search: 'One Piece' });
      expect(spy).toHaveBeenCalledWith('/studio/stories', {
        params: { page: 1, limit: 20, search: 'One Piece' },
      });
    });

    it('fetchTranslationProjects calls GET /ai/projects with story hierarchy filter', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({
        data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } },
      } as any);
      await fetchTranslationProjects({ storyId: 'story-1', page: 1, limit: 20 });
      expect(spy).toHaveBeenCalledWith('/ai/projects', {
        params: { storyId: 'story-1', page: 1, limit: 20 },
      });
    });

    it('fetchTranslationJobs serializes multi-status filter canonically', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({
        data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } },
      } as any);
      await fetchTranslationJobs({
        statuses: [
          TranslationJobStatus.QUEUED,
          TranslationJobStatus.TRANSLATING,
        ],
        search: 'chapter 100',
        page: 2,
        limit: 10,
      });
      expect(spy).toHaveBeenCalledWith('/ai/jobs', {
        params: {
          statuses: 'QUEUED,TRANSLATING',
          search: 'chapter 100',
          page: 2,
          limit: 10,
        },
      });
    });

    it('fetchTranslationJobDetail calls GET /ai/jobs/:id (without duplicating /api/v1)', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { job: { id: 'job-1' } } } as any);
      await fetchTranslationJobDetail('job-1');
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1');
    });

    it('fetchTranslationJobSegments calls GET /ai/jobs/:id/segments with positional params', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { data: [] } } as any);
      await fetchTranslationJobSegments('job-1', 2, 25, 4);
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/segments', {
        params: { page: 2, limit: 25, pageNumber: 4 },
      });
    });

    it('fetchTranslationJobSegments calls GET /ai/jobs/:id/segments with query object including pageNumber filter (#149 RED 1)', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { data: [] } } as any);
      await fetchTranslationJobSegments('job-1', { page: 1, limit: 50, pageNumber: 3 });
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/segments', {
        params: { page: 1, limit: 50, pageNumber: 3 },
      });
    });

    it('fetchTranslationJobPreviews calls GET /ai/jobs/:id/previews with bounded query (pageNumber or fromPage/toPage)', async () => {
      const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { sourceAssets: [], resultAssets: [] } } as any);
      await fetchTranslationJobPreviews('job-1', { pageNumber: 3 });
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/previews', {
        params: { pageNumber: 3 },
      });

      await fetchTranslationJobPreviews('job-1', { fromPage: 1, toPage: 5 });
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/previews', {
        params: { fromPage: 1, toPage: 5 },
      });
    });

    it('updateTranslationSegment calls PATCH /ai/jobs/:id/segments/:segmentId with payload', async () => {
      const spy = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: { id: 'seg-1' } } as any);
      await updateTranslationSegment('job-1', 'seg-1', {
        translatedText: 'Đã dịch',
        expectedVersion: 1,
      });
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/segments/seg-1', {
        translatedText: 'Đã dịch',
        expectedVersion: 1,
      });
    });

    it('requestJobMaterialization calls POST /ai/jobs/:id/materializations', async () => {
      const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({
        data: { status: 'ENQUEUED', targetRevision: 2 },
      } as any);
      await requestJobMaterialization('job-1');
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/materializations', {});
    });

    it('cancelTranslationJob calls POST /ai/jobs/:id/cancel (#149 RED 6)', async () => {
      const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({
        data: { id: 'job-1', status: 'CANCELED' },
      } as any);
      const res = await cancelTranslationJob('job-1');
      expect(spy).toHaveBeenCalledWith('/ai/jobs/job-1/cancel', {});
      expect(res).toEqual({ id: 'job-1', status: 'CANCELED' });
    });
  });

  describe('parseApiError with StandardErrorResponse and error.meta', () => {
    it('parses structured backend error with meta (currentVersion, expectedVersion)', () => {
      const mockAxiosError = {
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: {
          status: 409,
          data: {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'Segment version conflict detected',
              requestId: 'req-abc',
              timestamp: '2026-09-10T12:00:00Z',
              meta: {
                currentVersion: 4,
                expectedVersion: 2,
              },
            },
          },
        },
      };

      const parsed = parseApiError(mockAxiosError);
      expect(parsed.code).toBe('VERSION_CONFLICT');
      expect(parsed.message).toBe('Segment version conflict detected');
      expect(parsed.status).toBe(409);
      expect(parsed.requestId).toBe('req-abc');
      expect(parsed.meta).toEqual({
        currentVersion: 4,
        expectedVersion: 2,
      });
    });

    it('parses fallback HTTP error when error body is not standard JSON', () => {
      const mockAxiosError = {
        isAxiosError: true,
        message: 'Network Error',
        response: {
          status: 502,
          data: 'Bad Gateway',
        },
      };

      const parsed = parseApiError(mockAxiosError);
      expect(parsed.code).toBe('HTTP_ERROR');
      expect(parsed.message).toBe('Network Error');
      expect(parsed.status).toBe(502);
    });

    it('parses non-axios native Error instance', () => {
      const err = new Error('Generic JS Failure');
      const parsed = parseApiError(err);
      expect(parsed.code).toBe('UNHANDLED_ERROR');
      expect(parsed.message).toBe('Generic JS Failure');
    });
  });
});
