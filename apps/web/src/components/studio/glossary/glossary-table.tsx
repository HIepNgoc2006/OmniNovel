'use client';

import React, { useState, useMemo } from 'react';
import {
  GlossaryDisplayTerm,
  SUGGESTED_GLOSSARY_CATEGORIES,
} from '@omninovel/shared';
import {
  filterGlossaryTerms,
  formatCategoryBadge,
} from '../../../lib/studio/glossary-policy';
import { Search, Copy, Check, BookOpen } from 'lucide-react';

export interface GlossaryTableProps {
  terms: GlossaryDisplayTerm[];
  emptyMessage?: string;
  showCopyActions?: boolean;
}

export function GlossaryTable({
  terms,
  emptyMessage = 'Chưa có thuật ngữ nào.',
  showCopyActions = true,
}: GlossaryTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const filteredTerms = useMemo(() => {
    return filterGlossaryTerms(terms, searchQuery, categoryFilter);
  }, [terms, searchQuery, categoryFilter]);

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // Fallback
      console.warn('Không thể sao chép văn bản vào clipboard.');
    }
  };

  return (
    <div className="space-y-3" data-testid="glossary-table-container">
      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row gap-2 items-center justify-between">
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo gốc hoặc nghĩa dịch..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-800/80 border border-slate-700 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            data-testid="glossary-search-input"
          />
        </div>

        <div className="w-full sm:w-auto flex items-center gap-2">
          <span className="text-xs text-slate-400 shrink-0">Danh mục:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-800/80 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            data-testid="glossary-category-filter"
          >
            <option value="ALL">Tất cả danh mục</option>
            {SUGGESTED_GLOSSARY_CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table Content */}
      {filteredTerms.length === 0 ? (
        <div
          className="py-12 px-4 text-center border border-dashed border-slate-800 rounded-xl bg-slate-900/40"
          data-testid="glossary-empty-state"
        >
          <BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-xs text-slate-400 font-medium">{emptyMessage}</p>
          {searchQuery && (
            <p className="text-xs text-slate-500 mt-1">
              Không tìm thấy kết quả nào khớp với từ khóa &quot;{searchQuery}&quot;.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/60 max-h-80 overflow-y-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 bg-slate-950/90 backdrop-blur-sm border-b border-slate-800 z-10">
              <tr>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Thuật ngữ gốc</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Bản dịch</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Danh mục</th>
                {showCopyActions && (
                  <th className="py-2.5 px-3 font-semibold text-slate-300 text-right">Sao chép</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredTerms.map((term, index) => {
                const badge = formatCategoryBadge(term.category);
                const sourceKey = `source-${index}-${term.sourceTerm}`;
                const targetKey = `target-${index}-${term.targetTerm}`;

                return (
                  <tr
                    key={`${term.sourceTerm}-${index}`}
                    className="hover:bg-slate-800/40 transition-colors"
                    data-testid={`glossary-row-${term.sourceTerm}`}
                  >
                    <td className="py-2 px-3 font-medium text-slate-200">
                      {term.sourceTerm}
                    </td>
                    <td className="py-2 px-3 text-slate-300">
                      {term.targetTerm}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${
                          badge.isCustom
                            ? 'bg-slate-800 text-slate-400 border border-slate-700'
                            : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60'
                        }`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    {showCopyActions && (
                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Copy Source */}
                          <button
                            type="button"
                            onClick={() => handleCopy(term.sourceTerm, sourceKey)}
                            title="Sao chép thuật ngữ gốc"
                            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
                            data-testid={`copy-source-${term.sourceTerm}`}
                          >
                            {copiedKey === sourceKey ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>

                          {/* Copy Target */}
                          <button
                            type="button"
                            onClick={() => handleCopy(term.targetTerm, targetKey)}
                            title="Sao chép bản dịch"
                            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
                            data-testid={`copy-target-${term.sourceTerm}`}
                          >
                            {copiedKey === targetKey ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 hover:underline">
                                <Copy className="w-3 h-3" />
                                Nghĩa
                              </span>
                            )}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
