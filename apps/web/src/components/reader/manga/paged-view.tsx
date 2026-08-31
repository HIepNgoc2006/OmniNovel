'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, RefreshCw } from 'lucide-react';
import { MediaAssetSummary } from '@omninovel/shared';
import { PagedDirection, PagedLayout } from '../../../lib/reader/types';
import { getMediaPresignedUrlApi } from '../../../lib/api/chapters';

interface PagedViewProps {
  assets: MediaAssetSummary[];
  currentPage: number;
  direction: PagedDirection;
  layout: PagedLayout;
  onPageChange: (page: number) => void;
  onCenterClick?: () => void;
}

export function PagedView({
  assets,
  currentPage,
  direction,
  layout,
  onPageChange,
  onCenterClick,
}: PagedViewProps) {
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [failedAssets, setFailedAssets] = useState<Record<string, boolean>>({});

  const totalPages = assets.length;

  // Lấy danh sách index của trang hiển thị (single: 1 trang, double: 2 trang)
  const isDouble = layout === 'double' && totalPages > 1;
  const primaryIndex = Math.max(0, Math.min(totalPages - 1, currentPage - 1));
  const secondaryIndex = isDouble && primaryIndex + 1 < totalPages ? primaryIndex + 1 : null;

  const currentAssetPrimary = assets[primaryIndex];
  const currentAssetSecondary = secondaryIndex !== null ? assets[secondaryIndex] : null;

  // Preload presigned URLs cho trang hiện tại và các trang lân cận
  useEffect(() => {
    let isMounted = true;
    const indicesToLoad = [
      primaryIndex,
      secondaryIndex,
      primaryIndex - 1,
      primaryIndex + 1,
      primaryIndex + 2,
    ].filter((idx): idx is number => idx !== null && idx >= 0 && idx < totalPages);

    indicesToLoad.forEach((idx) => {
      const asset = assets[idx];
      if (asset && !imageUrls[asset.id] && !failedAssets[asset.id]) {
        getMediaPresignedUrlApi(asset.id)
          .then((res) => {
            if (isMounted && res.downloadUrl) {
              setImageUrls((prev) => ({ ...prev, [asset.id]: res.downloadUrl }));
            }
          })
          .catch(() => {
            if (isMounted) {
              setFailedAssets((prev) => ({ ...prev, [asset.id]: true }));
            }
          });
      }
    });

    return () => {
      isMounted = false;
    };
  }, [assets, failedAssets, imageUrls, primaryIndex, secondaryIndex, totalPages]);

  const handlePrev = useCallback(() => {
    const step = isDouble ? 2 : 1;
    if (currentPage > 1) {
      onPageChange(Math.max(1, currentPage - step));
    }
  }, [currentPage, isDouble, onPageChange]);

  const handleNext = useCallback(() => {
    const step = isDouble ? 2 : 1;
    if (currentPage < totalPages) {
      onPageChange(Math.min(totalPages, currentPage + step));
    }
  }, [currentPage, isDouble, onPageChange, totalPages]);

  const handleZoneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / rect.width;

    if (clickX >= 0.35 && clickX <= 0.65) {
      // Vùng giữa -> Bật/Tắt HUD
      if (onCenterClick) onCenterClick();
    } else if (clickX < 0.35) {
      // Vùng trái: RTL -> Next, LTR -> Prev
      if (direction === 'rtl') {
        handleNext();
      } else {
        handlePrev();
      }
    } else {
      // Vùng phải: RTL -> Prev, LTR -> Next
      if (direction === 'rtl') {
        handlePrev();
      } else {
        handleNext();
      }
    }
  };

  return (
    <div
      onClick={handleZoneClick}
      className="relative w-full h-[calc(100vh-3.5rem)] flex items-center justify-center p-2 sm:p-4 select-none cursor-pointer overflow-hidden"
    >
      {/* Container hiển thị ảnh */}
      <div className="relative max-h-full max-w-full flex items-center justify-center gap-2">
        {/* Trang thứ nhất / Single Page */}
        {currentAssetPrimary && (
          <div className="relative max-h-[calc(100vh-5rem)] flex items-center justify-center">
            {imageUrls[currentAssetPrimary.id] && !failedAssets[currentAssetPrimary.id] ? (
              <img
                src={imageUrls[currentAssetPrimary.id]}
                alt={`Trang ${primaryIndex + 1}`}
                className="max-h-[calc(100vh-5rem)] max-w-full object-contain rounded shadow-lg select-none"
              />
            ) : failedAssets[currentAssetPrimary.id] ? (
              <div className="w-80 h-96 flex items-center justify-center bg-slate-900 border border-slate-800 rounded-lg text-slate-500 gap-2">
                <ImageOff className="w-8 h-8 text-rose-500/70" />
                <p className="text-xs">Lỗi tải trang {primaryIndex + 1}</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setFailedAssets((prev) => ({ ...prev, [currentAssetPrimary.id]: false }));
                  }}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Thử lại
                </button>
              </div>
            ) : (
              <div className="w-80 h-96 flex items-center justify-center bg-slate-900/50 border border-slate-800/60 rounded-lg text-slate-500 text-xs animate-pulse">
                Đang tải trang {primaryIndex + 1}...
              </div>
            )}
          </div>
        )}

        {/* Trang thứ hai (chế độ Double Page) */}
        {isDouble && currentAssetSecondary && (
          <div className="relative max-h-[calc(100vh-5rem)] flex items-center justify-center">
            {imageUrls[currentAssetSecondary.id] && !failedAssets[currentAssetSecondary.id] ? (
              <img
                src={imageUrls[currentAssetSecondary.id]}
                alt={`Trang ${secondaryIndex !== null ? secondaryIndex + 1 : 2}`}
                className="max-h-[calc(100vh-5rem)] max-w-full object-contain rounded shadow-lg select-none"
              />
            ) : (
              <div className="w-80 h-96 flex items-center justify-center bg-slate-900/50 border border-slate-800/60 rounded-lg text-slate-500 text-xs animate-pulse">
                Đang tải trang {secondaryIndex !== null ? secondaryIndex + 1 : 2}...
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Navigation Controls (Ẩn trên mobile, hiện hover trên desktop) */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 hidden md:block">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (direction === 'rtl') handleNext();
            else handlePrev();
          }}
          disabled={direction === 'rtl' ? currentPage >= totalPages : currentPage <= 1}
          className="p-3 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed border border-slate-700/50 backdrop-blur-xs transition-all shadow-xl"
          title={direction === 'rtl' ? 'Trang tiếp (RTL)' : 'Trang trước'}
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      </div>

      <div className="absolute right-4 top-1/2 -translate-y-1/2 hidden md:block">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (direction === 'rtl') handlePrev();
            else handleNext();
          }}
          disabled={direction === 'rtl' ? currentPage <= 1 : currentPage >= totalPages}
          className="p-3 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed border border-slate-700/50 backdrop-blur-xs transition-all shadow-xl"
          title={direction === 'rtl' ? 'Trang trước (RTL)' : 'Trang tiếp'}
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
