'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Story } from '../../lib/api/stories';
import { Trophy, Flame, Eye, BookOpen, ChevronRight } from 'lucide-react';

interface RankingsSectionProps {
  topComics: Story[];
  topNovels: Story[];
}

export function RankingsSection({ topComics, topNovels }: RankingsSectionProps) {
  const [activeTab, setActiveTab] = useState<'COMIC' | 'NOVEL'>('COMIC');

  const currentList = (activeTab === 'COMIC' ? topComics : topNovels) || [];

  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 sm:p-6 flex flex-col gap-4 shadow-xl">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
            <Trophy className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-extrabold text-base text-white">Bảng Xếp Hạng Lượt Xem</h3>
            <p className="text-[11px] text-slate-400">Top truyện có lượt xem cao nhất toàn thời gian</p>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center p-1 bg-slate-950 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('COMIC')}
            className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
              activeTab === 'COMIC'
                ? 'bg-red-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Manga / Webtoon
          </button>
          <button
            onClick={() => setActiveTab('NOVEL')}
            className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
              activeTab === 'NOVEL'
                ? 'bg-amber-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Light Novel
          </button>
        </div>
      </div>

      {/* Rankings List */}
      <div className="flex flex-col gap-2.5">
        {currentList.length === 0 ? (
          <div className="py-8 text-center text-slate-400 text-xs italic">
            Chưa có dữ liệu xếp hạng trong danh mục này.
          </div>
        ) : (
          currentList.slice(0, 10).map((story, index) => {
            const rank = index + 1;
            const views = Number(story.viewsCount || story.viewCount || 0);
            const coverUrl = story.coverUrl || story.coverImageUrl;

            // Medal style for top 3
            let rankBadgeStyle = 'bg-slate-800/80 text-slate-400 border-slate-700/50';
            if (rank === 1) rankBadgeStyle = 'bg-amber-500/20 text-amber-400 border-amber-500/40 font-black shadow-sm';
            else if (rank === 2) rankBadgeStyle = 'bg-slate-300/20 text-slate-200 border-slate-300/40 font-black';
            else if (rank === 3) rankBadgeStyle = 'bg-amber-700/20 text-amber-600 border-amber-700/40 font-black';

            return (
              <Link
                key={story.id || story.slug}
                href={`/stories/${story.slug}`}
                className="group flex items-center gap-3 p-2 rounded-xl hover:bg-slate-800/60 transition-all border border-transparent hover:border-slate-800"
              >
                {/* Rank Number */}
                <div
                  className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-xs border ${rankBadgeStyle}`}
                >
                  {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank}
                </div>

                {/* Cover Thumbnail */}
                <div className="relative w-10 h-14 shrink-0 rounded-lg overflow-hidden bg-slate-950 border border-slate-800">
                  {coverUrl ? (
                    <img
                      src={coverUrl}
                      alt={story.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-slate-900">
                      <BookOpen className="w-4 h-4 text-slate-600" />
                    </div>
                  )}
                </div>

                {/* Story Info */}
                <div className="flex-1 min-w-0">
                  <h4
                    className="font-bold text-xs text-slate-200 group-hover:text-red-400 transition-colors truncate"
                    title={story.title}
                  >
                    {story.title}
                  </h4>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Eye className="w-3 h-3 text-slate-400" />
                      {views >= 1000 ? `${(views / 1000).toFixed(1)}k` : views}
                    </span>
                    {story.genres && story.genres.length > 0 && (
                      <span className="truncate">
                        • {story.genres[0].name}
                      </span>
                    )}
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors shrink-0" />
              </Link>
            );
          })
        )}
      </div>

      {/* View All Link */}
      <Link
        href={`/search?sort=POPULAR&format=${activeTab}`}
        className="pt-2 text-center text-xs font-bold text-slate-400 hover:text-white transition-colors block border-t border-slate-800"
      >
        Xem toàn bộ bảng xếp hạng &rarr;
      </Link>
    </div>
  );
}
