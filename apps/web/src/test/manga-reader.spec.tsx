import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MangaReader } from '../components/reader/manga/manga-reader';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  ChapterVersionType,
  MediaAssetType,
  ChapterDetailResponse,
} from '@omninovel/shared';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

// Mock auth-context
vi.mock('../lib/auth/auth-context', () => ({
  useAuth: () => ({
    status: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refetchUser: vi.fn(),
  }),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const mockData: ChapterDetailResponse = {
  story: {
    id: 's-manga-1',
    title: 'Võ Luyện Đỉnh Phong',
    slug: 'vo-luyen-dinh-phong',
    mediaFormat: MediaFormat.COMIC,
  },
  chapter: {
    id: 'c-manga-1',
    storyEditionId: 'e-1',
    chapterNumber: 1,
    title: 'Khởi Đầu Mới',
    activeVersionId: 'v-1',
  },
  activeVersion: {
    id: 'v-1',
    versionNumber: 1,
    versionType: ChapterVersionType.AI_TRANSLATED,
    language: 'vi',
    isPublished: true,
    createdAt: new Date().toISOString(),
  },
  availableVersions: [
    {
      id: 'v-1',
      versionNumber: 1,
      versionType: ChapterVersionType.AI_TRANSLATED,
      language: 'vi',
      isPublished: true,
      createdAt: new Date().toISOString(),
    },
  ],
  mediaAssets: [
    {
      id: 'asset-1',
      sortOrder: 1,
      assetType: MediaAssetType.MANGA_PAGE,
      storageKey: 'pages/1.png',
      width: 800,
      height: 1200,
    },
    {
      id: 'asset-2',
      sortOrder: 2,
      assetType: MediaAssetType.MANGA_PAGE,
      storageKey: 'pages/2.png',
      width: 800,
      height: 1200,
    },
  ],
  navigation: {
    previous: null,
    next: {
      id: 'c-manga-2',
      chapterNumber: 2,
      title: 'Đột Phá',
    },
  },
};

describe('MangaReader Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should render Manga HUD with title, chapter, and navigation controls', () => {
    render(<MangaReader initialData={mockData} allChapters={[]} />);

    expect(screen.getByText('Võ Luyện Đỉnh Phong')).toBeInTheDocument();
    expect(screen.getByText(/Chương 1/)).toBeInTheDocument();
    expect(screen.getByText(/Khởi Đầu Mới/)).toBeInTheDocument();
    expect(screen.getByText('Webtoon')).toBeInTheDocument();
    expect(screen.getByText('Chương Kế')).toBeInTheDocument();
  });

  it('should toggle reading mode between Webtoon and Paged', () => {
    render(<MangaReader initialData={mockData} allChapters={[]} />);

    const modeBtn = screen.getByText('Webtoon');
    fireEvent.click(modeBtn);

    expect(screen.getByText('Lật Trang')).toBeInTheDocument();
    expect(screen.getByText('RTL')).toBeInTheDocument();
  });
});
