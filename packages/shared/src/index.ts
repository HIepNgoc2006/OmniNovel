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

export interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    timestamp: string;
    details?: Array<{ field: string; issue: string }>;
  };
}

