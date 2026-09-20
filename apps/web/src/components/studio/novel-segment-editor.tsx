'use client';

import React, { useMemo, useCallback } from 'react';
import { TranslationSegmentDto } from '@omninovel/shared';
import { ProtectedAnchorText } from './protected-anchor-text';
import {
  validateSegmentTopology,
  computeSegmentEditorState,
  NovelSegmentState,
} from '@/lib/studio/novel-segment-policy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Save,
  ShieldAlert,
} from 'lucide-react';

export interface NovelSegmentEditorProps {
  segment: TranslationSegmentDto;
  draftText?: string;
  onDraftChange: (segmentId: string, text: string) => void;
  onSave: (segmentId: string) => any;
  onToggleVerify?: (segmentId: string) => any;
  isSaving?: boolean;
  conflictMessage?: string | null;
  errorMessage?: string | null;
  isReadonly?: boolean;
}

export function NovelSegmentEditor({
  segment,
  draftText,
  onDraftChange,
  onSave,
  onToggleVerify,
  isSaving = false,
  conflictMessage = null,
  errorMessage = null,
  isReadonly = false,
}: NovelSegmentEditorProps) {
  const currentText = draftText ?? segment.translatedText ?? '';

  const validation = useMemo(() => {
    return validateSegmentTopology(segment.rawText, currentText, {
      segmentId: segment.id,
      anchorBlockId: segment.anchorBlockId ?? undefined,
    });
  }, [segment.rawText, currentText, segment.id, segment.anchorBlockId]);

  const state: NovelSegmentState = useMemo(() => {
    return computeSegmentEditorState({
      canonicalText: segment.translatedText ?? '',
      draftText,
      isSaving,
      hasConflict: !!conflictMessage,
      errorMessage,
      validation,
    });
  }, [segment.translatedText, draftText, isSaving, conflictMessage, errorMessage, validation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        onToggleVerify?.(segment.id);
        return;
      }

      if (e.ctrlKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        if (state === 'DIRTY' && validation.valid && !isSaving && !isReadonly) {
          onSave(segment.id);
        }
      }
    },
    [onToggleVerify, onSave, segment.id, state, validation.valid, isSaving, isReadonly],
  );

  const renderStateBadge = () => {
    switch (state) {
      case 'CLEAN':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="secondary"
            className="text-[10px]"
          >
            CLEAN
          </Badge>
        );
      case 'DIRTY':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="warning"
            className="text-[10px]"
          >
            DIRTY
          </Badge>
        );
      case 'INVALID':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="primary"
            className="text-[10px]"
          >
            INVALID
          </Badge>
        );
      case 'SAVING':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="info"
            className="text-[10px] animate-pulse"
          >
            SAVING
          </Badge>
        );
      case 'SAVED':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="success"
            className="text-[10px]"
          >
            SAVED
          </Badge>
        );
      case 'CONFLICT':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="warning"
            className="text-[10px]"
          >
            CONFLICT
          </Badge>
        );
      case 'ERROR':
        return (
          <Badge
            data-testid="novel-segment-state-badge"
            variant="primary"
            className="text-[10px]"
          >
            ERROR
          </Badge>
        );
    }
  };

  const isSaveDisabled =
    state !== 'DIRTY' || !validation.valid || isSaving || isReadonly;

  return (
    <div
      data-testid={`novel-segment-container-${segment.id}`}
      className={`rounded-2xl border transition-colors ${
        state === 'INVALID'
          ? 'border-rose-500/50 bg-rose-950/10'
          : state === 'CONFLICT'
          ? 'border-amber-500/50 bg-amber-950/10'
          : state === 'DIRTY'
          ? 'border-indigo-500/40 bg-slate-900/60'
          : 'border-slate-800/80 bg-slate-900/30'
      } p-4 space-y-4`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <span className="font-mono text-slate-500">#{segment.sortOrder}</span>
          {segment.anchorBlockId && (
            <span className="px-2 py-0.5 rounded bg-slate-800 text-[11px] text-slate-300 font-mono">
              Block: {segment.anchorBlockId}
            </span>
          )}
          <span
            data-testid={`novel-segment-version-${segment.id}`}
            className="text-[11px] text-slate-500 font-mono"
          >
            v{segment.version}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {renderStateBadge()}
          {segment.isHumanVerified ? (
            <Badge
              data-testid={`novel-segment-verified-badge-${segment.id}`}
              variant="success"
              className="text-[10px] gap-1"
            >
              <CheckCircle2 className="w-3 h-3" />
              Đã duyệt
            </Badge>
          ) : (
            <Badge
              data-testid={`novel-segment-unverified-badge-${segment.id}`}
              variant="secondary"
              className="text-[10px]"
            >
              Chưa duyệt
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Source Column (Read-Only) */}
        <div className="space-y-2 p-3 rounded-xl bg-slate-950/50 border border-slate-800/60">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>Văn bản gốc (Source)</span>
            <span className="text-[10px] text-slate-500">Bất biến</span>
          </div>
          <div className="min-h-[72px] text-sm text-slate-200 leading-relaxed select-text">
            <ProtectedAnchorText text={segment.rawText} />
          </div>
        </div>

        {/* Translation Column (Interactive Editor) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>Bản dịch (Translation)</span>
            <span className="text-[10px] text-slate-500">
              Ctrl+Enter để Lưu
            </span>
          </div>

          <textarea
            data-testid={`novel-segment-textarea-${segment.id}`}
            value={currentText}
            onChange={(e) => onDraftChange(segment.id, e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSaving || isReadonly}
            rows={3}
            className="w-full rounded-xl bg-slate-950 border border-slate-700/80 p-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500/80 font-sans leading-relaxed transition-all resize-y disabled:opacity-50"
            placeholder="Nhập bản dịch và giữ nguyên các thẻ ⟦...⟧..."
          />

          {/* Validation Alert */}
          {!validation.valid && validation.error && (
            <div
              data-testid="novel-segment-topology-error"
              className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-start gap-2 text-xs text-rose-300"
            >
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{validation.error}</span>
            </div>
          )}

          {/* Conflict Alert */}
          {conflictMessage && (
            <div
              data-testid="novel-segment-conflict-banner"
              className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-xs text-amber-300"
            >
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>{conflictMessage}</span>
            </div>
          )}

          {/* Error Alert */}
          {errorMessage && (
            <div
              data-testid="novel-segment-error-banner"
              className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2 text-xs text-red-300"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Action Bar */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {onToggleVerify && (
              <Button
                variant="outline"
                size="sm"
                data-testid={`novel-segment-verify-btn-${segment.id}`}
                onClick={() => onToggleVerify(segment.id)}
                disabled={isSaving || isReadonly}
                className="h-7 text-xs px-2.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                {segment.isHumanVerified ? 'Bỏ duyệt' : 'Duyệt'}
              </Button>
            )}

            <Button
              variant="primary"
              size="sm"
              data-testid={`novel-segment-save-btn-${segment.id}`}
              onClick={() => onSave(segment.id)}
              disabled={isSaveDisabled}
              className="h-7 text-xs px-3"
            >
              {isSaving ? (
                <>
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                  Đang lưu...
                </>
              ) : (
                <>
                  <Save className="w-3 h-3 mr-1" />
                  Lưu
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
