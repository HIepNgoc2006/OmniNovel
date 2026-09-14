/**
 * Pure policy rules for Manga Segment Translation Editor (Phase 4D RED 3 #149)
 * Strict Separation of Concerns, zero side effects, 100% testable.
 */

/**
 * Check if the user's draft text is dirty compared to the canonical server text.
 * Trims whitespace when comparing to avoid false dirty flags on accidental trailing spaces.
 */
export function isDraftDirty(
  canonicalText: string | null | undefined,
  draftText: string | null | undefined,
): boolean {
  const normCanonical = (canonicalText ?? '').trim();
  const normDraft = (draftText ?? '').trim();
  return normCanonical !== normDraft;
}

/**
 * Resolve display text for an editor segment:
 * Priority 1: User-owned local draft if present in drafts map
 * Priority 2: Canonical translated text from server
 * Fallback: Empty string
 */
export function resolveDisplayDraft(
  canonicalText: string | null | undefined,
  drafts: Record<string, string>,
  segmentId: string,
): string {
  if (Object.prototype.hasOwnProperty.call(drafts, segmentId)) {
    return drafts[segmentId];
  }
  return canonicalText ?? '';
}

export interface CanSaveSegmentParams {
  isDirty: boolean;
  canEdit: boolean;
  isGateClosed: boolean;
  isSaving: boolean;
  hasPendingMutation: boolean;
  isRetryBlocked: boolean;
}

/**
 * Pure save authorization evaluator:
 * A segment can be saved ONLY if:
 * 1. Text is dirty (has user changes)
 * 2. Workspace permits editing (canEdit === true, e.g. READY_FOR_REVIEW)
 * 3. Authoritative sync gate is NOT closed (not RECONCILIATION_REQUIRED)
 * 4. Not currently saving (isSaving === false)
 * 5. Has no pending unknown mutation (hasPendingMutation === false)
 * 6. Is not blocked from retry (isRetryBlocked === false, e.g. orphan segment)
 */
export function canSaveSegment({
  isDirty,
  canEdit,
  isGateClosed,
  isSaving,
  hasPendingMutation,
  isRetryBlocked,
}: CanSaveSegmentParams): boolean {
  if (!isDirty) return false;
  if (!canEdit) return false;
  if (isGateClosed) return false;
  if (isSaving) return false;
  if (hasPendingMutation) return false;
  if (isRetryBlocked) return false;
  return true;
}

/**
 * Formats OCR confidence score as percentage string (e.g. 0.954 -> "95%").
 */
export function formatOcrConfidence(
  confidence: number | null | undefined,
): string | null {
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0) {
    return null;
  }
  const pct = Math.round(confidence * 100);
  return `${Math.min(100, Math.max(0, pct))}%`;
}
