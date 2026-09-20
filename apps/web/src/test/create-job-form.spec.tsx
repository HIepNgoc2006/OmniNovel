import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterVersionType } from '@omninovel/shared';
import { CreateJobForm } from '../components/studio/job-creation/create-job-form';
import { useCreateTranslationJob } from '../lib/studio/use-create-translation-job';

vi.mock('../lib/studio/use-create-translation-job', () => ({
  useCreateTranslationJob: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function buildHookState(overrides: Record<string, unknown> = {}) {
  return {
    stories: [
      {
        id: 'story-1',
        title: 'One Piece',
        slug: 'one-piece',
        mediaFormat: 'COMIC',
      },
    ],
    storyDetail: {
      id: 'story-1',
      title: 'One Piece',
      slug: 'one-piece',
      editions: [
        {
          id: 'edition-1',
          storyId: 'story-1',
          editionName: 'Raw',
          language: 'ja',
          isDefault: true,
          chapters: [
            {
              id: 'chapter-1',
              storyEditionId: 'edition-1',
              chapterNumber: '1.00',
              title: 'Romance Dawn',
              createdAt: '2026-09-20T00:00:00.000Z',
            },
          ],
        },
      ],
    },
    chapterVersions: [
      {
        id: 'version-1',
        chapterId: 'chapter-1',
        versionNumber: 1,
        versionType: ChapterVersionType.RAW_ORIGINAL,
        language: 'ja',
        isPublished: true,
        sourceVersionId: null,
        createdAt: '2026-09-20T00:00:00.000Z',
      },
    ],
    selectedStoryId: 'story-1',
    selectedEditionId: 'edition-1',
    selectedChapterId: 'chapter-1',
    selectedVersionId: 'version-1',
    sourceLang: 'ja',
    targetLang: 'vi',
    provider: 'MOCK',
    externalConsent: false,
    lifecycle: 'IDLE',
    isSubmitting: false,
    submissionError: null,
    formErrors: {},
    frozenSubmission: null,
    hierarchyError: null,
    isLoadingStories: false,
    isLoadingStoryDetail: false,
    isLoadingVersions: false,
    canSubmit: true,
    selectStory: vi.fn(),
    selectEdition: vi.fn(),
    selectChapter: vi.fn(),
    selectVersion: vi.fn(),
    setSourceLang: vi.fn(),
    setTargetLang: vi.fn(),
    setProvider: vi.fn(),
    setExternalConsent: vi.fn(),
    submit: vi.fn(),
    retry: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

describe('CreateJobForm (#146 Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the complete hierarchy selection flow', () => {
    vi.mocked(useCreateTranslationJob).mockReturnValue(buildHookState() as any);

    render(<CreateJobForm />);

    expect(screen.getByText('Tạo Bản Dịch Mới')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn bộ truyện')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn ấn bản')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn chương')).toBeInTheDocument();
    expect(screen.getByLabelText('Chọn phiên bản nguồn')).toBeInTheDocument();
    expect(screen.getByLabelText('Ngôn ngữ nguồn')).toHaveValue('JA');
  });

  it('shows external-provider disclosure and keeps submit disabled without consent', () => {
    const setExternalConsent = vi.fn();
    vi.mocked(useCreateTranslationJob).mockReturnValue(
      buildHookState({
        provider: 'OPENAI',
        externalConsent: false,
        canSubmit: false,
        formErrors: {
          externalConsent: 'Bạn phải xác nhận consent.',
        },
        setExternalConsent,
      }) as any,
    );

    render(<CreateJobForm />);

    expect(screen.getByTestId('external-provider-consent-card')).toBeInTheDocument();
    expect(screen.getByTestId('job-create-submit')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Đồng ý gửi dữ liệu sang bên thứ ba'));
    expect(setExternalConsent).toHaveBeenCalledWith(true);
  });

  it('hides consent for local provider and allows a valid submit', () => {
    const submit = vi.fn();
    vi.mocked(useCreateTranslationJob).mockReturnValue(
      buildHookState({
        provider: 'MOCK',
        canSubmit: true,
        submit,
      }) as any,
    );

    render(<CreateJobForm />);

    expect(screen.queryByTestId('external-provider-consent-card')).not.toBeInTheDocument();
    const button = screen.getByTestId('job-create-submit');
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('shows ambiguity warning and retries through the frozen logical submission', () => {
    const retry = vi.fn();
    vi.mocked(useCreateTranslationJob).mockReturnValue(
      buildHookState({
        lifecycle: 'SUBMISSION_OUTCOME_UNKNOWN',
        submissionError: {
          code: 'HTTP_ERROR',
          message: 'Kết quả chưa xác định',
          status: 503,
          isAmbiguous: true,
        },
        retry,
      }) as any,
    );

    render(<CreateJobForm />);

    expect(screen.getByTestId('job-create-ambiguity-banner')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Thử lại với cùng Idempotency Key',
      }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
