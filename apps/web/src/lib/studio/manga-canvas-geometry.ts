import type { TranslationSegmentDto } from '@omninovel/shared';

export interface AuthoritativeDimensions {
  width?: number | null;
  height?: number | null;
}

export interface DecodedDimensions {
  naturalWidth: number;
  naturalHeight: number;
}

export interface NormalizedBoundingBox {
  segmentId: string;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

/**
 * Maximum OCR rounding tolerance in pixels allowed to exceed the authoritative image boundary.
 * Exceeding this tolerance (> 1px) marks the bounding box as INVALID (returns null).
 * Within tolerance (<= 1px), the box is accepted and clipped at 100% for rendering.
 */
export const OCR_ROUNDING_TOLERANCE_PX = 1.0;

/**
 * Validates that authoritative dimensions are finite, positive numbers.
 */
export function isValidAuthoritativeDimensions(
  dims: AuthoritativeDimensions | null | undefined,
): dims is { width: number; height: number } {
  if (!dims) return false;
  return (
    typeof dims.width === 'number' &&
    Number.isFinite(dims.width) &&
    dims.width > 0 &&
    typeof dims.height === 'number' &&
    Number.isFinite(dims.height) &&
    dims.height > 0
  );
}

/**
 * Integrity Check: Validates that decoded DOM image dimensions match authoritative server metadata.
 * If decoded image is downsampled, cropped, or resampled differently, returns false.
 */
export function checkImageDimensionsIntegrity(
  authoritative: AuthoritativeDimensions | null | undefined,
  decoded: DecodedDimensions | null | undefined,
): boolean {
  if (!isValidAuthoritativeDimensions(authoritative) || !decoded) {
    return false;
  }
  return (
    decoded.naturalWidth === authoritative.width &&
    decoded.naturalHeight === authoritative.height
  );
}

/**
 * Validates that segment coordinates are non-negative, finite numbers and do not overflow
 * beyond the authoritative dimensions plus the OCR rounding tolerance (1px).
 */
export function validateSegmentCoordinates(
  segment: TranslationSegmentDto,
  authoritativeDims: { width: number; height: number },
): boolean {
  const { bboxX, bboxY, bboxW, bboxH } = segment;

  if (
    bboxX === null ||
    bboxY === null ||
    bboxW === null ||
    bboxH === null ||
    typeof bboxX !== 'number' ||
    typeof bboxY !== 'number' ||
    typeof bboxW !== 'number' ||
    typeof bboxH !== 'number' ||
    !Number.isFinite(bboxX) ||
    !Number.isFinite(bboxY) ||
    !Number.isFinite(bboxW) ||
    !Number.isFinite(bboxH) ||
    bboxX < 0 ||
    bboxY < 0 ||
    bboxW <= 0 ||
    bboxH <= 0
  ) {
    return false;
  }

  // Strict boundary rule: bounding box must start strictly inside the authoritative dimensions
  if (bboxX >= authoritativeDims.width || bboxY >= authoritativeDims.height) {
    return false;
  }

  // Strict overflow rule: right and bottom cannot exceed authoritative dimension + 1px tolerance
  const right = bboxX + bboxW;
  const bottom = bboxY + bboxH;

  if (right > authoritativeDims.width + OCR_ROUNDING_TOLERANCE_PX) {
    return false;
  }

  if (bottom > authoritativeDims.height + OCR_ROUNDING_TOLERANCE_PX) {
    return false;
  }

  return true;
}

/**
 * Normalizes segment coordinates into percentage values relative to authoritative SOURCE dimensions.
 * Canonical segment is never modified (Immutability).
 * Returns null if authoritative dimensions or segment geometry is invalid or overflows > 1px.
 */
export function computeNormalizedBoundingBox(
  segment: TranslationSegmentDto,
  authoritativeDims: AuthoritativeDimensions | null | undefined,
): NormalizedBoundingBox | null {
  if (!isValidAuthoritativeDimensions(authoritativeDims)) {
    return null;
  }

  if (!validateSegmentCoordinates(segment, authoritativeDims)) {
    return null;
  }

  const leftPct = (segment.bboxX! / authoritativeDims.width) * 100;
  const topPct = (segment.bboxY! / authoritativeDims.height) * 100;

  const rawWidthPct = (segment.bboxW! / authoritativeDims.width) * 100;
  const rawHeightPct = (segment.bboxH! / authoritativeDims.height) * 100;

  // Render-only clipping: ensure leftPct + widthPct does not exceed 100%
  const widthPct = Math.min(rawWidthPct, Math.max(0, 100 - leftPct));
  const heightPct = Math.min(rawHeightPct, Math.max(0, 100 - topPct));

  // Reject zero-size or degenerate boxes after clipping
  if (widthPct <= 0 || heightPct <= 0) {
    return null;
  }

  return {
    segmentId: segment.id,
    leftPct,
    topPct,
    widthPct,
    heightPct,
  };
}

/**
 * Filters segments for a specific target page and computes their normalized bounding boxes.
 * Invalid segments or segments from other pages are safely omitted.
 */
export function filterPageSegmentsForCanvas(
  segments: TranslationSegmentDto[] | null | undefined,
  targetPage: number,
  authoritativeDims: AuthoritativeDimensions | null | undefined,
): NormalizedBoundingBox[] {
  if (!segments || !Array.isArray(segments) || !isValidAuthoritativeDimensions(authoritativeDims)) {
    return [];
  }

  const result: NormalizedBoundingBox[] = [];
  for (const seg of segments) {
    if (seg.pageNumber !== targetPage) {
      continue;
    }
    const normalized = computeNormalizedBoundingBox(seg, authoritativeDims);
    if (normalized) {
      result.push(normalized);
    }
  }

  return result;
}
