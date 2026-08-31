'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { X, Search, CheckCircle2, BookOpen } from 'lucide-react';
import { ChapterItem } from '../../../lib/api/stories';

interface ChapterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  storySlug: string;
  storyTitle: string;
  currentChapterId: string;
  chapters: ChapterItem[];
  readChapterIds?: string[];
}

export function ChapterDrawer({
  isOpen,
  onClose,
  storySlug,
  storyTitle,
  currentChapterId,
  chapters,
  readChapterIds = [],
}: ChapterDrawerProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const readSet = useMemo(() => new Set(readChapterIds), [readChapterIds]);

  const filteredChapters = useMemo(() => {
    if (!searchTerm.trim()) return chapters;
    const term = searchTerm.toLowerCase();
    return chapters.filter(
      (c) =>
        String(c.chapterNumber).toLowerCase().includes(term) ||
        (c.title && c.title.toLowerCase().includes(term)),
    );
  }, [chapters, searchTerm]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Panel */}
      <div className="relative z-10 w-full max-w-sm bg-slate-900 border-r border-slate-800 text-slate-100 flex flex-col h-full shadow-2xl animate-in slide-in-from-left duration-200">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="min-w-0 flex-1 mr-2">
            <h2 className="text-base font-bold text-slate-100 truncate">{storyTitle}</h2>
            <p className="text-xs text-slate-400">Danh sách {chapters.length} chương</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Đóng danh sách chương"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="p-3 border-b border-slate-800/80">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm theo số chương hoặc tên..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-800/60 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-400 focus:outline-hidden focus:border-brand-500 transition-colors"
            />
          </div>
        </div>

        {/* Chapter List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 divide-y divide-slate-800/40">
          {filteredChapters.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              Không tìm thấy chương phù hợp
            </div>
          ) : (
            filteredChapters.map((chapter) => {
              const isCurrent = chapter.id === currentChapterId;
              const isRead = readSet.has(chapter.id);

              return (
                <Link
                  key={chapter.id}
                  href={`/stories/${storySlug}/read/${chapter.id}`}
                  onClick={onClose}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    isCurrent
                      ? 'bg-brand-500/20 text-brand-400 font-semibold border border-brand-500/30'
                      : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 pr-2">
                    {isCurrent ? (
                      <BookOpen className="w-4 h-4 shrink-0 text-brand-400" />
                    ) : (
                      <span className="w-4 h-4 shrink-0 text-xs text-slate-400 text-center font-mono">
                        #
                      </span>
                    )}
                    <span className="truncate">
                      Chương {chapter.chapterNumber}
                      {chapter.title ? ` - ${chapter.title}` : ''}
                    </span>
                  </div>

                  {isRead && (
                    <span title="Đã đọc xong">
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
