import {
  GlossaryDisplayTerm,
  SUGGESTED_GLOSSARY_CATEGORIES,
} from '@omninovel/shared';

export interface GlossaryValidationResult {
  valid: boolean;
  error?: string;
  normalized?: {
    sourceTerm: string;
    targetTerm: string;
    category?: string;
  };
}

export type GlossaryDuplicateType = 'NONE' | 'EXACT_MATCH' | 'CASE_INSENSITIVE_SIMILAR';

export interface GlossaryDuplicateCheckResult {
  type: GlossaryDuplicateType;
  existingTerm?: GlossaryDisplayTerm;
  similarTerm?: string;
}

export interface NormalizedSelectionResult {
  valid: boolean;
  text?: string;
  error?: string;
}

export interface CategoryBadgeInfo {
  label: string;
  value: string;
  isCustom: boolean;
}

/**
 * Validates and normalizes user input for creating/updating a glossary term.
 * Length constraints:
 * - sourceTerm: 1..100 characters
 * - targetTerm: 1..100 characters
 * - category: <= 50 characters
 */
export function validateGlossaryInput(
  sourceTerm: string,
  targetTerm: string,
  category?: string,
): GlossaryValidationResult {
  const trimmedSource = (sourceTerm ?? '').trim();
  const trimmedTarget = (targetTerm ?? '').trim();
  const trimmedCategory = category ? category.trim() : undefined;

  if (!trimmedSource) {
    return {
      valid: false,
      error: 'Thuật ngữ gốc không được để trống.',
    };
  }

  if (trimmedSource.length > 100) {
    return {
      valid: false,
      error: 'Thuật ngữ gốc không được vượt quá 100 ký tự.',
    };
  }

  if (!trimmedTarget) {
    return {
      valid: false,
      error: 'Bản dịch không được để trống.',
    };
  }

  if (trimmedTarget.length > 100) {
    return {
      valid: false,
      error: 'Bản dịch không được vượt quá 100 ký tự.',
    };
  }

  if (trimmedCategory && trimmedCategory.length > 50) {
    return {
      valid: false,
      error: 'Danh mục không được vượt quá 50 ký tự.',
    };
  }

  return {
    valid: true,
    normalized: {
      sourceTerm: trimmedSource,
      targetTerm: trimmedTarget,
      category: trimmedCategory || undefined,
    },
  };
}

/**
 * Checks if an input source term exists exactly or has a case-insensitive similar match.
 * Exact match: backend upsert will overwrite this record.
 * Similar match: warning to user that a different casing already exists.
 */
export function checkGlossaryDuplicate(
  terms: GlossaryDisplayTerm[],
  inputSourceTerm: string,
): GlossaryDuplicateCheckResult {
  const trimmed = (inputSourceTerm ?? '').trim();
  if (!trimmed) {
    return { type: 'NONE' };
  }

  const exact = terms.find((t) => t.sourceTerm === trimmed);
  if (exact) {
    return {
      type: 'EXACT_MATCH',
      existingTerm: exact,
    };
  }

  const lower = trimmed.toLowerCase();
  const similar = terms.find((t) => t.sourceTerm.toLowerCase() === lower);
  if (similar) {
    return {
      type: 'CASE_INSENSITIVE_SIMILAR',
      similarTerm: similar.sourceTerm,
    };
  }

  return { type: 'NONE' };
}

/**
 * Validates and normalizes selected text from source viewer (e.g. Novel Review).
 * Rejects selections containing structural anchors (⟦...⟧) or exceeding 100 chars.
 */
export function normalizeGlossarySelection(rawSelection: string): NormalizedSelectionResult {
  const trimmed = (rawSelection ?? '').trim();

  if (!trimmed) {
    return {
      valid: false,
      error: 'Văn bản được chọn không hợp lệ hoặc rỗng.',
    };
  }

  if (trimmed.includes('⟦') || trimmed.includes('⟧')) {
    return {
      valid: false,
      error: 'Không thể tạo thuật ngữ từ vùng chọn chứa thẻ cấu trúc bảo vệ.',
    };
  }

  if (trimmed.length > 100) {
    return {
      valid: false,
      error: 'Thuật ngữ được chọn quá dài (tối đa 100 ký tự).',
    };
  }

  return {
    valid: true,
    text: trimmed,
  };
}

/**
 * Resolves display label and badge formatting for glossary categories.
 * Safely handles any custom, legacy, or undefined category without crashing.
 */
export function formatCategoryBadge(category?: string): CategoryBadgeInfo {
  const normalizedCat = (category ?? '').trim();
  if (!normalizedCat) {
    return {
      label: 'Chưa phân loại',
      value: 'OTHER',
      isCustom: true,
    };
  }

  const found = SUGGESTED_GLOSSARY_CATEGORIES.find((c) => c.value === normalizedCat);
  if (found) {
    return {
      label: found.label,
      value: found.value,
      isCustom: false,
    };
  }

  return {
    label: normalizedCat,
    value: normalizedCat,
    isCustom: true,
  };
}

/**
 * Filters glossary terms by query (sourceTerm or targetTerm) and optional category.
 */
export function filterGlossaryTerms(
  terms: GlossaryDisplayTerm[],
  query: string,
  categoryFilter: string,
): GlossaryDisplayTerm[] {
  const trimmedQuery = (query ?? '').trim().toLowerCase();
  const isAllCategory = !categoryFilter || categoryFilter === 'ALL';

  return terms.filter((term) => {
    const matchesCategory = isAllCategory || term.category === categoryFilter;
    if (!matchesCategory) return false;

    if (!trimmedQuery) return true;

    const sourceMatch = term.sourceTerm.toLowerCase().includes(trimmedQuery);
    const targetMatch = term.targetTerm.toLowerCase().includes(trimmedQuery);
    return sourceMatch || targetMatch;
  });
}
