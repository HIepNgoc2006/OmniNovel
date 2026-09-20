'use client';

import React, { useEffect } from 'react';
import { TranslationJobReviewDetailResponse } from '@omninovel/shared';
import { useNovelReviewStudio } from '@/lib/studio/use-novel-review-studio';
import { NovelBlockList } from './novel-block-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Clock,
  Layers,
  Lock,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

export interface NovelReviewStudioProps {
  jobId: string;
  initialJobDetail?: TranslationJobReviewDetailResponse | null;
  onJobDetailChange?: (detail: TranslationJobReviewDetailResponse | null) => void;
  onOpenGlossary?: () => void;
}

export function NovelReviewStudio({
  jobId,
  initialJobDetail,
  onJobDetailChange,
  onOpenGlossary,
}: NovelReviewStudioProps) {
  const {
    status,
    jobDetail,
    error,
    segments,
    blocks,
    workspaceMode,
    segmentsLoading,
    segmentsError,
    refetchDetail,
    refetchSegments,
    drafts,
    savingSegmentIds,
    conflictStates,
    errorStates,
    setSegmentDraft,
    saveSegment,
    toggleVerification,
    selectPrev,
    selectNext,
    selectNextUnverified,
    selectNextError,
  } = useNovelReviewStudio(jobId, {
    initialJobDetail,
    onJobDetailChange,
  });

  // Global Keyboard Shortcuts for Bulk Traversal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        selectPrev();
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        selectNext();
      } else if (e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        selectNextUnverified();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectPrev, selectNext, selectNextUnverified]);

  // Loading Skeleton
  if (status === 'initializing' || (status === 'loading' && !jobDetail)) {
    return (
      <div
        data-testid="novel-studio-loading"
        className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4"
      >
        <div className="w-10 h-10 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mx-auto" />
        <p className="text-sm text-slate-400 font-medium">
          Đang khởi tạo Novel Review Studio...
        </p>
      </div>
    );
  }

  // Auth Required
  if (status === 'auth_required') {
    return (
      <div
        data-testid="novel-studio-auth-required"
        className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4"
      >
        <div className="p-4 rounded-full bg-amber-500/10 text-amber-400 w-16 h-16 mx-auto flex items-center justify-center border border-amber-500/20">
          <Lock className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-white">Yêu cầu đăng nhập</h2>
        <p className="text-sm text-slate-400">
          Bạn cần đăng nhập bằng tài khoản có thẩm quyền để duyệt bản dịch tiểu thuyết.
        </p>
      </div>
    );
  }

  // Error State
  if (status === 'error' || !jobDetail || !workspaceMode) {
    return (
      <div
        data-testid="novel-studio-error"
        className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4"
      >
        <div className="p-4 rounded-full bg-rose-500/10 text-rose-400 w-16 h-16 mx-auto flex items-center justify-center border border-rose-500/20">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-white">Không thể tải thông tin tác vụ</h2>
        <p className="text-sm text-rose-300">
          {error?.message || 'Đã có lỗi xảy ra trong quá trình truy xuất dữ liệu.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetchDetail()}
          className="mt-2"
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1" />
          Thử lại
        </Button>
      </div>
    );
  }

  // Unsupported MediaFormat
  if (workspaceMode.mode === 'UNSUPPORTED_FORMAT') {
    return (
      <div
        data-testid="novel-studio-unsupported-format"
        className="max-w-3xl mx-auto px-4 py-16 text-center space-y-4"
      >
        <div className="p-4 rounded-full bg-amber-500/10 text-amber-400 w-16 h-16 mx-auto flex items-center justify-center border border-amber-500/20">
          <Layers className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-white">Định dạng không được hỗ trợ</h2>
        <p className="text-sm text-slate-400">
          Tác vụ này thuộc định dạng{' '}
          <strong className="text-white">{jobDetail.context.story.mediaFormat}</strong>.
          Novel Review Studio chỉ hỗ trợ định dạng <strong className="text-white">NOVEL</strong>.
        </p>
      </div>
    );
  }

  // Pipeline Monitor (Job in-progress)
  if (workspaceMode.mode === 'PIPELINE_MONITOR') {
    return (
      <div
        data-testid="novel-studio-pipeline-monitor"
        className="max-w-3xl mx-auto px-4 py-16 text-center space-y-6"
      >
        <div className="p-4 rounded-full bg-indigo-500/10 text-indigo-400 w-16 h-16 mx-auto flex items-center justify-center border border-indigo-500/20 animate-pulse">
          <Sparkles className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-bold text-white">
            Tiến trình dịch tự động đang thực thi
          </h2>
          <p className="text-sm text-slate-400">
            Trạng thái hiện tại:{' '}
            <Badge variant="info" className="ml-1 font-mono">
              {jobDetail.job.status}
            </Badge>
          </p>
          <div className="max-w-md mx-auto pt-4 space-y-2">
            <div className="flex justify-between text-xs text-slate-400">
              <span>Tiến độ</span>
              <span>{jobDetail.job.progressPercentage}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-sky-400 transition-all duration-300"
                style={{ width: `${jobDetail.job.progressPercentage}%` }}
              />
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetchDetail()}
          className="mt-4"
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1" />
          Làm mới trạng thái
        </Button>
      </div>
    );
  }

  // Terminal State (Failed, Canceled, Expired)
  if (workspaceMode.mode === 'TERMINAL_STATE') {
    return (
      <div
        data-testid="novel-studio-terminal-state"
        className="max-w-3xl mx-auto px-4 py-16 text-center space-y-4"
      >
        <div className="p-4 rounded-full bg-rose-500/10 text-rose-400 w-16 h-16 mx-auto flex items-center justify-center border border-rose-500/20">
          <Clock className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-white">Tác vụ đã kết thúc</h2>
        <p className="text-sm text-slate-400">
          Tác vụ này đang ở trạng thái kết thúc{' '}
          <Badge variant="primary" className="ml-1 font-mono">
            {jobDetail.job.status}
          </Badge>
          , không thể chỉnh sửa hoặc duyệt bản dịch.
        </p>
      </div>
    );
  }

  // Reviewable & Applied Workspace
  const totalSegments = segments.length;
  const verifiedSegments = segments.filter((s) => s.isHumanVerified).length;
  const unverifiedCount = totalSegments - verifiedSegments;
  const hasErrors =
    Object.keys(errorStates).length > 0 || Object.keys(conflictStates).length > 0;
  const progressPercent =
    totalSegments > 0 ? Math.round((verifiedSegments / totalSegments) * 100) : 0;
  const isReadonly = !workspaceMode.canEdit;

  return (
    <div
      data-testid="novel-review-workspace"
      className="max-w-7xl mx-auto px-4 py-6 space-y-6"
    >
      {/* Top Banner for APPLIED State (P1 semantic: read-only, not "published") */}
      {workspaceMode.mode === 'APPLIED' && (
        <div
          data-testid="novel-studio-applied-banner"
          className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-between gap-3 text-sm text-indigo-300"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
            <span>
              <strong>Bản dịch đã được áp dụng</strong> — Không gian làm việc đang ở chế độ chỉ đọc.
            </span>
          </div>
          <Badge variant="info" className="text-xs font-mono">
            APPLIED
          </Badge>
        </div>
      )}

      {/* Authoritative Studio Header */}
      <header className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 space-y-5 backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-white font-sans">
                {jobDetail.context.story.title}
              </h1>
              <Badge variant="secondary" className="text-xs font-mono">
                {jobDetail.context.story.mediaFormat}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {jobDetail.context.project.sourceLanguage} →{' '}
                {jobDetail.context.project.targetLanguage}
              </Badge>
            </div>
            <p className="text-xs text-slate-400">
              Chương {jobDetail.context.chapter.chapterNumber}:{' '}
              {jobDetail.context.chapter.title || 'Không có tiêu đề'} • Bản dịch:{' '}
              {jobDetail.context.edition.editionName}
            </p>
          </div>

          {/* Quick Action Navigation Bar */}
          <div className="flex items-center gap-2 flex-wrap">
            {onOpenGlossary && (
              <Button
                variant="outline"
                size="sm"
                data-testid="novel-studio-glossary-btn"
                onClick={onOpenGlossary}
                className="h-8 text-xs"
              >
                <BookOpen className="w-3.5 h-3.5 mr-1 text-amber-400" />
                Thuật ngữ (Glossary)
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              data-testid="novel-nav-prev-btn"
              onClick={selectPrev}
              title="Phân đoạn trước (Alt+ArrowUp)"
              className="h-8 text-xs"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </Button>

            <Button
              variant="secondary"
              size="sm"
              data-testid="novel-nav-next-btn"
              onClick={selectNext}
              title="Phân đoạn sau (Alt+ArrowDown)"
              className="h-8 text-xs"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              data-testid="novel-nav-next-unverified-btn"
              onClick={selectNextUnverified}
              disabled={unverifiedCount === 0}
              title="Chưa duyệt tiếp theo (Alt+U)"
              className="h-8 text-xs"
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-slate-400" />
              Chưa duyệt ({unverifiedCount})
            </Button>

            {hasErrors && (
              <Button
                variant="destructive"
                size="sm"
                data-testid="novel-nav-next-error-btn"
                onClick={selectNextError}
                className="h-8 text-xs"
              >
                <ShieldAlert className="w-3.5 h-3.5 mr-1" />
                Lỗi cần xử lý
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetchSegments()}
              disabled={segmentsLoading}
              title="Tải lại phân đoạn"
              className="h-8 text-xs text-slate-400"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${segmentsLoading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </div>

        {/* Progress & Verification Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-800/80 pt-4 text-xs text-slate-400">
          <div className="flex items-center gap-3">
            <span
              data-testid="novel-studio-progress-counter"
              className="font-mono font-semibold text-white"
            >
              {verifiedSegments} / {totalSegments} đã duyệt
            </span>
            <span className="text-slate-500">•</span>
            <span>{blocks.length} khối nội dung</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-36 h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                data-testid="novel-studio-progress-bar"
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="font-mono text-emerald-400 font-bold w-10 text-right">
              {progressPercent}%
            </span>
          </div>
        </div>
      </header>

      {/* Segments Error Banner */}
      {segmentsError && (
        <div
          data-testid="novel-segments-error-banner"
          className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-3 text-sm text-rose-300"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>{segmentsError}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchSegments()}
            className="text-xs h-7"
          >
            Thử lại
          </Button>
        </div>
      )}

      {/* Segments Loading Spinner */}
      {segmentsLoading && segments.length === 0 ? (
        <div
          data-testid="novel-segments-loading"
          className="p-16 text-center space-y-3"
        >
          <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400" />
          <p className="text-xs text-slate-400">
            Đang tải danh sách phân đoạn dịch...
          </p>
        </div>
      ) : (
        /* Block List Review Workspace */
        <NovelBlockList
          blocks={blocks}
          drafts={drafts}
          savingSegmentIds={savingSegmentIds}
          conflictStates={conflictStates}
          errorStates={errorStates}
          onDraftChange={setSegmentDraft}
          onSaveSegment={saveSegment}
          onToggleVerify={toggleVerification}
          isReadonly={isReadonly}
        />
      )}
    </div>
  );
}
