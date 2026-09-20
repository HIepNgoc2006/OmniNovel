import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NovelReviewStudio } from '../components/studio/novel-review-studio';
import * as translationApi from '../lib/api/translation';
import * as authContext from '../lib/auth/auth-context';
import {
  TranslationJobStatus,
  MediaFormat,
  TranslationSegmentDto,
  TranslationJobReviewDetailResponse,
} from '@omninovel/shared';

describe('NovelReviewStudio Component (#150 Tasks 6 & 7)', () => {
  const mockJobId = 'job-novel-999';

  const createMockJobDetail = (
    status: TranslationJobStatus = TranslationJobStatus.READY_FOR_REVIEW,
    mediaFormat: MediaFormat = MediaFormat.NOVEL,
  ): TranslationJobReviewDetailResponse => ({
    job: {
      id: mockJobId,
      status,
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
        title: 'Chúa Tể Bóng Tối (Novel)',
        slug: 'chua-te-bong-toi-novel',
        mediaFormat,
      },
      edition: {
        id: 'e1',
        editionName: 'Bản Dịch Chính Thức',
        language: 'vi',
        isDefault: true,
      },
      chapter: { id: 'c1', chapterNumber: '1.00', title: 'Khởi đầu' },
      project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
      sourceVersion: { id: 'v1', versionNumber: 1 },
      targetVersion: null,
    },
    reviewSummary: {
      segmentCount: 2,
      verifiedCount: 1,
      pageCount: null,
      resultPageCount: null,
      blockCount: 1,
    },
    permissions: {
      canApply: false,
    },
  });

  const mockSegments: TranslationSegmentDto[] = [
    {
      id: 'seg-1',
      jobId: mockJobId,
      pageNumber: null,
      anchorBlockId: 'block-1',
      sortOrder: 1,
      bboxX: null,
      bboxY: null,
      bboxW: null,
      bboxH: null,
      rawText: 'Ngươi có phải ⟦S:0001⟧Chúa tể⟦/S:0001⟧ không?',
      translatedText: 'Are you ⟦S:0001⟧the Lord⟦/S:0001⟧?',
      confidence: 0.99,
      isHumanVerified: true,
      version: 1,
    },
    {
      id: 'seg-2',
      jobId: mockJobId,
      pageNumber: null,
      anchorBlockId: 'block-1',
      sortOrder: 2,
      bboxX: null,
      bboxY: null,
      bboxW: null,
      bboxH: null,
      rawText: 'Đúng vậy, ta là ⟦S:0002⟧Shadow⟦/S:0002⟧.',
      translatedText: 'Yes, I am ⟦S:0002⟧Shadow⟦/S:0002⟧.',
      confidence: 0.98,
      isHumanVerified: false,
      version: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'u1',
        username: 'editor',
        email: 'editor@omninovel.com',
        role: 'TRANSLATOR',
      },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refetchUser: vi.fn(),
    });

    vi.spyOn(translationApi, 'fetchTranslationJobSegments').mockResolvedValue({
      data: mockSegments,
      pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
      workspaceRevision: 1,
    });
  });

  it('1. renders PIPELINE_MONITOR view when job status is TRANSLATING', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.TRANSLATING);
    detail.job.progressPercentage = 45;

    render(
      <NovelReviewStudio jobId={mockJobId} initialJobDetail={detail} />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('novel-studio-pipeline-monitor'),
      ).toBeInTheDocument();
      expect(screen.getByText('45%')).toBeInTheDocument();
      expect(screen.getByText('TRANSLATING')).toBeInTheDocument();
    });
  });

  it('2. renders TERMINAL_STATE view when job status is FAILED', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.FAILED);

    render(
      <NovelReviewStudio jobId={mockJobId} initialJobDetail={detail} />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('novel-studio-terminal-state'),
      ).toBeInTheDocument();
      expect(screen.getByText('FAILED')).toBeInTheDocument();
      expect(screen.getByText('Tác vụ đã kết thúc')).toBeInTheDocument();
    });
  });

  it('3. renders APPLIED view with read-only banner and prohibits edits', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.APPLIED);

    render(
      <NovelReviewStudio jobId={mockJobId} initialJobDetail={detail} />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('novel-studio-applied-banner'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Bản dịch đã được áp dụng/i),
      ).toBeInTheDocument();
    });

    // Invariant: Save and Textarea are disabled in APPLIED mode
    const textareas = screen.getAllByRole('textbox');
    textareas.forEach((ta) => {
      expect(ta).toBeDisabled();
    });
  });

  it('4. renders REVIEWABLE workspace with header, progress bar, and block segments', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.READY_FOR_REVIEW);

    render(
      <NovelReviewStudio jobId={mockJobId} initialJobDetail={detail} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Chúa Tể Bóng Tối (Novel)')).toBeInTheDocument();
      expect(screen.getByTestId('novel-studio-progress-counter')).toHaveTextContent(
        '1 / 2 đã duyệt',
      );
      expect(screen.getByTestId('novel-block-block-1')).toBeInTheDocument();
      expect(screen.getByTestId('novel-segment-container-seg-1')).toBeInTheDocument();
      expect(screen.getByTestId('novel-segment-container-seg-2')).toBeInTheDocument();
    });
  });

  it('5. triggers bulk navigation and glossary slot', async () => {
    const detail = createMockJobDetail(TranslationJobStatus.READY_FOR_REVIEW);
    const onOpenGlossary = vi.fn();

    render(
      <NovelReviewStudio
        jobId={mockJobId}
        initialJobDetail={detail}
        onOpenGlossary={onOpenGlossary}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('novel-studio-glossary-btn'),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('novel-studio-glossary-btn'));
    expect(onOpenGlossary).toHaveBeenCalledTimes(1);

    // Click next unverified button
    const unverifiedBtn = screen.getByTestId('novel-nav-next-unverified-btn');
    expect(unverifiedBtn).toBeEnabled();
    fireEvent.click(unverifiedBtn);

    // Alt+ArrowDown keyboard navigation
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
  });
});
