import { describe, it, expect } from 'vitest';
import {
  validateGlossaryInput,
  checkGlossaryDuplicate,
  normalizeGlossarySelection,
  formatCategoryBadge,
  filterGlossaryTerms,
} from '../lib/studio/glossary-policy';
import { GlossaryDisplayTerm } from '@omninovel/shared';

describe('Glossary Policy - Pure Functions (#151)', () => {
  describe('validateGlossaryInput', () => {
    it('accepts valid sourceTerm, targetTerm, and category', () => {
      const result = validateGlossaryInput('  Hero  ', '  Anh hùng  ', '  CHARACTER_NAME  ');
      expect(result.valid).toBe(true);
      expect(result.normalized).toEqual({
        sourceTerm: 'Hero',
        targetTerm: 'Anh hùng',
        category: 'CHARACTER_NAME',
      });
    });

    it('rejects empty or whitespace-only sourceTerm', () => {
      const res1 = validateGlossaryInput('', 'Target');
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain('Thuật ngữ gốc không được để trống');

      const res2 = validateGlossaryInput('   ', 'Target');
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain('Thuật ngữ gốc không được để trống');
    });

    it('rejects empty or whitespace-only targetTerm', () => {
      const res = validateGlossaryInput('Source', '   ');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Bản dịch không được để trống');
    });

    it('rejects sourceTerm exceeding 100 characters', () => {
      const res = validateGlossaryInput('a'.repeat(101), 'Target');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('100 ký tự');
    });

    it('rejects targetTerm exceeding 100 characters', () => {
      const res = validateGlossaryInput('Source', 'b'.repeat(101));
      expect(res.valid).toBe(false);
      expect(res.error).toContain('100 ký tự');
    });

    it('rejects category exceeding 50 characters', () => {
      const res = validateGlossaryInput('Source', 'Target', 'c'.repeat(51));
      expect(res.valid).toBe(false);
      expect(res.error).toContain('50 ký tự');
    });
  });

  describe('checkGlossaryDuplicate', () => {
    const existingTerms: GlossaryDisplayTerm[] = [
      { sourceTerm: 'Hero', targetTerm: 'Anh hùng', category: 'CHARACTER_NAME' },
      { sourceTerm: 'Demon King', targetTerm: 'Ma vương', category: 'CHARACTER_NAME' },
      { sourceTerm: 'Elf Village', targetTerm: 'Làng Elf', category: 'LOCATION' },
    ];

    it('detects EXACT_MATCH even with surrounding whitespace', () => {
      const result = checkGlossaryDuplicate(existingTerms, '  Hero  ');
      expect(result.type).toBe('EXACT_MATCH');
      expect(result.existingTerm?.sourceTerm).toBe('Hero');
    });

    it('detects CASE_INSENSITIVE_SIMILAR when casing differs', () => {
      const result = checkGlossaryDuplicate(existingTerms, 'hero');
      expect(result.type).toBe('CASE_INSENSITIVE_SIMILAR');
      expect(result.similarTerm).toBe('Hero');
    });

    it('returns NONE when no exact or similar term exists', () => {
      const result = checkGlossaryDuplicate(existingTerms, 'Dragon');
      expect(result.type).toBe('NONE');
    });

    it('returns NONE for empty input', () => {
      const result = checkGlossaryDuplicate(existingTerms, '   ');
      expect(result.type).toBe('NONE');
    });
  });

  describe('normalizeGlossarySelection', () => {
    it('accepts clean plain text selection and trims whitespace', () => {
      const result = normalizeGlossarySelection('  Rimuru Tempest  ');
      expect(result.valid).toBe(true);
      expect(result.text).toBe('Rimuru Tempest');
    });

    it('rejects selection containing structure anchor brackets ⟦ or ⟧', () => {
      const res1 = normalizeGlossarySelection('⟦S:sec-1⟧Some text');
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain('thẻ cấu trúc');

      const res2 = normalizeGlossarySelection('Partial ⟧ text');
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain('thẻ cấu trúc');
    });

    it('rejects selection exceeding 100 characters', () => {
      const result = normalizeGlossarySelection('a'.repeat(101));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('100 ký tự');
    });

    it('rejects empty or whitespace-only selection', () => {
      const result = normalizeGlossarySelection('   ');
      expect(result.valid).toBe(false);
    });
  });

  describe('formatCategoryBadge', () => {
    it('returns formatted label for suggested categories', () => {
      const badge = formatCategoryBadge('CHARACTER_NAME');
      expect(badge.label).toBe('Tên nhân vật');
      expect(badge.isCustom).toBe(false);
    });

    it('gracefully falls back for unknown/legacy/custom category', () => {
      const badge = formatCategoryBadge('CUSTOM_MAGIC_SPELL');
      expect(badge.label).toBe('CUSTOM_MAGIC_SPELL');
      expect(badge.isCustom).toBe(true);
    });

    it('handles undefined or empty category gracefully', () => {
      const badge = formatCategoryBadge(undefined);
      expect(badge.label).toBe('Chưa phân loại');
      expect(badge.isCustom).toBe(true);
    });
  });

  describe('filterGlossaryTerms', () => {
    const terms: GlossaryDisplayTerm[] = [
      { sourceTerm: 'Arthur Pendragon', targetTerm: 'A-thơ', category: 'CHARACTER_NAME' },
      { sourceTerm: 'Camelot', targetTerm: 'Ca-mê-lốt', category: 'LOCATION' },
      { sourceTerm: 'Excalibur', targetTerm: 'Thánh kiếm Excalibur', category: 'ITEM' },
    ];

    it('filters by query across sourceTerm and targetTerm', () => {
      const matchSource = filterGlossaryTerms(terms, 'Arthur', 'ALL');
      expect(matchSource).toHaveLength(1);
      expect(matchSource[0].sourceTerm).toBe('Arthur Pendragon');

      const matchTarget = filterGlossaryTerms(terms, 'Thánh kiếm', 'ALL');
      expect(matchTarget).toHaveLength(1);
      expect(matchTarget[0].sourceTerm).toBe('Excalibur');
    });

    it('filters by category', () => {
      const locationOnly = filterGlossaryTerms(terms, '', 'LOCATION');
      expect(locationOnly).toHaveLength(1);
      expect(locationOnly[0].sourceTerm).toBe('Camelot');
    });

    it('combines query and category filter', () => {
      const combined = filterGlossaryTerms(terms, 'ca', 'LOCATION');
      expect(combined).toHaveLength(1);
      expect(combined[0].sourceTerm).toBe('Camelot');

      const miss = filterGlossaryTerms(terms, 'ca', 'CHARACTER_NAME');
      expect(miss).toHaveLength(0);
    });
  });
});
