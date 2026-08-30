'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useStories } from '../../../lib/query/hooks';
import { StoryCard } from '../../../components/story/story-card';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { MediaFormat, StoryStatus } from '@omninovel/shared';
import {
  Search as SearchIcon,
  SlidersHorizontal,
  RotateCcw,
  Sparkles,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Filter,
} from 'lucide-react';

const GENRE_OPTIONS = [
  { label: 'Tất cả thể loại', value: '' },
  { label: 'Action', value: 'action' },
  { label: 'Isekai', value: 'isekai' },
  { label: 'Fantasy', value: 'fantasy' },
  { label: 'Romance', value: 'romance' },
  { label: 'Sci-Fi', value: 'sci-fi' },
  { label: 'Comedy', value: 'comedy' },
  { label: 'Mystery', value: 'mystery' },
  { label: 'Drama', value: 'drama' },
  { label: 'Adventure', value: 'adventure' },
  { label: 'Supernatural', value: 'supernatural' },
];

function SearchCatalogContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL state
  const queryParam = searchParams.get('q') || searchParams.get('search') || '';
  const formatParam = searchParams.get('format') || '';
  const genreParam = searchParams.get('genre') || '';
  const statusParam = searchParams.get('status') || '';
  const sortParam = searchParams.get('sort') || 'LATEST';
  const pageParam = parseInt(searchParams.get('page') || '1', 10);

  // Local filter states
  const [keyword, setKeyword] = useState(queryParam);
  const [selectedFormat, setSelectedFormat] = useState<string>(formatParam);
  const [selectedGenre, setSelectedGenre] = useState<string>(genreParam);
  const [selectedStatus, setSelectedStatus] = useState<string>(statusParam);
  const [selectedSort, setSelectedSort] = useState<string>(sortParam);

  useEffect(() => {
    setKeyword(queryParam);
    setSelectedFormat(formatParam);
    setSelectedGenre(genreParam);
    setSelectedStatus(statusParam);
    setSelectedSort(sortParam);
  }, [queryParam, formatParam, genreParam, statusParam, sortParam]);

  // Query Stories from API
  const { data: storiesResponse, isLoading } = useStories({
    page: pageParam,
    limit: 16,
    q: queryParam || undefined,
    format: selectedFormat || undefined,
    genre: selectedGenre || undefined,
    status: (selectedStatus as StoryStatus) || undefined,
    sort: selectedSort || undefined,
  });

  const stories = storiesResponse?.data || [];
  const pagination = storiesResponse?.pagination || {
    page: 1,
    limit: 16,
    total: 0,
    totalPages: 1,
  };

  const applyFilters = (overrides?: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();

    const finalQuery = overrides?.search !== undefined ? overrides.search : keyword;
    const finalFormat = overrides?.format !== undefined ? overrides.format : selectedFormat;
    const finalGenre = overrides?.genre !== undefined ? overrides.genre : selectedGenre;
    const finalStatus = overrides?.status !== undefined ? overrides.status : selectedStatus;
    const finalSort = overrides?.sort !== undefined ? overrides.sort : selectedSort;
    const finalPage = overrides?.page !== undefined ? overrides.page : 1;

    if (finalQuery) params.set('q', String(finalQuery));
    if (finalFormat) params.set('format', String(finalFormat));
    if (finalGenre && finalGenre !== 'Tất cả thể loại') params.set('genre', String(finalGenre));
    if (finalStatus) params.set('status', String(finalStatus));
    if (finalSort && finalSort !== 'LATEST') params.set('sort', String(finalSort));
    if (Number(finalPage) > 1) params.set('page', String(finalPage));

    router.push(`/search?${params.toString()}`);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applyFilters({ search: keyword, page: 1 });
  };

  const handleResetFilters = () => {
    setKeyword('');
    setSelectedFormat('');
    setSelectedGenre('');
    setSelectedStatus('');
    setSelectedSort('LATEST');
    router.push('/search');
  };

  return (
    <div className="space-y-8 pb-16">
      {/* Header Title & Search Input */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs font-bold text-red-500 uppercase tracking-widest">
          <Sparkles className="w-4 h-4" />
          <span>Kho Truyện Đa Phương Thức</span>
        </div>
        <h1 className="text-2xl sm:text-4xl font-black text-white tracking-tight">
          Tìm Kiếm & Khám Phá Truyện
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-xl">
          Lọc theo thể loại, định dạng Manga / Light Novel, trạng thái hoàn thành và thứ tự sắp xếp phổ biến.
        </p>

        {/* Search Bar Input */}
        <form onSubmit={handleSearchSubmit} className="relative max-w-2xl pt-2">
          <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Nhập tên truyện, tác giả hoặc từ khóa..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="w-full bg-slate-900/90 border border-slate-800 focus:border-red-500 rounded-2xl pl-12 pr-28 py-3.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none shadow-xl transition-colors"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="absolute right-2 top-1/2 -translate-y-1/2"
          >
            Tìm Kiếm
          </Button>
        </form>
      </div>

      {/* Multi-Criteria Filter Bar */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 sm:p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <SlidersHorizontal className="w-4 h-4 text-red-400" />
            <span>Bộ Lọc Nâng Cao</span>
          </div>

          {(selectedFormat || selectedGenre || selectedStatus || keyword || selectedSort !== 'LATEST') && (
            <button
              onClick={handleResetFilters}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-400 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Đặt lại bộ lọc</span>
            </button>
          )}
        </div>

        {/* Filter Rows */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          {/* 1. Format */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-300 block">Định Dạng</label>
            <select
              value={selectedFormat}
              onChange={(e) => {
                setSelectedFormat(e.target.value);
                applyFilters({ format: e.target.value, page: 1 });
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-red-500"
            >
              <option value="">Tất cả định dạng</option>
              <option value={MediaFormat.COMIC}>Manga / Webtoon (Tranh)</option>
              <option value={MediaFormat.NOVEL}>Light Novel / Web Novel (Chữ)</option>
            </select>
          </div>

          {/* 2. Genre */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-300 block">Thể Loại</label>
            <select
              value={selectedGenre}
              onChange={(e) => {
                setSelectedGenre(e.target.value);
                applyFilters({ genre: e.target.value, page: 1 });
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-red-500"
            >
              {GENRE_OPTIONS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>

          {/* 3. Status */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-300 block">Tình Trạng</label>
            <select
              value={selectedStatus}
              onChange={(e) => {
                setSelectedStatus(e.target.value);
                applyFilters({ status: e.target.value, page: 1 });
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-red-500"
            >
              <option value="">Tất cả tình trạng</option>
              <option value={StoryStatus.ONGOING}>Đang tiến hành</option>
              <option value={StoryStatus.COMPLETED}>Đã hoàn thành</option>
            </select>
          </div>

          {/* 4. Sort Order */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-300 block">Sắp Xếp</label>
            <select
              value={selectedSort}
              onChange={(e) => {
                setSelectedSort(e.target.value);
                applyFilters({ sort: e.target.value, page: 1 });
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-red-500"
            >
              <option value="LATEST">Mới cập nhật</option>
              <option value="VIEWS">Xem nhiều nhất</option>
              <option value="POPULAR">Nổi bật nhất</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs text-slate-400 px-1">
        <span>
          Tìm thấy <span className="text-white font-bold">{pagination.total || stories.length}</span> bộ truyện
          {queryParam && <span> cho từ khóa &quot;{queryParam}&quot;</span>}
        </span>

        <span>Trang {pagination.page} / {pagination.totalPages || 1}</span>
      </div>

      {/* Catalog Stories Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-3 w-1/2 rounded" />
            </div>
          ))}
        </div>
      ) : stories.length === 0 ? (
        <div className="py-16 text-center bg-slate-900/40 border border-slate-800/60 rounded-3xl p-8 space-y-4">
          <BookOpen className="w-12 h-12 text-slate-600 mx-auto" />
          <h3 className="font-bold text-base text-slate-200">Không tìm thấy bộ truyện nào</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Không có kết quả nào khớp với các tiêu chí tìm kiếm hiện tại. Hãy thử thay đổi từ khóa hoặc đặt lại bộ lọc.
          </p>
          <Button variant="secondary" size="sm" onClick={handleResetFilters}>
            Đặt Lại Bộ Lọc
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {stories.map((story) => (
            <StoryCard key={story.id || story.slug} story={story} />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-6">
          <Button
            variant="secondary"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => applyFilters({ page: pagination.page - 1 })}
            className="gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Trước</span>
          </Button>

          <span className="text-xs text-slate-400 px-3">
            {pagination.page} / {pagination.totalPages}
          </span>

          <Button
            variant="secondary"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => applyFilters({ page: pagination.page + 1 })}
            className="gap-1"
          >
            <span>Sau</span>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6 py-8">
          <Skeleton className="h-10 w-64 rounded-xl" />
          <Skeleton className="h-40 w-full rounded-3xl" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />
            ))}
          </div>
        </div>
      }
    >
      <SearchCatalogContent />
    </Suspense>
  );
}
