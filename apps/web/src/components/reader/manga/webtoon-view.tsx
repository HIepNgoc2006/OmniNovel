'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, ImageOff } from 'lucide-react';
import { MediaAssetSummary } from '@omninovel/shared';
import { getMediaPresignedUrlApi } from '../../../lib/api/chapters';

interface WebtoonViewProps {
  assets: MediaAssetSummary[];
  onPageVisible?: (pageIndex: number) => void;
  onCenterClick?: () => void;
}

export function WebtoonView({
  assets,
  onPageVisible,
  onCenterClick,
}: WebtoonViewProps) {
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [failedAssets, setFailedAssets] = useState<Record<string, boolean>>({});
  const [retryCounts, setRetryCounts] = useState<Record<string, number>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 1. Tải presigned URL cho từng media asset
  useEffect(() => {
    let isMounted = true;

    assets.forEach((asset) => {
      if (!imageUrls[asset.id] && !failedAssets[asset.id]) {
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
  }, [assets, failedAssets, imageUrls]);

  // 2. Retry refresh signed URL khi gặp lỗi tải ảnh (tối đa 1 lần)
  const handleImageError = useCallback((assetId: string) => {
    const currentRetries = retryCounts[assetId] || 0;
    if (currentRetries < 1) {
      setRetryCounts((prev) => ({ ...prev, [assetId]: currentRetries + 1 }));
      getMediaPresignedUrlApi(assetId)
        .then((res) => {
          if (res.downloadUrl) {
            setImageUrls((prev) => ({ ...prev, [assetId]: res.downloadUrl }));
          } else {
            setFailedAssets((prev) => ({ ...prev, [assetId]: true }));
          }
        })
        .catch(() => {
          setFailedAssets((prev) => ({ ...prev, [assetId]: true }));
        });
    } else {
      setFailedAssets((prev) => ({ ...prev, [assetId]: true }));
    }
  }, [retryCounts]);

  // 3. IntersectionObserver để nhận diện trang đang hiển thị
  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = Number(entry.target.getAttribute('data-page-index'));
            if (!isNaN(index) && onPageVisible) {
              onPageVisible(index);
            }
          }
        });
      },
      {
        root: null,
        rootMargin: '-20% 0px -20% 0px',
        threshold: 0.1,
      },
    );

    imageRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [assets, onPageVisible]);

  // 4. Click handler (phân vùng 3 phần màn hình)
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const height = rect.height;

    // 1/3 vùng giữa kích hoạt bật/tắt HUD
    if (clickY >= height * 0.3 && clickY <= height * 0.7) {
      if (onCenterClick) onCenterClick();
    }
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="w-full max-w-3xl mx-auto flex flex-col items-center select-none cursor-pointer"
    >
      {assets.length === 0 ? (
        <div className="py-32 text-center text-slate-400">
          <p>Chương này chưa có hình ảnh nào được công bố.</p>
        </div>
      ) : (
        assets.map((asset, index) => {
          const url = imageUrls[asset.id];
          const isFailed = failedAssets[asset.id];
          const aspectRatioStyle =
            asset.width && asset.height
              ? { aspectRatio: `${asset.width} / ${asset.height}` }
              : { minHeight: '600px' };

          return (
            <div
              key={asset.id}
              ref={(el) => {
                imageRefs.current[index] = el;
              }}
              data-page-index={index + 1}
              style={{ ...aspectRatioStyle, contentVisibility: 'auto' }}
              className="w-full relative flex items-center justify-center bg-slate-950/60 border-b border-slate-900"
            >
              {url && !isFailed ? (
                <img
                  src={url}
                  alt={`Trang ${index + 1}`}
                  loading={index < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  onError={() => handleImageError(asset.id)}
                  className="w-full h-auto block object-contain select-none"
                />
              ) : isFailed ? (
                <div className="flex flex-col items-center justify-center p-8 text-slate-500 gap-2">
                  <ImageOff className="w-8 h-8 text-rose-500/70" />
                  <p className="text-xs">Không thể tải trang {index + 1}</p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setFailedAssets((prev) => ({ ...prev, [asset.id]: false }));
                      handleImageError(asset.id);
                    }}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 flex items-center gap-1 mt-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Thử lại
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-center p-12 text-slate-600 text-xs animate-pulse">
                  Đang tải trang {index + 1}...
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
