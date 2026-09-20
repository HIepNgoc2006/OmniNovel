'use client';

import React from 'react';
import Link from 'next/link';
import { useStudioDashboard } from '@/lib/studio/use-studio-dashboard';
import { StudioMetricsCards } from '@/components/studio/dashboard/studio-metrics-cards';
import { StudioStorySelector } from '@/components/studio/dashboard/studio-story-selector';
import { StudioJobFilterBar } from '@/components/studio/dashboard/studio-job-filter-bar';
import { StudioJobCard } from '@/components/studio/dashboard/studio-job-card';
import { Radio, Sparkles, Plus, AlertTriangle, RefreshCw } from 'lucide-react';

export default function StudioPage() {
  const {
    stories,
    projects,
    jobs,
    pagination,
    filterGroup,
    searchKeyword,
    selectedStoryId,
    selectedProjectId,
    page,
    isInitialLoading,
    isJobsLoading,
    isLoadingProjects,
    error,
    socketStatus,
    setFilterGroup,
    setSearchKeyword,
    setSelectedStoryId,
    setSelectedProjectId,
    setPage,
    refetchJobs,
  } = useStudioDashboard();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold uppercase tracking-wider mb-1.5">
            <Sparkles className="w-4 h-4" />
            <span>AI Translation Studio Hub</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
            Bảng Điều Khiển Dịch Thuật
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Quản lý tiến trình dịch thuật AI đa phương thức (Webtoon & Light Novel), theo dõi thời gian thực và phê duyệt bản dịch.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Realtime WebSocket Status Badge */}
          <div className="flex items-center gap-2 bg-slate-900/80 border border-slate-800 px-3.5 py-2 rounded-xl text-xs font-semibold backdrop-blur-sm">
            <Radio
              className={`w-3.5 h-3.5 ${
                socketStatus.isConnected
                  ? 'text-emerald-400 animate-pulse'
                  : 'text-slate-500'
              }`}
            />
            <span className="text-slate-400 font-normal">Realtime:</span>
            <span
              className={
                socketStatus.isConnected ? 'text-emerald-400 font-medium' : 'text-slate-500'
              }
            >
              {socketStatus.isConnected ? 'Đang kết nối' : 'Mất kết nối'}
            </span>
          </div>

          {/* Action: Create New Translation */}
          <Link
            href="/studio/ai/jobs/new"
            data-testid="create-job-cta-btn"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 active:scale-95 transition-all shadow-lg shadow-indigo-600/20"
          >
            <Plus className="w-4 h-4" />
            <span>Tạo Bản Dịch Mới</span>
          </Link>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex items-center justify-between p-4 rounded-2xl bg-rose-950/50 border border-rose-800/80 text-rose-300 text-sm">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            data-testid="dashboard-retry-btn"
            onClick={() => refetchJobs()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-900/80 hover:bg-rose-800 text-rose-100 transition-all cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Thử lại</span>
          </button>
        </div>
      )}

      {/* Metrics Quick Overview */}
      <StudioMetricsCards
        jobs={jobs}
        currentGroup={filterGroup}
        onSelectGroup={setFilterGroup}
      />

      {/* Filter and Search Bar Section */}
      <div className="space-y-4">
        {/* Story and Edition Selector */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <StudioStorySelector
            stories={stories}
            selectedStoryId={selectedStoryId}
            onSelectStory={setSelectedStoryId}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            isLoadingProjects={isLoadingProjects}
          />
        </div>

        {/* Status Group Tabs and Search */}
        <StudioJobFilterBar
          currentGroup={filterGroup}
          searchKeyword={searchKeyword}
          onSelectGroup={setFilterGroup}
          onSearchChange={setSearchKeyword}
          onRefresh={() => refetchJobs()}
          isRefreshing={isJobsLoading}
        />
      </div>

      {/* Job Cards List */}
      <div className="space-y-3 relative min-h-[200px]">
        {isInitialLoading ? (
          <div
            data-testid="dashboard-loading-skeleton"
            className="space-y-3 animate-pulse"
          >
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-28 rounded-2xl bg-slate-900/60 border border-slate-800/80 p-4"
              />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-3xl bg-slate-900/40 border border-dashed border-slate-800 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center text-xl text-slate-400">
              📂
            </div>
            <h3 className="text-base font-bold text-white">
              Không tìm thấy tiến trình dịch thuật nào
            </h3>
            <p className="text-xs text-slate-400 max-w-sm">
              Không có tiến trình nào khớp với bộ lọc hiện tại hoặc tác phẩm chưa có bản dịch.
            </p>
            <Link
              href="/studio/manga"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-indigo-300 bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-800/80 transition-all mt-2"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Bắt đầu tiến trình dịch</span>
            </Link>
          </div>
        ) : (
          <>
            {isJobsLoading && (
              <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px] flex items-center justify-center z-10 rounded-2xl">
                <div className="px-4 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs font-medium text-slate-300 shadow-xl flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                  <span>Đang tải...</span>
                </div>
              </div>
            )}
            <div className="space-y-3">
              {jobs.map((job) => (
                <StudioJobCard key={job.id} job={job} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination Controls */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t border-slate-800 text-xs text-slate-400">
          <span>
            Tổng cộng: <strong className="text-slate-200">{pagination.total}</strong> tiến trình
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="pagination-prev-btn"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1 || isJobsLoading}
              className="px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Trước
            </button>

            <span className="px-2 font-medium text-slate-300">
              Trang {page} / {pagination.totalPages}
            </span>

            <button
              type="button"
              data-testid="pagination-next-btn"
              onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
              disabled={page >= pagination.totalPages || isJobsLoading}
              className="px-3 py-1.5 rounded-xl border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Sau
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
