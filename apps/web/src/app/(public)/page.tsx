'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useStories, useProgression } from '../../lib/query/hooks';
import { useAuth } from '../../lib/auth/auth-context';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Sparkles,
  Flame,
  BookOpen,
  ArrowRight,
  Star,
  Eye,
  Heart,
  Sliders,
  Award,
  Layers,
} from 'lucide-react';
import { MediaFormat } from '@omninovel/shared';

export default function HomePage() {
  const { isAuthenticated, user } = useAuth();
  const { data: progression } = useProgression();
  const [selectedFormat, setSelectedFormat] = useState<MediaFormat | undefined>(undefined);
  const { data: storiesData, isLoading } = useStories({ mediaFormat: selectedFormat, limit: 8 });

  return (
    <div className="space-y-12 pb-16">
      {/* Hero Showcase Section */}
      <section className="relative overflow-hidden bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 border-b border-slate-800/80 py-12 md:py-16">
        {/* Glow ambient effects */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-10 right-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            {/* Hero Text */}
            <div className="lg:col-span-7 space-y-5 text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Next.js 16 & AI Translation Pipeline V3</span>
              </div>

              <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight leading-tight">
                Đọc Truyện Đa Phương Thức <br />
                <span className="bg-gradient-to-r from-red-500 via-rose-400 to-amber-400 bg-clip-text text-transparent">
                  Manga 120Hz & Light Novel Sepia
                </span>
              </h1>

              <p className="text-slate-400 text-sm sm:text-base leading-relaxed max-w-xl">
                Khám phá kho tàng truyện tranh và tiểu thuyết Nhật Bản với trải nghiệm đọc siêu mượt mà, tích hợp phòng dịch thuật AI OCR & Inpainting tự động.
              </p>

              {/* CTAs */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link href="/search?format=COMIC">
                  <Button variant="primary" size="lg" className="gap-2">
                    <Flame className="w-5 h-5" />
                    <span>Đọc Manga HOT</span>
                  </Button>
                </Link>
                <Link href="/search?format=NOVEL">
                  <Button variant="secondary" size="lg" className="gap-2">
                    <BookOpen className="w-5 h-5" />
                    <span>Đọc Light Novel</span>
                  </Button>
                </Link>
                {isAuthenticated && (
                  <Link href="/studio">
                    <Button variant="outline" size="lg" className="gap-2 text-red-400 border-red-500/30 hover:bg-red-500/10">
                      <Sliders className="w-5 h-5" />
                      <span>Vào AI Studio</span>
                    </Button>
                  </Link>
                )}
              </div>
            </div>

            {/* Hero Quick Widget / Gamification Promo */}
            <div className="lg:col-span-5">
              <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-3xl p-6 shadow-2xl shadow-black/60 relative overflow-hidden">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Award className="w-4 h-4 text-amber-400" />
                    <span>Hệ Thống Độc Giả & Gamification</span>
                  </h3>
                  <Badge variant="rank">Rank SSoT</Badge>
                </div>

                {isAuthenticated && progression ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between bg-slate-950 p-4 rounded-2xl border border-slate-800/80">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-red-500 to-amber-500 flex items-center justify-center text-white font-black text-lg shadow-md">
                          {progression.level}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white">{user?.username}</p>
                          <p className="text-[11px] text-amber-400 font-semibold">{progression.rankTitle}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-xs text-slate-400">OmniCoins</span>
                        <p className="text-base font-extrabold text-amber-400">{progression.omnicoinBalance}</p>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-slate-400">
                        <span>Tiến trình EXP</span>
                        <span>{progression.currentLevelExp} / {progression.nextLevelExp} EXP</span>
                      </div>
                      <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                        <div
                          className="h-full bg-gradient-to-r from-red-500 via-rose-500 to-amber-400 transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((progression.currentLevelExp / progression.nextLevelExp) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 text-left">
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Đăng nhập mỗi ngày để điểm danh nhận <span className="text-amber-400 font-bold">OmniCoins</span>, mở khóa đặc quyền đọc sớm và thăng hạng danh hiệu độc giả!
                    </p>
                    <div className="grid grid-cols-2 gap-3 pt-2">
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                        <p className="text-xs text-slate-400">Điểm danh</p>
                        <p className="text-sm font-bold text-emerald-400">+50 EXP / ngày</p>
                      </div>
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                        <p className="text-xs text-slate-400">Đọc truyện</p>
                        <p className="text-sm font-bold text-amber-400">+10 Coin / chap</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content & Catalog Showcase */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Section Header & Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-6 bg-red-600 rounded-full" />
            <h2 className="text-xl font-extrabold text-white tracking-tight">Mới Cập Nhật & Đề Cử</h2>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-2 bg-slate-900/80 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setSelectedFormat(undefined)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                selectedFormat === undefined
                  ? 'bg-red-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tất Cả
            </button>
            <button
              onClick={() => setSelectedFormat(MediaFormat.COMIC)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                selectedFormat === MediaFormat.COMIC
                  ? 'bg-red-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Manga
            </button>
            <button
              onClick={() => setSelectedFormat(MediaFormat.NOVEL)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                selectedFormat === MediaFormat.NOVEL
                  ? 'bg-red-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Light Novel
            </button>
          </div>
        </div>

        {/* Stories Grid */}
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="space-y-2">
                <Skeleton className="w-full aspect-[3/4] rounded-2xl" />
                <Skeleton className="w-3/4 h-4 rounded" />
                <Skeleton className="w-1/2 h-3 rounded" />
              </div>
            ))}
          </div>
        ) : storiesData?.data && storiesData.data.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {storiesData.data.map((story) => (
              <Link
                key={story.id}
                href={`/stories/${story.slug}`}
                className="group flex flex-col bg-slate-900 border border-slate-800/80 hover:border-red-500/50 rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-red-500/10"
              >
                {/* Cover Image */}
                <div className="relative aspect-[3/4] bg-slate-950 overflow-hidden">
                  {story.coverImageUrl ? (
                    <img
                      src={story.coverImageUrl}
                      alt={story.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-700 bg-slate-950">
                      <BookOpen className="w-8 h-8" />
                    </div>
                  )}
                  {/* Media Format Tag */}
                  <div className="absolute top-2 left-2">
                    <Badge variant={story.mediaFormat === MediaFormat.COMIC ? 'primary' : 'warning'}>
                      {story.mediaFormat}
                    </Badge>
                  </div>
                </div>

                {/* Info */}
                <div className="p-3 flex-1 flex flex-col justify-between">
                  <h3 className="font-bold text-xs text-white group-hover:text-red-400 transition-colors line-clamp-2">
                    {story.title}
                  </h3>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 mt-2">
                    <span className="flex items-center gap-0.5">
                      <Star className="w-3 h-3 text-amber-400 fill-current" />
                      {story.ratingAverage.toFixed(1)}
                    </span>
                    <span className="flex items-center gap-0.5">
                      <Eye className="w-3 h-3 text-slate-500" />
                      {story.viewCount}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          /* Empty / Initial Showcase State */
          <div className="bg-slate-900/50 border border-dashed border-slate-800 rounded-3xl p-12 text-center space-y-4">
            <div className="w-12 h-12 bg-slate-800 text-slate-400 rounded-2xl flex items-center justify-center mx-auto">
              <Layers className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-white">Sẵn Sàng Cho Phase 4B Catalog Ingestion</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Nền tảng Web Foundation đã sẵn sàng kết nối và hiển thị toàn bộ kho truyện và dữ liệu từ Core API.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
