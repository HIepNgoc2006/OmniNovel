import * as fs from 'fs';
import * as path from 'path';
import {
  validateMangaResultManifestV1,
  validateNovelResultManifestV1,
  validateTranslationResultManifest,
  validateTranslationInputManifestV1,
  validateMangaReviewSourceManifestV1,
  validateMangaCleanBaseManifestV1,
  validateNovelMaterializationResultV1,
  NovelBlockType,
} from '@omninovel/shared';

const CORPUS_PATH = path.resolve(
  __dirname,
  '../../../../../../packages/shared/fixtures/manifest-corpus.json',
);

interface CorpusCase {
  id: string;
  schema: string;
  description: string;
  valid: boolean;
  input: unknown;
  canonical?: unknown;
}

const corpus: CorpusCase[] = JSON.parse(
  fs.readFileSync(CORPUS_PATH, 'utf-8'),
);

describe('Translation Manifest Runtime Validators & Corpus Parity (#164)', () => {
  describe('validateMangaResultManifestV1', () => {
    it('should accept valid Manga manifest with fileSizeBytes', () => {
      const raw = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'outputs/page-1.webp',
            previewKey: 'previews/page-1.webp',
            width: 1200,
            height: 1800,
            fileSizeBytes: 1048576,
          },
        ],
      };

      const result = validateMangaResultManifestV1(raw);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.value?.version).toBe(1);
      expect(result.value?.pages[0].fileSizeBytes).toBe(1048576);
    });

    it('should support backward compatibility: auto-map legacy fileSize to fileSizeBytes', () => {
      const legacyRaw = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'outputs/page-1.webp',
            previewKey: 'previews/page-1.webp',
            width: 1200,
            height: 1800,
            fileSize: 524288,
          },
        ],
      };

      const result = validateMangaResultManifestV1(legacyRaw);
      expect(result.valid).toBe(true);
      expect(result.value?.pages[0].fileSizeBytes).toBe(524288);
    });

    it('should fail-closed with MISSING_OR_INVALID_VERSION if version is not 1', () => {
      const invalidVersion = {
        version: 2,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'k',
            previewKey: 'p',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
        ],
      };

      const result = validateMangaResultManifestV1(invalidVersion);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('MISSING_OR_INVALID_VERSION');
    });

    it('should reject manifest with duplicate page numbers', () => {
      const duplicatePages = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'k1',
            previewKey: 'p1',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
          {
            page: 1,
            storageKey: 'k2',
            previewKey: 'p2',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
        ],
      };

      const result = validateMangaResultManifestV1(duplicatePages);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('DUPLICATE_PAGE_NUMBER'))).toBe(true);
    });

    it('should reject manifest with duplicate page numbers in cleanBases', () => {
      const duplicateCleanBases = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'ai/jobs/job-1/attempt-1/page-1.webp',
            previewKey: 'ai/jobs/job-1/attempt-1/page-1.webp',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
          {
            page: 2,
            storageKey: 'ai/jobs/job-1/attempt-1/page-2.webp',
            previewKey: 'ai/jobs/job-1/attempt-1/page-2.webp',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
        ],
        cleanBases: [
          { page: 1, cleanBaseKey: 'ai/jobs/job-1/review-base/page_1.webp' },
          { page: 1, cleanBaseKey: 'ai/jobs/job-1/review-base/page_1_dup.webp' },
        ],
      };

      const result = validateMangaResultManifestV1(duplicateCleanBases);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes('DUPLICATE_CLEAN_BASE_PAGE_NUMBER'),
        ),
      ).toBe(true);
    });

    it('should accept valid Manga manifest with cleanBases', () => {
      const validWithCleanBases = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'ai/jobs/job-1/attempt-1/page-1.webp',
            previewKey: 'ai/jobs/job-1/attempt-1/page-1.webp',
            width: 1200,
            height: 1800,
            fileSizeBytes: 1024,
          },
        ],
        cleanBases: [
          { page: 1, cleanBaseKey: 'ai/jobs/job-1/review-base/page_1.webp' },
        ],
      };

      const result = validateMangaResultManifestV1(validWithCleanBases);
      expect(result.valid).toBe(true);
      expect(result.value?.cleanBases).toHaveLength(1);
      expect(result.value?.cleanBases?.[0].cleanBaseKey).toBe(
        'ai/jobs/job-1/review-base/page_1.webp',
      );
    });
  });

  describe('validateNovelResultManifestV1', () => {
    it('should accept valid Novel manifest with required htmlFileSizeBytes', () => {
      const raw = {
        version: 1,
        mediaFormat: 'NOVEL',
        htmlKey: 'novels/chapter-1.html',
        segmentCount: 42,
        charCount: 15420,
        htmlFileSizeBytes: 20480,
        title: 'Chương 1: Khởi đầu mới',
        qa: {
          passed: true,
          score: 0.985,
          fingerprintMatch: true,
          issuesCount: 0,
        },
        metrics: {
          totalBlocks: 42,
          totalBatches: 2,
          glossaryHits: 5,
        },
      };

      const result = validateNovelResultManifestV1(raw);
      expect(result.valid).toBe(true);
      expect(result.value?.version).toBe(1);
      expect(result.value?.mediaFormat).toBe('NOVEL');
      expect(result.value?.htmlFileSizeBytes).toBe(20480);
    });

    it('should reject Novel manifest missing htmlFileSizeBytes', () => {
      const missingSize = {
        version: 1,
        mediaFormat: 'NOVEL',
        htmlKey: 'novels/chapter-1.html',
        segmentCount: 10,
        charCount: 1000,
        qa: {
          passed: true,
          score: 90,
          fingerprintMatch: true,
          issuesCount: 0,
        },
      };

      const result = validateNovelResultManifestV1(missingSize);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('htmlFileSizeBytes'))).toBe(true);
    });
  });

  describe('validateTranslationInputManifestV1', () => {
    it('should validate consent invariants', () => {
      const invalidConsent = {
        version: 1,
        sourceLang: 'ja',
        targetLang: 'vi',
        provider: 'OPENAI',
        model: 'gpt-4o-mini',
        promptVersion: 'v1.0',
        glossarySnapshot: [],
        glossaryHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        externalConsent: {
          consented: false,
          consentedAt: '2026-09-03T10:00:00.000Z', // Mismatch!
          provider: 'OPENAI',
        },
      };

      const result = validateTranslationInputManifestV1(invalidConsent);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('consentedAt must be null'))).toBe(true);
    });
  });

  describe('Unicode Code Points Semantics (#164)', () => {
    it('should accurately count Unicode code points for emoji strings using Array.from or spread', () => {
      const text = 'Hello 😀';
      // In JS, text.length is 8 (UTF-16 code units)
      expect(text.length).toBe(8);
      // In Unicode code points, text is 7 code points (matching Python len(str))
      const codePointsCount = [...text].length;
      expect(codePointsCount).toBe(7);
      expect(Array.from(text).length).toBe(7);
    });
  });

  describe('Shared Manifest Corpus Parity (100% Corpus Cases)', () => {
    const validatorMap: Record<string, (data: unknown) => { valid: boolean; value?: unknown; errors: string[] }> = {
      MANGA_RESULT_V1: validateMangaResultManifestV1,
      NOVEL_RESULT_V1: validateNovelResultManifestV1,
      INPUT_MANIFEST_V1: validateTranslationInputManifestV1,
      MANGA_REVIEW_SOURCE_V1: validateMangaReviewSourceManifestV1,
      MANGA_CLEAN_BASE_V1: validateMangaCleanBaseManifestV1,
    };

    corpus.forEach((testCase) => {
      it(`[${testCase.id}] ${testCase.description}`, () => {
        const validator = validatorMap[testCase.schema];
        expect(validator).toBeDefined();

        const result = validator(testCase.input);

        if (testCase.valid) {
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
          expect(result.value).toEqual(testCase.canonical);
        } else {
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThanOrEqual(1);
        }
      });
    });
  });

  describe('NovelBlockType Canonical Enum Invariants (#160)', () => {
    it('should expose exactly the 4 canonical enum values', () => {
      expect(Object.values(NovelBlockType)).toEqual([
        'HEADING',
        'DIALOGUE',
        'NARRATION',
        'BLOCKQUOTE',
      ]);
    });
  });

  describe('validateNovelMaterializationResultV1 QA Issues Strict Validation (#161, #171 Finding A)', () => {
    const validBase = {
      version: 1,
      mediaFormat: 'NOVEL',
      htmlKey: 'ai/jobs/job-1/materializations/rev-2/content.html',
      htmlFileSizeBytes: 12345,
      segmentCount: 5,
      charCount: 200,
      qa: {
        passed: true,
        score: 0.95,
        fingerprintMatch: true,
        issuesCount: 1,
        issues: [
          {
            severity: 'warning',
            ruleId: 'GLOSSARY_MISS',
            message: 'Potential glossary miss',
          },
        ],
      },
    };

    it('should accept valid novel materialization result with canonical qa.issues', () => {
      const res = validateNovelMaterializationResultV1(validBase);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.value?.qa.issues).toEqual([
        {
          severity: 'warning',
          ruleId: 'GLOSSARY_MISS',
          message: 'Potential glossary miss',
        },
      ]);
    });

    it('should reject novel materialization result when qa.issues is not an array (e.g. object)', () => {
      const invalid = {
        ...validBase,
        qa: {
          ...validBase.qa,
          issues: { not: 'an array' },
        },
      };

      const res = validateNovelMaterializationResultV1(invalid);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('qa.issues must be an array'))).toBe(true);
    });

    it('should reject novel materialization result when qa.issues item has unexpected internal field', () => {
      const invalid = {
        ...validBase,
        qa: {
          ...validBase.qa,
          issues: [
            {
              severity: 'warning',
              ruleId: 'GLOSSARY_MISS',
              message: 'Potential glossary miss',
              unexpectedInternalField: 'leaked_data',
            },
          ],
        },
      };

      const res = validateNovelMaterializationResultV1(invalid);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('unexpectedInternalField'))).toBe(true);
    });

    it('should reject novel materialization result when qa.issues item is malformed (e.g. not an object, null, or missing fields)', () => {
      const invalidNotObject = {
        ...validBase,
        qa: {
          ...validBase.qa,
          issues: ['string-not-an-issue'],
        },
      };
      const res1 = validateNovelMaterializationResultV1(invalidNotObject);
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.includes('must be an object'))).toBe(true);

      const invalidMissingField = {
        ...validBase,
        qa: {
          ...validBase.qa,
          issues: [
            {
              severity: 'warning',
              // missing ruleId and message
            },
          ],
        },
      };
      const res2 = validateNovelMaterializationResultV1(invalidMissingField);
      expect(res2.valid).toBe(false);
      expect(res2.errors.some((e) => e.includes('ruleId must be a string'))).toBe(true);
      expect(res2.errors.some((e) => e.includes('message must be a string'))).toBe(true);
    });
  });
});

