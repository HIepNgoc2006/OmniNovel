'use client';

import React, { useState, useMemo } from 'react';
import type { TranslationSegmentDto, ReviewAssetDto } from '@omninovel/shared';
import {
  checkImageDimensionsIntegrity,
  filterPageSegmentsForCanvas,
} from '../../lib/studio/manga-canvas-geometry';
import { Layers, Columns, Image as ImageIcon, Sparkles, AlertCircle, Loader2 } from 'lucide-react';

export interface MangaStudioCanvasProps {
  currentPage: number;
  workspaceRevision: number;
  sourceAsset: ReviewAssetDto | null;
  resultAsset: ReviewAssetDto | null;
  segments: TranslationSegmentDto[];
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string) => void;
  isLoading?: boolean;
  error?: string | null;
}

export type CanvasViewMode = 'SOURCE' | 'RESULT' | 'SIDE_BY_SIDE';

export const MangaStudioCanvas: React.FC<MangaStudioCanvasProps> = ({
  currentPage,
  workspaceRevision,
  sourceAsset,
  resultAsset,
  segments,
  selectedSegmentId,
  onSelectSegment,
  isLoading = false,
  error = null,
}) => {
  const [viewMode, setViewMode] = useState<CanvasViewMode>('SOURCE');
  const [verifiedImageKey, setVerifiedImageKey] = useState<string | null>(null);

  // Stale Page / Asset Isolation check (C8)
  const isPageMismatch = Boolean(sourceAsset && sourceAsset.pageNumber !== currentPage);

  // Fail-closed condition when loading or sourceAsset is unavailable (C2)
  const isCanvasLoading = isLoading || !sourceAsset;

  // Identity Token for image load race protection (C9)
  const currentImageKey = sourceAsset
    ? `${workspaceRevision}:${currentPage}:${sourceAsset.url}`
    : '';

  // Handle source image onLoad event
  const handleSourceImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const targetKey = img.getAttribute('data-image-key');

    // Late onLoad race protection (C9): Ignore if token doesn't match current active token
    if (targetKey !== currentImageKey) {
      return;
    }

    // Integrity Check (G6, C9): Compare decoded dimensions with authoritative sourceAsset metadata
    const isIntegrityValid = checkImageDimensionsIntegrity(
      { width: sourceAsset?.width, height: sourceAsset?.height },
      { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight },
    );

    if (isIntegrityValid) {
      setVerifiedImageKey(currentImageKey);
    } else {
      // Fail-closed: do not render bounding box overlay if dimensions mismatch
      setVerifiedImageKey(null);
    }
  };

  // Overlay can ONLY render when integrity check passes and mode permits it
  const canRenderOverlay =
    (viewMode === 'SOURCE' || viewMode === 'SIDE_BY_SIDE') &&
    !isPageMismatch &&
    !isCanvasLoading &&
    verifiedImageKey === currentImageKey;

  // Normalized bounding boxes for the current page
  const pageBoxes = useMemo(() => {
    if (!canRenderOverlay || !sourceAsset) {
      return [];
    }
    return filterPageSegmentsForCanvas(segments, currentPage, {
      width: sourceAsset.width,
      height: sourceAsset.height,
    });
  }, [canRenderOverlay, segments, currentPage, sourceAsset]);

  // Lookup map for fast segment retrieval
  const segmentsById = useMemo(() => {
    const map = new Map<string, TranslationSegmentDto>();
    for (const seg of segments) {
      map.set(seg.id, seg);
    }
    return map;
  }, [segments]);

  return (
    <div className="flex flex-col h-full w-full bg-slate-950/60 border border-slate-800 rounded-2xl overflow-hidden shadow-inner">
      {/* Top Action Bar: View Mode Switcher */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/80 border-b border-slate-800 text-xs select-none">
        <div className="flex items-center gap-2 text-slate-300 font-medium">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span>Canvas Studio — Trang {currentPage}</span>
        </div>

        {/* View Mode Switcher Buttons (C3) */}
        <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800/80 gap-1">
          <button
            type="button"
            data-testid="view-mode-source-button"
            onClick={() => setViewMode('SOURCE')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'SOURCE'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>Ảnh gốc</span>
          </button>

          <button
            type="button"
            data-testid="view-mode-result-button"
            onClick={() => setViewMode('RESULT')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'RESULT'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Đã dịch</span>
          </button>

          <button
            type="button"
            data-testid="view-mode-split-button"
            onClick={() => setViewMode('SIDE_BY_SIDE')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === 'SIDE_BY_SIDE'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            <span>So sánh</span>
          </button>
        </div>
      </div>

      {/* Main Display Area */}
      <div className="flex-1 relative overflow-auto p-4 flex items-center justify-center min-h-[450px]">
        {/* State 1: Stale Page Mismatch Placeholder (C8) */}
        {isPageMismatch && (
          <div
            data-testid="canvas-mismatch-placeholder"
            className="flex flex-col items-center justify-center p-8 text-center text-amber-400/90 gap-3 border border-amber-500/30 rounded-2xl bg-amber-950/20 max-w-md"
          >
            <AlertCircle className="w-8 h-8 text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium text-sm">Dữ liệu trang chưa đồng bộ</p>
              <p className="text-xs text-slate-400">
                Ảnh hiện tại thuộc trang {sourceAsset?.pageNumber} trong khi studio đang hiển thị trang {currentPage}. Đang chờ dữ liệu trang mới...
              </p>
            </div>
          </div>
        )}

        {/* State 2: Loading or Missing Asset Placeholder (C2) */}
        {!isPageMismatch && isCanvasLoading && (
          <div
            data-testid="canvas-loading-placeholder"
            className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-3 border border-slate-800/80 rounded-2xl bg-slate-900/30 max-w-md"
          >
            <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            <div className="space-y-1">
              <p className="font-medium text-sm">Đang tải hình ảnh trang {currentPage}...</p>
              <p className="text-xs text-slate-500">
                Vui lòng đợi giây lát trong khi hệ thống đồng bộ hình ảnh và tọa độ OCR.
              </p>
            </div>
          </div>
        )}

        {/* State 3: Normal Content Display */}
        {!isPageMismatch && !isCanvasLoading && (
          <div
            className={`w-full h-full flex items-center justify-center ${
              viewMode === 'SIDE_BY_SIDE' ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : ''
            }`}
          >
            {/* SOURCE PANE: Present in SOURCE and SIDE_BY_SIDE modes */}
            {(viewMode === 'SOURCE' || viewMode === 'SIDE_BY_SIDE') && (
              <div className="relative flex items-center justify-center w-full h-full">
                <div className="relative inline-block max-w-full max-h-full select-none shadow-2xl rounded-lg overflow-hidden border border-slate-800">
                  <img
                    key={currentImageKey}
                    data-testid="canvas-source-image"
                    data-image-key={currentImageKey}
                    src={sourceAsset.url}
                    alt={`Trang gốc ${currentPage}`}
                    onLoad={handleSourceImageLoad}
                    className="max-h-[75vh] w-auto object-contain block"
                  />

                  {/* OCR Bounding Boxes Overlay */}
                  {canRenderOverlay && (
                    <div className="absolute inset-0 pointer-events-auto">
                      {pageBoxes.map((box) => {
                        const seg = segmentsById.get(box.segmentId);
                        const isSelected = selectedSegmentId === box.segmentId;
                        const isVerified = seg?.isHumanVerified ?? false;

                        return (
                          <div
                            key={box.segmentId}
                            data-testid={`bbox-item-${box.segmentId}`}
                            data-selected={isSelected ? 'true' : 'false'}
                            data-verified={isVerified ? 'true' : 'false'}
                            onClick={() => onSelectSegment(box.segmentId)}
                            className={`absolute cursor-pointer transition-all border-2 rounded-sm ${
                              isSelected
                                ? 'border-cyan-400 bg-cyan-400/25 ring-2 ring-cyan-400/60 shadow-[0_0_12px_rgba(34,211,238,0.5)] z-20'
                                : isVerified
                                ? 'border-emerald-500/80 bg-emerald-500/10 hover:border-emerald-400 hover:bg-emerald-500/20 z-10'
                                : 'border-amber-400/80 bg-amber-400/10 hover:border-amber-300 hover:bg-amber-400/20 z-10'
                            }`}
                            style={{
                              left: `${box.leftPct}%`,
                              top: `${box.topPct}%`,
                              width: `${box.widthPct}%`,
                              height: `${box.heightPct}%`,
                            }}
                            role="button"
                            tabIndex={0}
                            aria-label={`Vùng dịch ${box.segmentId}`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onSelectSegment(box.segmentId);
                              }
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* RESULT PANE: Present in RESULT and SIDE_BY_SIDE modes */}
            {(viewMode === 'RESULT' || viewMode === 'SIDE_BY_SIDE') && (
              <div className="relative flex items-center justify-center w-full h-full">
                {resultAsset && resultAsset.pageNumber === currentPage ? (
                  <div className="relative inline-block max-w-full max-h-full select-none shadow-2xl rounded-lg overflow-hidden border border-slate-800">
                    <img
                      data-testid="canvas-result-image"
                      src={resultAsset.url}
                      alt={`Trang đã dịch ${currentPage}`}
                      className="max-h-[75vh] w-auto object-contain block"
                    />
                    {/* Note: In RESULT mode / Result Pane, OCR bounding boxes are NEVER rendered */}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center p-6 text-center text-slate-400 border border-slate-800 rounded-2xl bg-slate-900/40">
                    <Sparkles className="w-6 h-6 text-slate-600 mb-2" />
                    <p className="text-xs font-medium">Chưa có kết quả dịch cho trang {currentPage}</p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Bản dịch đang xử lý hoặc chưa được sinh.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
