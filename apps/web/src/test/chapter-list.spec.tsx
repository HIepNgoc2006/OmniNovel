import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChapterListSection } from '../components/story/chapter-list-section';
import { Story } from '../lib/api/stories';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  ChapterVersionType,
} from '@omninovel/shared';

describe('ChapterListSection Component (Phase 4B)', () => {
  const mockStory: Story = {
    id: 'story-uuid-1',
    title: 'Sousou no Frieren',
    slug: 'sousou-no-frieren',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: PublicationFormat.MANGA,
    coverUrl: 'https://cdn.omninovel.com/covers/frieren.jpg',
    status: StoryStatus.ONGOING,
    visibility: StoryVisibility.PUBLIC,
    viewsCount: 120000,
    followersCount: 850,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    editions: [
      {
        id: 'edition-1',
        storyId: 'story-uuid-1',
        editionName: 'Bản Tiếng Việt Chuẩn',
        language: 'vi',
        isDefault: true,
        chapters: [
          {
            id: 'c-1',
            storyEditionId: 'edition-1',
            chapterNumber: 1,
            title: 'Hồi Kết Của Cuộc Hành Trình',
            createdAt: '2026-08-01T00:00:00.000Z',
            activeVersion: {
              id: 'v-1',
              versionNumber: 1,
              versionType: ChapterVersionType.HUMAN_EDITED,
              isPublished: true,
              createdAt: '2026-08-01T00:00:00.000Z',
            },
          },
          {
            id: 'c-2',
            storyEditionId: 'edition-1',
            chapterNumber: 2,
            title: 'Lời Nói Dối Của Pháp Sư',
            createdAt: '2026-08-02T00:00:00.000Z',
            activeVersion: {
              id: 'v-2',
              versionNumber: 1,
              versionType: ChapterVersionType.AI_TRANSLATED,
              isPublished: true,
              createdAt: '2026-08-02T00:00:00.000Z',
            },
          },
          {
            id: 'c-10',
            storyEditionId: 'edition-1',
            chapterNumber: 10,
            title: 'Bóng Ma Quá Khứ',
            createdAt: '2026-08-10T00:00:00.000Z',
            activeVersion: {
              id: 'v-10',
              versionNumber: 1,
              versionType: ChapterVersionType.RAW_ORIGINAL,
              isPublished: true,
              createdAt: '2026-08-10T00:00:00.000Z',
            },
          },
        ],
      },
    ],
  };

  it('render danh sách các chương và version badges tương ứng', () => {
    render(<ChapterListSection story={mockStory} />);

    expect(screen.getByText(/3/)).toBeDefined(); // 3 chương
    expect(screen.getByText('Chương 1: Hồi Kết Của Cuộc Hành Trình')).toBeDefined();
    expect(screen.getByText('Chương 2: Lời Nói Dối Của Pháp Sư')).toBeDefined();
    expect(screen.getByText('Chương 10: Bóng Ma Quá Khứ')).toBeDefined();

    // Version tags
    expect(screen.getByText('Biên Tập Viên')).toBeDefined();
    expect(screen.getByText('AI Dịch')).toBeDefined();
    expect(screen.getByText('Bản gốc')).toBeDefined();
  });

  it('lọc danh sách chương thông qua ô tìm kiếm số chương', () => {
    render(<ChapterListSection story={mockStory} />);

    const searchInput = screen.getByPlaceholderText('Tìm số chương...');
    fireEvent.change(searchInput, { target: { value: '10' } });

    expect(screen.getByText('Chương 10: Bóng Ma Quá Khứ')).toBeDefined();
    expect(screen.queryByText('Chương 1: Hồi Kết Của Cuộc Hành Trình')).toBeNull();
    expect(screen.queryByText('Chương 2: Lời Nói Dối Của Pháp Sư')).toBeNull();
  });

  it('chuyển đổi thứ tự sắp xếp Mới nhất / Cũ nhất', () => {
    render(<ChapterListSection story={mockStory} />);

    const sortButton = screen.getByRole('button', { name: /Mới nhất|Cũ nhất/i });
    expect(screen.getByText('Mới nhất')).toBeDefined();

    // Click to switch to ASC (Cũ nhất)
    fireEvent.click(sortButton);
    expect(screen.getByText('Cũ nhất')).toBeDefined();
  });
});
