'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ApplyTranslationMode,
  ApplyTranslationJobResponse,
  ReviewSummaryDto,
} from '@omninovel/shared';
import { Modal } from '../ui/modal';
import {
  ApplyLifecycleState,
  ParsedApiError,
  resolvePostApplyReaderUrl,
} from '../../lib/studio/studio-apply-policy';
import {
  CheckCircle2,
  AlertTriangle,
  Send,
  RefreshCw,
  BookOpen,
  ExternalLink,
  Layers,
  Sparkles,
  Loader2,
  AlertCircle,
} from 'lucide-react';

export interface ApplyTranslationModalProps {
  isOpen: boolean;
  onClose: () => void;
  storySlug: string;
  reviewSummary: ReviewSummaryDto | null;
  applyLifecycle: ApplyLifecycleState;
  applyResponse: ApplyTranslationJobResponse | null;
  applyError: ParsedApiError | null;
  onApply: (mode: ApplyTranslationMode) => Promise<unknown>;
  onRetry: () => Promise<unknown>;
  onReconcile: () => Promise<unknown>;
  onReset: () => void;
}

export function ApplyTranslationModal({
  isOpen,
  onClose,
  storySlug,
  reviewSummary,
  applyLifecycle,
  applyResponse,
  applyError,
  onApply,
  onRetry,
  onReconcile,
  onReset,
}: ApplyTranslationModalProps) {
  const [selectedMode, setSelectedMode] = useState<ApplyTranslationMode | null>(null);

  const segmentCount = reviewSummary?.segmentCount ?? 0;
  const verifiedCount = reviewSummary?.verifiedCount ?? 0;
  const unverifiedCount = Math.max(0, segmentCount - verifiedCount);
  const isAllVerified = segmentCount > 0 && unverifiedCount === 0;

  const isSubmitting =
    applyLifecycle === 'SUBMITTING' || applyLifecycle === 'RECONCILING';

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (selectedMode && !isSubmitting) {
      await onApply(selectedMode);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={
        applyLifecycle === 'SUCCEEDED'
          ? 'Xuất Bản Hoàn Tất'
          : 'Xuất Bản / Áp Dụng Bản Dịch'
      }
      maxWidth="lg"
    >
      <div className="space-y-6 text-slate-200">
        {/* State: SUCCEEDED */}
        {applyLifecycle === 'SUCCEEDED' && applyResponse && (
          <div className="space-y-6 text-center py-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-8 h-8" />
            </div>

            <div className="space-y-2">
              <h4 className="text-xl font-bold text-white tracking-wide">
                Xuất bản thành công!
              </h4>
              <p className="text-slate-300 text-sm">
                Phiên bản v{applyResponse.versionNumber} đã sẵn sàng phục vụ độc giả.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700/60 text-left space-y-2 text-sm">
              <div className="flex justify-between items-center text-slate-400">
                <span>Mã phiên bản tạo:</span>
                <span className="font-mono text-white text-xs">
                  {applyResponse.targetVersionId}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Số thứ tự phiên bản:</span>
                <span className="font-semibold text-emerald-400">
                  v{applyResponse.versionNumber}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Trạng thái kích hoạt:</span>
                <span className="text-slate-200">
                  {applyResponse.activeVersionId === applyResponse.targetVersionId
                    ? 'Bản đọc chính thức'
                    : 'Bản dịch phụ'}
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Link
                href={resolvePostApplyReaderUrl(storySlug, applyResponse)}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors shadow-lg shadow-emerald-600/20"
              >
                <BookOpen className="w-4 h-4" />
                Đọc chương này ngay
              </Link>
              <Link
                href="/studio"
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm border border-slate-700 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Về Studio Dashboard
              </Link>
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2.5 rounded-xl bg-transparent hover:bg-slate-800/80 text-slate-400 hover:text-white font-medium text-sm transition-colors cursor-pointer"
              >
                Ở lại Studio
              </button>
            </div>
          </div>
        )}

        {/* State: COMMITTED_RECONCILIATION_REQUIRED */}
        {applyLifecycle === 'COMMITTED_RECONCILIATION_REQUIRED' && (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex gap-3 text-amber-300">
              <AlertTriangle className="w-6 h-6 flex-shrink-0 mt-0.5" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-amber-200">
                  Yêu cầu xuất bản đã được ghi nhận trên máy chủ
                </p>
                <p className="text-amber-300/90">
                  Hệ thống đã lưu bản dịch, nhưng trình duyệt chưa nhận được bản ghi đối chiếu mới nhất hoặc số revision chưa khớp. Vui lòng cập nhật lại để đồng bộ.
                </p>
                {applyError && (
                  <p className="font-mono text-xs text-amber-400 mt-2">
                    Lỗi: {applyError.message}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
              >
                Đóng
              </button>
              <button
                type="button"
                onClick={() => onReconcile()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors shadow-lg shadow-amber-600/20"
              >
                <RefreshCw className="w-4 h-4" />
                Đối Chiếu & Cập Nhật Lại
              </button>
            </div>
          </div>
        )}

        {/* State: SUBMISSION_OUTCOME_UNKNOWN */}
        {applyLifecycle === 'SUBMISSION_OUTCOME_UNKNOWN' && (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 flex gap-3 text-purple-300">
              <RefreshCw className="w-6 h-6 flex-shrink-0 mt-0.5 text-purple-400" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-purple-200">
                  Không thể xác nhận trạng thái máy chủ
                </p>
                <p className="text-purple-300/90">
                  Kết nối bị gián đoạn hoặc máy chủ phản hồi lỗi bất định. Khóa Idempotency đã được giữ cố định để bảo đảm an toàn khi gửi lại.
                </p>
                {applyError && (
                  <p className="font-mono text-xs text-purple-400 mt-2">
                    Chi tiết: {applyError.message} ({applyError.code || 'UNKNOWN'})
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
              >
                Hủy Bỏ
              </button>
              <button
                type="button"
                onClick={() => onRetry()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors shadow-lg shadow-purple-600/20"
              >
                <RefreshCw className="w-4 h-4" />
                Thử Lại Với Khóa Gốc
              </button>
            </div>
          </div>
        )}

        {/* State: FAILED */}
        {applyLifecycle === 'FAILED' && (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex gap-3 text-rose-300">
              <AlertCircle className="w-6 h-6 flex-shrink-0 mt-0.5 text-rose-400" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-rose-200">Xuất bản thất bại</p>
                <p className="text-rose-300/90">
                  {applyError?.message || 'Đã có lỗi xảy ra trong quá trình xuất bản bản dịch.'}
                </p>
                {applyError?.code && (
                  <p className="font-mono text-xs text-rose-400 mt-2">
                    Mã lỗi: {applyError.code}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
              >
                Đóng
              </button>
              <button
                type="button"
                onClick={() => onReset()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium transition-colors shadow-lg shadow-rose-600/20"
              >
                <RefreshCw className="w-4 h-4" />
                Thử Chọn Lại
              </button>
            </div>
          </div>
        )}

        {/* State: IDLE / SUBMITTING / RECONCILING */}
        {(applyLifecycle === 'IDLE' || isSubmitting) && (
          <>
            {/* Verification Summary Banner */}
            {isAllVerified ? (
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3 text-emerald-300 text-sm">
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-400" />
                <span>
                  100% phân đoạn đã được duyệt thủ công ({verifiedCount}/{segmentCount}). Sẵn sàng xuất bản chính thức!
                </span>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3 text-amber-300 text-sm">
                <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium text-amber-200">
                    Còn {unverifiedCount} phân đoạn chưa được đánh dấu đã duyệt thủ công ({verifiedCount}/{segmentCount}).
                  </p>
                  <p className="text-amber-300/80 text-xs">
                    Bạn vẫn muốn xuất bản? Các phân đoạn AI chưa duyệt sẽ được giữ nguyên nội dung hiện tại.
                  </p>
                </div>
              </div>
            )}

            {/* Selection Title */}
            <div className="space-y-1 pt-1">
              <h4 className="text-sm font-semibold text-slate-200">
                Chọn phương thức xuất bản:
              </h4>
              <p className="text-xs text-slate-400">
                Vui lòng chọn cách bản dịch được gắn kết với chương này.
              </p>
            </div>

            {/* Mode Cards */}
            <div className="space-y-3">
              {/* Option 1: OVERWRITE_ACTIVE_VERSION */}
              <div
                data-testid="mode-card-OVERWRITE_ACTIVE_VERSION"
                onClick={() => !isSubmitting && setSelectedMode(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION)}
                className={`p-4 rounded-xl border transition-all cursor-pointer ${
                  selectedMode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION
                    ? 'bg-amber-500/10 border-amber-500/60 shadow-lg shadow-amber-500/10 ring-1 ring-amber-500/40'
                    : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800 hover:border-slate-600'
                } ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white text-sm">
                        Tạo phiên bản mới và đặt làm bản đọc chính
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        Bản chính (Primary)
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Tạo một ChapterVersion mới từ các segment đã duyệt và tự động kích hoạt làm phiên bản mặc định cho độc giả.
                    </p>
                    <div className="flex items-center gap-1.5 text-[11px] text-amber-300/80 pt-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>Độc giả truy cập chương này sẽ đọc ngay bản dịch mới.</span>
                    </div>
                  </div>
                  <div
                    className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                      selectedMode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION
                        ? 'border-amber-500 bg-amber-500 text-slate-900'
                        : 'border-slate-600'
                    }`}
                  >
                    {selectedMode === ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION && (
                      <div className="w-2 h-2 rounded-full bg-slate-900" />
                    )}
                  </div>
                </div>
              </div>

              {/* Option 2: CREATE_ALTERNATE_VERSION */}
              <div
                data-testid="mode-card-CREATE_ALTERNATE_VERSION"
                onClick={() => !isSubmitting && setSelectedMode(ApplyTranslationMode.CREATE_ALTERNATE_VERSION)}
                className={`p-4 rounded-xl border transition-all cursor-pointer ${
                  selectedMode === ApplyTranslationMode.CREATE_ALTERNATE_VERSION
                    ? 'bg-cyan-500/10 border-cyan-500/60 shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/40'
                    : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800 hover:border-slate-600'
                } ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white text-sm">
                        Tạo bản dịch phụ (Alternate Version)
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                        Bản phụ (Alternate)
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Tạo bản dịch song song mà không ghi đè bản đọc chính hiện tại. Độc giả có thể chuyển đổi trong danh sách phiên bản chương.
                    </p>
                    <div className="flex items-center gap-1.5 text-[11px] text-cyan-300/80 pt-1">
                      <Layers className="w-3.5 h-3.5" />
                      <span>An toàn, không làm gián đoạn bản dịch hiện đang phục vụ độc giả.</span>
                    </div>
                  </div>
                  <div
                    className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                      selectedMode === ApplyTranslationMode.CREATE_ALTERNATE_VERSION
                        ? 'border-cyan-500 bg-cyan-500 text-slate-900'
                        : 'border-slate-600'
                    }`}
                  >
                    {selectedMode === ApplyTranslationMode.CREATE_ALTERNATE_VERSION && (
                      <div className="w-2 h-2 rounded-full bg-slate-900" />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* In-Flight Status Indicator */}
            {isSubmitting && (
              <div className="p-3.5 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center gap-3 text-violet-300 text-sm">
                <Loader2 className="w-5 h-5 animate-spin text-violet-400 flex-shrink-0" />
                <span>
                  {applyLifecycle === 'SUBMITTING'
                    ? 'Đang ghi nhận xuất bản lên hệ thống...'
                    : 'Đang đối chiếu dữ liệu phiên bản mới...'}
                </span>
              </div>
            )}

            {/* Footer Actions */}
            <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!selectedMode || isSubmitting}
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all cursor-pointer ${
                  !selectedMode || isSubmitting
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/25 hover:shadow-emerald-500/40'
                }`}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Đang Xử Lý...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Xác Nhận Xuất Bản
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
