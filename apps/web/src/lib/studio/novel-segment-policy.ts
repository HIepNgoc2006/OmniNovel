import { validateProtectedAnchorTopology } from '@omninovel/shared';

export type NovelSegmentState =
  | 'CLEAN'
  | 'DIRTY'
  | 'INVALID'
  | 'SAVING'
  | 'SAVED'
  | 'CONFLICT'
  | 'ERROR';

export interface SegmentValidationResult {
  valid: boolean;
  error?: string;
}

export function validateSegmentTopology(
  sourceRawText: string,
  translatedDraftText: string,
  context?: { segmentId?: string; anchorBlockId?: string },
): SegmentValidationResult {
  const result = validateProtectedAnchorTopology(
    sourceRawText,
    translatedDraftText,
  );
  if (result.valid) {
    return { valid: true };
  }

  const prefix = context
    ? `[Block ${context.anchorBlockId || 'N/A'} / Phân đoạn ${context.segmentId || 'N/A'}] `
    : '';

  return {
    valid: false,
    error: `${prefix}${result.error || 'Lỗi cấu trúc thẻ protected anchor.'}`,
  };
}

export interface ComputeSegmentEditorStateOptions {
  canonicalText: string;
  draftText?: string;
  isSaving: boolean;
  hasConflict: boolean;
  errorMessage?: string | null;
  validation: SegmentValidationResult;
  isSaved?: boolean;
}

export function computeSegmentEditorState(
  options: ComputeSegmentEditorStateOptions,
): NovelSegmentState {
  if (options.hasConflict) return 'CONFLICT';
  if (options.errorMessage) return 'ERROR';
  if (options.isSaving) return 'SAVING';
  if (options.isSaved) return 'SAVED';

  const isDirty =
    options.draftText !== undefined &&
    options.draftText !== options.canonicalText;

  if (!isDirty) return 'CLEAN';

  if (!options.validation.valid) return 'INVALID';
  return 'DIRTY';
}
