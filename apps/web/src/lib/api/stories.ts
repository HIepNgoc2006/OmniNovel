import { apiClient } from './client';
import { MediaFormat, PublicationFormat, StoryStatus } from '@omninovel/shared';

export interface StoryListItem {
  id: string;
  title: string;
  originalTitle?: string;
  slug: string;
  coverImageUrl?: string;
  synopsis?: string;
  mediaFormat: MediaFormat;
  publicationFormat: PublicationFormat;
  status: StoryStatus;
  viewCount: number;
  ratingAverage: number;
  ratingCount: number;
  favoriteCount: number;
  latestChapterNumber?: number;
  updatedAt: string;
}

export interface StoryListResponse {
  data: StoryListItem[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export async function getStoriesApi(params?: {
  page?: number;
  limit?: number;
  mediaFormat?: MediaFormat;
  status?: StoryStatus;
  search?: string;
}): Promise<StoryListResponse> {
  const response = await apiClient.get<StoryListResponse>('/stories', { params });
  return response.data;
}

export async function getStoryBySlugApi(slug: string): Promise<StoryListItem> {
  const response = await apiClient.get<StoryListItem>(`/stories/${slug}`);
  return response.data;
}
