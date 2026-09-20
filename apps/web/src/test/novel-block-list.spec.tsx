import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NovelBlockList } from '../components/studio/novel-block-list';
import { NovelReviewBlock } from '../lib/studio/novel-studio-policy';
import { TranslationSegmentDto } from '@omninovel/shared';

describe('NovelBlockList', () => {
  const mockSegment1: TranslationSegmentDto = {
    id: 'seg-1',
    jobId: 'job-1',
    pageNumber: 1,
    sortOrder: 1,
    anchorBlockId: 'p-1',
    bboxX: null,
    bboxY: null,
    bboxW: null,
    bboxH: null,
    confidence: 0.95,
    rawText: 'Hello world',
    translatedText: 'Xin chào thế giới',
    isHumanVerified: true,
    version: 1,
  };

  const mockSegment2: TranslationSegmentDto = {
    id: 'seg-2',
    jobId: 'job-1',
    pageNumber: 1,
    sortOrder: 2,
    anchorBlockId: 'p-1',
    bboxX: null,
    bboxY: null,
    bboxW: null,
    bboxH: null,
    confidence: 0.95,
    rawText: 'Next line',
    translatedText: 'Dòng tiếp theo',
    isHumanVerified: false,
    version: 1,
  };

  const mockBlocks: NovelReviewBlock[] = [
    {
      anchorBlockId: 'p-1',
      segments: [mockSegment1, mockSegment2],
      firstSortOrder: 1,
      segmentCount: 2,
      verifiedCount: 1,
      hasError: false,
    },
  ];

  it('renders empty placeholder when blocks are empty', () => {
    render(
      <NovelBlockList
        blocks={[]}
        drafts={{}}
        onDraftChange={vi.fn()}
        onSaveSegment={vi.fn()}
      />,
    );

    expect(screen.getByTestId('novel-block-list-empty')).toBeInTheDocument();
    expect(
      screen.getByText('Chưa có phân đoạn dịch nào được tải.'),
    ).toBeInTheDocument();
  });

  it('renders blocks and calculates progress counts correctly', () => {
    render(
      <NovelBlockList
        blocks={mockBlocks}
        drafts={{}}
        onDraftChange={vi.fn()}
        onSaveSegment={vi.fn()}
      />,
    );

    expect(screen.getByTestId('novel-block-p-1')).toBeInTheDocument();
    expect(screen.getByText('Block p-1')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 đã duyệt')).toBeInTheDocument();
    expect(screen.getByTestId('novel-segment-container-seg-1')).toBeInTheDocument();
    expect(screen.getByTestId('novel-segment-container-seg-2')).toBeInTheDocument();
  });

  it('propagates draft changes and save triggers from editors', () => {
    const handleDraftChange = vi.fn();
    const handleSave = vi.fn();

    render(
      <NovelBlockList
        blocks={mockBlocks}
        drafts={{ 'seg-2': 'Dòng mới đã sửa' }}
        onDraftChange={handleDraftChange}
        onSaveSegment={handleSave}
      />,
    );

    const textarea = screen.getByTestId('novel-segment-textarea-seg-2');
    fireEvent.change(textarea, { target: { value: 'Dòng mới đã sửa thêm' } });
    expect(handleDraftChange).toHaveBeenCalledWith(
      'seg-2',
      'Dòng mới đã sửa thêm',
    );

    const saveBtn = screen.getByTestId('novel-segment-save-btn-seg-2');
    fireEvent.click(saveBtn);
    expect(handleSave).toHaveBeenCalledWith('seg-2');
  });
});
