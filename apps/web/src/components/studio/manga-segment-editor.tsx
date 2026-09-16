'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { TranslationSegmentDto } from '@omninovel/shared';
import type { ConflictState, ParsedApiError } from '../../lib/studio/use-manga-review-studio';
import {
  isDraftDirty,
  canSaveSegment,
  formatOcrConfidence,
} from '../../lib/studio/manga-segment-editor-policy';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Save,
  Undo2,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  Sparkles,
  Layers,
  ShieldAlert,
} from 'lucide-react';

export interface MangaSegmentEditorProps {
  segment: TranslationSegmentDto | null;
  draftText?: string;
  canEdit?: boolean;
  isGateClosed?: boolean;
  isSaving?: boolean;
  hasPendingMutation?: boolean;
  conflictState?: ConflictState | null;
  saveError?: ParsedApiError | null;
  onDraftChange: (segmentId: string, text: string) => void;
  onDiscardDraft: (segmentId: string) => void;
  onSave: (segmentId: string, text: string) => Promise<unknown> | unknown;
  onClearConflict?: (segmentId: string) => void;
  onLoadServerVersion?: (segmentId: string) => Promise<boolean | void> | void;
}

export const MangaSegmentEditor: React.FC<MangaSegmentEditorProps> = ({
  segment,
  draftText,
  canEdit = true,
  isGateClosed = false,
  isSaving = false,
  hasPendingMutation = false,
  conflictState = null,
  saveError = null,
  onDraftChange,
  onDiscardDraft,
  onSave,
  onClearConflict,
  onLoadServerVersion,
}) => {
  const [copied, setCopied] = useState(false);
  const [isLoadingServerVersion, setIsLoadingServerVersion] = useState(false);

  // If draftText is explicitly provided, use it; otherwise fallback to canonical segment.translatedText
  const currentText = draftText !== undefined ? draftText : (segment?.translatedText ?? '');
  const dirty = isDraftDirty(segment?.translatedText, currentText);
  const isRetryBlocked = Boolean(conflictState?.retryBlocked);

  const canSave = Boolean(
    segment &&
      canSaveSegment({
        isDirty: dirty,
        canEdit,
        isGateClosed,
        isSaving,
        hasPendingMutation,
        isRetryBlocked,
      }),
  );

  const handleCopyRaw = useCallback(async () => {
    if (!segment?.rawText) return;
    try {
      await navigator.clipboard.writeText(segment.rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed fallback
    }
  }, [segment?.rawText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (segment && canSave && !isSaving && !isLoadingServerVersion) {
          void onSave(segment.id, currentText);
        }
      }
    },
    [segment, canSave, isSaving, isLoadingServerVersion, onSave, currentText],
  );

  const handleLoadServerVersion = useCallback(async () => {
    if (!segment || !onLoadServerVersion) return;
    setIsLoadingServerVersion(true);
    try {
      await onLoadServerVersion(segment.id);
    } finally {
      setIsLoadingServerVersion(false);
    }
  }, [segment, onLoadServerVersion]);

  if (!segment) {
    return (
      <div
        data-testid="segment-editor-empty"
        className="p-6 bg-slate-950/80 border border-slate-800 rounded-3xl flex flex-col items-center justify-center text-center space-y-3 min-h-[280px]"
      >
        <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 shadow-inner">
          <Layers className="w-6 h-6 text-slate-400" />
        </div>
        <div className="space-y-1 max-w-xs">
          <h4 className="text-sm font-bold text-white">Chưa Chọn Ô Thoại</h4>
          <p className="text-xs text-slate-400 leading-relaxed">
            Nhấp vào ô thoại OCR trên ảnh hoặc chọn từ danh sách bên dưới để bắt đầu duyệt và chỉnh sửa bản dịch.
          </p>
        </div>
      </div>
    );
  }

  const confidenceFormatted = formatOcrConfidence(segment.confidence);

  return (
    <div
      data-testid="segment-editor-container"
      data-segment-id={segment.id}
      className="p-5 bg-slate-950/90 border border-slate-800 rounded-3xl flex flex-col space-y-4 shadow-xl relative"
    >
      {/* Editor Header: Metadata & Status Badges */}
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <Badge variant="primary" className="text-xs font-semibold">
            Ô #{segment.sortOrder}
          </Badge>
          <span className="text-xs text-slate-400">
            Trang {segment.pageNumber ?? '—'}
          </span>
          <span className="text-[11px] font-mono text-slate-500">
            v{segment.version ?? 1}
          </span>
          {confidenceFormatted && (
            <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-700">
              OCR: {confidenceFormatted}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirty ? (
            <Badge
              variant="warning"
              data-testid="badge-dirty"
              className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/40"
            >
              Bản nháp chưa lưu
            </Badge>
          ) : (
            <Badge
              variant="outline"
              data-testid="badge-synced"
              className="text-[10px] text-emerald-400 border-emerald-500/40 bg-emerald-950/20"
            >
              Đồng bộ
            </Badge>
          )}
        </div>
      </div>

      {/* Read-Only Source Card (Original text) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-slate-400 font-medium">
          <span>Nguyên tác (OCR gán):</span>
          <button
            type="button"
            data-testid="btn-copy-raw"
            onClick={handleCopyRaw}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400">Đã sao chép</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Sao chép</span>
              </>
            )}
          </button>
        </div>
        <div
          data-testid="segment-raw-text"
          className="p-3 bg-slate-900/90 border border-slate-800 rounded-2xl text-xs font-mono text-slate-300 leading-relaxed max-h-24 overflow-y-auto select-all"
        >
          {segment.rawText || (
            <span className="text-slate-600 italic">Không có văn bản gốc</span>
          )}
        </div>
      </div>

      {/* Textarea Editor for Vietnamese Translation */}
      <div className="space-y-1.5 flex-1 flex flex-col">
        <label
          htmlFor={`editor-textarea-${segment.id}`}
          className="text-[11px] text-slate-400 font-medium flex items-center justify-between"
        >
          <span>Bản dịch Tiếng Việt:</span>
          {!canEdit && (
            <span className="text-rose-400 text-[10px]">Chế độ chỉ đọc</span>
          )}
        </label>
        <textarea
          id={`editor-textarea-${segment.id}`}
          data-testid="segment-translation-textarea"
          value={currentText}
          disabled={!canEdit || isSaving || isLoadingServerVersion}
          onChange={(e) => onDraftChange(segment.id, e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nhập bản dịch tiếng Việt cho ô thoại này..."
          rows={3}
          className="w-full p-3 bg-slate-900 border border-slate-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-2xl text-xs text-white placeholder-slate-600 resize-none transition-all outline-none leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* OCC Conflict Banner (409 VERSION_CONFLICT) */}
      {conflictState && conflictState.kind === 'VERSION_CONFLICT' && (
        <div
          data-testid="editor-occ-conflict-banner"
          className="p-3.5 bg-amber-950/40 border border-amber-500/50 rounded-2xl space-y-2 text-xs text-amber-200"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-amber-300">
                Xung Đột Phiên Bản (409 VERSION_CONFLICT)
              </p>
              <p className="text-[11px] text-amber-200/90 leading-relaxed">
                {conflictState.currentVersion !== undefined &&
                conflictState.expectedVersion !== undefined
                  ? `Máy chủ đã được cập nhật lên v${conflictState.currentVersion} (bạn đang chỉnh sửa dựa trên v${conflictState.expectedVersion}). Bản nháp của bạn được giữ nguyên.`
                  : 'Phân đoạn này đã được chỉnh sửa bởi phiên bản khác trên máy chủ. Bản nháp của bạn đã được bảo vệ.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            {onLoadServerVersion && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="btn-load-server-version"
                disabled={isLoadingServerVersion}
                onClick={handleLoadServerVersion}
                className="h-7 text-xs bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/30"
              >
                {isLoadingServerVersion ? (
                  <>
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Đang nạp...
                  </>
                ) : (
                  'Nạp bản mới từ máy chủ'
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              data-testid="btn-keep-draft"
              disabled={isLoadingServerVersion}
              onClick={() => onClearConflict?.(segment.id)}
              className="h-7 text-xs text-amber-300 hover:text-white"
            >
              Giữ bản nháp
            </Button>
          </div>
        </div>
      )}

      {/* Orphan / Segment Removed Banner */}
      {conflictState && conflictState.kind === 'SEGMENT_REMOVED' && (
        <div
          data-testid="editor-segment-removed-banner"
          className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-2xl flex items-center gap-2.5 text-xs text-rose-300"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <div className="space-y-0.5">
            <p className="font-semibold text-rose-200">Phân đoạn đã bị xóa</p>
            <p className="text-[11px] text-rose-300/80">
              Phân đoạn này không còn tồn tại trên máy chủ. Bản nháp được lưu giữ nhưng không thể ghi đè.
            </p>
          </div>
        </div>
      )}

      {/* Save Error Banner (500 / Network / Other) */}
      {saveError && (
        <div
          data-testid="editor-save-error-banner"
          className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-2xl flex items-center justify-between gap-2 text-xs text-rose-300"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="line-clamp-1">{saveError.message || 'Lỗi lưu bản dịch.'}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="btn-retry-save"
            onClick={() => {
              if (canSave && !isSaving) {
                void onSave(segment.id, currentText);
              }
            }}
            className="h-6 px-2 text-xs text-rose-200 hover:text-white hover:bg-rose-500/20"
          >
            Thử lại
          </Button>
        </div>
      )}

      {/* Editor Footer: Actions & Shortcut Hints */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
        <span className="text-[11px] text-slate-500 hidden sm:inline">
          Phím tắt: <kbd className="font-mono bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">Ctrl+Enter</kbd> để lưu
        </span>

        <div className="flex items-center gap-2 ml-auto">
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="btn-discard-draft"
              disabled={isSaving || isLoadingServerVersion}
              onClick={() => onDiscardDraft(segment.id)}
              className="h-8 text-xs text-slate-400 hover:text-white hover:bg-slate-900"
            >
              <Undo2 className="w-3.5 h-3.5 mr-1" />
              Hủy thay đổi
            </Button>
          )}

          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="btn-save-segment"
            disabled={!canSave || isSaving || isLoadingServerVersion}
            onClick={() => onSave(segment.id, currentText)}
            className="h-8 text-xs font-semibold px-4"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Đang lưu...
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Lưu bản dịch
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};
