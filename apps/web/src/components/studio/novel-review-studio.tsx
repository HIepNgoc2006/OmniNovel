'use client';

import React from 'react';
import { TranslationJobReviewDetailResponse } from '@omninovel/shared';

export interface NovelReviewStudioProps {
  jobId: string;
  initialJobDetail?: TranslationJobReviewDetailResponse | null;
  onJobDetailChange?: (detail: TranslationJobReviewDetailResponse | null) => void;
}

export function NovelReviewStudio({
  jobId,
  initialJobDetail,
  onJobDetailChange,
}: NovelReviewStudioProps) {
  return (
    <div
      data-testid="novel-review-workspace"
      className="max-w-7xl mx-auto px-4 py-8 space-y-6"
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-white">
            {initialJobDetail?.context.story.title || 'Novel Review Studio'}
          </h1>
          <p className="text-xs text-slate-400">
            Chương {initialJobDetail?.context.chapter.chapterNumber}:{' '}
            {initialJobDetail?.context.chapter.title}
          </p>
        </div>
      </div>
    </div>
  );
}
