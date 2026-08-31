'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useStories, useFeaturedStories, useStoryRankings } from '@/lib/query/hooks';
import { HeroBannerSlider } from '@/components/home/hero-banner-slider';
import { RankingsSection } from '@/components/home/rankings-section';
import { DailyCheckinWidget } from '@/components/home/daily-checkin-widget';
import { StoryCard } from '@/components/story/story-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MediaFormat } from '@omninovel/shared';
import {
  Sparkles,
  Flame,
  BookOpen,
  ArrowRight,
  Compass,
  Zap,
  TrendingUp,
  Tag,
} from 'lucide-react';

const POPULAR_GENRES = [
  'Action',
  'Isekai',
  'Fantasy',
  'Romance',
  'Sci-Fi',
  'Comedy',
  'Mystery',
  'Drama',
  'Adventure',
  'Supernatural',
];

export default function HomePage() {
  const [selectedFormat, setSelectedFormat] = useState<MediaFormat | undefined>(undefined);

  const { data: featuredData, isLoading: isFeaturedLoading } = useFeaturedStories();
  const { data: rankingsData } = useStoryRankings();
  const { data: storiesResponse, isLoading: isStoriesLoading } = useStories({
    mediaFormat: selectedFormat,
    limit: 12,
  });

  const stories = storiesResponse?.data || [];
  const banners = featuredData?.banners || featuredData?.hotStories || [];
  const topComics = rankingsData?.topComics || [];
  const topNovels = rankingsData?.topNovels || [];

  return (
    <div className="space-y-10 pb-16">
      {/* 1. Hero Carousel Slider */}
      <section className="pt-2">
        {isFeaturedLoading ? (
          <Skeleton className="w-full h-80 sm:h-96 rounded-3xl" />
        ) : banners.length > 0 ? (
          <HeroBannerSlider banners={banners} />
        ) : (
          <div className="relative overflow-hidden bg-gradient-to-r from-red-950/40 via-slate-900 to-indigo-950/40 border border-slate-800 rounded-3xl p-8 sm:p-12 text-center md:text-left shadow-2xl">
            <div className="max-w-2xl space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Next.js 16 & AI Translation Pipeline V3</span>
              </div>
              <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-tight">
                Đọc Truyện Đa Phương Thức <br />
                <span className="bg-gradient-to-r from-red-500 via-rose-400 to-amber-400 bg-clip-text text-transparent">
                  Manga 120Hz & Light Novel
                </span>
              </h1>
              <p className="text-slate-400 text-sm leading-relaxed">
                Khám phá kho tàng Manga, Webtoon và Light Novel Nhật Bản chất lượng cao với phòng dịch thuật AI OCR Studio.
              </p>
              <div className="flex items-center gap-3 pt-2">
                <Link href="/search?format=COMIC">
                  <Button variant="primary" size="lg" className="gap-2">
                    <Flame className="w-4 h-4" />
                    Khám Phá Manga
                  </Button>
                </Link>
                <Link href="/search?format=NOVEL">
                  <Button variant="secondary" size="lg" className="gap-2">
                    <BookOpen className="w-4 h-4" />
                    Đọc Light Novel
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 2. Main Discovery Hub: 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Latest Updates & Category Filter (8 Cols) */}
        <section className="lg:col-span-8 space-y-6">
          {/* Section Header & Format Filter Tabs */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-800/80">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-red-600/20 text-red-500 flex items-center justify-center">
                <Zap className="w-4 h-4" />
              </div>
              <div>
                <h2 className="font-extrabold text-lg text-white">Mới Cập Nhật</h2>
                <p className="text-xs text-slate-400">Các chương truyện mới xuất bản gần đây</p>
              </div>
            </div>

            {/* Format Filter Switcher */}
            <div className="flex items-center p-1 bg-slate-900 rounded-2xl border border-slate-800">
              <button
                onClick={() => setSelectedFormat(undefined)}
                className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all ${
                  selectedFormat === undefined
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Tất cả
              </button>
              <button
                onClick={() => setSelectedFormat(MediaFormat.COMIC)}
                className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all ${
                  selectedFormat === MediaFormat.COMIC
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Manga / Webtoon
              </button>
              <button
                onClick={() => setSelectedFormat(MediaFormat.NOVEL)}
                className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-all ${
                  selectedFormat === MediaFormat.NOVEL
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Light Novel
              </button>
            </div>
          </div>

          {/* Story Cards Grid */}
          {isStoriesLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
                  <Skeleton className="h-4 w-3/4 rounded" />
                  <Skeleton className="h-3 w-1/2 rounded" />
                </div>
              ))}
            </div>
          ) : stories.length === 0 ? (
            <div className="py-16 text-center bg-slate-900/40 border border-slate-800/60 rounded-3xl p-8 space-y-3">
              <Compass className="w-12 h-12 text-slate-600 mx-auto animate-bounce" />
              <h3 className="font-bold text-base text-slate-300">Chưa có truyện trong danh mục này</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                Hiện hệ thống đang khởi tạo các bản dịch AI mới. Bạn có thể duyệt tìm qua thanh tìm kiếm hoặc khám phá thể loại khác!
              </p>
              <Link href="/search">
                <Button variant="secondary" size="sm" className="mt-2">
                  Duyệt Tìm Kiếm &rarr;
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {stories.map((story) => (
                <StoryCard key={story.id || story.slug} story={story} />
              ))}
            </div>
          )}

          {/* View More Catalog Button */}
          <div className="text-center pt-4">
            <Link href={`/search${selectedFormat ? `?format=${selectedFormat}` : ''}`}>
              <Button variant="outline" size="lg" className="gap-2 border-slate-700 hover:bg-slate-800">
                <span>Xem Tất Cả Truyện Trong Kho</span>
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </section>

        {/* Right Column: Sidebar (Daily Checkin & Top Rankings & Genre Cloud) (4 Cols) */}
        <aside className="lg:col-span-4 space-y-6">
          {/* Daily Checkin Widget */}
          <DailyCheckinWidget />

          {/* Top Rankings Leaderboard */}
          <RankingsSection topComics={topComics} topNovels={topNovels} />

          {/* Quick Genre Cloud Explorer */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 shadow-xl space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
              <Tag className="w-4 h-4 text-red-400" />
              <h4 className="font-extrabold text-sm text-white">Thể Loại Phổ Biến</h4>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {POPULAR_GENRES.map((genre) => (
                <Link
                  key={genre}
                  href={`/search?genre=${encodeURIComponent(genre)}`}
                  className="px-2.5 py-1 text-xs rounded-xl bg-slate-950/80 hover:bg-red-600/20 hover:text-red-300 border border-slate-800 hover:border-red-500/40 text-slate-300 transition-colors"
                >
                  {genre}
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
