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

// ==========================================
// RED 4: 4-State Action Matrix & Verification Policies
// ==========================================

export type SegmentVerificationState =
  | 'MUTATION_BLOCKED'
  | 'UNVERIFIED_CLEAN'
  | 'UNVERIFIED_DIRTY'
  | 'VERIFIED_CLEAN'
  | 'VERIFIED_DIRTY';

export interface CanToggleVerificationParams {
  isDirty?: boolean;
  canEdit: boolean;
  isGateClosed: boolean;
  isSaving: boolean;
  isVerifying: boolean;
  hasPendingMutation: boolean;
  isRetryBlocked: boolean;
  hasConflict?: boolean;
}

/**
 * Pure verification toggle evaluator:
 * Verification can be toggled if:
 * 1. Workspace permits editing (canEdit === true)
 * 2. Authoritative sync gate is open (!isGateClosed)
 * 3. Not currently saving (!isSaving)
 * 4. Not currently verifying (!isVerifying)
 * 5. No pending unknown mutation (!hasPendingMutation)
 * 6. Not retry-blocked / orphan (!isRetryBlocked)
 * 7. No unresolved conflict state (!hasConflict)
 * Note: Dirty drafts ARE permitted and execute atomic save+verify/unverify!
 */
export function canToggleVerification({
  canEdit,
  isGateClosed,
  isSaving,
  isVerifying,
  hasPendingMutation,
  isRetryBlocked,
  hasConflict = false,
}: CanToggleVerificationParams): boolean {
  if (!canEdit) return false;
  if (isGateClosed) return false;
  if (isSaving) return false;
  if (isVerifying) return false;
  if (hasPendingMutation) return false;
  if (isRetryBlocked) return false;
  if (hasConflict) return false;
  return true;
}

/**
 * Resolves 4-state action matrix for segment editor:
 * - 'MUTATION_BLOCKED': Editing/verification disabled by policy/gate/lock/conflict/in-flight
 * - 'UNVERIFIED_CLEAN': Segment is unverified & clean -> "Duyệt"
 * - 'UNVERIFIED_DIRTY': Segment is unverified & dirty -> "Lưu & Duyệt"
 * - 'VERIFIED_CLEAN': Segment is verified & clean -> "Bỏ duyệt"
 * - 'VERIFIED_DIRTY': Segment is verified & dirty -> "Lưu & Bỏ duyệt"
 */
export function resolveActionMatrixState({
  isDirty,
  isHumanVerified,
  canEdit,
  isGateClosed,
  isSaving,
  isVerifying,
  hasPendingMutation,
  isRetryBlocked,
  hasConflict = false,
}: CanToggleVerificationParams & { isDirty: boolean; isHumanVerified?: boolean }): SegmentVerificationState {
  if (
    !canEdit ||
    isGateClosed ||
    isSaving ||
    isVerifying ||
    hasPendingMutation ||
    isRetryBlocked ||
    hasConflict
  ) {
    return 'MUTATION_BLOCKED';
  }

  if (isDirty) {
    return isHumanVerified ? 'VERIFIED_DIRTY' : 'UNVERIFIED_DIRTY';
  }

  return isHumanVerified ? 'VERIFIED_CLEAN' : 'UNVERIFIED_CLEAN';
}

/**
 * Action button labels conforming to approved RED 4 4-state matrix:
 */
export function getVerificationButtonLabel(state: SegmentVerificationState): string {
  switch (state) {
    case 'UNVERIFIED_CLEAN':
      return 'Duyệt';
    case 'UNVERIFIED_DIRTY':
      return 'Lưu & Duyệt';
    case 'VERIFIED_CLEAN':
      return 'Bỏ duyệt';
    case 'VERIFIED_DIRTY':
      return 'Lưu & Bỏ duyệt';
    case 'MUTATION_BLOCKED':
    default:
      return 'Duyệt';
  }
}

// ==========================================
// RED 4: Hotkey Precedence & IME Guards
// ==========================================

/**
 * Checks if keyboard event was triggered while input method editor (IME) is composing
 * (e.g. Vietnamese Telex, Japanese IME). Hotkeys MUST NOT fire during IME composition!
 */
export function isImeComposing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  if ('isComposing' in e && Boolean((e as KeyboardEvent).isComposing)) return true;
  if ('nativeEvent' in e && Boolean((e.nativeEvent as KeyboardEvent)?.isComposing)) return true;
  if ('keyCode' in e && (e as any).keyCode === 229) return true;
  return false;
}

/**
 * Checks if target element is an active editable field (input, textarea, or contentEditable).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Pure evaluator for studio verification hotkey (Ctrl/Cmd+Shift+Enter, Alt+V, or V outside editor)
 */
export function shouldHandleStudioVerificationHotkey(
  e: KeyboardEvent | React.KeyboardEvent,
): boolean {
  if (isImeComposing(e)) return false;

  // Ctrl/Cmd + Shift + Enter
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
    return true;
  }

  // Modifier combo: Alt+V
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'v') {
    return true;
  }

  // Single key 'v' only when NOT focused on an editable element
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
    return !isEditableTarget(e.target);
  }

  return false;
}

// ==========================================
// RED 4: Bounded Traversal Helpers
// ==========================================

/**
 * Deterministically sorts segments by (sortOrder, id) ascending.
 */
export function sortSegmentsDeterministic<T extends { sortOrder: number; id: string }>(
  segments: T[],
): T[] {
  return [...segments].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

export function findNextSegmentIndex(currentIndex: number, totalSegments: number): number {
  if (totalSegments <= 0) return 0;
  if (currentIndex < 0) return 0;
  return Math.min(totalSegments - 1, currentIndex + 1);
}

export function findPrevSegmentIndex(currentIndex: number, totalSegments: number): number {
  if (totalSegments <= 0) return 0;
  if (currentIndex < 0) return 0;
  return Math.max(0, currentIndex - 1);
}

/**
 * Strictly bounded forward search for next unverified segment:
 * Scans only forward from currentIndex + 1 (or index 0 if currentIndex < 0) to length - 1.
 * ABSOLUTELY NO AUTO-WRAP! Clamps to bounded index if no unverified item ahead.
 */
export function findNextUnverifiedIndex(
  currentIndex: number,
  segments: { isHumanVerified?: boolean }[],
): number {
  if (segments.length === 0) return 0;
  const start = currentIndex < 0 ? 0 : currentIndex + 1;

  // Search forward from start item ONLY. NO AUTO-WRAP!
  for (let i = start; i < segments.length; i++) {
    if (!segments[i].isHumanVerified) {
      return i;
    }
  }

  return Math.max(0, Math.min(currentIndex < 0 ? 0 : currentIndex, segments.length - 1));
}
