import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChapterDrawer } from '../components/reader/shared/chapter-drawer';
import { ChapterItem } from '../lib/api/stories';

const mockChapters: ChapterItem[] = [
  {
    id: 'c-1',
    storyEditionId: 'e-1',
    chapterNumber: 1,
    title: 'Khởi Đầu Mới',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'c-2',
    storyEditionId: 'e-1',
    chapterNumber: 2,
    title: 'Gặp Gỡ Định Mệnh',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'c-3',
    storyEditionId: 'e-1',
    chapterNumber: 3,
    title: 'Đột Phá Cảnh Giới',
    createdAt: new Date().toISOString(),
  },
];

describe('ChapterDrawer Component', () => {
  it('should render chapter list and display Đang đọc badge and Đã đọc indicator', () => {
    render(
      <ChapterDrawer
        isOpen={true}
        onClose={vi.fn()}
        storySlug="vo-luyen-dinh-phong"
        storyTitle="Võ Luyện Đỉnh Phong"
        currentChapterId="c-2"
        chapters={mockChapters}
        readChapterIds={['c-1', 'c-2']}
      />,
    );

    expect(screen.getByText('Võ Luyện Đỉnh Phong')).toBeInTheDocument();
    expect(screen.getByText('Danh sách 3 chương')).toBeInTheDocument();

    // Check chapters are marked with "Đã đọc xong" icon
    const readBadges = screen.getAllByTitle('Đã đọc xong');
    expect(readBadges.length).toBe(2);

    // Check Chapter 2 is current
    expect(screen.getByText(/Chương 2 - Gặp Gỡ Định Mệnh/)).toBeInTheDocument();
  });

  it('should filter chapters correctly when searching', () => {
    render(
      <ChapterDrawer
        isOpen={true}
        onClose={vi.fn()}
        storySlug="vo-luyen-dinh-phong"
        storyTitle="Võ Luyện Đỉnh Phong"
        currentChapterId="c-1"
        chapters={mockChapters}
        readChapterIds={['c-1']}
      />,
    );

    const input = screen.getByPlaceholderText(/Tìm theo số chương/i);
    fireEvent.change(input, { target: { value: 'Đột Phá' } });

    expect(screen.queryByText(/Khởi Đầu Mới/)).not.toBeInTheDocument();
    expect(screen.getByText(/Đột Phá Cảnh Giới/)).toBeInTheDocument();
  });
});
