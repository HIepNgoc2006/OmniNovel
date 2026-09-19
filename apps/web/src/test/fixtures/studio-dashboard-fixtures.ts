import {
  ManagedStorySummaryDto,
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  TranslationJobStatus,
  TranslationJobSummaryDto,
  TranslationProjectSummaryDto,
} from '@omninovel/shared';

export const dashboardManagedStories: ManagedStorySummaryDto[] = [
  {
    id: 'story-manga-1',
    title: 'Manga Dashboard Fixture',
    slug: 'manga-dashboard-fixture',
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
  {
    id: 'story-novel-1',
    title: 'Novel Dashboard Fixture',
    slug: 'novel-dashboard-fixture',
    mediaFormat: MediaFormat.NOVEL,
    publicationFormat: PublicationFormat.LIGHT_NOVEL,
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

export const dashboardProjects: TranslationProjectSummaryDto[] = [
  {
    id: 'project-manga-1',
    storyId: 'story-manga-1',
    storyEditionId: 'edition-manga-1',
    sourceLanguage: 'ja',
    targetLanguage: 'vi',
    createdAt: '2026-09-20T00:00:00.000Z',
    latestJob: {
      id: 'job-ready-1',
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
    },
  },
];

const jobBase = {
  projectId: 'project-manga-1',
  storyId: 'story-manga-1',
  storyTitle: 'Manga Dashboard Fixture',
  storySlug: 'manga-dashboard-fixture',
  mediaFormat: MediaFormat.COMIC,
  storyEditionId: 'edition-manga-1',
  editionName: 'Bản Tiếng Việt',
  chapterId: 'chapter-1',
  chapterNumber: '1.00',
  chapterTitle: 'Chapter 1',
  sourceLanguage: 'ja',
  targetLanguage: 'vi',
  provider: 'OPENAI',
  modelName: 'gpt-4o-mini',
  createdAt: '2026-09-20T00:00:00.000Z',
  startedAt: '2026-09-20T00:01:00.000Z',
  heartbeatAt: '2026-09-20T00:02:00.000Z',
  completedAt: null,
} satisfies Omit<
  TranslationJobSummaryDto,
  'id' | 'status' | 'progressPercentage'
>;

export const dashboardJobs: TranslationJobSummaryDto[] = [
  {
    ...jobBase,
    id: 'job-queued-1',
    status: TranslationJobStatus.QUEUED,
    progressPercentage: 5,
  },
  {
    ...jobBase,
    id: 'job-translating-1',
    status: TranslationJobStatus.TRANSLATING,
    progressPercentage: 55,
  },
  {
    ...jobBase,
    id: 'job-ready-1',
    status: TranslationJobStatus.READY_FOR_REVIEW,
    progressPercentage: 100,
  },
  {
    ...jobBase,
    id: 'job-applied-1',
    status: TranslationJobStatus.APPLIED,
    progressPercentage: 100,
    completedAt: '2026-09-20T00:10:00.000Z',
  },
  {
    ...jobBase,
    id: 'job-failed-1',
    status: TranslationJobStatus.FAILED,
    progressPercentage: 60,
    completedAt: '2026-09-20T00:08:00.000Z',
  },
];
