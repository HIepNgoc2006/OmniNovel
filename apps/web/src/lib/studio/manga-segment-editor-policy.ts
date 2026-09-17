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
  | 'UNVERIFIED_CLEAN'
  | 'VERIFIED_CLEAN'
  | 'DRAFT_DIRTY'
  | 'MUTATION_BLOCKED';

export interface CanToggleVerificationParams {
  isDirty: boolean;
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
 * Verification can be toggled ONLY if:
 * 1. User has NO unsaved dirty draft (Lock 2: cannot verify dirty draft!)
 * 2. Workspace permits editing (canEdit === true)
 * 3. Authoritative sync gate is open (!isGateClosed)
 * 4. Not currently saving (!isSaving)
 * 5. Not currently verifying (!isVerifying)
 * 6. No pending unknown mutation (!hasPendingMutation)
 * 7. Not retry-blocked / orphan (!isRetryBlocked)
 * 8. No unresolved conflict state (!hasConflict)
 */
export function canToggleVerification({
  isDirty,
  canEdit,
  isGateClosed,
  isSaving,
  isVerifying,
  hasPendingMutation,
  isRetryBlocked,
  hasConflict = false,
}: CanToggleVerificationParams): boolean {
  if (isDirty) return false;
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
 * - 'DRAFT_DIRTY': User has unsaved changes -> Save enabled, Verify disabled
 * - 'VERIFIED_CLEAN': Segment is verified -> Unverify enabled, Save disabled
 * - 'UNVERIFIED_CLEAN': Segment is unverified -> Verify enabled, Save disabled
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
}: CanToggleVerificationParams & { isHumanVerified?: boolean }): SegmentVerificationState {
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
    return 'DRAFT_DIRTY';
  }

  return isHumanVerified ? 'VERIFIED_CLEAN' : 'UNVERIFIED_CLEAN';
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
 * Pure evaluator for studio verification hotkey (Alt+V, Ctrl+Shift+V, or V outside editor)
 */
export function shouldHandleStudioVerificationHotkey(
  e: KeyboardEvent | React.KeyboardEvent,
): boolean {
  if (isImeComposing(e)) return false;

  const keyLower = e.key.toLowerCase();
  if (keyLower !== 'v') return false;

  // Modifier combo: Alt+V or Ctrl+Shift+V or Cmd+Shift+V
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    return true;
  }

  // Single key 'v' only when NOT focused on an editable element
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    return !isEditableTarget(e.target);
  }

  return false;
}

// ==========================================
// RED 4: Bounded Traversal Helpers
// ==========================================

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

export function findNextUnverifiedIndex(
  currentIndex: number,
  segments: { isHumanVerified?: boolean }[],
): number {
  if (segments.length === 0) return 0;
  const start = Math.max(0, currentIndex);

  // Search forward from next item
  for (let i = start + 1; i < segments.length; i++) {
    if (!segments[i].isHumanVerified) {
      return i;
    }
  }

  // Wrap around from beginning to current
  for (let i = 0; i <= start && i < segments.length; i++) {
    if (!segments[i].isHumanVerified && i !== currentIndex) {
      return i;
    }
  }

  return start;
}
