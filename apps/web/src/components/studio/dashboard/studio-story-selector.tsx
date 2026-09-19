'use client';

import React from 'react';
import {
  ManagedStorySummaryDto,
  TranslationProjectSummaryDto,
  MediaFormat,
} from '@omninovel/shared';

export interface StudioStorySelectorProps {
  stories: ManagedStorySummaryDto[];
  selectedStoryId: string | null;
  onSelectStory: (id: string | null) => void;
  projects?: TranslationProjectSummaryDto[];
  selectedProjectId?: string | null;
  onSelectProject?: (id: string | null) => void;
  isLoadingProjects?: boolean;
}

export function StudioStorySelector({
  stories,
  selectedStoryId,
  onSelectStory,
  projects = [],
  selectedProjectId = null,
  onSelectProject,
  isLoadingProjects = false,
}: StudioStorySelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Story Select */}
      <div className="relative min-w-[240px]">
        <select
          data-testid="studio-story-select"
          value={selectedStoryId || ''}
          onChange={(e) => onSelectStory(e.target.value ? e.target.value : null)}
          className="w-full appearance-none bg-slate-900/90 text-slate-200 text-sm font-medium border border-slate-700/80 rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all cursor-pointer shadow-inner"
        >
          <option value="" className="bg-slate-900 text-slate-300">
            Tất cả tác phẩm
          </option>
          {stories.map((story) => (
            <option
              key={story.id}
              value={story.id}
              className="bg-slate-900 text-slate-100"
            >
              [{story.mediaFormat === MediaFormat.COMIC ? 'Truyện tranh' : 'Tiểu thuyết'}]{' '}
              {story.title}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 text-xs">
          ▼
        </div>
      </div>

      {/* Project/Edition Select if a story is selected */}
      {selectedStoryId && onSelectProject && (
        <div className="relative min-w-[200px]">
          <select
            data-testid="studio-project-select"
            value={selectedProjectId || ''}
            onChange={(e) =>
              onSelectProject(e.target.value ? e.target.value : null)
            }
            disabled={isLoadingProjects}
            className="w-full appearance-none bg-slate-900/90 text-slate-200 text-sm font-medium border border-slate-700/80 rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all cursor-pointer shadow-inner disabled:opacity-50"
          >
            <option value="" className="bg-slate-900 text-slate-300">
              Tất cả bản dịch
            </option>
            {projects.map((proj) => (
              <option
                key={proj.id}
                value={proj.id}
                className="bg-slate-900 text-slate-100"
              >
                {proj.sourceLanguage.toUpperCase()} → {proj.targetLanguage.toUpperCase()}
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 text-xs">
            {isLoadingProjects ? '...' : '▼'}
          </div>
        </div>
      )}
    </div>
  );
}
