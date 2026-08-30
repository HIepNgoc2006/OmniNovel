'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { Story, ChapterItem } from '../../lib/api/stories';
import { ChapterVersionType } from '@omninovel/shared';
import {
  ArrowUpDown,
  Search,
  BookOpen,
  Sparkles,
  CheckCircle2,
  Lock,
  Eye,
  Calendar,
  Layers,
} from 'lucide-react';

interface ChapterListSectionProps {
  story: Story;
}

export function ChapterListSection({ story }: ChapterListSectionProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC');
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | 'ALL'>('ALL');

  // Lấy edition mặc định hoặc đầu tiên
  const defaultEdition = story.editions?.find((e) => e.isDefault) || story.editions?.[0];
  const allChapters: ChapterItem[] = defaultEdition?.chapters || [];
  const volumes = defaultEdition?.volumes || [];

  // Filter & Sort Chapters
  const filteredChapters = useMemo(() => {
    let list = [...allChapters];

    // Filter by volume
    if (selectedVolumeId !== 'ALL') {
      list = list.filter((ch) => ch.volumeId === selectedVolumeId);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (ch) =>
          ch.chapterNumber.toString().includes(q) ||
          (ch.title && ch.title.toLowerCase().includes(q))
      );
    }

    // Sort by chapter number
    list.sort((a, b) => {
      const numA = Number(a.chapterNumber);
      const numB = Number(b.chapterNumber);
      return sortOrder === 'ASC' ? numA - numB : numB - numA;
    });

    return list;
  }, [allChapters, selectedVolumeId, searchQuery, sortOrder]);

  const getVersionBadge = (versionType?: ChapterVersionType) => {
    switch (versionType) {
      case ChapterVersionType.AI_TRANSLATED:
        return (
          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <Sparkles className="w-2.5 h-2.5" />
            AI Dịch
          </span>
        );
      case ChapterVersionType.HUMAN_EDITED:
        return (
          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            <CheckCircle2 className="w-2.5 h-2.5" />
            Biên Tập Viên
          </span>
        );
      case ChapterVersionType.COMMUNITY_FAN:
        return (
          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Fan dịch
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700">
            Bản gốc
          </span>
        );
    }
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 sm:p-7 shadow-xl space-y-5">
      {/* Header & Controls Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-red-600/20 text-red-500 flex items-center justify-center">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-extrabold text-lg text-white">Danh Sách Chương</h3>
            <p className="text-xs text-slate-400">
              Tổng cộng <span className="text-red-400 font-bold">{allChapters.length}</span> chương đã phát hành
            </p>
          </div>
        </div>

        {/* Search & Sort Controls */}
        <div className="flex items-center gap-2.5">
          {/* Quick Chapter Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm số chương..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-red-500 w-36 sm:w-44"
            />
          </div>

          {/* Sort Order Toggle */}
          <button
            onClick={() => setSortOrder(sortOrder === 'ASC' ? 'DESC' : 'ASC')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 text-xs font-semibold text-slate-300 hover:text-white transition-colors"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-red-400" />
            <span>{sortOrder === 'DESC' ? 'Mới nhất' : 'Cũ nhất'}</span>
          </button>
        </div>
      </div>

      {/* Volume Tabs (if volumes available) */}
      {volumes.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <button
            onClick={() => setSelectedVolumeId('ALL')}
            className={`px-3 py-1.5 rounded-xl font-bold transition-all shrink-0 ${
              selectedVolumeId === 'ALL'
                ? 'bg-red-600 text-white shadow-sm'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            Tất cả các tập
          </button>
          {volumes.map((vol) => (
            <button
              key={vol.id}
              onClick={() => setSelectedVolumeId(vol.id)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-xl font-bold transition-all shrink-0 ${
                selectedVolumeId === vol.id
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Layers className="w-3 h-3" />
              <span>Tập {vol.volumeNumber}: {vol.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Chapters Grid / List */}
      {filteredChapters.length === 0 ? (
        <div className="py-12 text-center text-slate-400 text-sm">
          {searchQuery
            ? `Không tìm thấy chương nào khớp với "${searchQuery}".`
            : 'Bộ truyện này chưa có chương nào được xuất bản.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-[500px] overflow-y-auto pr-1">
          {filteredChapters.map((chapter) => {
            const views = Number(chapter.viewsCount || 0);
            const dateStr = chapter.createdAt
              ? new Date(chapter.createdAt).toLocaleDateString('vi-VN')
              : 'Gần đây';

            return (
              <Link
                key={chapter.id}
                href={`/stories/${story.slug}/chapters/${chapter.chapterNumber}`}
                className="group flex flex-col justify-between p-3 rounded-2xl bg-slate-950/70 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700 transition-all hover:shadow-md gap-2"
              >
                {/* Chapter Title & Number */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-bold text-sm text-slate-200 group-hover:text-red-400 transition-colors block truncate">
                      Chương {chapter.chapterNumber}
                      {chapter.title && `: ${chapter.title}`}
                    </span>
                  </div>

                  {/* Version Tag */}
                  {chapter.activeVersion && (
                    <div className="shrink-0">
                      {getVersionBadge(chapter.activeVersion.versionType)}
                    </div>
                  )}
                </div>

                {/* Metadata Footnote */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-900">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3 text-slate-400" />
                    <span>{dateStr}</span>
                  </div>

                  {views > 0 && (
                    <div className="flex items-center gap-1">
                      <Eye className="w-3 h-3 text-slate-400" />
                      <span>{views.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
