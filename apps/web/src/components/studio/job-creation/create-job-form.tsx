'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useCreateTranslationJob } from '../../../lib/studio/use-create-translation-job';
import { StudioHierarchySelector } from './studio-hierarchy-selector';
import { StudioProviderConsentCard } from './studio-provider-consent-card';

export interface CreateJobFormProps {
  initialStorySlug?: string;
  initialChapterId?: string;
}

export function CreateJobForm({
  initialStorySlug,
  initialChapterId,
}: CreateJobFormProps) {
  const state = useCreateTranslationJob({
    initialStorySlug,
    initialChapterId,
  });

  const submitDisabled = !state.canSubmit || state.isSubmitting;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Link
            href="/studio"
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-400 transition hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Về Studio Dashboard
          </Link>
          <div className="flex items-center gap-2 text-indigo-400">
            <Sparkles className="h-4 w-4" />
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]">
              AI Translation Studio
            </span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
            Tạo Bản Dịch Mới
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-400">
            Chọn đúng nguồn canonical, cấu hình ngôn ngữ và nhà cung cấp. Mỗi lần gửi
            hợp lệ dùng một Idempotency Key cố định để chống tạo job trùng.
          </p>
        </div>
      </div>

      {state.lifecycle === 'SUBMISSION_OUTCOME_UNKNOWN' && (
        <div
          role="alert"
          data-testid="job-create-ambiguity-banner"
          className="rounded-2xl border border-purple-700/60 bg-purple-950/35 p-4 text-purple-200"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-purple-400" />
            <div className="flex-1 space-y-2">
              <p className="text-sm font-bold">Chưa xác định kết quả submission</p>
              <p className="text-xs leading-5 text-purple-300/90">
                Máy chủ có thể đã tạo job trước khi kết nối bị gián đoạn. Hệ thống đã
                giữ nguyên Idempotency Key; không tạo key mới cho lần thử lại này.
              </p>
              {state.submissionError?.message && (
                <p className="text-xs text-purple-300">{state.submissionError.message}</p>
              )}
              <button
                type="button"
                onClick={() => void state.retry()}
                disabled={state.isSubmitting}
                className="mt-1 inline-flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Thử lại với cùng Idempotency Key
              </button>
            </div>
          </div>
        </div>
      )}

      {state.lifecycle === 'FAILED' && state.submissionError && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-800/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-300"
        >
          <p className="font-semibold">Không thể tạo bản dịch</p>
          <p className="mt-1 text-xs leading-5">{state.submissionError.message}</p>
        </div>
      )}

      <StudioHierarchySelector
        stories={state.stories}
        storyDetail={state.storyDetail}
        chapterVersions={state.chapterVersions}
        selectedStoryId={state.selectedStoryId}
        selectedEditionId={state.selectedEditionId}
        selectedChapterId={state.selectedChapterId}
        selectedVersionId={state.selectedVersionId}
        isLoadingStories={state.isLoadingStories}
        isLoadingStoryDetail={state.isLoadingStoryDetail}
        isLoadingVersions={state.isLoadingVersions}
        hierarchyError={state.hierarchyError}
        onSelectStory={state.selectStory}
        onSelectEdition={state.selectEdition}
        onSelectChapter={state.selectChapter}
        onSelectVersion={state.selectVersion}
      />

      <StudioProviderConsentCard
        sourceLang={state.sourceLang}
        targetLang={state.targetLang}
        provider={state.provider}
        externalConsent={state.externalConsent}
        errors={state.formErrors}
        onTargetLangChange={state.setTargetLang}
        onProviderChange={state.setProvider}
        onExternalConsentChange={state.setExternalConsent}
      />

      <div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:justify-end">
        <Link
          href="/studio"
          className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-800"
        >
          Hủy
        </Link>
        <button
          type="button"
          data-testid="job-create-submit"
          disabled={submitDisabled}
          onClick={() => void state.submit()}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {state.isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {state.isSubmitting ? 'Đang khởi tạo...' : 'Khởi tạo bản dịch'}
        </button>
      </div>
    </div>
  );
}
