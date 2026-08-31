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


