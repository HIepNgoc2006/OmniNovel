'use client';

import React from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { useProgression, useCheckinMutation } from '@/lib/query/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  User,
  Mail,
  Shield,
  Coins,
  Award,
  CalendarCheck,
  Flame,
  CheckCircle2,
} from 'lucide-react';

export default function ProfilePage() {
  const { user } = useAuth();
  const { data: progression, isLoading: isProgressionLoading } = useProgression();
  const checkinMutation = useCheckinMutation();

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-8">
      {/* Header & User Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 relative z-10">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-red-600 to-amber-500 flex items-center justify-center text-white text-2xl font-black shadow-lg">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.username} className="w-full h-full rounded-2xl object-cover" />
            ) : (
              user?.username?.charAt(0).toUpperCase()
            )}
          </div>

          <div className="space-y-1 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black text-white">{user?.username}</h1>
              <Badge variant="rank">Lv.{progression?.level || 1} {progression?.rankTitle || 'Tân Thủ'}</Badge>
              <Badge variant="primary">{user?.role}</Badge>
            </div>
            <p className="text-xs text-slate-400 flex items-center gap-1">
              <Mail className="w-3.5 h-3.5" />
              <span>{user?.email}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Gamification Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Level & EXP */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Award className="w-4 h-4 text-amber-400" />
              <span>Cấp Độ & EXP</span>
            </span>
            <span className="font-bold text-white">Lv.{progression?.level || 1}</span>
          </div>

          <p className="text-2xl font-black text-white">
            {progression?.totalExp || 0} <span className="text-xs text-slate-400 font-normal">Tổng EXP</span>
          </p>

          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>Tiến độ cấp</span>
              <span>{progression?.currentLevelExp || 0} / {progression?.nextLevelExp || 100} EXP</span>
            </div>
            <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-gradient-to-r from-red-500 to-amber-400"
                style={{
                  width: `${Math.min(100, Math.round(((progression?.currentLevelExp || 0) / (progression?.nextLevelExp || 100)) * 100))}%`,
                }}
              />
            </div>
          </div>
        </div>

        {/* OmniCoins */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Coins className="w-4 h-4 text-amber-400" />
              <span>Số Dư OmniCoin</span>
            </span>
          </div>

          <p className="text-2xl font-black text-amber-400">
            {progression?.omnicoinBalance || 0} <span className="text-xs text-slate-400 font-normal">Coins</span>
          </p>

          <p className="text-[11px] text-slate-400">
            Sử dụng OmniCoin để mở khóa các chương truyện dịch AI sớm hoặc tip cho tác giả/dịch giả.
          </p>
        </div>

        {/* Daily Streak */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Flame className="w-4 h-4 text-rose-400" />
              <span>Chuỗi Điểm Danh</span>
            </span>
          </div>

          <p className="text-2xl font-black text-rose-400">
            {progression?.streak || 0} <span className="text-xs text-slate-400 font-normal">ngày liên tiếp</span>
          </p>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => checkinMutation.mutate()}
            isLoading={checkinMutation.isPending}
            className="w-full text-xs gap-1.5"
          >
            <CalendarCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Điểm Danh Ngay (+50 EXP)</span>
          </Button>

          {checkinMutation.isSuccess && (
            <p className="text-[11px] text-emerald-400 flex items-center gap-1 mt-1">
              <CheckCircle2 className="w-3 h-3" />
              <span>{checkinMutation.data.message}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
