'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  GlossaryDisplayTerm,
  SUGGESTED_GLOSSARY_CATEGORIES,
} from '@omninovel/shared';
import {
  validateGlossaryInput,
  checkGlossaryDuplicate,
} from '../../../lib/studio/glossary-policy';
import { Loader2, Plus, Info, AlertTriangle, CheckCircle2 } from 'lucide-react';

export interface CreateGlossaryFormProps {
  liveTerms: GlossaryDisplayTerm[];
  onSubmit: (data: {
    sourceTerm: string;
    targetTerm: string;
    category?: string;
  }) => Promise<void>;
  isSubmitting: boolean;
  initialSourceTerm?: string;
  onSuccess?: () => void;
}

export function CreateGlossaryForm({
  liveTerms,
  onSubmit,
  isSubmitting,
  initialSourceTerm = '',
  onSuccess,
}: CreateGlossaryFormProps) {
  const [sourceTerm, setSourceTerm] = useState(initialSourceTerm);
  const [targetTerm, setTargetTerm] = useState('');
  const [category, setCategory] = useState<string>('CHARACTER_NAME');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialSourceTerm) {
      setSourceTerm(initialSourceTerm);
    }
  }, [initialSourceTerm]);

  const duplicateCheck = useMemo(
    () => checkGlossaryDuplicate(liveTerms, sourceTerm),
    [liveTerms, sourceTerm],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSubmitError(null);
    setSuccessMessage(null);

    const validation = validateGlossaryInput(sourceTerm, targetTerm, category);
    if (!validation.valid || !validation.normalized) {
      setValidationError(validation.error || 'Dữ liệu không hợp lệ.');
      return;
    }

    try {
      await onSubmit(validation.normalized);
      setSuccessMessage(
        duplicateCheck.type === 'EXACT_MATCH'
          ? 'Đã cập nhật bản dịch của thuật ngữ thành công!'
          : 'Đã thêm thuật ngữ mới vào Từ điển Dự án!',
      );
      // Reset targetTerm after successful addition
      setTargetTerm('');
      if (!initialSourceTerm) {
        setSourceTerm('');
      }
      onSuccess?.();
    } catch (err: any) {
      setSubmitError(err?.message || 'Có lỗi xảy ra khi lưu thuật ngữ.');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/80 space-y-4"
      data-testid="create-glossary-form"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Plus className="w-4 h-4 text-emerald-400" />
          Thêm hoặc Cập nhật Thuật Ngữ
        </h4>
        <span className="text-xs text-slate-400">Tối đa 100 ký tự / mục</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Source Term */}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Thuật ngữ gốc <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={sourceTerm}
            onChange={(e) => {
              setSourceTerm(e.target.value);
              setValidationError(null);
              setSuccessMessage(null);
            }}
            placeholder="Ví dụ: Rimuru, Camelot..."
            maxLength={100}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            data-testid="glossary-source-input"
          />
        </div>

        {/* Target Term */}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Bản dịch / Nghĩa chuẩn <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={targetTerm}
            onChange={(e) => {
              setTargetTerm(e.target.value);
              setValidationError(null);
              setSuccessMessage(null);
            }}
            placeholder="Ví dụ: Ri-mu-ru, Ca-mê-lốt..."
            maxLength={100}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            data-testid="glossary-target-input"
          />
        </div>

        {/* Category */}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Danh mục
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            data-testid="glossary-category-select"
          >
            {SUGGESTED_GLOSSARY_CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Duplicate warning banners */}
      {duplicateCheck.type === 'EXACT_MATCH' && (
        <div
          className="flex items-start gap-2 p-2.5 bg-blue-950/40 border border-blue-800/60 rounded-lg text-xs text-blue-300"
          data-testid="glossary-exact-match-warning"
        >
          <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <span>
            Thuật ngữ <strong>&quot;{duplicateCheck.existingTerm?.sourceTerm}&quot;</strong> đã tồn
            tại trong dự án. Lưu sẽ cập nhật lại nghĩa dịch của bản ghi này.
          </span>
        </div>
      )}

      {duplicateCheck.type === 'CASE_INSENSITIVE_SIMILAR' && (
        <div
          className="flex items-start gap-2 p-2.5 bg-amber-950/40 border border-amber-800/60 rounded-lg text-xs text-amber-300"
          data-testid="glossary-similar-warning"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>
            Có một thuật ngữ tương tự khác chữ hoa/thường (
            <strong>&quot;{duplicateCheck.similarTerm}&quot;</strong>). Hãy kiểm tra trước khi lưu.
          </span>
        </div>
      )}

      {/* Errors & Success Feedback */}
      {validationError && (
        <p className="text-xs text-red-400" data-testid="glossary-validation-error">
          {validationError}
        </p>
      )}
      {submitError && (
        <p className="text-xs text-red-400" data-testid="glossary-submit-error">
          {submitError}
        </p>
      )}
      {successMessage && (
        <div className="flex items-center gap-2 text-xs text-emerald-400" data-testid="glossary-success-msg">
          <CheckCircle2 className="w-4 h-4" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Submit Button */}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-xs font-semibold rounded-lg shadow transition-colors flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
          data-testid="glossary-submit-btn"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Đang lưu...
            </>
          ) : duplicateCheck.type === 'EXACT_MATCH' ? (
            'Cập nhật Thuật Ngữ'
          ) : (
            'Lưu vào Từ Điển'
          )}
        </button>
      </div>
    </form>
  );
}
