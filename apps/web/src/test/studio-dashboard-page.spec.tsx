import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StudioPage from '../app/(site)/(studio)/studio/page';
import * as dashboardHook from '../lib/studio/use-studio-dashboard';
import {
  TranslationJobStatus,
  MediaFormat,
  ManagedStorySummaryDto,
  TranslationJobSummaryDto,
} from '@omninovel/shared';

vi.mock('../lib/studio/use-studio-dashboard');

describe('StudioPage Integration (#145 Task 5)', () => {
  const mockStories: ManagedStorySummaryDto[] = [
    {
      id: 'story-1',
      title: 'Solo Leveling',
      slug: 'solo-leveling',
      mediaFormat: MediaFormat.COMIC,
      publicationFormat: 'WEBTOON' as any,
      originCountry: 'KR',
      originalLanguage: 'ko',
      coverUrl: null,
      status: 'ONGOING' as any,
      visibility: 'PUBLIC' as any,
      summary: null,
      viewsCount: '5000',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  const mockJobs: TranslationJobSummaryDto[] = [
    {
      id: 'job-1',
      projectId: 'proj-1',
      storyId: 'story-1',
      storyTitle: 'Solo Leveling',
      storySlug: 'solo-leveling',
      mediaFormat: MediaFormat.COMIC,
      storyEditionId: 'edition-1',
      editionName: 'Bản Dịch Tiếng Việt',
      chapterId: 'chap-1',
      chapterNumber: '1.00',
      chapterTitle: 'Thức tỉnh',
      sourceLanguage: 'ko',
      targetLanguage: 'vi',
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      createdAt: '2026-09-01T00:00:00Z',
      startedAt: '2026-09-01T00:01:00Z',
      completedAt: '2026-09-01T00:05:00Z',
      heartbeatAt: null,
    },
  ];

  const mockHookDefault: ReturnType<typeof dashboardHook.useStudioDashboard> = {
    stories: mockStories,
    projects: [],
    jobs: mockJobs,
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    filterGroup: 'ALL',
    searchKeyword: '',
    selectedStoryId: null,
    selectedProjectId: null,
    page: 1,
    limit: 20,
    isInitialLoading: false,
    isJobsLoading: false,
    isLoadingProjects: false,
    error: null,
    socketStatus: { isConnected: true, subscriptionState: 'subscribed' },
    setFilterGroup: vi.fn(),
    setSearchKeyword: vi.fn(),
    setSelectedStoryId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setPage: vi.fn(),
    refetchJobs: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Renders header, metrics cards, filter bar, and job list', () => {
    vi.spyOn(dashboardHook, 'useStudioDashboard').mockReturnValue(mockHookDefault);

    render(<StudioPage />);

    expect(screen.getByText('Bảng Điều Khiển Dịch Thuật')).toBeInTheDocument();
    expect(screen.getByTestId('metric-card-REVIEW')).toBeInTheDocument();
    expect(screen.getByTestId('filter-pill-ALL')).toBeInTheDocument();
    expect(screen.getByText('Solo Leveling')).toBeInTheDocument();
    expect(screen.getByText(/Chương 1\.00/)).toBeInTheDocument();
    expect(screen.getByTestId('job-cta-button')).toHaveTextContent(/Duyệt bản dịch/i);
    expect(screen.getByTestId('create-job-cta-btn')).toHaveAttribute(
      'href',
      '/studio/ai/jobs/new',
    );
  });

  it('2. Renders loading state during initial load', () => {
    vi.spyOn(dashboardHook, 'useStudioDashboard').mockReturnValue({
      ...mockHookDefault,
      isInitialLoading: true,
      jobs: [],
    });

    render(<StudioPage />);

    expect(screen.getByTestId('dashboard-loading-skeleton')).toBeInTheDocument();
  });

  it('3. Renders empty state when jobs list is empty', () => {
    vi.spyOn(dashboardHook, 'useStudioDashboard').mockReturnValue({
      ...mockHookDefault,
      jobs: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
    });

    render(<StudioPage />);

    expect(
      screen.getByText(/Không tìm thấy tiến trình dịch thuật nào/i),
    ).toBeInTheDocument();
  });

  it('4. Handles pagination clicks properly', () => {
    const setPage = vi.fn();
    vi.spyOn(dashboardHook, 'useStudioDashboard').mockReturnValue({
      ...mockHookDefault,
      page: 1,
      pagination: { page: 1, limit: 20, total: 45, totalPages: 3 },
      setPage,
    });

    render(<StudioPage />);

    expect(screen.getByText('Trang 1 / 3')).toBeInTheDocument();
    const nextBtn = screen.getByTestId('pagination-next-btn');
    fireEvent.click(nextBtn);
    expect(setPage).toHaveBeenCalledWith(2);
  });

  it('5. Renders error alert when error exists and supports retry', () => {
    const refetchJobs = vi.fn();
    vi.spyOn(dashboardHook, 'useStudioDashboard').mockReturnValue({
      ...mockHookDefault,
      error: 'Không thể tải dữ liệu từ máy chủ',
      refetchJobs,
    });

    render(<StudioPage />);

    expect(screen.getByText('Không thể tải dữ liệu từ máy chủ')).toBeInTheDocument();
    const retryBtn = screen.getByTestId('dashboard-retry-btn');
    fireEvent.click(retryBtn);
    expect(refetchJobs).toHaveBeenCalledTimes(1);
  });
});
