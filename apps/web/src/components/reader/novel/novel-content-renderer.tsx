'use client';

import { useMemo, useState } from 'react';
import { sanitizeNovelHtml } from '../../../lib/reader/html-sanitizer';
import { NovelReaderSettings } from '../../../lib/reader/types';

interface NovelContentRendererProps {
  rawHtml: string;
  settings: NovelReaderSettings;
  onCenterClick?: () => void;
}

export function NovelContentRenderer({
  rawHtml,
  settings,
  onCenterClick,
}: NovelContentRendererProps) {
  const [footnotePopover, setFootnotePopover] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  // Khử trùng HTML an toàn
  const cleanHtml = useMemo(() => {
    return sanitizeNovelHtml(rawHtml);
  }, [rawHtml]);

  // Xác định class độ rộng khung đọc
  const widthClass =
    settings.containerWidth === 'narrow'
      ? 'max-w-2xl'
      : settings.containerWidth === 'wide'
      ? 'max-w-5xl'
      : 'max-w-3xl';

  // Xác định class font chữ
  const fontClass = settings.fontFamily === 'serif' ? 'font-serif' : 'font-sans';

  // Handler xử lý click (Footnote popover hoặc bật/tắt HUD)
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Kiểm tra nếu click vào footnote (thẻ có data-footnote hoặc class footnote)
    const footnoteElem = target.closest('[data-footnote]') as HTMLElement | null;
    if (footnoteElem) {
      e.stopPropagation();
      const footnoteText = footnoteElem.getAttribute('data-footnote') || footnoteElem.title;
      if (footnoteText) {
        const rect = footnoteElem.getBoundingClientRect();
        setFootnotePopover({
          text: footnoteText,
          x: rect.left + window.scrollX,
          y: rect.bottom + window.scrollY + 8,
        });
      }
      return;
    }

    // Đóng footnote nếu click ra ngoài
    if (footnotePopover) {
      setFootnotePopover(null);
    }

    // Click giữa màn hình để bật/tắt HUD
    const rect = e.currentTarget.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const height = rect.height;
    if (clickY >= height * 0.25 && clickY <= height * 0.75) {
      if (onCenterClick) onCenterClick();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`w-full mx-auto px-4 sm:px-8 py-8 ${widthClass} ${fontClass} transition-all duration-200`}
      style={{
        fontSize: `${settings.fontSize}px`,
        lineHeight: settings.lineHeight,
        textAlign: settings.textAlign,
      }}
    >
      {/* Novel Article Body */}
      <article
        className="novel-prose selection:bg-brand-500/30 selection:text-current space-y-4"
        style={{
          // Custom CSS properties for Ruby & Footnotes styling
          ['--paragraph-spacing' as any]: `${settings.paragraphSpacing}px`,
        }}
        dangerouslySetInnerHTML={{ __html: cleanHtml }}
      />

      {/* Footnote Popover Tooltip */}
      {footnotePopover && (
        <div
          style={{ top: `${footnotePopover.y}px`, left: `${footnotePopover.x}px` }}
          className="fixed z-50 max-w-xs bg-slate-900 border border-slate-700 text-slate-200 text-xs p-3 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="font-semibold text-brand-400 mb-1">Chú thích:</div>
          <div>{footnotePopover.text}</div>
        </div>
      )}
    </div>
  );
}
