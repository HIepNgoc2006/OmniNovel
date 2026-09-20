import { describe, it, expect } from 'vitest';
import {
  TranslationSegmentDto,
  MediaFormat,
  TranslationJobStatus,
} from '@omninovel/shared';
import {
  sortNovelSegmentsDeterministic,
  groupSegmentsByAnchorBlock,
  getNovelStudioWorkspaceMode,
  buildUpdateSegmentPayload,
} from '../lib/studio/novel-studio-policy';

describe('Novel Studio Policy (#150 Task 2)', () => {
  const createMockSegment = (
    id: string,
    sortOrder: number,
    anchorBlockId: string | null = 'block-1',
    isHumanVerified = false,
  ): TranslationSegmentDto => ({
    id,
    jobId: 'job-123',
    pageNumber: null,
    anchorBlockId,
    sortOrder,
    bboxX: null,
    bboxY: null,
    bboxW: null,
    bboxH: null,
    rawText: `Raw text for ${id}`,
    translatedText: `Translated text for ${id}`,
    confidence: 0.95,
    isHumanVerified,
    version: 1,
  });

  describe('sortNovelSegmentsDeterministic', () => {
    it('sorts segments by sortOrder ascending', () => {
      const segments: TranslationSegmentDto[] = [
        createMockSegment('seg-3', 30),
        createMockSegment('seg-1', 10),
        createMockSegment('seg-2', 20),
      ];

      const sorted = sortNovelSegmentsDeterministic(segments);

      expect(sorted.map((s) => s.id)).toEqual(['seg-1', 'seg-2', 'seg-3']);
      // Original array remains immutable
      expect(segments[0].id).toBe('seg-3');
    });

    it('tie-breaks identical sortOrder deterministically by id ascending', () => {
      const segments: TranslationSegmentDto[] = [
        createMockSegment('seg-c', 10),
        createMockSegment('seg-a', 10),
        createMockSegment('seg-b', 10),
      ];

      const sorted = sortNovelSegmentsDeterministic(segments);

      expect(sorted.map((s) => s.id)).toEqual(['seg-a', 'seg-b', 'seg-c']);
    });
  });

  describe('groupSegmentsByAnchorBlock', () => {
    it('groups segments by anchorBlockId and computes block summary metrics', () => {
      const segments: TranslationSegmentDto[] = [
        createMockSegment('seg-1', 1, 'block-alpha', true),
        createMockSegment('seg-2', 2, 'block-alpha', false),
        createMockSegment('seg-3', 3, 'block-beta', true),
      ];

      const blocks = groupSegmentsByAnchorBlock(segments);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].anchorBlockId).toBe('block-alpha');
      expect(blocks[0].segmentCount).toBe(2);
      expect(blocks[0].verifiedCount).toBe(1);
      expect(blocks[0].firstSortOrder).toBe(1);
      expect(blocks[0].segments.map((s) => s.id)).toEqual(['seg-1', 'seg-2']);

      expect(blocks[1].anchorBlockId).toBe('block-beta');
      expect(blocks[1].segmentCount).toBe(1);
      expect(blocks[1].verifiedCount).toBe(1);
      expect(blocks[1].firstSortOrder).toBe(3);
    });

    it('orders blocks deterministically by firstSortOrder ascending', () => {
      const segments: TranslationSegmentDto[] = [
        createMockSegment('seg-3', 30, 'block-gamma'),
        createMockSegment('seg-1', 10, 'block-alpha'),
        createMockSegment('seg-2', 20, 'block-beta'),
      ];

      const blocks = groupSegmentsByAnchorBlock(segments);

      expect(blocks.map((b) => b.anchorBlockId)).toEqual([
        'block-alpha',
        'block-beta',
        'block-gamma',
      ]);
    });

    it('handles empty segments array', () => {
      const blocks = groupSegmentsByAnchorBlock([]);
      expect(blocks).toEqual([]);
    });

    it('groups unassigned segments with fallback anchor block ID', () => {
      const segments: TranslationSegmentDto[] = [
        createMockSegment('seg-null', 1, null),
      ];

      const blocks = groupSegmentsByAnchorBlock(segments);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].anchorBlockId).toBe('unassigned');
    });
  });

  describe('getNovelStudioWorkspaceMode', () => {
    it('returns UNSUPPORTED_FORMAT when mediaFormat is not NOVEL', () => {
      const result = getNovelStudioWorkspaceMode({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        mediaFormat: MediaFormat.COMIC,
      });

      expect(result.mode).toBe('UNSUPPORTED_FORMAT');
      expect(result.canEdit).toBe(false);
    });

    it('returns REVIEWABLE when jobStatus is READY_FOR_REVIEW and mediaFormat is NOVEL', () => {
      const result = getNovelStudioWorkspaceMode({
        jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
        mediaFormat: MediaFormat.NOVEL,
      });

      expect(result.mode).toBe('REVIEWABLE');
      expect(result.canEdit).toBe(true);
    });

    it('returns APPLIED with read-only message when status is APPLIED', () => {
      const result = getNovelStudioWorkspaceMode({
        jobStatus: TranslationJobStatus.APPLIED,
        mediaFormat: MediaFormat.NOVEL,
      });

      expect(result.mode).toBe('APPLIED');
      expect(result.canEdit).toBe(false);
      expect(result.message).toContain('áp dụng');
      expect(result.message).not.toContain('xuất bản');
    });

    it('returns TERMINAL_STATE for FAILED, CANCELED, and EXPIRED jobs', () => {
      for (const status of [
        TranslationJobStatus.FAILED,
        TranslationJobStatus.CANCELED,
        TranslationJobStatus.EXPIRED,
      ]) {
        const result = getNovelStudioWorkspaceMode({
          jobStatus: status,
          mediaFormat: MediaFormat.NOVEL,
        });

        expect(result.mode).toBe('TERMINAL_STATE');
        expect(result.canEdit).toBe(false);
      }
    });

    it('returns PIPELINE_MONITOR for in-progress statuses', () => {
      for (const status of [
        TranslationJobStatus.QUEUED,
        TranslationJobStatus.PREPROCESSING,
        TranslationJobStatus.TRANSLATING,
        TranslationJobStatus.QUALITY_CHECK,
      ]) {
        const result = getNovelStudioWorkspaceMode({
          jobStatus: status,
          mediaFormat: MediaFormat.NOVEL,
        });

        expect(result.mode).toBe('PIPELINE_MONITOR');
        expect(result.canEdit).toBe(false);
      }
    });
  });

  describe('buildUpdateSegmentPayload', () => {
    it('constructs strict payload with only allowed mutation fields and expectedVersion', () => {
      const payload = buildUpdateSegmentPayload({
        translatedText: 'Bản dịch mới',
        isHumanVerified: true,
        expectedVersion: 2,
      });

      expect(payload).toEqual({
        translatedText: 'Bản dịch mới',
        isHumanVerified: true,
        expectedVersion: 2,
      });

      // Verification of immutability invariant: rawText, anchorBlockId, sortOrder, id, jobId are NEVER in payload
      const keys = Object.keys(payload);
      expect(keys).not.toContain('rawText');
      expect(keys).not.toContain('anchorBlockId');
      expect(keys).not.toContain('sortOrder');
      expect(keys).not.toContain('id');
      expect(keys).not.toContain('jobId');
    });

    it('allows verify-only mutation payload without translatedText', () => {
      const payload = buildUpdateSegmentPayload({
        isHumanVerified: true,
        expectedVersion: 1,
      });

      expect(payload).toEqual({
        isHumanVerified: true,
        expectedVersion: 1,
      });
      expect(payload.translatedText).toBeUndefined();
    });
  });
});
