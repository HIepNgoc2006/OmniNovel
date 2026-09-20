import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import TranslationReviewJobPage from '../app/(site)/(studio)/studio/ai/jobs/[jobId]/page';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationJobReviewDetailResponse,
} from '@omninovel/shared';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/studio/ai/jobs/job-dispatcher-test',
}));

describe('TranslationReviewJobPage Route Dispatcher (#150 Task 1)', () => {
  const mockJobId = 'job-dispatcher-test';
  const mockParams = Promise.resolve({ jobId: mockJobId });

  const createMockJobDetail = (
    mediaFormat: MediaFormat | string,
  ): TranslationJobReviewDetailResponse => ({
    job: {
      id: mockJobId,
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o-mini',
      promptVersion: 'v1',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: '2026-09-01T10:00:00Z',
      startedAt: '2026-09-01T10:01:00Z',
      heartbeatAt: '2026-09-01T10:05:00Z',
      completedAt: '2026-09-01T10:05:00Z',
      expiresAt: null,
      reviewRevision: 1,
      materializedRevision: 1,
      workspaceRevision: 1,
    },
    context: {
      story: {
        id: 's1',
        title: 'Story Title',
        slug: 'story-slug',
        mediaFormat: mediaFormat as MediaFormat,
      },
      edition: { id: 'e1', editionName: 'Việt', language: 'vi', isDefault: true },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Chapter 1' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 10,
      verifiedCount: 2,
      pageCount: 1,
      resultPageCount: 1,
      blockCount: 5,
    },
    permissions: {
      canApply: true,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: { id: 'u1', username: 'translator1', email: 'test@omninovel.com', role: 'TRANSLATOR' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });
  });

  it('1. dispatches to Manga workspace when story mediaFormat === COMIC', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(
      createMockJobDetail(MediaFormat.COMIC),
    );
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      workspaceRevision: 1,
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 1,
    });

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByText('Canvas So Sánh & Vùng Thoại OCR')).toBeDefined();
    expect(screen.queryByTestId('novel-review-workspace')).toBeNull();
  });

  it('2. dispatches to Novel workspace when story mediaFormat === NOVEL', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(
      createMockJobDetail(MediaFormat.NOVEL),
    );
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      workspaceRevision: 1,
    });

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByTestId('novel-review-workspace')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
  });

  it('3. fails closed when mediaFormat is unknown or invalid', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(
      createMockJobDetail('UNKNOWN_FORMAT_XYZ'),
    );

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByText('Định Dạng Không Hợp Lệ')).toBeDefined();
    expect(screen.getByText('Định Dạng Tác Phẩm Không Hỗ Trợ')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
    expect(screen.queryByTestId('novel-review-workspace')).toBeNull();
  });

  it('4. renders Auth Required shell when user is unauthenticated', async () => {
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'anonymous',
      user: null,
      isAuthenticated: false,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByText('Yêu Cầu Xác Thực')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
    expect(screen.queryByTestId('novel-review-workspace')).toBeNull();
  });

  it('5. renders error shell on 403 FORBIDDEN from authoritative detail fetch', async () => {
    vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          error: {
            code: 'FORBIDDEN',
            message: 'Bạn không có quyền truy cập job dịch này.',
          },
        },
      },
    });

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByText('Không Thể Truy Cập Job Dịch')).toBeDefined();
    expect(screen.getByText('FORBIDDEN')).toBeDefined();
    expect(screen.queryByText('Canvas So Sánh & Vùng Thoại OCR')).toBeNull();
    expect(screen.queryByTestId('novel-review-workspace')).toBeNull();
  });

  it('6. avoids double-fetching: job detail is fetched once by dispatcher and passed down', async () => {
    const detailSpy = vi.spyOn(translationApi, 'fetchTranslationJobDetail').mockResolvedValue(
      createMockJobDetail(MediaFormat.COMIC),
    );
    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      workspaceRevision: 1,
    });
    vi.spyOn(translationApi, 'fetchTranslationJobPreviews').mockResolvedValue({
      sourceAssets: [],
      resultAssets: [],
      workspaceRevision: 1,
    });

    await act(async () => {
      render(<TranslationReviewJobPage params={Promise.resolve({ jobId: mockJobId })} />);
    });

    expect(await screen.findByText('Canvas So Sánh & Vùng Thoại OCR')).toBeDefined();

    // Authoritative fetch count MUST be exactly 1 on mount (zero double-fetch)
    expect(detailSpy).toHaveBeenCalledTimes(1);
  });
});
