'use client';

import React from 'react';
import Link from 'next/link';
import {
  TranslationJobSummaryDto,
  TranslationJobStatus,
  MediaFormat,
  JOB_STATUS_GROUPS,
} from '@omninovel/shared';

export interface StudioJobCardProps {
  job: TranslationJobSummaryDto;
}

const STATUS_CONFIG: Record<
  TranslationJobStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  [TranslationJobStatus.CREATED]: {
    label: 'Khởi tạo',
    color: 'text-slate-300',
    bg: 'bg-slate-800/80',
    border: 'border-slate-700',
  },
  [TranslationJobStatus.VALIDATING]: {
    label: 'Kiểm tra',
    color: 'text-sky-300',
    bg: 'bg-sky-950/60',
    border: 'border-sky-800',
  },
  [TranslationJobStatus.QUEUED]: {
    label: 'Trong hàng đợi',
    color: 'text-indigo-300',
    bg: 'bg-indigo-950/60',
    border: 'border-indigo-800',
  },
  [TranslationJobStatus.PREPROCESSING]: {
    label: 'Tiền xử lý',
    color: 'text-cyan-300',
    bg: 'bg-cyan-950/60',
    border: 'border-cyan-800',
  },
  [TranslationJobStatus.OCR]: {
    label: 'Nhận diện chữ',
    color: 'text-blue-300',
    bg: 'bg-blue-950/60',
    border: 'border-blue-800',
  },
  [TranslationJobStatus.TRANSLATING]: {
    label: 'Đang dịch AI',
    color: 'text-indigo-300',
    bg: 'bg-indigo-950/60',
    border: 'border-indigo-800',
  },
  [TranslationJobStatus.INPAINTING]: {
    label: 'Xóa chữ gốc',
    color: 'text-purple-300',
    bg: 'bg-purple-950/60',
    border: 'border-purple-800',
  },
  [TranslationJobStatus.TYPESETTING]: {
    label: 'Điền chữ (Typeset)',
    color: 'text-fuchsia-300',
    bg: 'bg-fuchsia-950/60',
    border: 'border-fuchsia-800',
  },
  [TranslationJobStatus.QUALITY_CHECK]: {
    label: 'Kiểm định QA',
    color: 'text-amber-300',
    bg: 'bg-amber-950/60',
    border: 'border-amber-800',
  },
  [TranslationJobStatus.READY_FOR_REVIEW]: {
    label: 'Chờ duyệt',
    color: 'text-amber-400',
    bg: 'bg-amber-950/80',
    border: 'border-amber-700',
  },
  [TranslationJobStatus.APPLIED]: {
    label: 'Đã xuất bản',
    color: 'text-emerald-400',
    bg: 'bg-emerald-950/80',
    border: 'border-emerald-700',
  },
  [TranslationJobStatus.FAILED]: {
    label: 'Thất bại',
    color: 'text-rose-400',
    bg: 'bg-rose-950/80',
    border: 'border-rose-700',
  },
  [TranslationJobStatus.CANCELED]: {
    label: 'Đã hủy',
    color: 'text-slate-400',
    bg: 'bg-slate-800/80',
    border: 'border-slate-700',
  },
  [TranslationJobStatus.EXPIRED]: {
    label: 'Hết hạn',
    color: 'text-zinc-400',
    bg: 'bg-zinc-800/80',
    border: 'border-zinc-700',
  },
};

export function StudioJobCard({ job }: StudioJobCardProps) {
  const statusCfg = STATUS_CONFIG[job.status] || {
    label: job.status,
    color: 'text-slate-300',
    bg: 'bg-slate-800',
    border: 'border-slate-700',
  };

  const isReview = job.status === TranslationJobStatus.READY_FOR_REVIEW;
  const isApplied = job.status === TranslationJobStatus.APPLIED;
  const isActive = (JOB_STATUS_GROUPS.ACTIVE as readonly string[]).includes(job.status);
  const isComic = job.mediaFormat === MediaFormat.COMIC;

  // Review URL routing based on media format
  const reviewUrl = isComic
    ? `/studio/manga?jobId=${job.id}`
    : `/studio/novel?jobId=${job.id}`;

  const readerUrl = job.chapterId
    ? `/story/${job.storySlug || 'story'}/chapter/${job.chapterId}`
    : `/story/${job.storySlug || 'story'}`;

  return (
    <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 rounded-2xl bg-slate-900/70 border border-slate-800/90 hover:border-slate-700 transition-all duration-200 gap-4 shadow-sm hover:shadow-md">
      {/* Left: Info */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Media Format Badge */}
          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider uppercase bg-slate-800 text-slate-300 border border-slate-700">
            {isComic ? 'Manga / Webtoon' : 'Light Novel'}
          </span>

          {/* Status Badge */}
          <span
            data-testid="job-status-badge"
            className={`px-2.5 py-0.5 rounded-md text-xs font-semibold border ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}
          >
            {statusCfg.label}
          </span>

          {/* Languages */}
          <span className="text-xs text-slate-400 font-mono">
            {job.sourceLanguage.toUpperCase()} → {job.targetLanguage.toUpperCase()}
          </span>
        </div>

        {/* Story Title & Chapter */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <h4 className="text-sm font-bold text-white truncate max-w-sm">
            {job.storyTitle || 'Tác phẩm chưa đặt tên'}
          </h4>
          <span className="text-xs font-medium text-slate-400">
            Chương {job.chapterNumber}
            {job.chapterTitle ? `: ${job.chapterTitle}` : ''}
          </span>
        </div>

        {/* Progress & Heartbeat */}
        <div className="flex items-center gap-3 pt-1">
          <div className="w-32 bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isReview || isApplied
                  ? 'bg-emerald-500'
                  : job.status === TranslationJobStatus.FAILED
                  ? 'bg-rose-500'
                  : 'bg-indigo-500'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, job.progressPercentage))}%` }}
            />
          </div>
          <span className="text-xs font-mono font-medium text-slate-300">
            {job.progressPercentage}%
          </span>

          {isActive && (
            <span className="flex items-center gap-1.5 text-[11px] text-sky-400 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
              Đang thực thi
            </span>
          )}

          {job.heartbeatAt && !isReview && !isApplied && (
            <span className="text-[11px] text-slate-500">
              Heartbeat: {new Date(job.heartbeatAt).toLocaleTimeString('vi-VN')}
            </span>
          )}
        </div>
      </div>

      {/* Right: Contextual CTA */}
      <div className="flex items-center gap-2 self-stretch md:self-auto justify-end">
        {isReview && (
          <Link
            href={reviewUrl}
            data-testid="job-cta-button"
            className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 active:scale-95 transition-all shadow-md shadow-indigo-600/25"
          >
            <span>Duyệt bản dịch</span>
            <span>→</span>
          </Link>
        )}

        {isApplied && (
          <Link
            href={readerUrl}
            data-testid="job-cta-button"
            className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-800/80 active:scale-95 transition-all"
          >
            <span>Xem trên Reader</span>
            <span>↗</span>
          </Link>
        )}

        {isActive && (
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium text-slate-400 bg-slate-800/50 border border-slate-700/50">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
            Đang xử lý...
          </span>
        )}

        {!isReview && !isApplied && !isActive && (
          <span className="text-xs text-slate-500 italic">
            {job.status === TranslationJobStatus.FAILED
              ? 'Cần tạo lại tiến trình'
              : 'Đã hoàn tất / lưu trữ'}
          </span>
        )}
      </div>
    </div>
  );
}
