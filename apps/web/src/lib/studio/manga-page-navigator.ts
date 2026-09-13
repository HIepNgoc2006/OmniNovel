/**
 * Manga Page Navigator Policy & Pure Utilities (#149 RED 1)
 *
 * Implements:
 * 1. Bounded preview window calculation (contiguous, centered when possible, max 5 pages).
 * 2. URL page parameter parsing & canonicalization rules.
 * 3. Page bounds helpers.
 * 4. Keyboard hotkey guard (suppressing page flip when editing inputs).
 */

export interface BoundedPreviewWindow {
  fromPage: number;
  toPage: number;
  size: number;
}

export interface ParsedPageQuery {
  page: number;
  isCanonical: boolean;
}

/**
 * Calculates a bounded preview window of size <= windowSize (default 5).
 * Rules:
 * - If resultPageCount <= 0 or invalid: returns null.
 * - If resultPageCount <= windowSize: window is [1..resultPageCount].
 * - If resultPageCount > windowSize: window size is windowSize, centered around currentPage,
 *   shifting to [1..5] at the beginning and [N-4..N] at the end.
 * - Contiguous range, always includes currentPage.
 */
export function computeBoundedPreviewWindow(
  currentPage: number,
  resultPageCount?: number | null,
  windowSize = 5,
): BoundedPreviewWindow | null {
  if (
    typeof resultPageCount !== 'number' ||
    !Number.isSafeInteger(resultPageCount) ||
    resultPageCount <= 0
  ) {
    return null;
  }

  const effectiveWindowSize = Math.min(windowSize, resultPageCount);

  if (resultPageCount <= effectiveWindowSize) {
    return {
      fromPage: 1,
      toPage: resultPageCount,
      size: resultPageCount,
    };
  }

  // Clamp currentPage into [1..resultPageCount] for window centering
  const clampedCurrent = Math.max(1, Math.min(currentPage, resultPageCount));

  // Center window around clampedCurrent:
  // e.g. for windowSize=5: offset is 2.
  const halfWindow = Math.floor(effectiveWindowSize / 2);
  const idealStart = clampedCurrent - halfWindow;

  // Bound start between 1 and (resultPageCount - effectiveWindowSize + 1)
  const fromPage = Math.max(1, Math.min(idealStart, resultPageCount - effectiveWindowSize + 1));
  const toPage = fromPage + effectiveWindowSize - 1;

  return {
    fromPage,
    toPage,
    size: effectiveWindowSize,
  };
}

/**
 * Parses and validates the URL ?page= query parameter.
 * Rules:
 * - Missing / empty / undefined -> page 1, isCanonical: false
 * - Not a positive integer -> page 1, isCanonical: false
 * - > maxPage (when maxPage > 0) -> clamped to maxPage, isCanonical: false
 * - Valid in-bounds page -> page N, isCanonical: true only if exact string match (no leading 0s or spaces)
 */
export function parsePageQueryParam(
  rawParam: string | null | undefined,
  maxPage?: number | null,
): ParsedPageQuery {
  if (rawParam === null || rawParam === undefined || rawParam.trim() === '') {
    return { page: 1, isCanonical: false };
  }

  const trimmed = rawParam.trim();
  // Must be strictly digits
  if (!/^\d+$/.test(trimmed)) {
    return { page: 1, isCanonical: false };
  }

  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed) || parsed <= 0) {
    return { page: 1, isCanonical: false };
  }

  const hasMax = typeof maxPage === 'number' && maxPage > 0;
  if (hasMax && parsed > maxPage) {
    return { page: maxPage, isCanonical: false };
  }

  const canonicalString = String(parsed);
  const isCanonical = rawParam === canonicalString;

  return {
    page: parsed,
    isCanonical,
  };
}

/**
 * Checks if user can navigate to the previous page.
 */
export function canNavigatePrev(currentPage: number): boolean {
  return currentPage > 1;
}

/**
 * Checks if user can navigate to the next page.
 */
export function canNavigateNext(currentPage: number, maxPage?: number | null): boolean {
  if (typeof maxPage !== 'number' || maxPage <= 0) {
    return false;
  }
  return currentPage < maxPage;
}

/**
 * Clamps a page number within valid bounds [1..maxPage].
 */
export function clampPageNumber(page: number, maxPage?: number | null): number {
  const minClamped = Math.max(1, page);
  if (typeof maxPage === 'number' && maxPage > 0) {
    return Math.min(minClamped, maxPage);
  }
  return minClamped;
}

/**
 * Checks if an event target is an interactive editable form element or contentEditable.
 * Used to suppress ArrowLeft/ArrowRight keyboard navigation while typing.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) {
    return false;
  }

  const tagName = target.tagName.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }

  if (
    (target as HTMLElement).isContentEditable ||
    target.getAttribute('contenteditable') === 'true' ||
    target.getAttribute('contenteditable') === ''
  ) {
    return true;
  }

  return false;
}
