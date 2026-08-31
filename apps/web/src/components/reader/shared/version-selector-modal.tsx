'use client';

import { X, Check, Globe, Sparkles, UserCheck, Users } from 'lucide-react';
import { ChapterVersionSummary, ChapterVersionType } from '@omninovel/shared';

interface VersionSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  versions: ChapterVersionSummary[];
  currentVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
}

const TYPE_CONFIG: Record<
  ChapterVersionType,
  { label: string; icon: any; colorClass: string }
> = {
  [ChapterVersionType.RAW_ORIGINAL]: {
    label: 'Bản Gốc (Raw)',
    icon: Globe,
    colorClass: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  },
  [ChapterVersionType.AI_TRANSLATED]: {
    label: 'AI Studio Dịch',
    icon: Sparkles,
    colorClass: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  },
  [ChapterVersionType.HUMAN_EDITED]: {
    label: 'Biên Tập Viên Trau Chuốt',
    icon: UserCheck,
    colorClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  },
  [ChapterVersionType.COMMUNITY_FAN]: {
    label: 'Cộng Đồng Dịch',
    icon: Users,
    colorClass: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  },
};

export function VersionSelectorModal({
  isOpen,
  onClose,
  versions,
  currentVersionId,
  onSelectVersion,
}: VersionSelectorModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Card */}
      <div className="relative z-10 w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl text-slate-100 p-5 shadow-2xl animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div>
            <h3 className="text-base font-bold text-slate-100">Chọn Phiên Bản Bản Dịch</h3>
            <p className="text-xs text-slate-400">
              Có {versions.length} bản dịch khả dụng cho chương này
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-2 max-h-80 overflow-y-auto pr-1">
          {versions.map((ver) => {
            const isSelected = ver.id === currentVersionId;
            const config = TYPE_CONFIG[ver.versionType] || {
              label: ver.versionType,
              icon: Globe,
              colorClass: 'text-slate-400 bg-slate-800 border-slate-700',
            };
            const Icon = config.icon;

            return (
              <button
                key={ver.id}
                onClick={() => {
                  onSelectVersion(ver.id);
                  onClose();
                }}
                className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                  isSelected
                    ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                    : 'border-slate-800 bg-slate-800/40 hover:bg-slate-800 hover:border-slate-700 text-slate-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg border ${config.colorClass}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-slate-100">
                        {config.label}
                      </span>
                      <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-sm bg-slate-800 border border-slate-700 text-slate-400">
                        v{ver.versionNumber} ({ver.language})
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {new Date(ver.createdAt).toLocaleDateString('vi-VN')}
                    </p>
                  </div>
                </div>

                {isSelected && (
                  <div className="w-6 h-6 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center">
                    <Check className="w-4 h-4" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
