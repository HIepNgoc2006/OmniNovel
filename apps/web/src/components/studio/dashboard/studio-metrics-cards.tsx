'use client';

import React from 'react';
import {
  TranslationJobSummaryDto,
  JOB_STATUS_GROUPS,
  JobStatusGroup,
} from '@omninovel/shared';

export interface StudioMetricsCardsProps {
  jobs: TranslationJobSummaryDto[];
  currentGroup: JobStatusGroup;
  onSelectGroup: (group: JobStatusGroup) => void;
}

export function StudioMetricsCards({
  jobs,
  currentGroup,
  onSelectGroup,
}: StudioMetricsCardsProps) {
  const counts = React.useMemo(() => {
    let active = 0;
    let review = 0;
    let applied = 0;
    let problem = 0;

    for (const job of jobs) {
      if ((JOB_STATUS_GROUPS.ACTIVE as readonly string[]).includes(job.status)) {
        active++;
      } else if ((JOB_STATUS_GROUPS.REVIEW as readonly string[]).includes(job.status)) {
        review++;
      } else if ((JOB_STATUS_GROUPS.APPLIED as readonly string[]).includes(job.status)) {
        applied++;
      } else if ((JOB_STATUS_GROUPS.PROBLEM as readonly string[]).includes(job.status)) {
        problem++;
      }
    }

    return {
      ACTIVE: active,
      REVIEW: review,
      APPLIED: applied,
      PROBLEM: problem,
      ALL: jobs.length,
    };
  }, [jobs]);

  const cards: Array<{
    group: JobStatusGroup;
    label: string;
    count: number;
    color: string;
    bgColor: string;
    activeRing: string;
    icon: string;
  }> = [
    {
      group: 'ACTIVE',
      label: 'Đang chạy',
      count: counts.ACTIVE,
      color: 'text-sky-400',
      bgColor: 'bg-sky-500/10 border-sky-500/20',
      activeRing: 'ring-2 ring-sky-500',
      icon: '⚡',
    },
    {
      group: 'REVIEW',
      label: 'Chờ duyệt',
      count: counts.REVIEW,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10 border-amber-500/20',
      activeRing: 'ring-2 ring-amber-500',
      icon: '📝',
    },
    {
      group: 'APPLIED',
      label: 'Đã xuất bản',
      count: counts.APPLIED,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/20',
      activeRing: 'ring-2 ring-emerald-500',
      icon: '✅',
    },
    {
      group: 'PROBLEM',
      label: 'Sự cố / Hủy',
      count: counts.PROBLEM,
      color: 'text-rose-400',
      bgColor: 'bg-rose-500/10 border-rose-500/20',
      activeRing: 'ring-2 ring-rose-500',
      icon: '⚠️',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => {
        const isActive = currentGroup === card.group;
        return (
          <button
            key={card.group}
            type="button"
            data-testid={`metric-card-${card.group}`}
            onClick={() => onSelectGroup(card.group)}
            className={`flex flex-col items-start p-4 rounded-xl border text-left transition-all duration-200 cursor-pointer ${
              card.bgColor
            } ${
              isActive
                ? `${card.activeRing} shadow-lg shadow-black/40`
                : 'hover:border-slate-600/50 hover:bg-slate-800/40 opacity-80 hover:opacity-100'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-1">
              <span className="text-xs font-medium text-slate-400">
                {card.label}
              </span>
              <span className="text-base">{card.icon}</span>
            </div>
            <span className={`text-2xl font-bold tracking-tight ${card.color}`}>
              {card.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
