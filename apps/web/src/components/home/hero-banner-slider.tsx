'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Story } from '../../lib/api/stories';
import { MediaFormat } from '@omninovel/shared';
import { BookOpen, Sparkles, ChevronLeft, ChevronRight, Eye, Heart, Flame } from 'lucide-react';
import { Button } from '../ui/button';

interface HeroBannerSliderProps {
  banners: Story[];
}

export function HeroBannerSlider({ banners }: HeroBannerSliderProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const total = banners.length;

  const nextSlide = useCallback(() => {
    if (total === 0) return;
    setCurrentIndex((prev) => (prev + 1) % total);
  }, [total]);

  const prevSlide = useCallback(() => {
    if (total === 0) return;
    setCurrentIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  // Autoplay slider every 5 seconds if not paused
  useEffect(() => {
    if (isPaused || total <= 1) return;
    const timer = setInterval(() => {
      nextSlide();
    }, 5000);
    return () => clearInterval(timer);
  }, [isPaused, total, nextSlide]);

  if (total === 0) {
    return null;
  }

  const current = banners[currentIndex];
  const isNovel = current.mediaFormat === MediaFormat.NOVEL;
  const coverUrl = current.coverUrl || current.coverImageUrl || '/placeholder-cover.jpg';
  const views = Number(current.viewsCount || current.viewCount || 0);

  return (
    <div
      className="relative w-full rounded-3xl overflow-hidden bg-slate-950 border border-slate-800/80 shadow-2xl transition-all duration-500"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      {/* Blurred Backdrop Image */}
      {coverUrl && coverUrl !== '/placeholder-cover.jpg' && (
        <div
          className="absolute inset-0 bg-cover bg-center filter blur-3xl opacity-20 scale-125 transform transition-all duration-700 pointer-events-none"
          style={{ backgroundImage: `url(${coverUrl})` }}
        />
      )}

      {/* Radiant Gradient Grids */}
      <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/90 to-transparent z-10" />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent z-10" />

      {/* Main Slide Content */}
      <div className="relative z-20 min-h-[360px] md:min-h-[420px] p-6 sm:p-10 flex flex-col md:flex-row items-center justify-between gap-8">
        {/* Left Column: Story Details */}
        <div className="flex-1 space-y-4 max-w-2xl text-center md:text-left">
          {/* Badge Ribbon */}
          <div className="flex flex-wrap items-center justify-center md:justify-start gap-2.5">
            <span className="flex items-center gap-1 px-3 py-1 text-xs font-black uppercase tracking-wider rounded-xl bg-red-600/30 text-red-400 border border-red-500/30 shadow-lg shadow-red-950/50">
              <Flame className="w-3.5 h-3.5 fill-red-400 text-red-400 animate-pulse" />
              HOT TRENDING
            </span>

            <span
              className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-xl border ${
                isNovel
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
              }`}
            >
              {isNovel ? 'Light Novel' : 'Manga / Webtoon'}
            </span>

            {current.originCountry && (
              <span className="px-2.5 py-1 text-xs font-semibold rounded-xl bg-slate-800/60 text-slate-300 border border-slate-700/50">
                {current.originCountry}
              </span>
            )}
          </div>

          {/* Title */}
          <h2 className="text-2xl sm:text-4xl lg:text-5xl font-black text-white tracking-tight leading-tight line-clamp-2">
            {current.title}
          </h2>

          {/* Genres */}
          {current.genres && current.genres.length > 0 && (
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 pt-1">
              {current.genres.slice(0, 4).map((g) => (
                <span
                  key={g.id}
                  className="text-xs font-medium px-2.5 py-0.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700/40"
                >
                  {g.name}
                </span>
              ))}
            </div>
          )}

          {/* Synopsis */}
          <p className="text-xs sm:text-sm text-slate-300 line-clamp-3 leading-relaxed max-w-xl">
            {current.summary || current.synopsis || 'Khám phá cuộc phiêu lưu đặc sắc trong thế giới OmniNovel với chất lượng dịch thuật AI Studio đỉnh cao.'}
          </p>

          {/* Stats Bar */}
          <div className="flex items-center justify-center md:justify-start gap-6 text-xs text-slate-400 font-medium pt-2">
            <div className="flex items-center gap-1.5">
              <Eye className="w-4 h-4 text-slate-400" />
              <span>{views.toLocaleString()} lượt xem</span>
            </div>
            {current.followersCount > 0 && (
              <div className="flex items-center gap-1.5">
                <Heart className="w-4 h-4 text-rose-400" />
                <span>{current.followersCount.toLocaleString()} theo dõi</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-amber-400">
              <Sparkles className="w-4 h-4" />
              <span>AI Studio Ready</span>
            </div>
          </div>

          {/* CTA Actions */}
          <div className="flex items-center justify-center md:justify-start gap-3 pt-3">
            <Link href={`/stories/${current.slug}`}>
              <Button variant="primary" size="lg" className="shadow-lg shadow-red-600/30 gap-2">
                <BookOpen className="w-4 h-4" />
                Đọc Ngay
              </Button>
            </Link>
            <Link href={`/stories/${current.slug}`}>
              <Button variant="secondary" size="lg">
                Xem Chi Tiết
              </Button>
            </Link>
          </div>
        </div>

        {/* Right Column: 3D-ish Cover Frame */}
        <div className="relative group shrink-0 hidden md:block">
          <div className="relative w-48 lg:w-56 aspect-[3/4] rounded-2xl overflow-hidden shadow-2xl border-2 border-slate-700/80 transform hover:rotate-1 hover:scale-105 transition-all duration-500">
            {coverUrl && coverUrl !== '/placeholder-cover.jpg' ? (
              <img
                src={coverUrl}
                alt={current.title}
                className="w-full h-full object-cover object-center"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-center p-4">
                <BookOpen className="w-12 h-12 text-slate-600 mb-2" />
                <span className="text-xs font-bold text-slate-400">{current.title}</span>
              </div>
            )}
          </div>

          {/* Reflection Glow */}
          <div className="absolute -inset-2 bg-gradient-to-r from-red-600 to-amber-500 rounded-3xl filter blur-xl opacity-20 group-hover:opacity-40 transition-opacity -z-10" />
        </div>
      </div>

      {/* Navigation Controls */}
      {total > 1 && (
        <>
          <button
            onClick={prevSlide}
            aria-label="Slide trước"
            className="absolute left-3 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-slate-950/70 hover:bg-slate-900 border border-slate-800 text-slate-300 hover:text-white backdrop-blur-md transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={nextSlide}
            aria-label="Slide tiếp theo"
            className="absolute right-3 top-1/2 -translate-y-1/2 z-30 p-2 rounded-full bg-slate-950/70 hover:bg-slate-900 border border-slate-800 text-slate-300 hover:text-white backdrop-blur-md transition-all"
          >
            <ChevronRight className="w-5 h-5" />
          </button>

          {/* Dots Indicator */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5">
            {banners.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                aria-label={`Chuyển đến banner ${idx + 1}`}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  idx === currentIndex
                    ? 'w-6 bg-red-500'
                    : 'w-2 bg-slate-700 hover:bg-slate-500'
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
