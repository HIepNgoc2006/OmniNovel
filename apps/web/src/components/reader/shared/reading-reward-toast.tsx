'use client';

import { Sparkles, Trophy, X } from 'lucide-react';

interface ReadingRewardToastProps {
  isVisible: boolean;
  onDismiss: () => void;
  earnedExp: number;
}

export function ReadingRewardToast({
  isVisible,
  onDismiss,
  earnedExp = 5,
}: ReadingRewardToastProps) {
  if (!isVisible) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-5 duration-300">
      <div className="bg-gradient-to-r from-amber-500/20 via-brand-500/20 to-purple-500/20 border border-amber-500/40 backdrop-blur-md rounded-2xl p-4 shadow-2xl flex items-center gap-3 text-slate-100">
        <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0 shadow-inner">
          <Trophy className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <h4 className="font-bold text-sm text-amber-300">Đã Hoàn Thành Chương!</h4>
          </div>
          <p className="text-xs text-slate-300 mt-0.5">
            Bạn vừa nhận được <strong className="text-amber-400 font-bold">+{earnedExp} EXP</strong> vào hồ sơ tu tiên.
          </p>
        </div>

        <button
          onClick={onDismiss}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
