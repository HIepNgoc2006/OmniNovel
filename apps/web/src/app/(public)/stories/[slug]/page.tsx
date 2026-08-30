'use client';

import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useStoryBySlug } from '../../../../lib/query/hooks';
import { setBookmarkApi, getBookmarkStatusApi } from '../../../../lib/api/stories';
import { useAuth } from '../../../../lib/auth/auth-context';
import { ChapterListSection } from '../../../../components/story/chapter-list-section';
import { StoryCommentSection } from '../../../../components/story/story-comment-section';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { MediaFormat, StoryStatus } from '@omninovel/shared';
import {
  BookOpen,
  Sparkles,
  Heart,
  Eye,
  Share2,
  Star,
  Flame,
  Calendar,
  Globe,
  Tag,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export default function StoryDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug as string;

  const { user } = useAuth();
  const { data: story, isLoading, error } = useStoryBySlug(slug);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isSynopsisExpanded, setIsSynopsisExpanded] = useState(false);

  React.useEffect(() => {
    if (story) {
      setFollowersCount(story.followersCount || 0);
    }
  }, [story]);

  React.useEffect(() => {
    if (story?.id && user) {
      getBookmarkStatusApi(story.id)
        .then((res) => setIsFollowing(res.isBookmarked))
        .catch(() => {});
    }
  }, [story?.id, user]);

  if (isLoading) {
    return (
      <div className="space-y-8 py-8">
        <Skeleton className="h-8 w-48 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          <Skeleton className="md:col-span-4 aspect-[3/4] rounded-3xl" />
          <div className="md:col-span-8 space-y-4">
            <Skeleton className="h-10 w-3/4 rounded-xl" />
            <Skeleton className="h-6 w-1/2 rounded" />
            <Skeleton className="h-32 w-full rounded-2xl" />
            <div className="flex gap-3">
              <Skeleton className="h-12 w-36 rounded-xl" />
              <Skeleton className="h-12 w-36 rounded-xl" />
            </div>
          </div>
        </div>
        <Skeleton className="h-96 w-full rounded-3xl" />
      </div>
    );
  }

  if (error || !story) {
    return (
      <div className="py-20 text-center space-y-4 max-w-md mx-auto">
        <BookOpen className="w-16 h-16 text-slate-600 mx-auto" />
        <h2 className="text-xl font-bold text-white">Không Tìm Thấy Bộ Truyện</h2>
        <p className="text-xs text-slate-400">
          Bộ truyện bạn đang tìm kiếm có thể đã bị gỡ bỏ, đặt ở chế độ riêng tư hoặc đường dẫn không chính xác.
        </p>
        <Link href="/search">
          <Button variant="primary" size="sm">
            Quay Về Trang Tìm Kiếm
          </Button>
        </Link>
      </div>
    );
  }

  const isNovel = story.mediaFormat === MediaFormat.NOVEL;
  const coverUrl = story.coverUrl || story.coverImageUrl || '/placeholder-cover.jpg';
  const views = Number(story.viewsCount || story.viewCount || 0);

  // Lấy danh sách chapters
  const defaultEdition = story.editions?.find((e) => e.isDefault) || story.editions?.[0];
  const chapters = defaultEdition?.chapters || [];

  // Sort ascending để lấy First Chapter và Latest Chapter
  const sortedChapters = [...chapters].sort(
    (a, b) => Number(a.chapterNumber) - Number(b.chapterNumber)
  );
  const firstChapter = sortedChapters[0];
  const latestChapter = sortedChapters[sortedChapters.length - 1];

  const handleShare = () => {
    if (typeof window !== 'undefined') {
      navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleToggleFollow = async () => {
    if (!story) return;
    const nextState = !isFollowing;
    setIsFollowing(nextState);
    setFollowersCount((prev) => (nextState ? prev + 1 : Math.max(0, prev - 1)));

    try {
      const res = await setBookmarkApi({ storyId: story.id, isBookmarked: nextState });
      setIsFollowing(res.isBookmarked);
      if (typeof res.followersCount === 'number') {
        setFollowersCount(res.followersCount);
      }
    } catch {
      // Revert if failed
      setIsFollowing(!nextState);
      setFollowersCount((prev) => (!nextState ? prev + 1 : Math.max(0, prev - 1)));
    }
  };

  const synopsisText =
    story.summary ||
    story.synopsis ||
    'Chưa có tóm tắt chi tiết cho bộ truyện này. Hãy trải nghiệm trực tiếp các chương để theo dõi câu chuyện!';

  return (
    <div className="space-y-10 pb-20">
      {/* Back to catalog breadcrumb */}
      <div>
        <Link
          href="/search"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Quay lại danh mục</span>
        </Link>
      </div>

      {/* Hero Showcase Card */}
      <div className="relative overflow-hidden bg-slate-900/80 border border-slate-800/80 rounded-3xl p-6 sm:p-8 md:p-10 shadow-2xl">
        {/* Ambient Blur Backdrop */}
        {coverUrl && coverUrl !== '/placeholder-cover.jpg' && (
          <div
            className="absolute inset-0 bg-cover bg-center filter blur-3xl opacity-20 scale-125 pointer-events-none"
            style={{ backgroundImage: `url(${coverUrl})` }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/70 to-slate-950/90 pointer-events-none" />

        <div className="relative z-10 grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          {/* Left: Cover Image Box (4 Cols) */}
          <div className="md:col-span-4 flex flex-col items-center md:items-start gap-4">
            <div className="relative w-56 sm:w-64 md:w-full aspect-[3/4] rounded-2xl overflow-hidden shadow-2xl border-2 border-slate-700/60 group">
              {coverUrl && coverUrl !== '/placeholder-cover.jpg' ? (
                <img
                  src={coverUrl}
                  alt={story.title}
                  className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-500"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-center p-4">
                  <BookOpen className="w-12 h-12 text-slate-600 mb-2" />
                  <span className="text-xs font-bold text-slate-400">{story.title}</span>
                </div>
              )}
            </div>

            {/* Quick stats under cover on mobile */}
            <div className="flex items-center justify-center gap-4 text-xs text-slate-400 font-medium w-full">
              <div className="flex items-center gap-1">
                <Eye className="w-3.5 h-3.5 text-slate-400" />
                <span>{views.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1 text-rose-400">
                <Heart className={`w-3.5 h-3.5 ${isFollowing ? 'fill-rose-500 text-rose-500' : 'fill-rose-500/20'}`} />
                <span>{followersCount.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Right: Detailed Metadata & Action CTAs (8 Cols) */}
          <div className="md:col-span-8 space-y-5 text-left">
            {/* Format & Status Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-3 py-1 text-xs font-extrabold uppercase tracking-wider rounded-xl border ${
                  isNovel
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-red-500/20 text-red-300 border-red-500/30'
                }`}
              >
                {isNovel ? 'Light Novel' : 'Manga / Webtoon'}
              </span>

              <span className="px-2.5 py-1 text-xs font-bold rounded-xl bg-slate-800 text-slate-300 border border-slate-700/60">
                {story.status === StoryStatus.COMPLETED ? 'Đã hoàn thành' : 'Đang tiến hành'}
              </span>

              {story.originCountry && (
                <span className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-xl bg-slate-800/80 text-slate-300 border border-slate-700/50">
                  <Globe className="w-3 h-3" />
                  <span>{story.originCountry} ({story.originalLanguage?.toUpperCase() || 'JA'})</span>
                </span>
              )}
            </div>

            {/* Title & Slug */}
            <div className="space-y-1">
              <h1 className="text-2xl sm:text-4xl font-black text-white tracking-tight leading-tight">
                {story.title}
              </h1>
              <p className="text-xs text-slate-400 font-mono">
                omninovel.com/stories/{story.slug}
              </p>
            </div>

            {/* Genres Tag Cloud */}
            {story.genres && story.genres.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {story.genres.map((g) => (
                  <Link
                    key={g.id}
                    href={`/search?genre=${encodeURIComponent(g.slug || g.name.toLowerCase())}`}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-xl bg-slate-950/80 hover:bg-red-600/20 hover:text-red-300 border border-slate-800 hover:border-red-500/40 text-slate-300 transition-colors"
                  >
                    <Tag className="w-3 h-3 text-red-400" />
                    <span>{g.name}</span>
                  </Link>
                ))}
              </div>
            )}

            {/* Synopsis / Description with Expand toggle */}
            <div className="space-y-2 pt-1">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Tóm Tắt Nội Dung
              </h3>
              <p
                className={`text-xs sm:text-sm text-slate-300 leading-relaxed ${
                  !isSynopsisExpanded ? 'line-clamp-3' : ''
                }`}
              >
                {synopsisText}
              </p>
              {synopsisText.length > 180 && (
                <button
                  onClick={() => setIsSynopsisExpanded(!isSynopsisExpanded)}
                  className="inline-flex items-center gap-1 text-xs font-bold text-red-400 hover:text-red-300 pt-1"
                >
                  {isSynopsisExpanded ? (
                    <>
                      <span>Thu gọn</span>
                      <ChevronUp className="w-3.5 h-3.5" />
                    </>
                  ) : (
                    <>
                      <span>Xem thêm</span>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Action Toolbar */}
            <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-slate-800/80">
              {/* Read From Chapter 1 */}
              {firstChapter && (
                <Link href={`/stories/${story.slug}/chapters/${firstChapter.chapterNumber}`}>
                  <Button variant="primary" size="lg" className="gap-2 shadow-lg shadow-red-600/30">
                    <BookOpen className="w-4 h-4" />
                    Đọc Từ Đầu (Ch.{firstChapter.chapterNumber})
                  </Button>
                </Link>
              )}

              {/* Read Latest Chapter */}
              {latestChapter && latestChapter.chapterNumber !== firstChapter?.chapterNumber && (
                <Link href={`/stories/${story.slug}/chapters/${latestChapter.chapterNumber}`}>
                  <Button variant="secondary" size="lg" className="gap-2">
                    <Flame className="w-4 h-4 text-red-400" />
                    Đọc Mới Nhất (Ch.{latestChapter.chapterNumber})
                  </Button>
                </Link>
              )}

              {/* Follow Button */}
              <Button
                variant={isFollowing ? 'secondary' : 'outline'}
                size="lg"
                onClick={handleToggleFollow}
                className={`gap-2 ${isFollowing ? 'text-rose-400 border-rose-500/40' : ''}`}
              >
                <Heart className={`w-4 h-4 ${isFollowing ? 'fill-rose-500 text-rose-500' : ''}`} />
                <span>{isFollowing ? 'Đã Theo Dõi' : 'Theo Dõi'}</span>
              </Button>

              {/* Share Button */}
              <Button variant="ghost" size="lg" onClick={handleShare} className="gap-2 text-slate-300">
                {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4" />}
                <span>{copiedLink ? 'Đã sao chép link' : 'Chia Sẻ'}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Chapter List Section */}
      <section>
        <ChapterListSection story={story} />
      </section>

      {/* 3. Community Reviews & Comments Section */}
      <section>
        <StoryCommentSection storySlug={story.slug} />
      </section>
    </div>
  );
}
