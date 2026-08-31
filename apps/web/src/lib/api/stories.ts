import { apiClient } from './client';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  ChapterVersionType,
  LatestChapterSummary,
  SetBookmarkDto,
  BookmarkStatusResponse,
  UpdateReadingProgressDto,
  ReadingProgressResponse,
} from '@omninovel/shared';

export type {
  LatestChapterSummary,
  SetBookmarkDto,
  BookmarkStatusResponse,
  UpdateReadingProgressDto,
  ReadingProgressResponse,
};

export interface GenreItem {
  id: number;
  name: string;
  slug: string;
  description?: string;
}

export interface ChapterVersionItem {
  id: string;
  versionNumber: number;
  versionType: ChapterVersionType;
  isPublished: boolean;
  translatedBy?: string;
  rawAssetKey?: string;
  renderedAssetKey?: string;
  htmlKey?: string;
  createdAt: string;
}

export interface ChapterItem {
  id: string;
  storyEditionId: string;
  volumeId?: string | null;
  chapterNumber: string | number;
  title?: string | null;
  activeVersionId?: string | null;
  viewsCount?: string | number;
  createdAt: string;
  activeVersion?: ChapterVersionItem | null;
}

export interface VolumeItem {
  id: string;
  storyEditionId: string;
  volumeNumber: number;
  title: string;
  chapters?: ChapterItem[];
}

export interface StoryEditionItem {
  id: string;
  storyId: string;
  editionName: string;
  language: string;
  isDefault: boolean;
  volumes?: VolumeItem[];
  chapters?: ChapterItem[];
}

export interface Story {
  id: string;
  title: string;
  slug: string;
  mediaFormat: MediaFormat;
  publicationFormat: PublicationFormat;
  originCountry?: string;
  originalLanguage?: string;
  coverUrl: string;
  coverImageUrl?: string;
  status: StoryStatus;
  visibility: StoryVisibility;
  summary?: string | null;
  synopsis?: string | null;
  createdBy?: string | null;
  viewsCount: string | number;
  viewCount?: number;
  followersCount: number;
  favoriteCount?: number;
  createdAt: string;
  updatedAt: string;
  genres?: GenreItem[];
  latestChapter?: LatestChapterSummary | null;
  editions?: StoryEditionItem[];
}

export interface StoryPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface StoryListResponse {
  data: Story[];
  pagination: StoryPagination;
  meta?: StoryPagination;
}

export interface FeaturedStoriesResponse {
  hotStories: Story[];
  banners: Story[];
}

export interface RankingsResponse {
  topComics: Story[];
  topNovels: Story[];
}

export interface StoryComment {
  id: string;
  userId: string;
  username: string;
  userAvatar?: string | null;
  userRole?: string;
  userLevel?: number;
  rankTitle?: string;
  content: string;
  rating?: number;
  likesCount: number;
  isLiked?: boolean;
  createdAt: string;
  replies?: StoryComment[];
}

export interface GetStoriesParams {
  page?: number;
  limit?: number;
  format?: MediaFormat;
  mediaFormat?: MediaFormat;
  genre?: string;
  status?: StoryStatus;
  sort?: 'LATEST' | 'VIEWS' | 'POPULAR';
  search?: string;
  q?: string;
}

export async function getStoriesApi(params?: GetStoriesParams): Promise<StoryListResponse> {
  const queryParams: Record<string, any> = {};
  if (params?.page) queryParams.page = params.page;
  if (params?.limit) queryParams.limit = params.limit;
  if (params?.format) queryParams.format = params.format;
  if (params?.mediaFormat) queryParams.format = params.mediaFormat;
  if (params?.genre) queryParams.genre = params.genre;
  if (params?.status) queryParams.status = params.status;
  if (params?.sort) queryParams.sort = params.sort;
  if (params?.q) queryParams.q = params.q;
  if (params?.search) queryParams.search = params.search;

  const response = await apiClient.get<StoryListResponse>('/stories', { params: queryParams });
  const data = response.data;
  
  const pagination = data.pagination || data.meta || {
    page: params?.page || 1,
    limit: params?.limit || 20,
    total: data.data?.length || 0,
    totalPages: 1,
  };

  return {
    data: data.data || [],
    pagination,
    meta: pagination,
  };
}

export async function getFeaturedStoriesApi(): Promise<FeaturedStoriesResponse> {
  const response = await apiClient.get<FeaturedStoriesResponse>('/stories/featured');
  return response.data;
}

export async function getStoryRankingsApi(): Promise<RankingsResponse> {
  const response = await apiClient.get<RankingsResponse>('/stories/rankings');
  return response.data;
}

export async function getStoryBySlugApi(slug: string): Promise<Story> {
  const response = await apiClient.get<Story>(`/stories/${slug}`);
  return response.data;
}

export async function setBookmarkApi(dto: SetBookmarkDto): Promise<BookmarkStatusResponse> {
  const response = await apiClient.post<BookmarkStatusResponse>('/library/bookmarks', dto);
  return response.data;
}

export async function getBookmarkStatusApi(storyId: string): Promise<BookmarkStatusResponse> {
  const response = await apiClient.get<BookmarkStatusResponse>(`/library/bookmarks/${storyId}`);
  return response.data;
}

export async function saveReadingProgressApi(
  dto: UpdateReadingProgressDto,
): Promise<ReadingProgressResponse> {
  const response = await apiClient.put<ReadingProgressResponse>('/library/reading-progress', dto);
  return response.data;
}

export async function getReadingProgressApi(
  storyId: string,
): Promise<ReadingProgressResponse> {
  const response = await apiClient.get<ReadingProgressResponse>(`/library/reading-progress/${storyId}`);
  return response.data;
}

