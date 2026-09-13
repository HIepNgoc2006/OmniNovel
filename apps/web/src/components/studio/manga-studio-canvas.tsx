'use client';

import React, { useState, useMemo } from 'react';
import type { TranslationSegmentDto, ReviewAssetDto } from '@omninovel/shared';
import {
  checkImageDimensionsIntegrity,
  filterPageSegmentsForCanvas,
} from '../../lib/studio/manga-canvas-geometry';
import {
  Layers,
  Columns,
  Image as ImageIcon,
  Sparkles,
  AlertCircle,
  Loader2,
  ImageOff,
} from 'lucide-react';

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

export type ImageIntegrityState =
  | 'LOADING'
  | 'VERIFIED'
  | 'DIMENSION_MISMATCH'
  | 'LOAD_ERROR';

export type ResultImageState = 'LOADING' | 'READY' | 'LOAD_ERROR';

export interface CanvasSourcePaneProps {
  currentPage: number;
  workspaceRevision: number;
  sourceAsset: ReviewAssetDto | null;
  segments: TranslationSegmentDto[];
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string) => void;
  isLoading?: boolean;
}

/**
 * Isolated Source Pane Component (P1 Option A)
 * Local ImageIntegrityState is tied directly to this component instance's lifecycle.
 * Unmounting and remounting (e.g. view mode toggling SOURCE -> RESULT -> SIDE_BY_SIDE)
 * resets state to 'LOADING', preventing stale 'VERIFIED' state from being reused
 * before the newly mounted DOM image instance finishes decoding and verification.
 */
export const CanvasSourcePane: React.FC<CanvasSourcePaneProps> = ({
  currentPage,
  workspaceRevision,
  sourceAsset,
  segments,
  selectedSegmentId,
  onSelectSegment,
  isLoading = false,
}) => {
  const isSourcePageMismatch = Boolean(sourceAsset && sourceAsset.pageNumber !== currentPage);

  const currentSourceImageKey = sourceAsset
    ? `${workspaceRevision}:${currentPage}:${sourceAsset.url}`
    : '';

  const [imageStatus, setImageStatus] = useState<{
    key: string;
    state: ImageIntegrityState;
  }>({ key: currentSourceImageKey, state: 'LOADING' });

  // If key changes during lifecycle without unmount (e.g. sourceAsset transitions asset -> null -> same asset), reset immediately
  const [prevKey, setPrevKey] = useState(currentSourceImageKey);
  if (prevKey !== currentSourceImageKey) {
    setPrevKey(currentSourceImageKey);
    setImageStatus({ key: currentSourceImageKey, state: 'LOADING' });
  }

  const effectiveStatus: ImageIntegrityState =
    imageStatus.key === currentSourceImageKey ? imageStatus.state : 'LOADING';

  const handleSourceImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const targetKey = img.getAttribute('data-image-key');
    if (targetKey !== currentSourceImageKey) return;

    const isIntegrityValid = checkImageDimensionsIntegrity(
      { width: sourceAsset?.width, height: sourceAsset?.height },
      { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight },
    );

    setImageStatus({
      key: currentSourceImageKey,
      state: isIntegrityValid ? 'VERIFIED' : 'DIMENSION_MISMATCH',
    });
  };

  const handleSourceImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const targetKey = img.getAttribute('data-image-key');
    if (targetKey !== currentSourceImageKey) return;

    setImageStatus({
      key: currentSourceImageKey,
      state: 'LOAD_ERROR',
    });
  };

  const canRenderOverlay =
    !isSourcePageMismatch &&
    Boolean(sourceAsset) &&
    effectiveStatus === 'VERIFIED';

  const pageBoxes = useMemo(() => {
    if (!canRenderOverlay || !sourceAsset) {
      return [];
    }
    return filterPageSegmentsForCanvas(segments, currentPage, {
      width: sourceAsset.width,
      height: sourceAsset.height,
    });
  }, [canRenderOverlay, segments, currentPage, sourceAsset]);

  const segmentsById = useMemo(() => {
    const map = new Map<string, TranslationSegmentDto>();
    for (const seg of segments) {
      map.set(seg.id, seg);
    }
    return map;
  }, [segments]);

  if (isSourcePageMismatch) {
    return (
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
    );
  }

  if (isLoading && !sourceAsset) {
    return (
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
    );
  }

  if (!sourceAsset) {
    return (
      <div
        data-testid="canvas-source-unavailable"
        className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-3 border border-slate-800/80 rounded-2xl bg-slate-900/30 max-w-md"
      >
        <ImageOff className="w-8 h-8 text-slate-500" />
        <div className="space-y-1">
          <p className="font-medium text-sm">Ảnh gốc không khả dụng</p>
          <p className="text-xs text-slate-500">
            Không tìm thấy ảnh nguồn cho trang {currentPage}.
          </p>
        </div>
      </div>
    );
  }

  if (effectiveStatus === 'LOAD_ERROR') {
    return (
      <div
        data-testid="canvas-source-error"
        className="flex flex-col items-center justify-center p-8 text-center text-rose-400 gap-3 border border-rose-500/30 rounded-2xl bg-rose-950/20 max-w-md"
      >
        <ImageOff className="w-8 h-8 text-rose-400" />
        <div className="space-y-1">
          <p className="font-medium text-sm">Lỗi tải ảnh gốc</p>
          <p className="text-xs text-slate-400">
            Không thể tải hoặc giải mã hình ảnh trang {currentPage}. URL có thể đã hết hạn hoặc kết nối bị gián đoạn.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="canvas-source-wrapper"
      className="relative inline-block max-w-full max-h-full select-none shadow-2xl rounded-lg overflow-hidden border border-slate-800"
    >
      <img
        key={currentSourceImageKey}
        data-testid="canvas-source-image"
        data-image-key={currentSourceImageKey}
        src={sourceAsset.url}
        alt={`Trang gốc ${currentPage}`}
        onLoad={handleSourceImageLoad}
        onError={handleSourceImageError}
        className="block max-w-full max-h-[75vh] w-auto h-auto object-contain"
      />

      {/* OCR Bounding Boxes Overlay: exact alignment with rendered image */}
      {canRenderOverlay && (
        <div
          data-testid="canvas-overlay-container"
          className="absolute inset-0 pointer-events-auto"
        >
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
  );
};

export interface CanvasResultPaneProps {
  currentPage: number;
  workspaceRevision: number;
  resultAsset: ReviewAssetDto | null;
  isLoading?: boolean;
}

/**
 * Isolated Result Pane Component (P2)
 * Manages result image presentation and handles broken image / onError decoding states.
 */
export const CanvasResultPane: React.FC<CanvasResultPaneProps> = ({
  currentPage,
  workspaceRevision,
  resultAsset,
  isLoading = false,
}) => {
  const isResultPageMismatch = Boolean(resultAsset && resultAsset.pageNumber !== currentPage);
  const currentResultImageKey = resultAsset
    ? `${workspaceRevision}:${currentPage}:${resultAsset.url}`
    : '';

  const [resultStatus, setResultStatus] = useState<{
    key: string;
    state: ResultImageState;
  }>({ key: currentResultImageKey, state: 'LOADING' });

  const [prevResultKey, setPrevResultKey] = useState(currentResultImageKey);
  if (prevResultKey !== currentResultImageKey) {
    setPrevResultKey(currentResultImageKey);
    setResultStatus({ key: currentResultImageKey, state: 'LOADING' });
  }

  const effectiveResultStatus: ResultImageState =
    resultStatus.key === currentResultImageKey ? resultStatus.state : 'LOADING';

  const handleResultImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (e.currentTarget.getAttribute('data-image-key') !== currentResultImageKey) return;
    setResultStatus({ key: currentResultImageKey, state: 'READY' });
  };

  const handleResultImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (e.currentTarget.getAttribute('data-image-key') !== currentResultImageKey) return;
    setResultStatus({ key: currentResultImageKey, state: 'LOAD_ERROR' });
  };

  if (isResultPageMismatch) {
    return (
      <div
        data-testid="canvas-mismatch-placeholder"
        className="flex flex-col items-center justify-center p-8 text-center text-amber-400/90 gap-3 border border-amber-500/30 rounded-2xl bg-amber-950/20 max-w-md"
      >
        <AlertCircle className="w-8 h-8 text-amber-400" />
        <div className="space-y-1">
          <p className="font-medium text-sm">Dữ liệu kết quả chưa đồng bộ</p>
          <p className="text-xs text-slate-400">
            Ảnh kết quả thuộc trang {resultAsset?.pageNumber} trong khi studio đang hiển thị trang {currentPage}.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading && !resultAsset) {
    return (
      <div
        data-testid="canvas-loading-placeholder"
        className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-3 border border-slate-800/80 rounded-2xl bg-slate-900/30 max-w-md"
      >
        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
        <div className="space-y-1">
          <p className="font-medium text-sm">Đang tải kết quả trang {currentPage}...</p>
          <p className="text-xs text-slate-500">
            Vui lòng đợi trong khi tải kết quả bản dịch.
          </p>
        </div>
      </div>
    );
  }

  if (!resultAsset) {
    return (
      <div
        data-testid="canvas-result-unavailable"
        className="flex flex-col items-center justify-center p-8 text-center text-slate-400 border border-slate-800 rounded-2xl bg-slate-900/40 max-w-md"
      >
        <Sparkles className="w-6 h-6 text-slate-600 mb-2" />
        <p className="text-xs font-medium">Chưa có kết quả dịch cho trang {currentPage}</p>
        <p className="text-[11px] text-slate-500 mt-1">
          Bản dịch đang xử lý hoặc chưa được sinh.
        </p>
      </div>
    );
  }

  if (effectiveResultStatus === 'LOAD_ERROR') {
    return (
      <div
        data-testid="canvas-result-error"
        className="flex flex-col items-center justify-center p-8 text-center text-rose-400 gap-3 border border-rose-500/30 rounded-2xl bg-rose-950/20 max-w-md"
      >
        <ImageOff className="w-8 h-8 text-rose-400" />
        <div className="space-y-1">
          <p className="font-medium text-sm">Lỗi tải ảnh kết quả</p>
          <p className="text-xs text-slate-400">
            Không thể tải hoặc giải mã hình ảnh kết quả trang {currentPage}. URL có thể đã hết hạn hoặc kết nối bị gián đoạn.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="canvas-result-wrapper"
      className="relative inline-block max-w-full max-h-full select-none shadow-2xl rounded-lg overflow-hidden border border-slate-800"
    >
      <img
        key={currentResultImageKey}
        data-testid="canvas-result-image"
        data-image-key={currentResultImageKey}
        src={resultAsset.url}
        alt={`Trang đã dịch ${currentPage}`}
        onLoad={handleResultImageLoad}
        onError={handleResultImageError}
        className="block max-w-full max-h-[75vh] w-auto h-auto object-contain"
      />
      {/* In RESULT mode / Result Pane, OCR bounding boxes are NEVER rendered */}
    </div>
  );
};

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
        {/* P2-1: Error state has highest precedence, fails closed completely */}
        {error ? (
          <div
            data-testid="canvas-error-state"
            className="flex flex-col items-center justify-center p-8 text-center text-rose-400 gap-3 border border-rose-500/30 rounded-2xl bg-rose-950/20 max-w-md"
          >
            <AlertCircle className="w-8 h-8 text-rose-400" />
            <div className="space-y-1">
              <p className="font-medium text-sm">Không thể hiển thị Canvas</p>
              <p className="text-xs text-slate-400">{error}</p>
            </div>
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {viewMode === 'SOURCE' && (
              <div className="relative flex items-center justify-center w-full h-full">
                <CanvasSourcePane
                  key={`source:${workspaceRevision}:${currentPage}:${sourceAsset?.url ?? 'none'}`}
                  currentPage={currentPage}
                  workspaceRevision={workspaceRevision}
                  sourceAsset={sourceAsset}
                  segments={segments}
                  selectedSegmentId={selectedSegmentId}
                  onSelectSegment={onSelectSegment}
                  isLoading={isLoading}
                />
              </div>
            )}

            {viewMode === 'RESULT' && (
              <div className="relative flex items-center justify-center w-full h-full">
                <CanvasResultPane
                  key={`result:${workspaceRevision}:${currentPage}:${resultAsset?.url ?? 'none'}`}
                  currentPage={currentPage}
                  workspaceRevision={workspaceRevision}
                  resultAsset={resultAsset}
                  isLoading={isLoading}
                />
              </div>
            )}

            {viewMode === 'SIDE_BY_SIDE' && (
              <div className="w-full h-full grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="relative flex items-center justify-center w-full h-full">
                  <CanvasSourcePane
                    key={`split-source:${workspaceRevision}:${currentPage}:${sourceAsset?.url ?? 'none'}`}
                    currentPage={currentPage}
                    workspaceRevision={workspaceRevision}
                    sourceAsset={sourceAsset}
                    segments={segments}
                    selectedSegmentId={selectedSegmentId}
                    onSelectSegment={onSelectSegment}
                    isLoading={isLoading}
                  />
                </div>
                <div className="relative flex items-center justify-center w-full h-full">
                  <CanvasResultPane
                    key={`split-result:${workspaceRevision}:${currentPage}:${resultAsset?.url ?? 'none'}`}
                    currentPage={currentPage}
                    workspaceRevision={workspaceRevision}
                    resultAsset={resultAsset}
                    isLoading={isLoading}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
