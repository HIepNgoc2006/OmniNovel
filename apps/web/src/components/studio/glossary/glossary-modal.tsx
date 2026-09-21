'use client';

import React, { useState, useEffect } from 'react';
import { GlossaryDisplayTerm } from '@omninovel/shared';
import { Modal } from '../../ui/modal';
import { useProjectGlossary } from '../../../lib/studio/use-project-glossary';
import { CreateGlossaryForm } from './create-glossary-form';
import { GlossaryTable } from './glossary-table';
import { GlossarySnapshotNotice } from './glossary-snapshot-notice';
import { BookOpen, Camera, Loader2, AlertCircle } from 'lucide-react';

export interface GlossaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  snapshotTerms: GlossaryDisplayTerm[];
  initialSourceTerm?: string;
}

export type GlossaryTab = 'LIVE' | 'SNAPSHOT';

export function GlossaryModal({
  isOpen,
  onClose,
  projectId,
  snapshotTerms = [],
  initialSourceTerm,
}: GlossaryModalProps) {
  const [activeTab, setActiveTab] = useState<GlossaryTab>('LIVE');

  const {
    terms: liveTerms,
    isLoading,
    isError,
    error,
    createTerm,
    isCreating,
  } = useProjectGlossary({
    projectId,
    isEnabled: isOpen,
  });

  // Whenever a prefilled sourceTerm is passed in, switch to LIVE tab
  useEffect(() => {
    if (initialSourceTerm) {
      setActiveTab('LIVE');
    }
  }, [initialSourceTerm]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Từ Điển Thuật Ngữ (Translation Glossary)"
      maxWidth="3xl"
    >
      <div className="space-y-4" data-testid="glossary-modal-content">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
          <button
            type="button"
            onClick={() => setActiveTab('LIVE')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === 'LIVE'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            data-testid="glossary-tab-live"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Từ điển Dự án (Live)</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                activeTab === 'LIVE' ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {liveTerms.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('SNAPSHOT')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === 'SNAPSHOT'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            data-testid="glossary-tab-snapshot"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Snapshot của Job</span>
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                activeTab === 'SNAPSHOT' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {snapshotTerms.length}
            </span>
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'LIVE' && (
          <div className="space-y-4" data-testid="glossary-live-panel">
            {/* Form for adding/updating terms */}
            <CreateGlossaryForm
              liveTerms={liveTerms}
              onSubmit={async (data) => {
                await createTerm(data);
              }}
              isSubmitting={isCreating}
              initialSourceTerm={initialSourceTerm}
            />

            {/* Loading & Error states */}
            {isLoading && (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
                <span className="text-xs">Đang tải danh sách thuật ngữ từ điển...</span>
              </div>
            )}

            {isError && (
              <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span>
                  Không thể tải từ điển: {error?.message || 'Lỗi không xác định.'}
                </span>
              </div>
            )}

            {!isLoading && (
              <GlossaryTable
                terms={liveTerms}
                emptyMessage="Dự án chưa có thuật ngữ nào trong từ điển."
              />
            )}
          </div>
        )}

        {activeTab === 'SNAPSHOT' && (
          <div className="space-y-4" data-testid="glossary-snapshot-panel">
            <GlossarySnapshotNotice />
            <GlossaryTable
              terms={snapshotTerms}
              emptyMessage="Job dịch này không có snapshot thuật ngữ nào được ghim."
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
