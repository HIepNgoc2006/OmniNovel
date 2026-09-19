'use client';

import React from 'react';
import { JobStatusGroup } from '@omninovel/shared';

export interface StudioJobFilterBarProps {
  currentGroup: JobStatusGroup;
  searchKeyword: string;
  onSelectGroup: (group: JobStatusGroup) => void;
  onSearchChange: (keyword: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

const FILTER_TABS: Array<{ key: JobStatusGroup; label: string }> = [
  { key: 'ALL', label: 'Tất cả' },
  { key: 'ACTIVE', label: 'Đang chạy' },
  { key: 'REVIEW', label: 'Chờ duyệt' },
  { key: 'APPLIED', label: 'Đã xuất bản' },
  { key: 'PROBLEM', label: 'Sự cố' },
];

export function StudioJobFilterBar({
  currentGroup,
  searchKeyword,
  onSelectGroup,
  onSearchChange,
  onRefresh,
  isRefreshing = false,
}: StudioJobFilterBarProps) {
  return (
    <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-slate-900/60 p-2.5 rounded-2xl border border-slate-800 backdrop-blur-sm">
      {/* Status Group Tabs */}
      <div className="flex items-center overflow-x-auto gap-1.5 scrollbar-none">
        {FILTER_TABS.map((tab) => {
          const isActive = currentGroup === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              data-testid={`filter-pill-${tab.key}`}
              data-active={isActive ? 'true' : undefined}
              onClick={() => onSelectGroup(tab.key)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-150 cursor-pointer ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search Input & Refresh Button */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 md:w-64">
          <input
            type="text"
            data-testid="studio-search-input"
            value={searchKeyword}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Tìm theo tên truyện, số chương..."
            className="w-full bg-slate-950/80 text-slate-200 placeholder-slate-500 text-xs rounded-xl px-3.5 py-2 border border-slate-700/80 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all shadow-inner"
          />
          {searchKeyword && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs"
            >
              ✕
            </button>
          )}
        </div>

        {onRefresh && (
          <button
            type="button"
            data-testid="studio-refresh-button"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Làm mới danh sách"
            className="p-2 rounded-xl text-slate-400 hover:text-white bg-slate-800/80 hover:bg-slate-700 border border-slate-700 transition-all disabled:opacity-50 cursor-pointer text-xs"
          >
            <span className={`inline-block ${isRefreshing ? 'animate-spin' : ''}`}>
              🔄
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
