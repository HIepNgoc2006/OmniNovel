import {
  validateMangaResultManifestV1,
  validateNovelResultManifestV1,
  validateTranslationResultManifest,
  NovelBlockType,
} from '@omninovel/shared';

describe('Translation Manifest Runtime Validators (#164)', () => {
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
        pages: [
          {
            page: 1,
            storageKey: 'outputs/page-1.webp',
            previewKey: 'previews/page-1.webp',
            width: 1200,
            height: 1800,
            fileSize: 524288, // Legacy field name
          },
        ],
      };

      const result = validateMangaResultManifestV1(legacyRaw);
      expect(result.valid).toBe(true);
      expect(result.value?.pages[0].fileSizeBytes).toBe(524288);
    });

    it('should fail-closed with UNKNOWN_MANIFEST_VERSION if version is not 1', () => {
      const invalidVersion = {
        version: 2,
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
      expect(result.errors[0]).toContain('UNKNOWN_MANIFEST_VERSION');
    });

    it('should reject manifest with empty pages array', () => {
      const emptyPages = {
        version: 1,
        pages: [],
      };

      const result = validateMangaResultManifestV1(emptyPages);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('pages array must not be empty');
    });

    it('should validate optional cleanBases array', () => {
      const withCleanBases = {
        version: 1,
        pages: [
          {
            page: 1,
            storageKey: 'out.webp',
            previewKey: 'prev.webp',
            width: 100,
            height: 100,
            fileSizeBytes: 1000,
          },
        ],
        cleanBases: [
          {
            page: 1,
            cleanBaseKey: 'clean/clean-1.webp',
          },
        ],
      };

      const result = validateMangaResultManifestV1(withCleanBases);
      expect(result.valid).toBe(true);
      expect(result.value?.cleanBases?.[0].cleanBaseKey).toBe('clean/clean-1.webp');
    });

    it('should reject cleanBases with invalid page number or missing key', () => {
      const badCleanBases = {
        version: 1,
        pages: [
          {
            page: 1,
            storageKey: 'out.webp',
            previewKey: 'prev.webp',
            width: 100,
            height: 100,
            fileSizeBytes: 1000,
          },
        ],
        cleanBases: [
          {
            page: 0,
            cleanBaseKey: '',
          },
        ],
      };

      const result = validateMangaResultManifestV1(badCleanBases);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('validateNovelResultManifestV1', () => {
    it('should accept valid Novel manifest with QA metrics', () => {
      const raw = {
        version: 1,
        mediaFormat: 'NOVEL',
        htmlKey: 'novels/chapter-1.html',
        segmentCount: 42,
        charCount: 15420,
        title: 'Chương 1: Khởi đầu mới',
        qa: {
          passed: true,
          score: 98.5,
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
      expect(result.value?.htmlKey).toBe('novels/chapter-1.html');
      expect(result.value?.qa.score).toBe(98.5);
    });

    it('should reject Novel manifest missing required fields (htmlKey, segmentCount)', () => {
      const missingFields = {
        version: 1,
        mediaFormat: 'NOVEL',
        charCount: 1000,
        qa: {
          passed: true,
          score: 90,
          fingerprintMatch: true,
          issuesCount: 0,
        },
      };

      const result = validateNovelResultManifestV1(missingFields);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('htmlKey must be a non-empty string');
      expect(result.errors).toContain('segmentCount must be a non-negative integer');
    });

    it('should reject Novel manifest with invalid QA structure', () => {
      const badQa = {
        version: 1,
        mediaFormat: 'NOVEL',
        htmlKey: 'novels/ch1.html',
        segmentCount: 10,
        charCount: 1000,
        qa: 'NOT_AN_OBJECT',
      };

      const result = validateNovelResultManifestV1(badQa);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('qa must be an object');
    });
  });

  describe('validateTranslationResultManifest (Discriminated Narrowing)', () => {
    it('should route COMIC mediaFormat to Manga validator', () => {
      const comicData = {
        version: 1,
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

      const result = validateTranslationResultManifest(comicData, 'COMIC');
      expect(result.valid).toBe(true);
      expect(result.value?.mediaFormat).toBe('COMIC');
    });

    it('should route NOVEL mediaFormat to Novel validator', () => {
      const novelData = {
        version: 1,
        mediaFormat: 'NOVEL',
        htmlKey: 'k.html',
        segmentCount: 5,
        charCount: 500,
        qa: { passed: true, score: 95, fingerprintMatch: true, issuesCount: 0 },
      };

      const result = validateTranslationResultManifest(novelData, 'NOVEL');
      expect(result.valid).toBe(true);
      expect(result.value?.mediaFormat).toBe('NOVEL');
    });

    it('should reject Comic data validated as Novel', () => {
      const comicData = {
        version: 1,
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

      const result = validateTranslationResultManifest(comicData, 'NOVEL');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('htmlKey must be a non-empty string');
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
});
