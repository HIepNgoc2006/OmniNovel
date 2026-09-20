import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChapterVersionType,
  ManagedStorySummaryDto,
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  StudioChapterVersionSummaryDto,
  TranslationJobStatus,
} from '@omninovel/shared';
import { useCreateTranslationJob } from '../lib/studio/use-create-translation-job';
import * as translationApi from '../lib/api/translation';
import * as storiesApi from '../lib/api/stories';
import { useRouter } from 'next/navigation';

vi.mock('../lib/api/translation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/translation')>();
  return {
    ...actual,
    fetchManagedStories: vi.fn(),
    fetchStudioChapterVersions: vi.fn(),
    createTranslationJobApi: vi.fn(),
  };
});

vi.mock('../lib/api/stories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api/stories')>();
  return {
    ...actual,
    getStoryBySlugApi: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

describe('useCreateTranslationJob (#146 Task 3)', () => {
  const push = vi.fn();

  const managedStories: ManagedStorySummaryDto[] = [
    {
      id: 'story-1',
      title: 'One Piece',
      slug: 'one-piece',
      mediaFormat: MediaFormat.COMIC,
      publicationFormat: PublicationFormat.MANGA,
      originCountry: 'JP',
      originalLanguage: 'ja',
      coverUrl: null,
      status: StoryStatus.ONGOING,
      visibility: StoryVisibility.PRIVATE,
      summary: null,
      viewsCount: '0',
      followersCount: 0,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  ];

  const storyDetail: storiesApi.Story = {
    id: 'story-1',
    title: 'One Piece',
    slug: 'one-piece',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: PublicationFormat.MANGA,
    originCountry: 'JP',
    originalLanguage: 'ja',
    coverUrl: '',
    status: StoryStatus.ONGOING,
    visibility: StoryVisibility.PRIVATE,
    viewsCount: '0',
    followersCount: 0,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
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
  };

  const versions: StudioChapterVersionSummaryDto[] = [
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
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push } as any);
    vi.mocked(translationApi.fetchManagedStories).mockResolvedValue({
      data: managedStories,
      pagination: {
        total: 1,
        page: 1,
        limit: 100,
        totalPages: 1,
      },
    });
    vi.mocked(storiesApi.getStoryBySlugApi).mockResolvedValue(storyDetail);
    vi.mocked(translationApi.fetchStudioChapterVersions).mockResolvedValue(
      versions,
    );
    vi.mocked(translationApi.createTranslationJobApi).mockResolvedValue({
      jobId: 'job-new-1',
      status: TranslationJobStatus.QUEUED,
      isDuplicate: false,
    });
  });

  async function prepareValidForm() {
    const rendered = renderHook(() => useCreateTranslationJob());

    await waitFor(() => {
      expect(rendered.result.current.isLoadingStories).toBe(false);
    });

    await act(async () => {
      await rendered.result.current.selectStory('story-1');
    });

    act(() => {
      rendered.result.current.selectEdition('edition-1');
    });

    await act(async () => {
      await rendered.result.current.selectChapter('chapter-1');
    });

    act(() => {
      rendered.result.current.selectVersion('version-1');
      rendered.result.current.setTargetLang('vi');
      rendered.result.current.setProvider('MOCK');
    });

    return rendered;
  }

  it('loads managed stories, then resolves canonical story hierarchy by slug and chapter versions', async () => {
    const { result } = renderHook(() => useCreateTranslationJob());

    await waitFor(() => {
      expect(result.current.isLoadingStories).toBe(false);
    });

    expect(result.current.stories).toEqual(managedStories);

    await act(async () => {
      await result.current.selectStory('story-1');
    });

    expect(storiesApi.getStoryBySlugApi).toHaveBeenCalledWith('one-piece');
    expect(result.current.storyDetail?.id).toBe('story-1');

    act(() => {
      result.current.selectEdition('edition-1');
    });

    await act(async () => {
      await result.current.selectChapter('chapter-1');
    });

    expect(translationApi.fetchStudioChapterVersions).toHaveBeenCalledWith(
      'chapter-1',
    );
    expect(result.current.chapterVersions).toEqual(versions);
  });

  it('selecting a source version derives sourceLang from the authoritative version', async () => {
    const { result } = await prepareValidForm();

    expect(result.current.selectedVersionId).toBe('version-1');
    expect(result.current.sourceLang).toBe('ja');
    expect(result.current.targetLang).toBe('vi');
    expect(result.current.canSubmit).toBe(true);
  });

  it('uses an in-flight ref to prevent same-tick double submit', async () => {
    let resolveRequest:
      | ((value: {
          jobId: string;
          status: TranslationJobStatus;
          isDuplicate: boolean;
        }) => void)
      | undefined;

    vi.mocked(translationApi.createTranslationJobApi).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const { result } = await prepareValidForm();

    let first: Promise<any>;
    let second: Promise<any>;
    act(() => {
      first = result.current.submit();
      second = result.current.submit();
    });

    expect(translationApi.createTranslationJobApi).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest?.({
        jobId: 'job-new-1',
        status: TranslationJobStatus.QUEUED,
        isDuplicate: false,
      });
      await first!;
      await second!;
    });

    expect(push).toHaveBeenCalledWith('/studio/ai/jobs/job-new-1');
  });

  it('preserves the exact frozen Idempotency-Key across ambiguous retry', async () => {
    vi.mocked(translationApi.createTranslationJobApi)
      .mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ECONNABORTED',
        message: 'timeout of 30000ms exceeded',
        response: null,
      })
      .mockResolvedValueOnce({
        jobId: 'job-replayed-1',
        status: TranslationJobStatus.QUEUED,
        isDuplicate: true,
      });

    const { result } = await prepareValidForm();

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.lifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.current.submissionError?.isAmbiguous).toBe(true);

    const firstKey = vi.mocked(translationApi.createTranslationJobApi).mock
      .calls[0][1];
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await act(async () => {
      await result.current.retry();
    });

    const secondKey = vi.mocked(translationApi.createTranslationJobApi).mock
      .calls[1][1];
    expect(secondKey).toBe(firstKey);
    expect(push).toHaveBeenCalledWith('/studio/ai/jobs/job-replayed-1');
  });

  it('invalidates frozen submission identity when form inputs change after ambiguity', async () => {
    vi.mocked(translationApi.createTranslationJobApi)
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 503,
          data: {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Service unavailable',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        jobId: 'job-new-2',
        status: TranslationJobStatus.QUEUED,
        isDuplicate: false,
      });

    const { result } = await prepareValidForm();

    await act(async () => {
      await result.current.submit();
    });

    const firstKey = vi.mocked(translationApi.createTranslationJobApi).mock
      .calls[0][1];
    expect(result.current.frozenSubmission?.idempotencyKey).toBe(firstKey);

    act(() => {
      result.current.setTargetLang('en');
    });

    expect(result.current.lifecycle).toBe('IDLE');
    expect(result.current.frozenSubmission).toBeNull();

    await act(async () => {
      await result.current.submit();
    });

    const secondKey = vi.mocked(translationApi.createTranslationJobApi).mock
      .calls[1][1];
    expect(secondKey).not.toBe(firstKey);
  });

  it.each([
    ['new job', false],
    ['durable duplicate', true],
  ])('hands off both %s responses to the canonical job route', async (_label, isDuplicate) => {
    vi.mocked(translationApi.createTranslationJobApi).mockResolvedValueOnce({
      jobId: 'job-handoff',
      status: TranslationJobStatus.QUEUED,
      isDuplicate,
    });

    const { result } = await prepareValidForm();

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.lifecycle).toBe('SUCCEEDED');
    expect(push).toHaveBeenCalledWith('/studio/ai/jobs/job-handoff');
  });

  it('supports canonical deep-link initialization by storySlug + chapterId', async () => {
    const { result } = renderHook(() =>
      useCreateTranslationJob({
        initialStorySlug: 'one-piece',
        initialChapterId: 'chapter-1',
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoadingStories).toBe(false);
      expect(result.current.selectedChapterId).toBe('chapter-1');
    });

    expect(result.current.selectedStoryId).toBe('story-1');
    expect(result.current.selectedEditionId).toBe('edition-1');
    expect(result.current.chapterVersions).toEqual(versions);
  });
});
