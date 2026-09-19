import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TranslationJobStatus,
  MediaFormat,
  ManagedStorySummaryDto,
  TranslationProjectSummaryDto,
  TranslationJobSummaryDto,
} from '@omninovel/shared';
import { StudioMetricsCards } from '../components/studio/dashboard/studio-metrics-cards';
import { StudioStorySelector } from '../components/studio/dashboard/studio-story-selector';
import { StudioJobFilterBar } from '../components/studio/dashboard/studio-job-filter-bar';
import { StudioJobCard } from '../components/studio/dashboard/studio-job-card';

describe('Studio Dashboard Sub-Components (#145 Task 4)', () => {
  const sampleJobActive: TranslationJobSummaryDto = {
    id: 'job-active-1',
    projectId: 'proj-1',
    storyId: 'story-1',
    storyTitle: 'Solo Leveling',
    storySlug: 'solo-leveling',
    mediaFormat: MediaFormat.COMIC,
    storyEditionId: 'edition-1',
    editionName: 'Bản Dịch Tiếng Việt',
    chapterId: 'chap-10',
    chapterNumber: '10.00',
    chapterTitle: 'Thức tỉnh Hạng E',
    sourceLanguage: 'ko',
    targetLanguage: 'vi',
    status: TranslationJobStatus.TRANSLATING,
    progressPercentage: 65,
    provider: 'OPENAI',
    modelName: 'gpt-4o',
    createdAt: '2026-09-01T10:00:00Z',
    startedAt: '2026-09-01T10:01:00Z',
    completedAt: null,
    heartbeatAt: '2026-09-01T10:04:00Z',
  };

  const sampleJobReviewComic: TranslationJobSummaryDto = {
    id: 'job-review-comic',
    projectId: 'proj-1',
    storyId: 'story-1',
    storyTitle: 'Solo Leveling',
    storySlug: 'solo-leveling',
    mediaFormat: MediaFormat.COMIC,
    storyEditionId: 'edition-1',
    editionName: 'Bản Dịch Tiếng Việt',
    chapterId: 'chap-11',
    chapterNumber: '11.00',
    chapterTitle: 'Hầm ngục kép',
    sourceLanguage: 'ko',
    targetLanguage: 'vi',
    status: TranslationJobStatus.READY_FOR_REVIEW,
    progressPercentage: 100,
    provider: 'OPENAI',
    modelName: 'gpt-4o',
    createdAt: '2026-09-01T11:00:00Z',
    startedAt: '2026-09-01T11:01:00Z',
    completedAt: '2026-09-01T11:06:00Z',
    heartbeatAt: null,
  };

  const sampleJobReviewNovel: TranslationJobSummaryDto = {
    id: 'job-review-novel',
    projectId: 'proj-2',
    storyId: 'story-2',
    storyTitle: 'Toàn Trí Độc Giả',
    storySlug: 'toan-tri-doc-gia',
    mediaFormat: MediaFormat.NOVEL,
    storyEditionId: 'edition-2',
    editionName: 'Web Novel Edition',
    chapterId: 'chap-20',
    chapterNumber: '20.00',
    chapterTitle: 'Ba điều ước',
    sourceLanguage: 'ko',
    targetLanguage: 'vi',
    status: TranslationJobStatus.READY_FOR_REVIEW,
    progressPercentage: 100,
    provider: 'OPENAI',
    modelName: 'gpt-4o',
    createdAt: '2026-09-01T12:00:00Z',
    startedAt: '2026-09-01T12:01:00Z',
    completedAt: '2026-09-01T12:05:00Z',
    heartbeatAt: null,
  };

  const sampleJobApplied: TranslationJobSummaryDto = {
    ...sampleJobActive,
    id: 'job-applied-1',
    status: TranslationJobStatus.APPLIED,
    progressPercentage: 100,
  };

  const sampleJobFailed: TranslationJobSummaryDto = {
    ...sampleJobActive,
    id: 'job-failed-1',
    status: TranslationJobStatus.FAILED,
    progressPercentage: 30,
  };

  const sampleStories: ManagedStorySummaryDto[] = [
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
    {
      id: 'story-2',
      title: 'Toàn Trí Độc Giả',
      slug: 'toan-tri-doc-gia',
      mediaFormat: MediaFormat.NOVEL,
      publicationFormat: 'WEB_NOVEL' as any,
      originCountry: 'KR',
      originalLanguage: 'ko',
      coverUrl: null,
      status: 'ONGOING' as any,
      visibility: 'PUBLIC' as any,
      summary: null,
      viewsCount: '3000',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  describe('StudioMetricsCards', () => {
    it('calculates counts correctly and triggers onSelectGroup', () => {
      const onSelectGroup = vi.fn();
      const allJobs = [
        sampleJobActive,
        sampleJobReviewComic,
        sampleJobReviewNovel,
        sampleJobApplied,
        sampleJobFailed,
      ];

      render(
        <StudioMetricsCards
          jobs={allJobs}
          currentGroup="ALL"
          onSelectGroup={onSelectGroup}
        />,
      );

      // Verify active, review, applied, problem counts
      expect(screen.getByTestId('metric-card-ACTIVE')).toHaveTextContent('1');
      expect(screen.getByTestId('metric-card-REVIEW')).toHaveTextContent('2');
      expect(screen.getByTestId('metric-card-APPLIED')).toHaveTextContent('1');
      expect(screen.getByTestId('metric-card-PROBLEM')).toHaveTextContent('1');

      // Click on REVIEW card
      fireEvent.click(screen.getByTestId('metric-card-REVIEW'));
      expect(onSelectGroup).toHaveBeenCalledWith('REVIEW');
    });
  });

  describe('StudioStorySelector', () => {
    it('renders stories list and allows selection', () => {
      const onSelectStory = vi.fn();
      render(
        <StudioStorySelector
          stories={sampleStories}
          selectedStoryId={null}
          onSelectStory={onSelectStory}
        />,
      );

      expect(screen.getByText('Tất cả tác phẩm')).toBeInTheDocument();
      expect(screen.getByText(/Solo Leveling/)).toBeInTheDocument();
      expect(screen.getByText(/Toàn Trí Độc Giả/)).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('studio-story-select'), {
        target: { value: 'story-1' },
      });
      expect(onSelectStory).toHaveBeenCalledWith('story-1');
    });
  });

  describe('StudioJobFilterBar', () => {
    it('renders all canonical filter groups and search input', () => {
      const onSelectGroup = vi.fn();
      const onSearchChange = vi.fn();

      render(
        <StudioJobFilterBar
          currentGroup="ACTIVE"
          searchKeyword=""
          onSelectGroup={onSelectGroup}
          onSearchChange={onSearchChange}
        />,
      );

      expect(screen.getByTestId('filter-pill-ALL')).toBeInTheDocument();
      expect(screen.getByTestId('filter-pill-ACTIVE')).toHaveAttribute(
        'data-active',
        'true',
      );
      expect(screen.getByTestId('filter-pill-REVIEW')).toBeInTheDocument();
      expect(screen.getByTestId('filter-pill-APPLIED')).toBeInTheDocument();
      expect(screen.getByTestId('filter-pill-PROBLEM')).toBeInTheDocument();

      // Click REVIEW
      fireEvent.click(screen.getByTestId('filter-pill-REVIEW'));
      expect(onSelectGroup).toHaveBeenCalledWith('REVIEW');

      // Typing search
      const input = screen.getByTestId('studio-search-input');
      fireEvent.change(input, { target: { value: 'Chương 10' } });
      expect(onSearchChange).toHaveBeenCalledWith('Chương 10');
    });
  });

  describe('StudioJobCard', () => {
    it('renders job info, progress, and comic review link for READY_FOR_REVIEW comic', () => {
      render(<StudioJobCard job={sampleJobReviewComic} />);

      expect(screen.getByText('Solo Leveling')).toBeInTheDocument();
      expect(screen.getByText(/Chương 11\.00/)).toBeInTheDocument();
      expect(screen.getByText(/Hầm ngục kép/)).toBeInTheDocument();
      expect(screen.getByText(/100%/)).toBeInTheDocument();

      const cta = screen.getByTestId('job-cta-button');
      expect(cta).toHaveAttribute('href', '/studio/manga?jobId=job-review-comic');
      expect(cta).toHaveTextContent(/Duyệt bản dịch/i);
    });

    it('renders novel review link for READY_FOR_REVIEW novel', () => {
      render(<StudioJobCard job={sampleJobReviewNovel} />);

      expect(screen.getByText('Toàn Trí Độc Giả')).toBeInTheDocument();
      const cta = screen.getByTestId('job-cta-button');
      expect(cta).toHaveAttribute('href', '/studio/novel?jobId=job-review-novel');
    });

    it('renders active progress indicator and heartbeat for TRANSLATING job', () => {
      render(<StudioJobCard job={sampleJobActive} />);

      expect(screen.getByText(/65%/)).toBeInTheDocument();
      expect(screen.getByTestId('job-status-badge')).toHaveTextContent(/Đang dịch/i);
    });
  });
});
