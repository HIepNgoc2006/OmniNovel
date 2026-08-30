import React from 'react';
import Link from 'next/link';
import { BookOpen, Sparkles, Eye, Star, Heart, Flame } from 'lucide-react';
import { Story } from '../../lib/api/stories';
import { MediaFormat, StoryStatus } from '@omninovel/shared';

interface StoryCardProps {
  story: Story;
  priority?: boolean;
}

export function StoryCard({ story, priority = false }: StoryCardProps) {
  const coverUrl = story.coverUrl || story.coverImageUrl || '/placeholder-cover.jpg';
  const views = Number(story.viewsCount || story.viewCount || 0);
  const isNovel = story.mediaFormat === MediaFormat.NOVEL;
  const status = story.status;

  // Lấy chương mới nhất từ projection hoặc editions
  const defaultEdition = story.editions?.find((e) => e.isDefault) || story.editions?.[0];
  const chapters = defaultEdition?.chapters || [];
  const latestChapter =
    story.latestChapter ||
    (chapters.length > 0
      ? chapters.reduce((max, curr) => (Number(curr.chapterNumber) > Number(max.chapterNumber) ? curr : max))
      : null);

  return (
    <div className="group relative flex flex-col bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700 rounded-2xl overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-red-950/20 hover:-translate-y-1">
      {/* Cover Image Container */}
      <Link href={`/stories/${story.slug}`} className="relative aspect-[3/4] w-full overflow-hidden bg-slate-950 block">
        {coverUrl && coverUrl !== '/placeholder-cover.jpg' ? (
          <img
            src={coverUrl}
            alt={story.title}
            loading={priority ? 'eager' : 'lazy'}
            className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-500 ease-out"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 p-4 text-center">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-2 ${
              isNovel ? 'bg-amber-500/20 text-amber-400' : 'bg-red-600/20 text-red-500'
            }`}>
              <BookOpen className="w-6 h-6" />
            </div>
            <span className="text-xs font-bold text-slate-400 line-clamp-2">{story.title}</span>
          </div>
        )}

        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent opacity-80 group-hover:opacity-60 transition-opacity" />

        {/* Top Badges */}
        <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-1.5 pointer-events-none">
          {/* Format Badge */}
          <span
            className={`px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider rounded-lg backdrop-blur-md shadow-sm border ${
              isNovel
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-red-500/20 text-red-300 border-red-500/40'
            }`}
          >
            {isNovel ? 'Light Novel' : 'Manga'}
          </span>

          {/* Status Badge */}
          {status === StoryStatus.COMPLETED && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 backdrop-blur-md">
              Full
            </span>
          )}
        </div>

        {/* Bottom stats inside Cover */}
        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between text-[11px] text-slate-300 font-medium pointer-events-none">
          <div className="flex items-center gap-1 bg-slate-950/70 backdrop-blur-md px-2 py-0.5 rounded-md">
            <Eye className="w-3 h-3 text-slate-400" />
            <span>{views >= 1000 ? `${(views / 1000).toFixed(1)}k` : views}</span>
          </div>

          <div className="flex items-center gap-1 bg-slate-950/70 backdrop-blur-md px-2 py-0.5 rounded-md text-red-400">
            <Flame className="w-3 h-3 fill-red-400 text-red-400" />
            <span>HOT</span>
          </div>
        </div>
      </Link>

      {/* Story Metadata Details */}
      <div className="p-3 flex flex-col flex-1 justify-between gap-2">
        <div>
          {/* Genres preview */}
          {story.genres && story.genres.length > 0 && (
            <div className="flex items-center gap-1 mb-1 overflow-hidden">
              <span className="text-[10px] text-slate-400 truncate">
                {story.genres.slice(0, 2).map((g) => g.name).join(' • ')}
              </span>
            </div>
          )}

          {/* Story Title */}
          <Link
            href={`/stories/${story.slug}`}
            className="font-bold text-sm text-slate-100 hover:text-red-400 transition-colors line-clamp-2 leading-snug group-hover:underline"
            title={story.title}
          >
            {story.title}
          </Link>
        </div>

        {/* Latest Chapter Link & Update Time */}
        <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
          {latestChapter ? (
            <Link
              href={`/stories/${story.slug}/chapters/${latestChapter.chapterNumber}`}
              className="text-slate-400 hover:text-white transition-colors truncate font-medium flex items-center gap-1"
            >
              <span className="text-red-500 font-bold">Ch.{latestChapter.chapterNumber}</span>
              {latestChapter.title && (
                <span className="text-[11px] text-slate-400 truncate max-w-[100px]">
                  - {latestChapter.title}
                </span>
              )}
            </Link>
          ) : (
            <span className="text-[11px] text-slate-400 italic">Chưa có chương</span>
          )}

          {story.followersCount > 0 && (
            <div className="flex items-center gap-0.5 text-slate-400 text-[11px]">
              <Heart className="w-2.5 h-2.5 text-rose-500" />
              <span>{story.followersCount}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
