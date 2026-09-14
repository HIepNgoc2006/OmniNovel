import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TranslationSegmentDto, ReviewAssetDto } from '@omninovel/shared';
import {
  computeNormalizedBoundingBox,
  checkImageDimensionsIntegrity,
  type AuthoritativeDimensions,
} from '../lib/studio/manga-canvas-geometry';
import { MangaStudioCanvas } from '../components/studio/manga-studio-canvas';

describe('Manga Review Studio Canvas & OCR Bounding Box Geometry (#149 RED 2)', () => {
  const mockAuthoritativeDims: AuthoritativeDimensions = {
    width: 1000,
    height: 1500,
  };

  const createMockSegment = (overrides?: Partial<TranslationSegmentDto>): TranslationSegmentDto => ({
    id: 'seg-1',
    jobId: 'job-123',
    pageNumber: 1,
    anchorBlockId: null,
    sortOrder: 1,
    bboxX: 100,
    bboxY: 150,
    bboxW: 200,
    bboxH: 300,
    rawText: 'Hello world',
    translatedText: 'Xin chào thế giới',
    confidence: 0.95,
    isHumanVerified: false,
    version: 1,
    ...overrides,
  });

  const mockSourceAsset: ReviewAssetDto = {
    kind: 'SOURCE_REVIEW',
    pageNumber: 1,
    width: 1000,
    height: 1500,
    url: 'https://cdn.example.com/source-p1.jpg',
  };

  const mockResultAsset: ReviewAssetDto = {
    kind: 'RESULT',
    pageNumber: 1,
    width: 1000,
    height: 1500,
    url: 'https://cdn.example.com/result-p1.jpg',
  };

  describe('Phase 1: Pure Geometry Policy (G1 - G7)', () => {
    it('G1. computeNormalizedBoundingBox converts pixel coordinates to exact percentage based on authoritative SOURCE dimensions', () => {
      const seg = createMockSegment({
        bboxX: 100,
        bboxY: 150,
        bboxW: 200,
        bboxH: 300,
      });

      const normalized = computeNormalizedBoundingBox(seg, mockAuthoritativeDims);

      expect(normalized).not.toBeNull();
      expect(normalized).toEqual({
        segmentId: 'seg-1',
        leftPct: 10,
        topPct: 10,
        widthPct: 20,
        heightPct: 20,
      });
    });

    it('G2. Fail-closed: returns null when authoritative dimensions are zero, negative, NaN, Infinity, or missing', () => {
      const seg = createMockSegment();

      expect(computeNormalizedBoundingBox(seg, { width: 0, height: 1500 })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, { width: 1000, height: 0 })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, { width: -100, height: 1500 })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, { width: 1000, height: -150 })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, { width: NaN, height: 1500 })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, { width: 1000, height: Infinity })).toBeNull();
      expect(computeNormalizedBoundingBox(seg, null as any)).toBeNull();
    });

    it('G3. Safe skip: returns null when segment coordinates are null, negative, NaN, or non-positive width/height', () => {
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxX: null }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxY: null }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxW: null }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxH: null }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxX: -5 }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxY: -1 }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxW: 0 }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxH: 0 }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxW: -50 }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxX: NaN }), mockAuthoritativeDims)).toBeNull();
      expect(computeNormalizedBoundingBox(createMockSegment({ bboxH: Infinity }), mockAuthoritativeDims)).toBeNull();
    });

    it('G4. Strict skip on overflow > 1px: bbox exceeding image boundaries by more than 1px is INVALID and returns null', () => {
      const segOverflowX = createMockSegment({
        bboxX: 900,
        bboxW: 105,
      });
      expect(computeNormalizedBoundingBox(segOverflowX, mockAuthoritativeDims)).toBeNull();

      const segOverflowY = createMockSegment({
        bboxY: 1400,
        bboxH: 110,
      });
      expect(computeNormalizedBoundingBox(segOverflowY, mockAuthoritativeDims)).toBeNull();
    });

    it('G5. Immutability: computing normalized bounding box never mutates the raw canonical TranslationSegmentDto', () => {
      const originalSeg: TranslationSegmentDto = Object.freeze(createMockSegment({
        bboxX: 200,
        bboxY: 300,
        bboxW: 400,
        bboxH: 500,
      }));

      const snapshotBefore = JSON.stringify(originalSeg);
      const normalized = computeNormalizedBoundingBox(originalSeg, mockAuthoritativeDims);

      expect(normalized).not.toBeNull();
      expect(JSON.stringify(originalSeg)).toBe(snapshotBefore);
    });

    it('G6. Authoritative-dimension integrity check: checkImageDimensionsIntegrity fails if decoded dimensions mismatch authoritative metadata', () => {
      expect(checkImageDimensionsIntegrity(mockAuthoritativeDims, { naturalWidth: 500, naturalHeight: 750 })).toBe(false);
      expect(checkImageDimensionsIntegrity(mockAuthoritativeDims, { naturalWidth: 1000, naturalHeight: 1200 })).toBe(false);
      expect(checkImageDimensionsIntegrity(mockAuthoritativeDims, { naturalWidth: 0, naturalHeight: 0 })).toBe(false);
      expect(checkImageDimensionsIntegrity(mockAuthoritativeDims, { naturalWidth: 1000, naturalHeight: 1500 })).toBe(true);
    });

    it('G7. <= 1px rounding tolerance: right/bottom overflow <= 1px is accepted, clipped at 100% for render, canonical object unmodified', () => {
      const segTolX = createMockSegment({
        id: 'seg-tol-x',
        bboxX: 800,
        bboxW: 200.8,
      });

      const normalized = computeNormalizedBoundingBox(segTolX, mockAuthoritativeDims);
      expect(normalized).not.toBeNull();
      expect(normalized!.leftPct).toBe(80);
      expect(normalized!.leftPct + normalized!.widthPct).toBeLessThanOrEqual(100);
      expect(normalized!.widthPct).toBe(20);
      expect(segTolX.bboxW).toBe(200.8);
    });

    it('G8. Boundary & Zero-size rejection (P2): bbox starting at or beyond image boundary is rejected, zero-size box returns null', () => {
      // bboxX starts exactly at image width (1000)
      const segAtBoundaryX = createMockSegment({
        bboxX: 1000,
        bboxW: 0.5,
      });
      expect(computeNormalizedBoundingBox(segAtBoundaryX, mockAuthoritativeDims)).toBeNull();

      // bboxX starts beyond image width (1000.5)
      const segBeyondX = createMockSegment({
        bboxX: 1000.5,
        bboxW: 0.2,
      });
      expect(computeNormalizedBoundingBox(segBeyondX, mockAuthoritativeDims)).toBeNull();

      // bboxY starts exactly at image height (1500)
      const segAtBoundaryY = createMockSegment({
        bboxY: 1500,
        bboxH: 0.5,
      });
      expect(computeNormalizedBoundingBox(segAtBoundaryY, mockAuthoritativeDims)).toBeNull();

      // bboxY starts beyond image height (1500.5)
      const segBeyondY = createMockSegment({
        bboxY: 1500.5,
        bboxH: 0.3,
      });
      expect(computeNormalizedBoundingBox(segBeyondY, mockAuthoritativeDims)).toBeNull();
    });
  });

  describe('Phase 2: Component Presentation & Race Guards (C1 - C10)', () => {
    it('C1. Page scope isolation: Canvas only renders bounding boxes belonging to currentPage', () => {
      const segPage1 = createMockSegment({ id: 'seg-p1', pageNumber: 1 });
      const segPage2 = createMockSegment({ id: 'seg-p2', pageNumber: 2 });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[segPage1, segPage2]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // Simulate image onLoad with matching authoritative dimensions
      const img = screen.getByTestId('canvas-source-image');
      Object.defineProperty(img, 'naturalWidth', { value: 1000 });
      Object.defineProperty(img, 'naturalHeight', { value: 1500 });
      fireEvent.load(img);

      expect(screen.getByTestId('bbox-item-seg-p1')).toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-p2')).not.toBeInTheDocument();
    });

    it('C2. Fail-closed: displays placeholder and no ghost bounding boxes when asset is loading or missing', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null}
          resultAsset={null}
          segments={[createMockSegment()]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          isLoading={true}
        />
      );

      expect(screen.getByTestId('canvas-loading-placeholder')).toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();
    });

    it('C3. View mode switching: only renders OCR bounding boxes on SOURCE and SIDE_BY_SIDE panes, NOT on RESULT', () => {
      const { rerender } = render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[createMockSegment({ id: 'seg-1' })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // Trigger load on source image
      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      expect(screen.getByTestId('bbox-item-seg-1')).toBeInTheDocument();

      // Switch to RESULT view mode
      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      expect(screen.getByTestId('canvas-result-image')).toBeInTheDocument();
      // In RESULT mode, OCR bounding boxes MUST NOT be rendered
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();

      // Switch to SIDE_BY_SIDE
      fireEvent.click(screen.getByTestId('view-mode-split-button'));
      const splitSourceImg = screen.getByTestId('canvas-source-image');
      expect(splitSourceImg).toBeInTheDocument();
      expect(screen.getByTestId('canvas-result-image')).toBeInTheDocument();
      // Invariant P1: Before newly mounted source image loads, bounding box must NOT render
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();

      // Trigger load on the newly mounted split source image
      Object.defineProperty(splitSourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(splitSourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(splitSourceImg);

      // Bounding box now renders in source pane
      expect(screen.getByTestId('bbox-item-seg-1')).toBeInTheDocument();
    });

    it('C4. Selected segment highlight: bounding box matching selectedSegmentId displays active highlight', () => {
      const seg1 = createMockSegment({ id: 'seg-1' });
      const seg2 = createMockSegment({ id: 'seg-2', bboxX: 400, bboxY: 500 });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[seg1, seg2]}
          selectedSegmentId="seg-2"
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      const box1 = screen.getByTestId('bbox-item-seg-1');
      const box2 = screen.getByTestId('bbox-item-seg-2');

      expect(box1).toHaveAttribute('data-selected', 'false');
      expect(box2).toHaveAttribute('data-selected', 'true');
    });

    it('C5. Interactive selection: clicking a bounding box invokes onSelectSegment with the segment ID', () => {
      const onSelectSpy = vi.fn();
      const seg = createMockSegment({ id: 'seg-interactive' });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[seg]}
          selectedSegmentId={null}
          onSelectSegment={onSelectSpy}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      fireEvent.click(screen.getByTestId('bbox-item-seg-interactive'));
      expect(onSelectSpy).toHaveBeenCalledWith('seg-interactive');
    });

    it('C6. Verification badge: verified segment (isHumanVerified: true) renders verified badge attribute', () => {
      const unverified = createMockSegment({ id: 'seg-unverified', isHumanVerified: false });
      const verified = createMockSegment({ id: 'seg-verified', isHumanVerified: true, bboxX: 300 });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[unverified, verified]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      expect(screen.getByTestId('bbox-item-seg-unverified')).toHaveAttribute('data-verified', 'false');
      expect(screen.getByTestId('bbox-item-seg-verified')).toHaveAttribute('data-verified', 'true');
    });

    it('C7. Container responsiveness: bounding box styles use exact percentage coordinates for CSS scaling', () => {
      const seg = createMockSegment({
        id: 'seg-pct',
        bboxX: 250,
        bboxY: 300,
        bboxW: 500,
        bboxH: 600,
      });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset} // 1000 x 1500
          resultAsset={mockResultAsset}
          segments={[seg]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      const box = screen.getByTestId('bbox-item-seg-pct');
      expect(box.style.left).toBe('25%'); // 250 / 1000 * 100
      expect(box.style.top).toBe('20%');  // 300 / 1500 * 100
      expect(box.style.width).toBe('50%'); // 500 / 1000 * 100
      expect(box.style.height).toBe('40%'); // 600 / 1500 * 100
    });

    it('C8. Stale page asset mismatch: currentPage=3 but sourceAsset.pageNumber=2 fails closed without rendering overlay', () => {
      const staleAsset: ReviewAssetDto = {
        kind: 'SOURCE_REVIEW',
        pageNumber: 2, // Stale!
        width: 1000,
        height: 1500,
        url: 'https://cdn.example.com/source-p2.jpg',
      };

      render(
        <MangaStudioCanvas
          currentPage={3} // Expected page 3
          workspaceRevision={10}
          sourceAsset={staleAsset}
          resultAsset={null}
          segments={[createMockSegment({ pageNumber: 3 })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      expect(screen.getByTestId('canvas-mismatch-placeholder')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();
    });

    it('C9. Page switch late onLoad race guard: late onLoad from old page does NOT commit dimensions to new page', () => {
      const { rerender } = render(
        <MangaStudioCanvas
          currentPage={2}
          workspaceRevision={10}
          sourceAsset={{
            kind: 'SOURCE_REVIEW',
            pageNumber: 2,
            width: 800,
            height: 1200,
            url: 'https://cdn.example.com/source-p2.jpg',
          }}
          resultAsset={null}
          segments={[createMockSegment({ id: 'seg-p2', pageNumber: 2, bboxX: 80, bboxY: 120 })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const oldImg = screen.getByTestId('canvas-source-image');

      // User immediately switches to page 3 BEFORE page 2 image finishes loading
      rerender(
        <MangaStudioCanvas
          currentPage={3}
          workspaceRevision={10}
          sourceAsset={{
            kind: 'SOURCE_REVIEW',
            pageNumber: 3,
            width: 1000,
            height: 1500,
            url: 'https://cdn.example.com/source-p3.jpg',
          }}
          resultAsset={null}
          segments={[createMockSegment({ id: 'seg-p3', pageNumber: 3, bboxX: 100, bboxY: 150 })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // Now late onLoad from page 2 arrives on the old image instance
      Object.defineProperty(oldImg, 'naturalWidth', { value: 800 });
      Object.defineProperty(oldImg, 'naturalHeight', { value: 1200 });
      fireEvent.load(oldImg);

      // Page 3 overlay MUST NOT be rendered with page 2 dimensions
      expect(screen.queryByTestId('bbox-item-seg-p2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-p3')).not.toBeInTheDocument();

      // Now current page 3 image loads with page 3 dimensions
      const page3Img = screen.getByTestId('canvas-source-image');
      Object.defineProperty(page3Img, 'naturalWidth', { value: 1000 });
      Object.defineProperty(page3Img, 'naturalHeight', { value: 1500 });
      fireEvent.load(page3Img);

      // Page 3 bounding box renders correctly
      const p3Box = screen.getByTestId('bbox-item-seg-p3');
      expect(p3Box).toBeInTheDocument();
      expect(p3Box.style.left).toBe('10%'); // 100 / 1000
    });

    it('C10. Source/Result geometry integrity: RESULT dimensions difference does not affect SOURCE bbox calculation', () => {
      const resultWithDifferentDims: ReviewAssetDto = {
        kind: 'RESULT',
        pageNumber: 1,
        width: 2000, // Different dimensions from source!
        height: 3000,
        url: 'https://cdn.example.com/result-upscaled-p1.jpg',
      };

      const seg = createMockSegment({ id: 'seg-res-check', bboxX: 100, bboxY: 150 });

      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset} // 1000 x 1500
          resultAsset={resultWithDifferentDims}
          segments={[seg]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      const box = screen.getByTestId('bbox-item-seg-res-check');
      // Must be calculated relative to SOURCE (1000x1500), NOT RESULT (2000x3000)
      expect(box.style.left).toBe('10%'); // 100 / 1000 = 10% (NOT 100 / 2000 = 5%)
    });

    it('C11. Wide-image scaling & overlay plane alignment (P1-1): source image enforces max-w-full and overlay container matches wrapper', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={{
            kind: 'SOURCE_REVIEW',
            pageNumber: 1,
            width: 2000, // Wide landscape image
            height: 800,
            url: 'https://cdn.example.com/source-wide.jpg',
          }}
          resultAsset={null}
          segments={[createMockSegment({ bboxX: 1000, bboxY: 400, bboxW: 500, bboxH: 200 })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      // Critical P1-1 invariant: Image must be constrained by max-w-full to prevent horizontal overflow and unaligned overlay plane
      expect(sourceImg.className).toContain('max-w-full');
      expect(sourceImg.className).toContain('max-h-[75vh]');
      expect(sourceImg.className).toContain('w-auto');
      expect(sourceImg.className).toContain('h-auto');
      expect(sourceImg.className).toContain('object-contain');
      expect(sourceImg.className).toContain('block');

      // Trigger image load to render overlay
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 2000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 800 });
      fireEvent.load(sourceImg);

      // Wrapper and overlay container must have identical bounding plane
      const wrapper = screen.getByTestId('canvas-source-wrapper');
      const overlay = screen.getByTestId('canvas-overlay-container');
      expect(wrapper.className).toContain('relative');
      expect(wrapper.className).toContain('inline-block');
      expect(overlay.className).toContain('absolute');
      expect(overlay.className).toContain('inset-0');
    });

    it('C12. Independent pane availability (P1-2): RESULT mode accessible when sourceAsset is null', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null} // Source asset missing/not available
          resultAsset={mockResultAsset} // Result asset is available!
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // In RESULT mode, result image MUST be rendered without being blocked by missing sourceAsset
      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      expect(screen.getByTestId('canvas-result-image')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-loading-placeholder')).not.toBeInTheDocument();

      // Switch to SOURCE mode: should show source unavailable placeholder
      fireEvent.click(screen.getByTestId('view-mode-source-button'));
      expect(screen.getByTestId('canvas-source-unavailable')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();

      // Switch to SIDE_BY_SIDE: source pane shows unavailable, but result pane shows image
      fireEvent.click(screen.getByTestId('view-mode-split-button'));
      expect(screen.getByTestId('canvas-source-unavailable')).toBeInTheDocument();
      expect(screen.getByTestId('canvas-result-image')).toBeInTheDocument();
    });

    it('C13. Error prop fail-safe (P2-1): renders canvas-error-state when error is provided and suppresses content', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[createMockSegment()]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          error="PREVIEWS_WINDOW_FAILED"
        />
      );

      expect(screen.getByTestId('canvas-error-state')).toBeInTheDocument();
      expect(screen.getByText('PREVIEWS_WINDOW_FAILED')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();
    });

    it('C14. Broken image decode failure (P2-2): triggers onError and displays broken image placeholder', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[createMockSegment()]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      // Simulate image decode failure
      fireEvent.error(sourceImg);

      expect(screen.getByTestId('canvas-source-error')).toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-1')).not.toBeInTheDocument();
    });

    it('C15. Pane unmount/remount integrity reset (P1): remounted source pane resets state to LOADING and prevents stale VERIFIED reuse', () => {
      const { rerender } = render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[createMockSegment({ id: 'seg-remount-1' })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // 1. Initial SOURCE mode: load image -> verified -> bbox appears
      const sourceImg1 = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg1, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg1, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg1);
      expect(screen.getByTestId('bbox-item-seg-remount-1')).toBeInTheDocument();

      // 2. Switch to RESULT mode: source pane completely unmounts
      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-remount-1')).not.toBeInTheDocument();

      // 3. Switch to SIDE_BY_SIDE: source pane remounts with a NEW DOM instance
      fireEvent.click(screen.getByTestId('view-mode-split-button'));
      const sourceImg2 = screen.getByTestId('canvas-source-image');
      expect(sourceImg2).toBeInTheDocument();

      // CRITICAL P1 INVARIANT: Bounding box MUST NOT exist before sourceImg2 finishes onLoad/integrity check!
      expect(screen.queryByTestId('bbox-item-seg-remount-1')).not.toBeInTheDocument();

      // 4. Now sourceImg2 finishes loading
      Object.defineProperty(sourceImg2, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg2, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg2);
      expect(screen.getByTestId('bbox-item-seg-remount-1')).toBeInTheDocument();

      // 5. Test asset -> null -> same asset transition
      rerender(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null} // Null out source asset
          resultAsset={mockResultAsset}
          segments={[createMockSegment({ id: 'seg-remount-1' })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bbox-item-seg-remount-1')).not.toBeInTheDocument();

      // Restore same asset
      rerender(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={mockResultAsset}
          segments={[createMockSegment({ id: 'seg-remount-1' })]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );
      const sourceImg3 = screen.getByTestId('canvas-source-image');
      // Must still be LOADING, old VERIFIED must not revive
      expect(screen.queryByTestId('bbox-item-seg-remount-1')).not.toBeInTheDocument();
      Object.defineProperty(sourceImg3, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg3, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg3);
      expect(screen.getByTestId('bbox-item-seg-remount-1')).toBeInTheDocument();
    });

    it('C16. Result image decode failure (P2): triggers onError and renders result error placeholder', () => {
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null}
          resultAsset={mockResultAsset}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
        />
      );

      // Switch to RESULT mode
      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      const resultImg = screen.getByTestId('canvas-result-image');
      expect(resultImg).toBeInTheDocument();

      // Trigger error on result image
      fireEvent.error(resultImg);
      expect(screen.getByTestId('canvas-result-error')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-result-image')).not.toBeInTheDocument();
    });

    it('C17. Source image onError invokes onPreviewAssetError callback with kind SOURCE and currentSourceImageKey', () => {
      const onPreviewAssetErrorSpy = vi.fn();
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          onPreviewAssetError={onPreviewAssetErrorSpy}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      expect(sourceImg).toBeInTheDocument();

      fireEvent.error(sourceImg);
      expect(onPreviewAssetErrorSpy).toHaveBeenCalledTimes(1);
      expect(onPreviewAssetErrorSpy).toHaveBeenCalledWith(
        'SOURCE',
        `10:1:${mockSourceAsset.url}`
      );
    });

    it('C18. Result image onError invokes onPreviewAssetError callback with kind RESULT and currentResultImageKey', () => {
      const onPreviewAssetErrorSpy = vi.fn();
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null}
          resultAsset={mockResultAsset}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          onPreviewAssetError={onPreviewAssetErrorSpy}
        />
      );

      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      const resultImg = screen.getByTestId('canvas-result-image');
      expect(resultImg).toBeInTheDocument();

      fireEvent.error(resultImg);
      expect(onPreviewAssetErrorSpy).toHaveBeenCalledTimes(1);
      expect(onPreviewAssetErrorSpy).toHaveBeenCalledWith(
        'RESULT',
        `10:1:${mockResultAsset.url}`
      );
    });

    it('C19. Stale error event with non-matching data-image-key does NOT invoke onPreviewAssetError', () => {
      const onPreviewAssetErrorSpy = vi.fn();
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          onPreviewAssetError={onPreviewAssetErrorSpy}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      sourceImg.setAttribute('data-image-key', 'stale:old:key');

      fireEvent.error(sourceImg);
      expect(onPreviewAssetErrorSpy).not.toHaveBeenCalled();
    });

    it('C20. Changing presentationEpoch remounts image and resets LOAD_ERROR to fresh image load attempt even if URL is identical (#149 P1-2)', () => {
      const { rerender } = render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          presentationEpoch={0}
        />
      );

      const firstImg = screen.getByTestId('canvas-source-image');
      expect(firstImg).toBeInTheDocument();
      expect(firstImg.getAttribute('data-presentation-epoch')).toBe('0');

      // Fail image decode -> transitions to LOAD_ERROR
      fireEvent.error(firstImg);
      expect(screen.getByTestId('canvas-source-error')).toBeInTheDocument();
      expect(screen.queryByTestId('canvas-source-image')).not.toBeInTheDocument();

      // Rerender with incremented presentationEpoch (same sourceAsset.url!)
      rerender(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          presentationEpoch={1}
        />
      );

      // Error placeholder must be dismissed, and a fresh <img> DOM instance with presentationEpoch=1 must be mounted
      expect(screen.queryByTestId('canvas-source-error')).not.toBeInTheDocument();
      const freshImg = screen.getByTestId('canvas-source-image');
      expect(freshImg).toBeInTheDocument();
      expect(freshImg.getAttribute('data-presentation-epoch')).toBe('1');
    });

    it('C21. Successful source image integrity verification triggers onPreviewAssetLoaded callback with kind SOURCE and imageKey', () => {
      const onPreviewAssetLoadedSpy = vi.fn();
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={mockSourceAsset}
          resultAsset={null}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          onPreviewAssetLoaded={onPreviewAssetLoadedSpy}
        />
      );

      const sourceImg = screen.getByTestId('canvas-source-image');
      Object.defineProperty(sourceImg, 'naturalWidth', { value: 1000 });
      Object.defineProperty(sourceImg, 'naturalHeight', { value: 1500 });
      fireEvent.load(sourceImg);

      expect(onPreviewAssetLoadedSpy).toHaveBeenCalledTimes(1);
      expect(onPreviewAssetLoadedSpy).toHaveBeenCalledWith(
        'SOURCE',
        `10:1:${mockSourceAsset.url}`
      );
    });

    it('C22. Successful result image load triggers onPreviewAssetLoaded callback with kind RESULT and imageKey', () => {
      const onPreviewAssetLoadedSpy = vi.fn();
      render(
        <MangaStudioCanvas
          currentPage={1}
          workspaceRevision={10}
          sourceAsset={null}
          resultAsset={mockResultAsset}
          segments={[]}
          selectedSegmentId={null}
          onSelectSegment={vi.fn()}
          onPreviewAssetLoaded={onPreviewAssetLoadedSpy}
        />
      );

      fireEvent.click(screen.getByTestId('view-mode-result-button'));
      const resultImg = screen.getByTestId('canvas-result-image');
      fireEvent.load(resultImg);

      expect(onPreviewAssetLoadedSpy).toHaveBeenCalledTimes(1);
      expect(onPreviewAssetLoadedSpy).toHaveBeenCalledWith(
        'RESULT',
        `10:1:${mockResultAsset.url}`
      );
    });
  });
});

