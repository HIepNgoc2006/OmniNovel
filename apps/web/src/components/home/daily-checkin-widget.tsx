'use client';

import React, { useState } from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { useProgression, useCheckinMutation } from '../../lib/query/hooks';
import { Coins, Flame, Gift, CheckCircle2, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';

export function DailyCheckinWidget() {
  const { user } = useAuth();
  const { data: progression } = useProgression();
  const checkinMutation = useCheckinMutation();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isCheckedIn = Boolean(
    progression?.lastCheckinDate &&
    new Date(progression.lastCheckinDate).toDateString() === new Date().toDateString()
  );

  const handleCheckin = async () => {
    if (!user) return;
    if (isCheckedIn || checkinMutation.isPending) return;

    try {
      const res = await checkinMutation.mutateAsync();
      setSuccessMessage(`+${res.omnicoinGained} OmniCoins, +${res.expGained} EXP!`);
    } catch {
      setSuccessMessage('Bạn đã điểm danh hôm nay rồi!');
    }
  };

  return (
    <div className="relative overflow-hidden bg-gradient-to-br from-red-950/40 via-slate-900/60 to-amber-950/30 border border-red-900/30 rounded-3xl p-5 shadow-xl">
      {/* Background Decorative Rings */}
      <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-amber-500/10 rounded-full blur-2xl pointer-events-none" />

      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-red-500/20 text-red-400 flex items-center justify-center">
            <Gift className="w-4 h-4" />
          </div>
          <div>
            <h4 className="font-extrabold text-sm text-white">Điểm Danh Hàng Ngày</h4>
            <p className="text-[11px] text-slate-400">Nhận OmniCoins & EXP mỗi ngày</p>
          </div>
        </div>

        {/* Streak Counter */}
        {user && progression && (
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-950/60 border border-slate-800 text-xs font-bold text-amber-400">
            <Flame className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            <span>{progression.streak} ngày</span>
          </div>
        )}
      </div>

      {/* Reward description & Action */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between p-3 rounded-2xl bg-slate-950/50 border border-slate-800/80 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <Coins className="w-3.5 h-3.5" />
            </div>
            <div>
              <p className="font-bold text-white">Phần thưởng hôm nay</p>
              <p className="text-[10px] text-slate-400">+10 OmniCoins & +50 EXP</p>
            </div>
          </div>

          <div className="text-right">
            <span className="text-[10px] font-semibold text-emerald-400 block">Miễn phí</span>
            <span className="text-[10px] text-slate-400">Reset lúc 00:00</span>
          </div>
        </div>

        {/* Success Alert */}
        {successMessage && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-semibold">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Checkin Action Button */}
        <Button
          variant={isCheckedIn ? 'secondary' : 'primary'}
          className="w-full justify-center gap-2 shadow-lg"
          onClick={handleCheckin}
          disabled={checkinMutation.isPending || isCheckedIn}
        >
          {isCheckedIn ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Đã Điểm Danh Hôm Nay
            </>
          ) : checkinMutation.isPending ? (
            'Đang nhận thưởng...'
          ) : !user ? (
            <>
              <Sparkles className="w-4 h-4 text-amber-300" />
              Đăng Nhập Để Nhận Thưởng
            </>
          ) : (
            <>
              <Gift className="w-4 h-4" />
              Điểm Danh Nhận Coin
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
