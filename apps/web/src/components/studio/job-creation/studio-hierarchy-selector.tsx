'use client';

import React from 'react';
import {
  ChapterVersionType,
  ManagedStorySummaryDto,
  StudioChapterVersionSummaryDto,
} from '@omninovel/shared';
import { Story } from '../../../lib/api/stories';

export interface StudioHierarchySelectorProps {
  stories: ManagedStorySummaryDto[];
  storyDetail: Story | null;
  chapterVersions: StudioChapterVersionSummaryDto[];
  selectedStoryId: string | null;
  selectedEditionId: string | null;
  selectedChapterId: string | null;
  selectedVersionId: string | null;
  isLoadingStories: boolean;
  isLoadingStoryDetail: boolean;
  isLoadingVersions: boolean;
  hierarchyError: string | null;
  onSelectStory: (id: string | null) => void | Promise<void>;
  onSelectEdition: (id: string | null) => void;
  onSelectChapter: (id: string | null) => void | Promise<void>;
  onSelectVersion: (id: string | null) => void;
}

function versionTypeLabel(type: ChapterVersionType): string {
  switch (type) {
    case ChapterVersionType.RAW_ORIGINAL:
      return 'Bản gốc';
    case ChapterVersionType.HUMAN_EDITED:
      return 'Biên tập thủ công';
    case ChapterVersionType.AI_TRANSLATED:
      return 'Bản dịch AI';
    default:
      return type;
  }
}

export function StudioHierarchySelector({
  stories,
  storyDetail,
  chapterVersions,
  selectedStoryId,
  selectedEditionId,
  selectedChapterId,
  selectedVersionId,
  isLoadingStories,
  isLoadingStoryDetail,
  isLoadingVersions,
  hierarchyError,
  onSelectStory,
  onSelectEdition,
  onSelectChapter,
  onSelectVersion,
}: StudioHierarchySelectorProps) {
  const editions = storyDetail?.editions ?? [];
  const selectedEdition =
    editions.find((edition) => edition.id === selectedEditionId) ?? null;
  const chapters = selectedEdition?.chapters ?? [];

  return (
    <section
      aria-labelledby="job-source-heading"
      className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-400">
            Nguồn dịch
          </p>
          <h2 id="job-source-heading" className="mt-1 text-lg font-bold text-white">
            Chọn Story → Edition → Chapter → Version
          </h2>
        </div>
        <span className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1 text-[11px] text-slate-400">
          Canonical hierarchy
        </span>
      </div>

      {hierarchyError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-800/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-300"
        >
          {hierarchyError}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">1. Bộ truyện</span>
          <select
            aria-label="Chọn bộ truyện"
            data-testid="job-create-story-select"
            value={selectedStoryId ?? ''}
            disabled={isLoadingStories}
            onChange={(event) => void onSelectStory(event.target.value || null)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
          >
            <option value="">
              {isLoadingStories ? 'Đang tải bộ truyện...' : 'Chọn bộ truyện'}
            </option>
            {stories.map((story) => (
              <option key={story.id} value={story.id}>
                {story.title}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">2. Ấn bản</span>
          <select
            aria-label="Chọn ấn bản"
            data-testid="job-create-edition-select"
            value={selectedEditionId ?? ''}
            disabled={!storyDetail || isLoadingStoryDetail}
            onChange={(event) => onSelectEdition(event.target.value || null)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
          >
            <option value="">
              {isLoadingStoryDetail ? 'Đang tải ấn bản...' : 'Chọn ấn bản'}
            </option>
            {editions.map((edition) => (
              <option key={edition.id} value={edition.id}>
                {edition.editionName} ({edition.language.toUpperCase()})
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">3. Chương</span>
          <select
            aria-label="Chọn chương"
            data-testid="job-create-chapter-select"
            value={selectedChapterId ?? ''}
            disabled={!selectedEditionId}
            onChange={(event) => void onSelectChapter(event.target.value || null)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
          >
            <option value="">Chọn chương</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                Chương {chapter.chapterNumber}
                {chapter.title ? ` — ${chapter.title}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">4. Phiên bản nguồn</span>
          <select
            aria-label="Chọn phiên bản nguồn"
            data-testid="job-create-version-select"
            value={selectedVersionId ?? ''}
            disabled={!selectedChapterId || isLoadingVersions}
            onChange={(event) => onSelectVersion(event.target.value || null)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
          >
            <option value="">
              {isLoadingVersions ? 'Đang tải phiên bản...' : 'Chọn phiên bản nguồn'}
            </option>
            {chapterVersions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.versionNumber} · {versionTypeLabel(version.versionType)} ·{' '}
                {version.language.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedVersionId && (
        <div className="grid gap-3 sm:grid-cols-2">
          {chapterVersions
            .filter((version) => version.id === selectedVersionId)
            .map((version) => (
              <React.Fragment key={version.id}>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">Version</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    v{version.versionNumber} · {versionTypeLabel(version.versionType)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">Ngôn ngữ nguồn</p>
                  <p className="mt-1 text-sm font-semibold uppercase text-slate-200">
                    {version.language}
                  </p>
                </div>
              </React.Fragment>
            ))}
        </div>
      )}
    </section>
  );
}
