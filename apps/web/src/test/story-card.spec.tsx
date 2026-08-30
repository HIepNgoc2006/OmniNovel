import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoryCard } from '../components/story/story-card';
import { Story } from '../lib/api/stories';
import { MediaFormat, PublicationFormat, StoryStatus, StoryVisibility } from '@omninovel/shared';

describe('StoryCard Component (Phase 4B)', () => {
  const comicStory: Story = {
    id: 'story-comic-1',
    title: 'One Piece Đảo Hải Tặc',
    slug: 'one-piece-dao-hai-tac',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: PublicationFormat.MANGA,
    coverUrl: 'https://cdn.omninovel.com/covers/onepiece.jpg',
    status: StoryStatus.ONGOING,
    visibility: StoryVisibility.PUBLIC,
    summary: 'Hành trình tìm kiếm kho báu vĩ đại...',
    viewsCount: 2500000,
    followersCount: 1420,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    genres: [{ id: 1, name: 'Action', slug: 'action' }],
    editions: [
      {
        id: 'edition-1',
        storyId: 'story-comic-1',
        editionName: 'Bản Tiếng Việt',
        language: 'vi',
        isDefault: true,
        chapters: [
          {
            id: 'chap-1',
            storyEditionId: 'edition-1',
            chapterNumber: 1120,
            title: 'Hòn Đảo Tương Lai',
            createdAt: '2026-08-30T00:00:00.000Z',
          },
        ],
      },
    ],
  };

  const novelStory: Story = {
    ...comicStory,
    id: 'story-novel-1',
    title: 'Overlord - Kẻ Thống Trị Lăng Mộ',
    slug: 'overlord-ke-thong-tri',
    mediaFormat: MediaFormat.NOVEL,
    publicationFormat: PublicationFormat.LIGHT_NOVEL,
    status: StoryStatus.COMPLETED,
  };

  it('render Manga badge cho định dạng COMIC và hiển thị số chương mới nhất', () => {
    render(<StoryCard story={comicStory} />);

    expect(screen.getByText('One Piece Đảo Hải Tặc')).toBeDefined();
    expect(screen.getByText('Manga')).toBeDefined();
    expect(screen.getByText('Ch.1120')).toBeDefined();
    expect(screen.getByText('- Hòn Đảo Tương Lai')).toBeDefined();
    expect(screen.getByText('2500.0k')).toBeDefined();
  });

  it('render Light Novel badge và Full badge cho bộ truyện NOVEL đã COMPLETED', () => {
    render(<StoryCard story={novelStory} />);

    expect(screen.getByText('Overlord - Kẻ Thống Trị Lăng Mộ')).toBeDefined();
    expect(screen.getByText('Light Novel')).toBeDefined();
    expect(screen.getByText('Full')).toBeDefined();
  });
});
