'use client';

import React, { useState } from 'react';
import {
  Bookmark,
  Clock,
  BookOpen,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Smartphone,
  Loader2,
} from 'lucide-react';
import { ConflictResolution } from '@omninovel/shared';
import { useGuestClaimCoordinator } from '../../lib/claim/use-guest-claim-coordinator';

export function GuestClaimDialog() {
  const {
    isOpen,
    isCommitting,
    isPreparing,
    previewData,
    error,
    skipClaim,
    confirmClaim,
  } = useGuestClaimCoordinator();

  const [conflictDecisions, setConflictDecisions] = useState<Record<string, ConflictResolution>>({});

  if (!isOpen || !previewData) {
    return null;
  }

  const handleResolutionChange = (storyId: string, resolution: ConflictResolution) => {
    setConflictDecisions((prev) => ({
      ...prev,
      [storyId]: resolution,
    }));
  };

  const handleConfirm = async () => {
    try {
      await confirmClaim(undefined, conflictDecisions);
    } catch {
      // Error is caught and surfaced via coordinator state
    }
  };

  const conflicts = previewData.conflicts || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-claim-title"
    >
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/60 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
            <Cloud className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h2 id="guest-claim-title" className="text-xl font-bold text-white tracking-tight">
              Gộp Dữ Liệu Đọc Khách Vào Tài Khoản
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Phát hiện dữ liệu đọc trên trình duyệt trước khi đăng nhập. Bạn có muốn đồng bộ vào tài khoản này không?
            </p>
          </div>
        </div>

        {/* Modal Content */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto flex-1 custom-scrollbar">
          {error && (
            <div className="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-sm flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Stat Overview Cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3.5 bg-slate-800/60 border border-slate-700/60 rounded-2xl flex flex-col items-center justify-center text-center">
              <Bookmark className="w-5 h-5 text-indigo-400 mb-1" />
              <div className="text-2xl font-extrabold text-white">
                {previewData.bookmarksToImport}
              </div>
              <div className="text-xs text-slate-400 font-medium">Dấu trang</div>
            </div>

            <div className="p-3.5 bg-slate-800/60 border border-slate-700/60 rounded-2xl flex flex-col items-center justify-center text-center">
              <Clock className="w-5 h-5 text-emerald-400 mb-1" />
              <div className="text-2xl font-extrabold text-white">
                {previewData.historyToImport}
              </div>
              <div className="text-xs text-slate-400 font-medium">Lịch sử đọc</div>
            </div>

            <div className="p-3.5 bg-slate-800/60 border border-slate-700/60 rounded-2xl flex flex-col items-center justify-center text-center">
              <BookOpen className="w-5 h-5 text-amber-400 mb-1" />
              <div className="text-2xl font-extrabold text-white">
                {previewData.progressToImport}
              </div>
              <div className="text-xs text-slate-400 font-medium">Tiến độ truyện</div>
            </div>
          </div>

          {/* Conflicts Section */}
          {conflicts.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4" />
                <span>
                  Phát hiện {conflicts.length} truyện có xung đột tiến độ giữa máy này và đám mây:
                </span>
              </div>

              <div className="space-y-3">
                {conflicts.map((conflict) => {
                  const currentDecision =
                    conflictDecisions[conflict.storyId] || ConflictResolution.KEEP_CLOUD;

                  return (
                    <div
                      key={conflict.storyId}
                      className="p-4 bg-slate-800/40 border border-slate-700/60 rounded-2xl space-y-3"
                    >
                      <div className="text-xs font-semibold text-slate-300">
                        Mã truyện: <span className="text-slate-100 font-mono">{conflict.storyId}</span>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {/* Cloud option */}
                        <label
                          className={`flex flex-col p-3 rounded-xl border cursor-pointer transition-all ${
                            currentDecision === ConflictResolution.KEEP_CLOUD
                              ? 'bg-violet-950/40 border-violet-500/80 text-violet-200'
                              : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold flex items-center gap-1.5">
                              <Cloud className="w-3.5 h-3.5" />
                              Bản Đám Mây
                            </span>
                            <input
                              type="radio"
                              name={`conflict_${conflict.storyId}`}
                              value={ConflictResolution.KEEP_CLOUD}
                              checked={currentDecision === ConflictResolution.KEEP_CLOUD}
                              onChange={() =>
                                handleResolutionChange(
                                  conflict.storyId,
                                  ConflictResolution.KEEP_CLOUD,
                                )
                              }
                              className="accent-violet-500"
                            />
                          </div>
                          <div>Chương: {conflict.cloudProgress.chapterId}</div>
                          <div>Tiến độ: {conflict.cloudProgress.progressPercentage}%</div>
                        </label>

                        {/* Guest option */}
                        <label
                          className={`flex flex-col p-3 rounded-xl border cursor-pointer transition-all ${
                            currentDecision === ConflictResolution.USE_GUEST
                              ? 'bg-emerald-950/40 border-emerald-500/80 text-emerald-200'
                              : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold flex items-center gap-1.5">
                              <Smartphone className="w-3.5 h-3.5" />
                              Máy Hiện Tại
                            </span>
                            <input
                              type="radio"
                              name={`conflict_${conflict.storyId}`}
                              value={ConflictResolution.USE_GUEST}
                              checked={currentDecision === ConflictResolution.USE_GUEST}
                              onChange={() =>
                                handleResolutionChange(
                                  conflict.storyId,
                                  ConflictResolution.USE_GUEST,
                                )
                              }
                              className="accent-emerald-500"
                            />
                          </div>
                          <div>Chương: {conflict.guestProgress.chapterId}</div>
                          <div>Tiến độ: {conflict.guestProgress.progressPercentage}%</div>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-xs text-slate-400 leading-relaxed">
            * Nếu chọn <strong className="text-slate-300">Bỏ qua</strong>, dữ liệu khách trên máy này sẽ được lưu trữ riêng biệt an toàn mà không làm mất dữ liệu của tài khoản.
          </p>
        </div>

        {/* Modal Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/80 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={isCommitting || isPreparing}
            onClick={() => skipClaim()}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700/80 transition-all disabled:opacity-50"
          >
            Bỏ qua & Không gộp
          </button>

          <button
            type="button"
            disabled={isCommitting || isPreparing}
            onClick={handleConfirm}
            className="px-6 py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 shadow-lg shadow-violet-600/25 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isCommitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Đang gộp dữ liệu...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>Gộp Vào Tài Khoản</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
