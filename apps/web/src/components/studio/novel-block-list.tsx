'use client';

import React from 'react';
import { NovelReviewBlock } from '@/lib/studio/novel-studio-policy';
import { NovelSegmentEditor } from './novel-segment-editor';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Layers } from 'lucide-react';

export interface NovelBlockListProps {
  blocks: NovelReviewBlock[];
  drafts: Record<string, string>;
  savingSegmentIds?: Record<string, boolean>;
  conflictStates?: Record<string, string>;
  errorStates?: Record<string, string>;
  onDraftChange: (segmentId: string, text: string) => void;
  onSaveSegment: (segmentId: string) => any;
  onToggleVerify?: (segmentId: string) => any;
  isReadonly?: boolean;
}

export function NovelBlockList({
  blocks,
  drafts,
  savingSegmentIds = {},
  conflictStates = {},
  errorStates = {},
  onDraftChange,
  onSaveSegment,
  onToggleVerify,
  isReadonly = false,
}: NovelBlockListProps) {
  if (blocks.length === 0) {
    return (
      <div
        data-testid="novel-block-list-empty"
        className="p-12 text-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 text-slate-400 space-y-2"
      >
        <Layers className="w-8 h-8 mx-auto text-slate-500" />
        <p className="text-sm">Chưa có phân đoạn dịch nào được tải.</p>
      </div>
    );
  }

  return (
    <div data-testid="novel-block-list" className="space-y-8">
      {blocks.map((block) => {
        const isAllVerified =
          block.segmentCount > 0 && block.verifiedCount === block.segmentCount;

        return (
          <section
            key={block.anchorBlockId}
            data-testid={`novel-block-${block.anchorBlockId}`}
            className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6 space-y-4"
          >
            {/* Block Header */}
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-indigo-500" />
                <h2 className="text-sm font-bold text-white font-mono">
                  Block {block.anchorBlockId}
                </h2>
                <span className="text-xs text-slate-500">
                  {block.segmentCount} phân đoạn
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Badge
                  variant={isAllVerified ? 'success' : 'secondary'}
                  className="text-xs font-mono"
                >
                  {isAllVerified && <CheckCircle2 className="w-3 h-3 mr-1" />}
                  {block.verifiedCount} / {block.segmentCount} đã duyệt
                </Badge>
              </div>
            </div>

            {/* Block Segments */}
            <div className="space-y-4">
              {block.segments.map((segment) => (
                <NovelSegmentEditor
                  key={segment.id}
                  segment={segment}
                  draftText={drafts[segment.id]}
                  onDraftChange={onDraftChange}
                  onSave={onSaveSegment}
                  onToggleVerify={onToggleVerify}
                  isSaving={savingSegmentIds[segment.id]}
                  conflictMessage={conflictStates[segment.id]}
                  errorMessage={errorStates[segment.id]}
                  isReadonly={isReadonly}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
