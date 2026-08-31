'use client';

import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  List,
  Layers,
  Settings,
} from 'lucide-react';
import { ReaderTheme } from '../../../lib/reader/types';

interface NovelHudProps {
  isVisible: boolean;
  storySlug: string;
  storyTitle: string;
  chapterNumber: number | string;
  chapterTitle?: string | null;
  progressPercentage: number;
  theme: ReaderTheme;
  previousChapterId: string | null;
  nextChapterId: string | null;
  onOpenSettings: () => void;
  onOpenDrawer: () => void;
  onOpenVersionModal: () => void;
}

export function NovelHud({
  isVisible,
  storySlug,
  storyTitle,
  chapterNumber,
  chapterTitle,
  progressPercentage,
  theme,
  previousChapterId,
  nextChapterId,
  onOpenSettings,
  onOpenDrawer,
  onOpenVersionModal,
}: NovelHudProps) {
  const themeClasses =
    theme === 'sepia'
      ? 'bg-[#f7efe1]/95 text-[#2d2319] border-[#e8dac1]'
      : theme === 'light'
      ? 'bg-white/95 text-slate-900 border-slate-200'
      : 'bg-slate-900/95 text-slate-100 border-slate-800';

  return (
    <>
      {/* Top Header Bar */}
      <header
        className={`fixed top-0 left-0 right-0 z-40 backdrop-blur-md border-b transition-all duration-300 ${themeClasses} ${
          isVisible
            ? 'translate-y-0 opacity-100'
            : '-translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href={`/stories/${storySlug}`}
              className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 opacity-80 hover:opacity-100 transition-colors"
              title="Quay lại chi tiết truyện"
            >
              <ChevronLeft className="w-5 h-5" />
            </Link>

            <div className="min-w-0">
              <h1 className="text-sm font-bold truncate">{storyTitle}</h1>
              <p className="text-xs opacity-75 truncate">
                Chương {chapterNumber}
                {chapterTitle ? ` - ${chapterTitle}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onOpenVersionModal}
              className="px-2.5 py-1.5 rounded-lg border border-purple-500/30 text-purple-600 dark:text-purple-300 hover:bg-purple-500/10 text-xs font-semibold flex items-center gap-1.5 transition-colors"
              title="Đổi bản dịch"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Bản Dịch</span>
            </button>

            <button
              onClick={onOpenSettings}
              className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 opacity-80 hover:opacity-100 transition-colors"
              title="Tùy chỉnh giao diện đọc"
            >
              <Settings className="w-5 h-5" />
            </button>

            <button
              onClick={onOpenDrawer}
              className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 opacity-80 hover:opacity-100 transition-colors"
              title="Mục lục chương"
            >
              <List className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Reading Progress Indicator Line */}
        <div className="w-full bg-black/10 dark:bg-white/10 h-0.5">
          <div
            className="bg-brand-500 h-0.5 transition-all duration-150"
            style={{ width: `${Math.min(100, Math.max(0, progressPercentage))}%` }}
          />
        </div>
      </header>

      {/* Bottom Floating Bar */}
      <footer
        className={`fixed bottom-0 left-0 right-0 z-40 backdrop-blur-md border-t transition-all duration-300 ${themeClasses} ${
          isVisible
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex items-center justify-between">
          <div>
            {previousChapterId ? (
              <Link
                href={`/stories/${storySlug}/read/${previousChapterId}`}
                className="px-3 py-1.5 rounded-lg border border-current/20 hover:bg-black/5 dark:hover:bg-white/5 text-xs font-medium flex items-center gap-1 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Chương Trước</span>
              </Link>
            ) : (
              <span className="px-3 py-1.5 opacity-30 text-xs font-medium flex items-center gap-1 cursor-not-allowed">
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Chương Trước</span>
              </span>
            )}
          </div>

          <div className="text-xs font-mono opacity-80">
            {Math.round(progressPercentage)}% đã đọc
          </div>

          <div>
            {nextChapterId ? (
              <Link
                href={`/stories/${storySlug}/read/${nextChapterId}`}
                className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center gap-1 transition-colors shadow-sm"
              >
                <span className="hidden sm:inline">Chương Kế</span>
                <ChevronRight className="w-4 h-4" />
              </Link>
            ) : (
              <span className="px-3 py-1.5 opacity-30 text-xs font-medium flex items-center gap-1 cursor-not-allowed">
                <span className="hidden sm:inline">Hết Chương</span>
                <ChevronRight className="w-4 h-4" />
              </span>
            )}
          </div>
        </div>
      </footer>
    </>
  );
}
