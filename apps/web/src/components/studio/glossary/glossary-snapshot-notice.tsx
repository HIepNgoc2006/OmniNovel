'use client';

import React from 'react';
import { Lock, Info } from 'lucide-react';

export function GlossarySnapshotNotice() {
  return (
    <div
      className="p-3 bg-indigo-950/40 border border-indigo-800/60 rounded-xl text-xs text-indigo-200 flex items-start gap-2.5"
      data-testid="glossary-snapshot-notice"
    >
      <Lock className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="font-semibold text-indigo-100 flex items-center gap-1.5">
          <span>Bản Snapshot Bất Biến Của Job Dịch</span>
        </p>
        <p className="text-slate-300 leading-relaxed">
          Danh sách dưới đây là bản snapshot thuật ngữ bất biến được chụp tại thời điểm Job này bắt
          đầu dịch. Các thuật ngữ mới thêm vào Từ điển Dự án (Live) sẽ được áp dụng cho các lần dịch
          tiếp theo mà không làm thay đổi bản snapshot này.
        </p>
      </div>
    </div>
  );
}
