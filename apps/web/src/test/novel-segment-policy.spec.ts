import { describe, it, expect } from 'vitest';
import {
  validateSegmentTopology,
  computeSegmentEditorState,
} from '../lib/studio/novel-segment-policy';

describe('Novel Segment Policy (#150 Task 4)', () => {
  const mockRawText = 'Nhân vật ⟦S:0001⟧Ainz Ooal Gown⟦/S:0001⟧ bước vào phòng ⟦IMG:0002⟧.';

  describe('validateSegmentTopology', () => {
    it('1. accepts valid translation preserving all anchors with identical topology', () => {
      const validTranslation = 'Chúa tể ⟦S:0001⟧Ainz Ooal Gown⟦/S:0001⟧ bước vào căn phòng ⟦IMG:0002⟧.';
      const result = validateSegmentTopology(mockRawText, validTranslation);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('2. rejects translation when an anchor ID is missing and adds contextual block/segment prefix', () => {
      const missingAnchorTranslation = 'Chúa tể Ainz Ooal Gown bước vào phòng ⟦IMG:0002⟧.';
      const result = validateSegmentTopology(mockRawText, missingAnchorTranslation, {
        segmentId: 'seg-123',
        anchorBlockId: 'block-456',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[Block block-456 / Phân đoạn seg-123]');
      expect(result.error).toContain('0001');
    });

    it('3. rejects translation when unexpected anchor is added', () => {
      const unexpectedAnchorTranslation =
        'Chúa tể ⟦S:0001⟧Ainz Ooal Gown⟦/S:0001⟧ bước vào ⟦E:9999⟧phòng⟦/E:9999⟧ ⟦IMG:0002⟧.';
      const result = validateSegmentTopology(mockRawText, unexpectedAnchorTranslation);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('9999');
    });

    it('4. rejects duplicate opening/closing brackets or malformed tags', () => {
      const malformedTranslation = 'Chúa tể ⟦S:0001⟧Ainz Ooal Gown⟦S:0001⟧ bước vào ⟦IMG:0002⟧.';
      const result = validateSegmentTopology(mockRawText, malformedTranslation);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('5. rejects interleaved non-LIFO tag nesting', () => {
      const rawWithNested = 'Đoạn ⟦S:0001⟧A ⟦E:0002⟧B⟦/E:0002⟧ C⟦/S:0001⟧.';
      // Interleaved: opens S then E, but closes S before E
      const interleaved = 'Đoạn ⟦S:0001⟧A ⟦E:0002⟧B⟦/S:0001⟧ C⟦/E:0002⟧.';

      const result = validateSegmentTopology(rawWithNested, interleaved);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('6. preserves self-closing semantics for IMG tag', () => {
      const rawImg = 'Hình ảnh ⟦IMG:0010⟧ minh họa.';
      const validImg = 'Bức vẽ ⟦IMG:0010⟧ chú thích.';

      const result = validateSegmentTopology(rawImg, validImg);
      expect(result.valid).toBe(true);
    });

    it('7. allows plain text when source text has no anchors', () => {
      const rawPlain = 'Chỉ là một câu bình thường.';
      const transPlain = 'Dịch một câu bình thường.';

      const result = validateSegmentTopology(rawPlain, transPlain);
      expect(result.valid).toBe(true);
    });
  });

  describe('computeSegmentEditorState', () => {
    it('returns CLEAN when draftText is undefined or equal to canonicalText', () => {
      const state1 = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: undefined,
        isSaving: false,
        hasConflict: false,
        validation: { valid: true },
      });
      expect(state1).toBe('CLEAN');

      const state2 = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: 'Gốc',
        isSaving: false,
        hasConflict: false,
        validation: { valid: true },
      });
      expect(state2).toBe('CLEAN');
    });

    it('returns DIRTY when draftText is modified and validation is valid', () => {
      const state = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: 'Sửa hợp lệ',
        isSaving: false,
        hasConflict: false,
        validation: { valid: true },
      });
      expect(state).toBe('DIRTY');
    });

    it('returns INVALID when draftText is modified but validation failed', () => {
      const state = computeSegmentEditorState({
        canonicalText: '⟦S:0001⟧A⟦/S:0001⟧',
        draftText: 'Mất thẻ',
        isSaving: false,
        hasConflict: false,
        validation: { valid: false, error: 'Thiếu thẻ' },
      });
      expect(state).toBe('INVALID');
    });

    it('returns SAVING when isSaving is true', () => {
      const state = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: 'Đang lưu',
        isSaving: true,
        hasConflict: false,
        validation: { valid: true },
      });
      expect(state).toBe('SAVING');
    });

    it('returns SAVED when isSaved is true and not saving', () => {
      const state = computeSegmentEditorState({
        canonicalText: 'Mới',
        draftText: 'Mới',
        isSaving: false,
        hasConflict: false,
        validation: { valid: true },
        isSaved: true,
      });
      expect(state).toBe('SAVED');
    });

    it('returns CONFLICT when hasConflict is true', () => {
      const state = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: 'Bản nháp',
        isSaving: false,
        hasConflict: true,
        validation: { valid: true },
      });
      expect(state).toBe('CONFLICT');
    });

    it('returns ERROR when errorMessage is present', () => {
      const state = computeSegmentEditorState({
        canonicalText: 'Gốc',
        draftText: 'Bản nháp',
        isSaving: false,
        hasConflict: false,
        errorMessage: 'Lỗi máy chủ 500',
        validation: { valid: true },
      });
      expect(state).toBe('ERROR');
    });
  });
});
