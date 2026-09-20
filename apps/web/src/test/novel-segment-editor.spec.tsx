import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NovelSegmentEditor } from '../components/studio/novel-segment-editor';
import { TranslationSegmentDto } from '@omninovel/shared';

describe('NovelSegmentEditor Component (#150 Task 4)', () => {
  const mockSegment: TranslationSegmentDto = {
    id: 'seg-101',
    jobId: 'job-123',
    pageNumber: null,
    anchorBlockId: 'block-1',
    sortOrder: 1,
    bboxX: null,
    bboxY: null,
    bboxW: null,
    bboxH: null,
    rawText: 'Chào mừng ⟦S:0001⟧Ainz-sama⟦/S:0001⟧ đến đây.',
    translatedText: 'Welcome ⟦S:0001⟧Lord Ainz⟦/S:0001⟧ here.',
    confidence: 0.99,
    isHumanVerified: false,
    version: 1,
  };

  it('1. renders source text with ProtectedAnchorText in read-only presentation', () => {
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText('Chào mừng')).toBeDefined();
    expect(screen.getByText('⟦S:0001⟧')).toBeDefined();
    expect(screen.getByText('⟦/S:0001⟧')).toBeDefined();

    // Invariant: Source is NOT an input/textarea
    const inputs = screen.queryAllByRole('textbox');
    expect(inputs).toHaveLength(1); // Only translation textarea
  });

  it('2. renders draft translation in textarea and displays CLEAN badge initially', () => {
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId('novel-segment-textarea-seg-101');
    expect(textarea).toHaveValue(mockSegment.translatedText);
    expect(screen.getByTestId('novel-segment-state-badge')).toHaveTextContent('CLEAN');

    const saveBtn = screen.getByTestId('novel-segment-save-btn-seg-101');
    expect(saveBtn).toBeDisabled(); // Clean state cannot be saved
  });

  it('3. calls onDraftChange when user types in textarea', () => {
    const onDraftChange = vi.fn();
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        onDraftChange={onDraftChange}
        onSave={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId('novel-segment-textarea-seg-101');
    fireEvent.change(textarea, {
      target: { value: 'Welcome ⟦S:0001⟧Lord Ainz Ooal Gown⟦/S:0001⟧ here.' },
    });

    expect(onDraftChange).toHaveBeenCalledWith(
      'seg-101',
      'Welcome ⟦S:0001⟧Lord Ainz Ooal Gown⟦/S:0001⟧ here.',
    );
  });

  it('4. displays DIRTY badge and enables Save button when valid draft is provided', () => {
    const onSave = vi.fn();
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        draftText="Welcome ⟦S:0001⟧Lord Ainz Ooal Gown⟦/S:0001⟧ here."
        onDraftChange={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByTestId('novel-segment-state-badge')).toHaveTextContent('DIRTY');

    const saveBtn = screen.getByTestId('novel-segment-save-btn-seg-101');
    expect(saveBtn).not.toBeDisabled();

    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith('seg-101');
  });

  it('5. displays INVALID badge, shows topology error alert, and DISABLES Save button when anchor is removed', () => {
    const onSave = vi.fn();
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        draftText="Welcome Lord Ainz here." // Missing ⟦S:0001⟧ and ⟦/S:0001⟧
        onDraftChange={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByTestId('novel-segment-state-badge')).toHaveTextContent('INVALID');

    const errorAlert = screen.getByTestId('novel-segment-topology-error');
    expect(errorAlert).toBeDefined();
    expect(errorAlert.textContent).toContain('0001');

    const saveBtn = screen.getByTestId('novel-segment-save-btn-seg-101');
    expect(saveBtn).toBeDisabled();

    fireEvent.click(saveBtn);
    expect(onSave).not.toHaveBeenCalled(); // Blocked before PATCH
  });

  it('6. displays SAVING badge and disables button when isSaving is true', () => {
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        draftText="Welcome ⟦S:0001⟧Lord Ainz Ooal Gown⟦/S:0001⟧ here."
        isSaving={true}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('novel-segment-state-badge')).toHaveTextContent('SAVING');
    const saveBtn = screen.getByTestId('novel-segment-save-btn-seg-101');
    expect(saveBtn).toBeDisabled();
  });

  it('7. displays CONFLICT banner when conflictMessage is provided and preserves draft', () => {
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        draftText="Local edited text ⟦S:0001⟧Ainz⟦/S:0001⟧"
        conflictMessage="Xung đột phiên bản (409 VERSION_CONFLICT): Phiên bản máy chủ là v2, phiên bản cơ sở là v1."
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('novel-segment-state-badge')).toHaveTextContent('CONFLICT');
    expect(screen.getByTestId('novel-segment-conflict-banner')).toBeDefined();
    expect(screen.getByTestId('novel-segment-textarea-seg-101')).toHaveValue(
      'Local edited text ⟦S:0001⟧Ainz⟦/S:0001⟧',
    );
  });

  it('8. triggers onSave via Ctrl+Enter hotkey when valid and dirty', () => {
    const onSave = vi.fn();
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        draftText="Welcome ⟦S:0001⟧Lord Ainz Ooal Gown⟦/S:0001⟧ here."
        onDraftChange={vi.fn()}
        onSave={onSave}
      />,
    );

    const textarea = screen.getByTestId('novel-segment-textarea-seg-101');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSave).toHaveBeenCalledWith('seg-101');
  });

  it('9. triggers onToggleVerify via Ctrl+Shift+Enter hotkey', () => {
    const onToggleVerify = vi.fn();
    render(
      <NovelSegmentEditor
        segment={mockSegment}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
        onToggleVerify={onToggleVerify}
      />,
    );

    const textarea = screen.getByTestId('novel-segment-textarea-seg-101');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, shiftKey: true });

    expect(onToggleVerify).toHaveBeenCalledWith('seg-101');
  });
});
