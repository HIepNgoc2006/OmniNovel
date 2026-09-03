export enum NovelBlockType {
  HEADING = 'HEADING',
  DIALOGUE = 'DIALOGUE',
  NARRATION = 'NARRATION',
  BLOCKQUOTE = 'BLOCKQUOTE',
}

// ----------------------------------------------------------------------
// Manga Result Manifest (Version 1)
// ----------------------------------------------------------------------

export interface MangaResultManifestPageV1 {
  page: number;
  storageKey: string;
  previewKey: string;
  width: number;
  height: number;
  fileSizeBytes: number;
}

export interface MangaCleanBasePageV1 {
  page: number;
  cleanBaseKey: string;
}

export interface MangaResultManifestV1 {
  version: 1;
  mediaFormat: 'COMIC';
  pages: MangaResultManifestPageV1[];
  cleanBases?: MangaCleanBasePageV1[];
}

// ----------------------------------------------------------------------
// Novel Result Manifest (Version 1)
// ----------------------------------------------------------------------

export interface NovelResultQaIssueV1 {
  severity: string;
  ruleId: string;
  message: string;
}

export interface NovelResultQaV1 {
  passed: boolean;
  score: number;
  fingerprintMatch: boolean;
  issuesCount: number;
  issues?: NovelResultQaIssueV1[];
}

export interface NovelResultAssetV1 {
  storageKey: string;
  contentType?: string;
}

export interface NovelResultMetricsV1 {
  totalBlocks?: number;
  totalBatches?: number;
  glossaryHits?: number;
  promptVersion?: string;
}

export interface NovelResultManifestV1 {
  version: 1;
  mediaFormat: 'NOVEL';
  htmlKey: string;
  segmentCount: number;
  charCount: number;
  title?: string;
  language?: string;
  assets?: NovelResultAssetV1[];
  qa: NovelResultQaV1;
  metrics?: NovelResultMetricsV1;
}

// ----------------------------------------------------------------------
// Discriminated Union for Result Manifest
// ----------------------------------------------------------------------

export type TranslationResultManifestV1 =
  | MangaResultManifestV1
  | NovelResultManifestV1;

// ----------------------------------------------------------------------
// Auxiliary Manifests (Review Source, Clean Base, Input)
// ----------------------------------------------------------------------

export interface MangaReviewSourcePageV1 {
  page: number;
  storageKey: string;
  width?: number;
  height?: number;
}

export interface MangaReviewSourceManifestV1 {
  version: 1;
  pages: MangaReviewSourcePageV1[];
}

export interface MangaCleanBaseManifestV1 {
  version: 1;
  pages: MangaCleanBasePageV1[];
}

export interface TranslationGlossaryTermSnapshot {
  sourceTerm: string;
  targetTerm: string;
  category: string;
}

export interface TranslationInputManifestV1 {
  version?: 1;
  sourceLang: string;
  targetLang: string;
  provider: string;
  model: string;
  promptVersion: string;
  glossarySnapshot: TranslationGlossaryTermSnapshot[];
  glossaryHash: string;
  externalConsent: boolean;
}

// ----------------------------------------------------------------------
// Validation Result Interface
// ----------------------------------------------------------------------

export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

// ----------------------------------------------------------------------
// Runtime Validators
// ----------------------------------------------------------------------

export function validateMangaResultManifestV1(
  data: unknown,
): ValidationResult<MangaResultManifestV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Manifest data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  // Check version (Fail-closed on unknown versions)
  if (obj.version !== undefined && obj.version !== 1) {
    return {
      valid: false,
      errors: [`UNKNOWN_MANIFEST_VERSION: Expected version 1, got ${obj.version}`],
    };
  }

  // Check mediaFormat if present
  if (obj.mediaFormat !== undefined && obj.mediaFormat !== 'COMIC') {
    errors.push(`mediaFormat must be 'COMIC', got '${obj.mediaFormat}'`);
  }

  // Validate pages array
  if (!Array.isArray(obj.pages)) {
    errors.push('pages must be an array');
  } else if (obj.pages.length === 0) {
    errors.push('pages array must not be empty');
  }

  const validatedPages: MangaResultManifestPageV1[] = [];

  if (Array.isArray(obj.pages)) {
    obj.pages.forEach((p: any, idx: number) => {
      if (!p || typeof p !== 'object') {
        errors.push(`pages[${idx}] must be an object`);
        return;
      }

      if (typeof p.page !== 'number' || !Number.isInteger(p.page) || p.page < 1) {
        errors.push(`pages[${idx}].page must be an integer >= 1`);
      }

      if (typeof p.storageKey !== 'string' || p.storageKey.trim() === '') {
        errors.push(`pages[${idx}].storageKey must be a non-empty string`);
      }

      if (typeof p.previewKey !== 'string' || p.previewKey.trim() === '') {
        errors.push(`pages[${idx}].previewKey must be a non-empty string`);
      }

      if (typeof p.width !== 'number' || !Number.isInteger(p.width) || p.width < 1) {
        errors.push(`pages[${idx}].width must be a positive integer`);
      }

      if (typeof p.height !== 'number' || !Number.isInteger(p.height) || p.height < 1) {
        errors.push(`pages[${idx}].height must be a positive integer`);
      }

      // Backward compatibility: map fileSize -> fileSizeBytes
      let fileSizeBytes = p.fileSizeBytes;
      if (fileSizeBytes === undefined && typeof p.fileSize === 'number') {
        fileSizeBytes = p.fileSize;
      }

      if (typeof fileSizeBytes !== 'number' || fileSizeBytes < 0) {
        errors.push(`pages[${idx}].fileSizeBytes must be a non-negative number`);
      }

      if (errors.length === 0) {
        validatedPages.push({
          page: p.page,
          storageKey: p.storageKey,
          previewKey: p.previewKey,
          width: p.width,
          height: p.height,
          fileSizeBytes,
        });
      }
    });
  }

  // Validate cleanBases if present
  let validatedCleanBases: MangaCleanBasePageV1[] | undefined;
  if (obj.cleanBases !== undefined) {
    if (!Array.isArray(obj.cleanBases)) {
      errors.push('cleanBases must be an array if provided');
    } else {
      validatedCleanBases = [];
      obj.cleanBases.forEach((cb: any, idx: number) => {
        if (!cb || typeof cb !== 'object') {
          errors.push(`cleanBases[${idx}] must be an object`);
          return;
        }
        if (typeof cb.page !== 'number' || !Number.isInteger(cb.page) || cb.page < 1) {
          errors.push(`cleanBases[${idx}].page must be an integer >= 1`);
        }
        if (typeof cb.cleanBaseKey !== 'string' || cb.cleanBaseKey.trim() === '') {
          errors.push(`cleanBases[${idx}].cleanBaseKey must be a non-empty string`);
        }
        if (errors.length === 0) {
          validatedCleanBases!.push({
            page: cb.page,
            cleanBaseKey: cb.cleanBaseKey,
          });
        }
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      mediaFormat: 'COMIC',
      pages: validatedPages,
      ...(validatedCleanBases ? { cleanBases: validatedCleanBases } : {}),
    },
  };
}

export function validateNovelResultManifestV1(
  data: unknown,
): ValidationResult<NovelResultManifestV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Manifest data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  // Check version (Fail-closed on unknown versions)
  if (obj.version !== undefined && obj.version !== 1) {
    return {
      valid: false,
      errors: [`UNKNOWN_MANIFEST_VERSION: Expected version 1, got ${obj.version}`],
    };
  }

  // Check mediaFormat
  if (obj.mediaFormat !== undefined && obj.mediaFormat !== 'NOVEL') {
    errors.push(`mediaFormat must be 'NOVEL', got '${obj.mediaFormat}'`);
  }

  // Check htmlKey
  if (typeof obj.htmlKey !== 'string' || obj.htmlKey.trim() === '') {
    errors.push('htmlKey must be a non-empty string');
  }

  // Check segmentCount
  if (
    typeof obj.segmentCount !== 'number' ||
    !Number.isInteger(obj.segmentCount) ||
    obj.segmentCount < 0
  ) {
    errors.push('segmentCount must be a non-negative integer');
  }

  // Check charCount
  if (
    typeof obj.charCount !== 'number' ||
    !Number.isInteger(obj.charCount) ||
    obj.charCount < 0
  ) {
    errors.push('charCount must be a non-negative integer');
  }

  // Check QA
  let validatedQa: NovelResultQaV1 | undefined;
  if (!obj.qa || typeof obj.qa !== 'object' || Array.isArray(obj.qa)) {
    errors.push('qa must be an object');
  } else {
    if (typeof obj.qa.passed !== 'boolean') {
      errors.push('qa.passed must be a boolean');
    }
    if (obj.qa.score !== undefined && typeof obj.qa.score !== 'number') {
      errors.push('qa.score must be a number');
    }
    if (typeof obj.qa.fingerprintMatch !== 'boolean') {
      errors.push('qa.fingerprintMatch must be a boolean');
    }
    if (obj.qa.issuesCount !== undefined && typeof obj.qa.issuesCount !== 'number') {
      errors.push('qa.issuesCount must be a number');
    }
    if (obj.qa.issues !== undefined && !Array.isArray(obj.qa.issues)) {
      errors.push('qa.issues must be an array if provided');
    }

    if (errors.length === 0) {
      validatedQa = {
        passed: obj.qa.passed,
        score:
          typeof obj.qa.score === 'number'
            ? obj.qa.score
            : obj.qa.passed
            ? 1.0
            : 0.0,
        fingerprintMatch: obj.qa.fingerprintMatch,
        issuesCount:
          typeof obj.qa.issuesCount === 'number'
            ? obj.qa.issuesCount
            : obj.qa.issues?.length ?? 0,
        issues: obj.qa.issues,
      };
    }
  }

  // Check assets if present
  if (obj.assets !== undefined && !Array.isArray(obj.assets)) {
    errors.push('assets must be an array if provided');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      mediaFormat: 'NOVEL',
      htmlKey: obj.htmlKey,
      segmentCount: obj.segmentCount,
      charCount: obj.charCount,
      title: obj.title,
      language: obj.language,
      assets: obj.assets,
      qa: validatedQa!,
      metrics: obj.metrics,
    },
  };
}

export function validateTranslationResultManifest(
  data: unknown,
  mediaFormat: 'COMIC' | 'NOVEL',
): ValidationResult<TranslationResultManifestV1> {
  if (mediaFormat === 'COMIC') {
    return validateMangaResultManifestV1(data);
  } else if (mediaFormat === 'NOVEL') {
    return validateNovelResultManifestV1(data);
  } else {
    return {
      valid: false,
      errors: [`Unsupported media format: ${mediaFormat}. Must be 'COMIC' or 'NOVEL'`],
    };
  }
}
