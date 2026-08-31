'use client';

import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  List,
  Layers,
  Maximize,
  Minimize,
  SlidersHorizontal,
  ArrowRightLeft,
} from 'lucide-react';
import { MangaReadingMode, PagedDirection } from '../../../lib/reader/types';

interface MangaHudProps {
  isVisible: boolean;
  storySlug: string;
  storyTitle: string;
  chapterNumber: number | string;
  chapterTitle?: string | null;
  currentPage: number;
  totalPages: number;
  readingMode: MangaReadingMode;
  direction: PagedDirection;
  isFullscreen: boolean;
  previousChapterId: string | null;
  nextChapterId: string | null;
  onPageChange: (page: number) => void;
  onToggleMode: () => void;
  onToggleDirection: () => void;
  onToggleFullscreen: () => void;
  onOpenDrawer: () => void;
  onOpenVersionModal: () => void;
}

export function MangaHud({
  isVisible,
  storySlug,
  storyTitle,
  chapterNumber,
  chapterTitle,
  currentPage,
  totalPages,
  readingMode,
  direction,
  isFullscreen,
  previousChapterId,
  nextChapterId,
  onPageChange,
  onToggleMode,
  onToggleDirection,
  onToggleFullscreen,
  onOpenDrawer,
  onOpenVersionModal,
}: MangaHudProps) {
  return (
    <>
      {/* Top Header Bar */}
      <header
        className={`fixed top-0 left-0 right-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 transition-all duration-300 ${
          isVisible
            ? 'translate-y-0 opacity-100'
            : '-translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between text-slate-100">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href={`/stories/${storySlug}`}
              className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
              title="Quay lại trang truyện"
            >
              <ChevronLeft className="w-5 h-5" />
            </Link>

            <div className="min-w-0">
              <h1 className="text-sm font-bold text-slate-100 truncate">{storyTitle}</h1>
              <p className="text-xs text-slate-400 truncate">
                Chương {chapterNumber}
                {chapterTitle ? ` - ${chapterTitle}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onOpenVersionModal}
              className="px-2.5 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/20 text-xs font-semibold flex items-center gap-1.5 transition-colors"
              title="Đổi bản dịch"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Bản Dịch</span>
            </button>

            <button
              onClick={onOpenDrawer}
              className="p-2 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-slate-100 transition-colors"
              title="Mục lục chương"
            >
              <List className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Bottom Control Bar */}
      <footer
        className={`fixed bottom-0 left-0 right-0 z-40 bg-slate-900/90 backdrop-blur-md border-t border-slate-800 transition-all duration-300 ${
          isVisible
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex flex-col gap-2 text-slate-100">
          {/* Page Scrubber Slider (for Paged & Webtoon) */}
          {totalPages > 1 && (
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono text-slate-400 w-12 text-right">
                {currentPage} / {totalPages}
              </span>
              <input
                type="range"
                min={1}
                max={totalPages}
                value={currentPage}
                onChange={(e) => onPageChange(Number(e.target.value))}
                className="flex-1 accent-brand-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
              />
            </div>
          )}

          {/* Action Controls */}
          <div className="flex items-center justify-between">
            {/* Previous Chapter */}
            <div className="flex items-center gap-2">
              {previousChapterId ? (
                <Link
                  href={`/stories/${storySlug}/read/${previousChapterId}`}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Chương Trước</span>
                </Link>
              ) : (
                <button
                  disabled
                  className="px-3 py-1.5 rounded-lg bg-slate-800/40 text-slate-600 text-xs font-medium flex items-center gap-1 cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Chương Trước</span>
                </button>
              )}
            </div>

            {/* Mode & Direction Switches */}
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleMode}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                title="Đổi chế độ cuộn dọc Webtoon / Lật trang Paged"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-brand-400" />
                <span>{readingMode === 'webtoon' ? 'Webtoon' : 'Lật Trang'}</span>
              </button>

              {readingMode === 'paged' && (
                <button
                  onClick={onToggleDirection}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold flex items-center gap-1 transition-colors"
                  title="Đổi hướng đọc RTL (Phải sang Trái) / LTR"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5 text-amber-400" />
                  <span>{direction.toUpperCase()}</span>
                </button>
              )}

              <button
                onClick={onToggleFullscreen}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
              >
                {isFullscreen ? (
                  <Minimize className="w-4 h-4" />
                ) : (
                  <Maximize className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Next Chapter */}
            <div className="flex items-center gap-2">
              {nextChapterId ? (
                <Link
                  href={`/stories/${storySlug}/read/${nextChapterId}`}
                  className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium flex items-center gap-1 transition-colors shadow-sm"
                >
                  <span className="hidden sm:inline">Chương Kế</span>
                  <ChevronRight className="w-4 h-4" />
                </Link>
              ) : (
                <button
                  disabled
                  className="px-3 py-1.5 rounded-lg bg-slate-800/40 text-slate-600 text-xs font-medium flex items-center gap-1 cursor-not-allowed"
                >
                  <span className="hidden sm:inline">Hết Chương</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
