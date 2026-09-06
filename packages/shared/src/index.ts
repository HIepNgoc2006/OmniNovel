// ==========================================
// OMNINOVEL SHARED ENUMS & CONTRACTS
// ==========================================

export enum GlobalRole {
  ADMIN = 'ADMIN',
  TRANSLATOR = 'TRANSLATOR',
  READER = 'READER',
}

export enum StoryMemberRole {
  OWNER = 'OWNER',
  EDITOR = 'EDITOR',
  TRANSLATOR = 'TRANSLATOR',
  UPLOADER = 'UPLOADER',
}

export enum MediaFormat {
  COMIC = 'COMIC',
  NOVEL = 'NOVEL',
}

export enum PublicationFormat {
  MANGA = 'MANGA',
  MANHWA = 'MANHWA',
  MANHUA = 'MANHUA',
  WEBTOON = 'WEBTOON',
  LIGHT_NOVEL = 'LIGHT_NOVEL',
  WEB_NOVEL = 'WEB_NOVEL',
}

export enum StoryStatus {
  ONGOING = 'ONGOING',
  COMPLETED = 'COMPLETED',
  HIATUS = 'HIATUS',
  CANCELLED = 'CANCELLED',
}

export enum StoryVisibility {
  PUBLIC = 'PUBLIC',
  UNLISTED = 'UNLISTED',
  PRIVATE = 'PRIVATE',
}

export enum ChapterVersionType {
  RAW_ORIGINAL = 'RAW_ORIGINAL',
  AI_TRANSLATED = 'AI_TRANSLATED',
  HUMAN_EDITED = 'HUMAN_EDITED',
  COMMUNITY_FAN = 'COMMUNITY_FAN',
}

export enum MediaAssetType {
  MANGA_PAGE = 'MANGA_PAGE',
  NOVEL_HTML = 'NOVEL_HTML',
  ILLUSTRATION = 'ILLUSTRATION',
}

export enum TranslationJobStatus {
  CREATED = 'CREATED',
  VALIDATING = 'VALIDATING',
  QUEUED = 'QUEUED',
  PREPROCESSING = 'PREPROCESSING',
  OCR = 'OCR',
  TRANSLATING = 'TRANSLATING',
  INPAINTING = 'INPAINTING',
  TYPESETTING = 'TYPESETTING',
  QUALITY_CHECK = 'QUALITY_CHECK',
  READY_FOR_REVIEW = 'READY_FOR_REVIEW',
  APPLIED = 'APPLIED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
}

export enum RewardType {
  EXP = 'EXP',
  OMNICOIN = 'OMNICOIN',
}

export enum RewardSourceType {
  CHECKIN = 'CHECKIN',
  READ_CHAPTER = 'READ_CHAPTER',
  LEVEL_REWARD = 'LEVEL_REWARD',
  MISSION_DAILY = 'MISSION_DAILY',
  ADMIN_ADJUSTMENT = 'ADMIN_ADJUSTMENT',
}

export interface UserProgressionResponse {
  userId?: string;
  level: number;
  totalExp: number | string;
  currentLevelExp: number;
  nextLevelExp: number;
  omnicoinBalance: number;
  streak: number;
  currentStreak?: number;
  maxStreak?: number;
  lastCheckinDate?: string | null;
  hasCheckedInToday?: boolean;
  rankTitle: string;
}

export interface GenreSummary {
  id: number;
  name: string;
  slug: string;
}

export interface LatestChapterSummary {
  id: string;
  chapterNumber: number | string;
  title: string | null;
  createdAt: string | Date;
}

export interface FindStoriesQuery {
  page?: number;
  limit?: number;
  format?: MediaFormat;
  genre?: string;
  status?: StoryStatus;
  q?: string;
  search?: string;
  sort?: 'LATEST' | 'VIEWS' | 'POPULAR';
}

export interface SetBookmarkDto {
  storyId: string;
  isBookmarked: boolean;
}

export interface BookmarkStatusResponse {
  isBookmarked: boolean;
  followersCount?: number;
}

export enum ReadingMode {
  WEBTOON = 'WEBTOON',
  PAGED = 'PAGED',
  NOVEL = 'NOVEL',
}

export interface ChapterNavigationItem {
  id: string;
  chapterNumber: number | string;
  title: string | null;
}

export interface ChapterVersionSummary {
  id: string;
  versionNumber: number;
  versionType: ChapterVersionType;
  language: string;
  isPublished: boolean;
  createdAt: string | Date;
}

export interface MediaAssetSummary {
  id: string;
  sortOrder: number;
  assetType: MediaAssetType;
  storageKey: string;
  width: number | null;
  height: number | null;
}

export interface ChapterDetailResponse {
  story: {
    id: string;
    slug: string;
    title: string;
    mediaFormat: MediaFormat;
    visibility: StoryVisibility;
  };
  chapter: {
    id: string;
    storyEditionId: string;
    chapterNumber: number | string;
    title: string | null;
    activeVersionId: string | null;
    viewsCount?: number | string;
  };
  activeVersion: ChapterVersionSummary | null;
  availableVersions: ChapterVersionSummary[];
  mediaAssets: MediaAssetSummary[];
  pages?: MediaAssetSummary[];
  navigation: {
    previous: ChapterNavigationItem | null;
    next: ChapterNavigationItem | null;
  };
}

export interface ServerResumeState {
  chapterId: string | null;
  chapterVersionId?: string | null;
  readingMode?: ReadingMode | string;
  scrollPosition: number;
  progressPercentage: number;
}

export interface UpdateReadingProgressDto {
  chapterId: string;
  chapterVersionId?: string;
  readingMode?: ReadingMode | string;
  progressPercentage: number;
  scrollPosition: number;
  storyId?: string;
}

export interface ReadingProgressResponse {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode: ReadingMode | string;
  progressPercentage: number;
  scrollPosition: number;
  updatedAt: string | Date;
  readChapterIds?: string[];
}

export interface ChapterReadStateSummary {
  chapterId: string;
  maxProgressPercentage: number;
  completedAt: string | Date | null;
  lastReadAt: string | Date;
}

export type ReadChapterRewardReason =
  | 'ALREADY_REWARDED'
  | 'DAILY_CAP_REACHED'
  | 'CRITERIA_NOT_MET';

export interface ReadChapterRewardRequest {
  chapterId: string;
  readingDurationSeconds: number;
  progressPercentage: number;
}

export interface ReadChapterRewardResponse {
  success: boolean;
  earnedExp: number;
  reason?: ReadChapterRewardReason;
  message?: string;
  totalExp?: string | number;
  level?: number;
  todayTotalReadExp?: number;
  dailyCap?: number;
}

export interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    timestamp: string;
    details?: Array<{ field: string; issue: string }>;
  };
}

// ==========================================
// PHASE 4D: AI TRANSLATION STUDIO & REVIEW CONTRACTS
// ==========================================

export type IsoDateString = string;

export interface ManagedStorySummaryDto {
  id: string;
  title: string;
  slug: string;
  mediaFormat: MediaFormat;
  publicationFormat: PublicationFormat;
  originCountry: string;
  originalLanguage: string;
  coverUrl: string | null;
  status: StoryStatus;
  visibility: StoryVisibility;
  summary: string | null;
  viewsCount: string;
  followersCount?: number;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export enum NovelBlockType {
  HEADING = 'HEADING',
  DIALOGUE = 'DIALOGUE',
  NARRATION = 'NARRATION',
  BLOCKQUOTE = 'BLOCKQUOTE',
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface TranslationProjectSummaryDto {
  id: string;
  storyId: string;
  storyEditionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: IsoDateString;
  latestJob?: {
    id: string;
    status: TranslationJobStatus;
    progressPercentage: number;
  };
}

export interface TranslationJobSummaryDto {
  id: string;
  projectId: string;
  storyId: string;
  storyTitle: string;
  storyEditionId: string;
  editionName: string;
  chapterId: string;
  chapterNumber: string;
  chapterTitle: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  status: TranslationJobStatus;
  progressPercentage: number;
  provider: string;
  modelName: string;
  createdAt: IsoDateString;
  startedAt: IsoDateString | null;
  completedAt: IsoDateString | null;
}

export interface ReviewSummaryDto {
  segmentCount: number;
  verifiedCount: number;
  pageCount: number | null;
  blockCount: number | null;
}

export interface TranslationJobReviewDetailResponse {
  job: {
    id: string;
    status: TranslationJobStatus;
    progressPercentage: number;
    provider: string;
    modelName: string;
    promptVersion: string;
    attemptCount: number;
    maxAttempts: number;
    createdAt: IsoDateString;
    startedAt: IsoDateString | null;
    heartbeatAt: IsoDateString | null;
    completedAt: IsoDateString | null;
    expiresAt: IsoDateString | null;
    reviewRevision: number;
    materializedRevision: number;
  };
  context: {
    story: {
      id: string;
      title: string;
      slug: string;
      mediaFormat: MediaFormat;
    };
    edition: {
      id: string;
      editionName: string;
      language: string;
      isDefault: boolean;
    };
    chapter: {
      id: string;
      chapterNumber: string;
      title: string | null;
    };
    project: {
      id: string;
      sourceLanguage: string;
      targetLanguage: string;
    };
    sourceVersion: { id: string; versionNumber: number };
    targetVersion: { id: string; versionNumber: number } | null;
  };
  reviewSummary: ReviewSummaryDto;
  glossarySnapshot?: Array<{
    sourceTerm: string;
    targetTerm: string;
    category: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
}

export interface TranslationSegmentDto {
  id: string;
  jobId: string;
  pageNumber: number | null;
  anchorBlockId: string | null;
  sortOrder: number;
  bboxX: number | null;
  bboxY: number | null;
  bboxW: number | null;
  bboxH: number | null;
  rawText: string;
  translatedText: string | null;
  confidence: number | null;
  isHumanVerified: boolean;
  blockType?: NovelBlockType | null;
  version: number;
  createdAt?: IsoDateString;
}

export interface UpdateTranslationSegmentRequest {
  translatedText?: string;
  isHumanVerified?: boolean;
  expectedVersion: number;
}

export * from './validators/protected-anchor';
export * from './manifests/translation-manifests';
export * from './manifests/materialization-contracts';

export type ReviewAssetDto =
  | {
      kind: 'SOURCE_MEDIA';
      id: string;
      pageNumber: number;
      width: number | null;
      height: number | null;
      url: string;
    }
  | {
      kind: 'SOURCE_REVIEW';
      pageNumber: number;
      width: number | null;
      height: number | null;
      url: string;
    }
  | {
      kind: 'RESULT';
      pageNumber: number;
      width: number | null;
      height: number | null;
      fileSizeBytes?: number;
      url: string;
    };
