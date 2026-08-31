import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NovelReader } from '../components/reader/novel/novel-reader';
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

const mockNovelData: ChapterDetailResponse = {
  story: {
    id: 's-novel-1',
    title: 'Toàn Chức Cao Thủ',
    slug: 'toan-chuc-cao-thu',
    mediaFormat: MediaFormat.NOVEL,
  },
  chapter: {
    id: 'c-novel-1',
    storyEditionId: 'e-novel-1',
    chapterNumber: 1,
    title: 'Diệp Tu Rời Khỏi',
    activeVersionId: 'v-novel-1',
  },
  activeVersion: {
    id: 'v-novel-1',
    versionNumber: 1,
    versionType: ChapterVersionType.HUMAN_EDITED,
    language: 'vi',
    isPublished: true,
    createdAt: new Date().toISOString(),
  },
  availableVersions: [
    {
      id: 'v-novel-1',
      versionNumber: 1,
      versionType: ChapterVersionType.HUMAN_EDITED,
      language: 'vi',
      isPublished: true,
      createdAt: new Date().toISOString(),
    },
  ],
  mediaAssets: [
    {
      id: 'asset-novel-html-1',
      sortOrder: 1,
      assetType: MediaAssetType.NOVEL_HTML,
      storageKey: 'novels/ch1.html',
      width: null,
      height: null,
    },
  ],
  navigation: {
    previous: null,
    next: {
      id: 'c-novel-2',
      chapterNumber: 2,
      title: 'Quán Net Hưng Hân',
    },
  },
};

describe('NovelReader Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should render Novel HUD with Sepia theme container', () => {
    const { container } = render(<NovelReader initialData={mockNovelData} allChapters={[]} />);

    expect(screen.getByText('Toàn Chức Cao Thủ')).toBeInTheDocument();
    expect(screen.getByText(/Chương 1/)).toBeInTheDocument();
    expect(screen.getByText(/Diệp Tu Rời Khỏi/)).toBeInTheDocument();

    const rootDiv = container.querySelector('[data-reader-theme]');
    expect(rootDiv).toHaveAttribute('data-reader-theme', 'sepia');
  });

  it('should open settings modal and allow changing theme to dark', () => {
    const { container } = render(<NovelReader initialData={mockNovelData} allChapters={[]} />);

    const settingsBtn = screen.getByTitle('Tùy chỉnh giao diện đọc');
    fireEvent.click(settingsBtn);

    expect(screen.getByText('Tùy Chỉnh Giao Diện Đọc')).toBeInTheDocument();

    const darkBtn = screen.getByText('Dark (Tối)');
    fireEvent.click(darkBtn);

    const rootDiv = container.querySelector('[data-reader-theme]');
    expect(rootDiv).toHaveAttribute('data-reader-theme', 'dark');
  });
});
