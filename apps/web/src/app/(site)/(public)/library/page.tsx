'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Bookmark,
  History,
  Trash2,
  BookOpen,
  ArrowRight,
  Sparkles,
  Compass,
} from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { activeScopeCoordinator } from '../../../../lib/identity/active-scope-coordinator';
import { guestLibraryRepository } from '../../../../lib/storage/guest-library-repository';
import { getBookmarksApi, setBookmarkApi, Story } from '../../../../lib/api/stories';
import { LocalBookmark, LocalReadingHistory } from '@omninovel/shared';

type LibraryTab = 'bookmarks' | 'history';

interface UnifiedBookmarkItem {
  storyId: string;
  title: string;
  slug?: string;
  coverUrl?: string;
  createdAt?: string;
}

export default function LibraryPage() {
  const [activeTab, setActiveTab] = useState<LibraryTab>('bookmarks');
  const [bookmarks, setBookmarks] = useState<UnifiedBookmarkItem[]>([]);
  const [history, setHistory] = useState<LocalReadingHistory[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeScope, setActiveScope] = useState<string | null>(activeScopeCoordinator.activeScope);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const scope = await activeScopeCoordinator.waitForResolvedScope();
      setActiveScope(scope);

      if (scope.startsWith('guest:')) {
        const [bms, hist] = await Promise.all([
          guestLibraryRepository.getBookmarks(),
          guestLibraryRepository.getHistory(),
        ]);
        setBookmarks(
          bms.map((b) => ({
            storyId: b.storyId,
            title: b.title,
            slug: b.slug,
            coverUrl: b.coverUrl,
            createdAt: b.createdAt,
          }))
        );
        setHistory(hist);
      } else if (scope.startsWith('account:')) {
        try {
          const res = await getBookmarksApi({ page: 1, limit: 50 });
          setBookmarks(
            res.items.map((s: Story) => ({
              storyId: s.id,
              title: s.title,
              slug: s.slug,
              coverUrl: s.coverUrl || s.coverImageUrl,
              createdAt: s.createdAt,
            }))
          );
        } catch {
          setBookmarks([]);
        }
        setHistory([]);
      }
    } catch {
      // Safe fallback
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Subscribe to coordinator scope changes (e.g. login, logout rotation)
  useEffect(() => {
    loadData();
    const unsubscribe = activeScopeCoordinator.subscribe((scope) => {
      setActiveScope(scope);
      loadData();
    });
    return () => {
      unsubscribe();
    };
  }, [loadData]);

  const handleRemoveBookmark = async (storyId: string) => {
    try {
      const scope = await activeScopeCoordinator.waitForResolvedScope();
      if (scope.startsWith('guest:')) {
        await guestLibraryRepository.removeBookmark(storyId);
      } else {
        await setBookmarkApi({ storyId, isBookmarked: false });
      }
      setBookmarks((prev) => prev.filter((b) => b.storyId !== storyId));
    } catch {
      // safe error handling
    }
  };

  const handleDeleteHistory = async (storyId: string) => {
    try {
      await guestLibraryRepository.deleteStoryHistory(storyId);
      setHistory((prev) => prev.filter((h) => h.storyId !== storyId));
    } catch {
      // safe error handling
    }
  };

  const handleClearAllHistory = async () => {
    try {
      await guestLibraryRepository.clearAllHistory();
      setHistory([]);
    } catch {
      // safe error handling
    }
  };

  return (
    <div className="space-y-8 pb-20 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-red-600/20 text-red-500 flex items-center justify-center border border-red-500/30">
              <BookOpen className="w-4 h-4" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Thư Viện Của Tôi
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            {activeScope?.startsWith('guest:')
              ? 'Đang lưu trữ cục bộ trên trình duyệt (Khách). Đăng nhập để đồng bộ đa thiết bị.'
              : 'Đã kết nối tài khoản. Dữ liệu được đồng bộ hóa an toàn trên đám mây.'}
          </p>
        </div>

        {/* Tab Controls */}
        <div className="flex items-center bg-slate-900 border border-slate-800 p-1 rounded-2xl shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('bookmarks')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all ${
              activeTab === 'bookmarks'
                ? 'bg-red-600 text-white shadow-md shadow-red-600/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            <span>Dấu Trang ({bookmarks.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all ${
              activeTab === 'history'
                ? 'bg-red-600 text-white shadow-md shadow-red-600/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Lịch Sử Đọc ({history.length})</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="space-y-3 animate-pulse">
              <div className="w-full aspect-[3/4] bg-slate-800/80 rounded-2xl" />
              <div className="h-4 bg-slate-800 rounded w-3/4" />
              <div className="h-3 bg-slate-800/60 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : activeTab === 'bookmarks' ? (
        // ==================== BOOKMARKS TAB ====================
        bookmarks.length === 0 ? (
          <div className="py-20 text-center max-w-md mx-auto space-y-4">
            <div className="w-16 h-16 rounded-3xl bg-slate-900 border border-slate-800 text-slate-500 flex items-center justify-center mx-auto shadow-inner">
              <Bookmark className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white">Chưa Có Dấu Trang Nào</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Bạn chưa lưu bộ truyện nào vào Thư Viện. Hãy khám phá kho tàng Manga và Light Novel để thêm truyện yêu thích!
            </p>
            <Link href="/search">
              <Button variant="primary" size="sm" className="gap-2">
                <Compass className="w-4 h-4" />
                <span>Khám Phá Truyện Ngay</span>
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {bookmarks.map((bm) => (
              <div
                key={bm.storyId}
                className="group relative bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700 rounded-2xl overflow-hidden p-2.5 transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="relative aspect-[3/4] w-full rounded-xl overflow-hidden bg-slate-950 mb-2.5">
                    {bm.coverUrl ? (
                      <img
                        src={bm.coverUrl}
                        alt={bm.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 p-2">
                        <BookOpen className="w-8 h-8 mb-1" />
                        <span className="text-[10px] text-center font-bold text-slate-500 truncate w-full">
                          {bm.title}
                        </span>
                      </div>
                    )}

                    {/* Remove Action Button */}
                    <button
                      type="button"
                      onClick={() => handleRemoveBookmark(bm.storyId)}
                      title="Xóa khỏi thư viện"
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-slate-950/80 hover:bg-rose-600 text-slate-300 hover:text-white transition-colors cursor-pointer shadow-lg backdrop-blur-sm"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <Link href={`/stories/${bm.slug || bm.storyId}`}>
                    <h4 className="text-xs font-bold text-white line-clamp-2 hover:text-red-400 transition-colors">
                      {bm.title}
                    </h4>
                  </Link>
                </div>

                <div className="pt-2 mt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Truyện</span>
                  <Link
                    href={`/stories/${bm.slug || bm.storyId}`}
                    className="text-red-400 hover:text-red-300 inline-flex items-center gap-0.5 font-bold"
                  >
                    <span>Xem</span>
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        // ==================== READING HISTORY TAB ====================
        history.length === 0 ? (
          <div className="py-20 text-center max-w-md mx-auto space-y-4">
            <div className="w-16 h-16 rounded-3xl bg-slate-900 border border-slate-800 text-slate-500 flex items-center justify-center mx-auto shadow-inner">
              <History className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white">Chưa Có Lịch Sử Đọc</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Bạn chưa bắt đầu đọc chương truyện nào. Vị trí và tiến độ đọc sẽ tự động được ghi nhớ tại đây khi bạn trải nghiệm truyện!
            </p>
            <Link href="/">
              <Button variant="primary" size="sm" className="gap-2">
                <Sparkles className="w-4 h-4" />
                <span>Bắt Đầu Đọc Truyện</span>
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400">
                Hiển thị {history.length} truyện đã đọc gần đây
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearAllHistory}
                className="gap-1.5 text-xs text-rose-400 hover:text-rose-300 border-rose-500/30 hover:border-rose-500/50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa tất cả</span>
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {history.map((h) => {
                const percent = Math.min(100, Math.max(0, Math.round(h.progressPercentage || 0)));
                const readLink = h.storySlug
                  ? `/stories/${h.storySlug}/chapters/${h.chapterNumber || 1}`
                  : `/stories/${h.storyId}`;

                return (
                  <div
                    key={`${h.storyId}-${h.chapterId}`}
                    className="group bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700 rounded-2xl p-3 flex gap-3 transition-all items-center justify-between"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="w-14 h-18 shrink-0 rounded-xl overflow-hidden bg-slate-950 relative">
                        {h.storyCoverUrl ? (
                          <img
                            src={h.storyCoverUrl}
                            alt={h.storyTitle}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-600">
                            <BookOpen className="w-5 h-5" />
                          </div>
                        )}
                      </div>

                      <div className="space-y-1 overflow-hidden">
                        <Link href={readLink}>
                          <h4 className="text-xs font-bold text-white truncate hover:text-red-400 transition-colors">
                            {h.storyTitle}
                          </h4>
                        </Link>
                        <p className="text-[11px] text-slate-400">
                          Đang đọc:{' '}
                          <span className="text-slate-200 font-semibold">
                            Chương {h.chapterNumber || '1'}
                          </span>
                        </p>

                        {/* Progress Bar */}
                        <div className="flex items-center gap-2 pt-0.5">
                          <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-red-600 rounded-full"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-mono text-slate-400">{percent}%</span>
                        </div>
                      </div>
                    </div>

                    {/* Delete entry action */}
                    <button
                      type="button"
                      onClick={() => handleDeleteHistory(h.storyId)}
                      title="Xóa khỏi lịch sử"
                      className="p-2 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}
    </div>
  );
}
