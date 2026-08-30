import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getStoriesApi,
  getFeaturedStoriesApi,
  getStoryRankingsApi,
  getStoryBySlugApi,
} from '../lib/api/stories';
import { apiClient } from '../lib/api/client';
import { MediaFormat, StoryStatus, StoryVisibility, PublicationFormat } from '@omninovel/shared';

describe('Story API Client & Normalization (Phase 4B)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockStory = {
    id: 'story-uuid-1',
    title: 'Thám Tử Lừng Danh Conan',
    slug: 'tham-tu-lung-danh-conan',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: PublicationFormat.MANGA,
    coverUrl: 'https://cdn.omninovel.com/covers/conan.jpg',
    status: StoryStatus.ONGOING,
    visibility: StoryVisibility.PUBLIC,
    summary: 'Shinichi Kudo bị teo nhỏ thành Edogawa Conan...',
    viewsCount: 15400,
    followersCount: 320,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };

  it('gọi getStoriesApi với đầy đủ query parameters và chuẩn hóa pagination', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        data: [mockStory],
        pagination: {
          page: 2,
          limit: 10,
          total: 25,
          totalPages: 3,
        },
      },
    });

    const result = await getStoriesApi({
      page: 2,
      limit: 10,
      format: MediaFormat.COMIC,
      search: 'Conan',
      sort: 'VIEWS',
    });

    expect(getSpy).toHaveBeenCalledWith('/stories', {
      params: {
        page: 2,
        limit: 10,
        format: MediaFormat.COMIC,
        search: 'Conan',
        sort: 'VIEWS',
      },
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].title).toBe('Thám Tử Lừng Danh Conan');
    expect(result.pagination.totalPages).toBe(3);
    expect(result.meta).toEqual(result.pagination);
  });

  it('gọi getFeaturedStoriesApi trả về banners và hotStories', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        hotStories: [mockStory],
        banners: [mockStory],
      },
    });

    const result = await getFeaturedStoriesApi();
    expect(getSpy).toHaveBeenCalledWith('/stories/featured');
    expect(result.banners).toHaveLength(1);
    expect(result.hotStories).toHaveLength(1);
    expect(result.banners[0].slug).toBe('tham-tu-lung-danh-conan');
  });

  it('gọi getStoryRankingsApi trả về topComics và topNovels', async () => {
    const mockNovel = {
      ...mockStory,
      id: 'novel-uuid-1',
      title: 'Mushoku Tensei',
      slug: 'mushoku-tensei',
      mediaFormat: MediaFormat.NOVEL,
    };

    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: {
        topComics: [mockStory],
        topNovels: [mockNovel],
      },
    });

    const result = await getStoryRankingsApi();
    expect(getSpy).toHaveBeenCalledWith('/stories/rankings');
    expect(result.topComics).toHaveLength(1);
    expect(result.topNovels).toHaveLength(1);
    expect(result.topNovels[0].mediaFormat).toBe(MediaFormat.NOVEL);
  });

  it('gọi getStoryBySlugApi lấy chi tiết bộ truyện', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: mockStory,
    });

    const result = await getStoryBySlugApi('tham-tu-lung-danh-conan');
    expect(getSpy).toHaveBeenCalledWith('/stories/tham-tu-lung-danh-conan');
    expect(result.id).toBe('story-uuid-1');
    expect(result.slug).toBe('tham-tu-lung-danh-conan');
  });
});
