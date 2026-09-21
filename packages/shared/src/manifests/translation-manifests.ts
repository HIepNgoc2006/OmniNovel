export enum NovelBlockType {
  HEADING = 'HEADING',
  DIALOGUE = 'DIALOGUE',
  NARRATION = 'NARRATION',
  BLOCKQUOTE = 'BLOCKQUOTE',
}

export const JS_MAX_SAFE_INTEGER = 9007199254740991; // 2^53 - 1

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
  sourceReview?: MangaReviewSourceManifestV1;
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
  fileSizeBytes: number;
}

export interface NovelResultMetricsV1 {
  totalBlocks?: number;
  totalBatches?: number;
  glossaryHits?: number;
  promptVersion?: string;
}

// ----------------------------------------------------------------------
// Novel Structure Snapshot Types (Version 1) (#163)
// ----------------------------------------------------------------------

export type NovelInlineNodeSnapshotV1 =
  | { type: 'TEXT'; text: string }
  | { type: 'RUBY'; baseText: string; rubyText: string; parenthesisText?: string }
  | { type: 'STRONG'; children: NovelInlineNodeSnapshotV1[] }
  | { type: 'EMPHASIS'; children: NovelInlineNodeSnapshotV1[] }
  | { type: 'INLINE_IMAGE'; src: string; alt?: string };

export type NovelBlockNodeSnapshotV1 =
  | { type: 'HEADING'; level: number; children: NovelInlineNodeSnapshotV1[] }
  | { type: 'PARAGRAPH'; children: NovelInlineNodeSnapshotV1[] }
  | { type: 'BLOCKQUOTE'; children: NovelBlockNodeSnapshotV1[] }
  | { type: 'ILLUSTRATION'; src: string; alt?: string; caption?: string; width?: number; height?: number }
  | { type: 'DIVIDER' };

export interface CanonicalNovelDocumentSnapshotV1 {
  title?: string;
  language: string;
  format: string;
  metadata?: Record<string, any>;
  blocks: NovelBlockNodeSnapshotV1[];
}

export interface NovelSegmentSnapshotV1 {
  anchorBlockId: string;
  sortOrder: number;
  blockType: NovelBlockType;
}

export interface NovelAnchorMapEntrySnapshotV1 {
  anchorId: string;
  tagType: 'S' | 'E' | 'R' | 'IMG';
  rubyText?: string;
  parenthesisText?: string;
  imageSrc?: string;
  imageAlt?: string;
}

export interface NovelStructureSnapshotV1 {
  version: 1;
  segmenterVersion: string;
  sourceStructureFingerprint: string; // sha256:<64hex>
  document: CanonicalNovelDocumentSnapshotV1;
  segments: NovelSegmentSnapshotV1[];
  anchorMaps: Record<string, NovelAnchorMapEntrySnapshotV1[]>;
}

export interface NovelStructureSnapshotReferenceV1 {
  version: 1;
  storageKey: string;
  sha256: string;
  segmenterVersion: string;
  sourceStructureFingerprint: string;
}

export interface NovelResultManifestV1 {
  version: 1;
  mediaFormat: 'NOVEL';
  htmlKey: string;
  segmentCount: number;
  charCount: number;
  htmlFileSizeBytes: number;
  title?: string;
  language?: string;
  assets?: NovelResultAssetV1[];
  qa: NovelResultQaV1;
  metrics?: NovelResultMetricsV1;
  /**
   * Pinned reference to versioned immutable Novel structure snapshot (#163).
   * Note: Optional at parser level for backward-compatibility with pre-#163 manifests,
   * but strictly required by Core gate on all new READY_FOR_REVIEW callbacks.
   */
  structureSnapshot?: NovelStructureSnapshotReferenceV1;
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

export interface TranslationExternalConsentSnapshotV1 {
  consented: boolean;
  consentedAt: string | null;
  provider: string;
}

export interface TranslationInputManifestV1 {
  version: 1;
  sourceLang: string;
  targetLang: string;
  provider: string;
  model: string;
  promptVersion: string;
  glossarySnapshot: TranslationGlossaryTermSnapshot[];
  glossaryHash: string;
  externalConsent: TranslationExternalConsentSnapshotV1;
}

// ----------------------------------------------------------------------
// Validation Result Interface & Internal Helpers
// ----------------------------------------------------------------------

export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

function assertNoUnknownKeys(
  obj: Record<string, any>,
  allowedKeys: string[],
  context: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push(`UNKNOWN_FIELD: Unexpected field '${key}' in ${context}`);
    }
  }
}

function isSafePositiveInteger(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    val > 0 &&
    val <= JS_MAX_SAFE_INTEGER
  );
}

function isSafeNonNegativeInteger(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    val >= 0 &&
    val <= JS_MAX_SAFE_INTEGER
  );
}

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidRfc3339WithTimezone(val: unknown): boolean {
  if (typeof val !== 'string') return false;
  if (!RFC3339_REGEX.test(val)) return false;
  if (Number.isNaN(Date.parse(val))) return false;
  const [datePart] = val.split('T');
  const [yearStr, monthStr, dayStr] = datePart.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() + 1 === month &&
    check.getUTCDate() === day
  );
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

  // Allowed keys checking at root
  assertNoUnknownKeys(
    obj,
    ['version', 'mediaFormat', 'pages', 'cleanBases', 'sourceReview'],
    'MangaResultManifestV1',
    errors,
  );

  // Strict version check (no default, must be 1)
  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  // Strict mediaFormat check (no default, must be COMIC)
  if (obj.mediaFormat !== 'COMIC') {
    errors.push(`mediaFormat must be 'COMIC', got '${obj.mediaFormat}'`);
  }

  // Validate pages array
  if (!Array.isArray(obj.pages)) {
    errors.push('pages must be an array');
  } else if (obj.pages.length === 0) {
    errors.push('pages array must not be empty');
  }

  const validatedPages: MangaResultManifestPageV1[] = [];
  const seenPages = new Set<number>();

  if (Array.isArray(obj.pages)) {
    obj.pages.forEach((p: any, idx: number) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`pages[${idx}] must be an object`);
        return;
      }

      assertNoUnknownKeys(
        p,
        [
          'page',
          'storageKey',
          'previewKey',
          'width',
          'height',
          'fileSizeBytes',
          'fileSize',
        ],
        `pages[${idx}]`,
        errors,
      );

      if (!isSafePositiveInteger(p.page)) {
        errors.push(`pages[${idx}].page must be an integer >= 1`);
      } else {
        if (seenPages.has(p.page)) {
          errors.push(`DUPLICATE_PAGE_NUMBER: Duplicate page number ${p.page}`);
        }
        seenPages.add(p.page);
      }

      if (typeof p.storageKey !== 'string' || p.storageKey.trim() === '') {
        errors.push(`pages[${idx}].storageKey must be a non-empty string`);
      }

      if (typeof p.previewKey !== 'string' || p.previewKey.trim() === '') {
        errors.push(`pages[${idx}].previewKey must be a non-empty string`);
      }

      if (!isSafePositiveInteger(p.width)) {
        errors.push(`pages[${idx}].width must be a positive integer`);
      }

      if (!isSafePositiveInteger(p.height)) {
        errors.push(`pages[${idx}].height must be a positive integer`);
      }

      // Legacy fileSize alias & conflict detection
      let fileSizeBytes = p.fileSizeBytes;
      if (p.fileSize !== undefined && p.fileSizeBytes !== undefined) {
        if (p.fileSize !== p.fileSizeBytes) {
          errors.push(
            `CONFLICTING_LEGACY_FILE_SIZE: Conflicting fileSize (${p.fileSize}) and fileSizeBytes (${p.fileSizeBytes}) in pages[${idx}]`,
          );
        }
      } else if (p.fileSizeBytes === undefined && p.fileSize !== undefined) {
        fileSizeBytes = p.fileSize;
      }

      if (!isSafePositiveInteger(fileSizeBytes)) {
        errors.push(
          `pages[${idx}].fileSizeBytes must be a positive safe integer`,
        );
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

    // Sequence check: pages must be a complete 1..N sequence where N = pages.length
    if (errors.length === 0) {
      for (let i = 1; i <= obj.pages.length; i++) {
        if (!seenPages.has(i)) {
          errors.push(
            `NON_CONTIGUOUS_PAGES: Missing page ${i} in 1..${obj.pages.length} sequence`,
          );
          break;
        }
      }
    }
  }

  // Sort canonical validatedPages ascending by page number
  validatedPages.sort((a, b) => a.page - b.page);

  // Validate cleanBases if present
  let validatedCleanBases: MangaCleanBasePageV1[] | undefined;
  if (obj.cleanBases !== undefined) {
    if (!Array.isArray(obj.cleanBases)) {
      errors.push('cleanBases must be an array if provided');
    } else {
      validatedCleanBases = [];
      const seenCleanBasePages = new Set<number>();
      obj.cleanBases.forEach((cb: any, idx: number) => {
        if (!cb || typeof cb !== 'object' || Array.isArray(cb)) {
          errors.push(`cleanBases[${idx}] must be an object`);
          return;
        }

        assertNoUnknownKeys(
          cb,
          ['page', 'cleanBaseKey'],
          `cleanBases[${idx}]`,
          errors,
        );

        if (!isSafePositiveInteger(cb.page)) {
          errors.push(`cleanBases[${idx}].page must be an integer >= 1`);
        } else {
          if (seenCleanBasePages.has(cb.page)) {
            errors.push(
              `DUPLICATE_CLEAN_BASE_PAGE_NUMBER: Duplicate page number ${cb.page} in cleanBases`,
            );
          }
          seenCleanBasePages.add(cb.page);
        }

        if (typeof cb.cleanBaseKey !== 'string' || cb.cleanBaseKey.trim() === '') {
          errors.push(
            `cleanBases[${idx}].cleanBaseKey must be a non-empty string`,
          );
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

  // Validate sourceReview if present (#159)
  let validatedSourceReview: MangaReviewSourceManifestV1 | undefined;
  if (obj.sourceReview !== undefined) {
    const sourceReviewResult = validateMangaReviewSourceManifestV1(obj.sourceReview);
    if (!sourceReviewResult.valid) {
      errors.push(...sourceReviewResult.errors);
    } else {
      validatedSourceReview = sourceReviewResult.value;
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
      ...(validatedSourceReview ? { sourceReview: validatedSourceReview } : {}),
    },
  };
}

export interface ValidateNovelQaOptions {
  requirePassedTrue?: boolean;
  prefix?: string;
}

export function validateNovelQaV1(
  qa: unknown,
  options: ValidateNovelQaOptions = {},
): ValidationResult<NovelResultQaV1> {
  const errors: string[] = [];
  const prefix = options.prefix ?? 'qa';

  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) {
    return { valid: false, errors: [`${prefix} must be an object`] };
  }

  const obj = qa as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['passed', 'score', 'fingerprintMatch', 'issuesCount', 'issues'],
    'NovelResultQaV1',
    errors,
  );

  if (typeof obj.passed !== 'boolean') {
    errors.push(`${prefix}.passed must be a boolean`);
  } else if (options.requirePassedTrue && obj.passed !== true) {
    errors.push(`${prefix}.passed must be true for completed materialization`);
  }

  if (
    typeof obj.score !== 'number' ||
    Number.isNaN(obj.score) ||
    obj.score < 0.0 ||
    obj.score > 1.0
  ) {
    errors.push(`${prefix}.score must be a number between 0.0 and 1.0`);
  }

  if (typeof obj.fingerprintMatch !== 'boolean') {
    errors.push(`${prefix}.fingerprintMatch must be a boolean`);
  }

  if (!isSafeNonNegativeInteger(obj.issuesCount)) {
    errors.push(`${prefix}.issuesCount must be a non-negative integer`);
  }

  let validatedIssues: NovelResultQaIssueV1[] | undefined;
  if (obj.issues !== undefined) {
    if (!Array.isArray(obj.issues)) {
      errors.push(`${prefix}.issues must be an array if provided`);
    } else {
      validatedIssues = [];
      obj.issues.forEach((iss: any, idx: number) => {
        const issuePrefix = `${prefix}.issues[${idx}]`;
        if (!iss || typeof iss !== 'object' || Array.isArray(iss)) {
          errors.push(`${issuePrefix} must be an object`);
          return;
        }

        assertNoUnknownKeys(
          iss,
          ['severity', 'ruleId', 'message'],
          issuePrefix,
          errors,
        );

        if (typeof iss.severity !== 'string') {
          errors.push(`${issuePrefix}.severity must be a string`);
        }
        if (typeof iss.ruleId !== 'string') {
          errors.push(`${issuePrefix}.ruleId must be a string`);
        }
        if (typeof iss.message !== 'string') {
          errors.push(`${issuePrefix}.message must be a string`);
        }

        if (
          typeof iss.severity === 'string' &&
          typeof iss.ruleId === 'string' &&
          typeof iss.message === 'string'
        ) {
          validatedIssues!.push({
            severity: iss.severity,
            ruleId: iss.ruleId,
            message: iss.message,
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
      passed: Boolean(obj.passed),
      score: Number(obj.score),
      fingerprintMatch: Boolean(obj.fingerprintMatch),
      issuesCount: Number(obj.issuesCount),
      ...(validatedIssues !== undefined ? { issues: validatedIssues } : {}),
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

  assertNoUnknownKeys(
    obj,
    [
      'version',
      'mediaFormat',
      'htmlKey',
      'segmentCount',
      'charCount',
      'htmlFileSizeBytes',
      'title',
      'language',
      'assets',
      'qa',
      'metrics',
      'structureSnapshot',
    ],
    'NovelResultManifestV1',
    errors,
  );

  // Strict version check (no default, must be 1)
  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  // Strict mediaFormat check (no default, must be NOVEL)
  if (obj.mediaFormat !== 'NOVEL') {
    errors.push(`mediaFormat must be 'NOVEL', got '${obj.mediaFormat}'`);
  }

  // Check htmlKey
  if (typeof obj.htmlKey !== 'string' || obj.htmlKey.trim() === '') {
    errors.push('htmlKey must be a non-empty string');
  }

  // Check segmentCount
  if (!isSafeNonNegativeInteger(obj.segmentCount)) {
    errors.push('segmentCount must be a non-negative integer');
  }

  // Check charCount
  if (!isSafeNonNegativeInteger(obj.charCount)) {
    errors.push('charCount must be a non-negative integer');
  }

  // Check htmlFileSizeBytes (required)
  if (!isSafePositiveInteger(obj.htmlFileSizeBytes)) {
    errors.push('htmlFileSizeBytes must be a positive safe integer');
  }

  // Check optional title and language
  if (obj.title !== undefined && typeof obj.title !== 'string') {
    errors.push('title must be a string if provided');
  }
  if (obj.language !== undefined && typeof obj.language !== 'string') {
    errors.push('language must be a string if provided');
  }

  // Check QA
  let validatedQa: NovelResultQaV1 | undefined;
  const qaValidation = validateNovelQaV1(obj.qa, { prefix: 'qa' });
  if (!qaValidation.valid) {
    errors.push(...qaValidation.errors);
  } else {
    validatedQa = qaValidation.value;
  }

  // Check assets if present
  let validatedAssets: NovelResultAssetV1[] | undefined;
  if (obj.assets !== undefined) {
    if (!Array.isArray(obj.assets)) {
      errors.push('assets must be an array if provided');
    } else {
      validatedAssets = [];
      obj.assets.forEach((ast: any, idx: number) => {
        if (!ast || typeof ast !== 'object' || Array.isArray(ast)) {
          errors.push(`assets[${idx}] must be an object`);
          return;
        }

        assertNoUnknownKeys(
          ast,
          ['storageKey', 'contentType', 'fileSizeBytes', 'fileSize'],
          `assets[${idx}]`,
          errors,
        );

        if (typeof ast.storageKey !== 'string' || ast.storageKey.trim() === '') {
          errors.push(`assets[${idx}].storageKey must be a non-empty string`);
        }

        if (
          ast.contentType !== undefined &&
          typeof ast.contentType !== 'string'
        ) {
          errors.push(`assets[${idx}].contentType must be a string`);
        }

        let fileSizeBytes = ast.fileSizeBytes;
        if (ast.fileSize !== undefined && ast.fileSizeBytes !== undefined) {
          if (ast.fileSize !== ast.fileSizeBytes) {
            errors.push(
              `CONFLICTING_LEGACY_FILE_SIZE: Conflicting fileSize and fileSizeBytes in assets[${idx}]`,
            );
          }
        } else if (ast.fileSizeBytes === undefined && ast.fileSize !== undefined) {
          fileSizeBytes = ast.fileSize;
        }

        if (!isSafePositiveInteger(fileSizeBytes)) {
          errors.push(
            `assets[${idx}].fileSizeBytes must be a positive safe integer`,
          );
        }

        if (errors.length === 0) {
          validatedAssets!.push({
            storageKey: ast.storageKey,
            ...(ast.contentType ? { contentType: ast.contentType } : {}),
            fileSizeBytes,
          });
        }
      });
    }
  }

  // Check metrics if present
  let validatedMetrics: NovelResultMetricsV1 | undefined;
  if (obj.metrics !== undefined) {
    if (
      !obj.metrics ||
      typeof obj.metrics !== 'object' ||
      Array.isArray(obj.metrics)
    ) {
      errors.push('metrics must be an object if provided');
    } else {
      assertNoUnknownKeys(
        obj.metrics,
        ['totalBlocks', 'totalBatches', 'glossaryHits', 'promptVersion'],
        'NovelResultMetricsV1',
        errors,
      );
      if (
        obj.metrics.totalBlocks !== undefined &&
        !isSafeNonNegativeInteger(obj.metrics.totalBlocks)
      ) {
        errors.push('metrics.totalBlocks must be a non-negative integer');
      }
      if (
        obj.metrics.totalBatches !== undefined &&
        !isSafeNonNegativeInteger(obj.metrics.totalBatches)
      ) {
        errors.push('metrics.totalBatches must be a non-negative integer');
      }
      if (
        obj.metrics.glossaryHits !== undefined &&
        !isSafeNonNegativeInteger(obj.metrics.glossaryHits)
      ) {
        errors.push('metrics.glossaryHits must be a non-negative integer');
      }
      if (
        obj.metrics.promptVersion !== undefined &&
        typeof obj.metrics.promptVersion !== 'string'
      ) {
        errors.push('metrics.promptVersion must be a string');
      }

      if (errors.length === 0) {
        validatedMetrics = {
          ...(obj.metrics.totalBlocks !== undefined
            ? { totalBlocks: obj.metrics.totalBlocks }
            : {}),
          ...(obj.metrics.totalBatches !== undefined
            ? { totalBatches: obj.metrics.totalBatches }
            : {}),
          ...(obj.metrics.glossaryHits !== undefined
            ? { glossaryHits: obj.metrics.glossaryHits }
            : {}),
          ...(obj.metrics.promptVersion !== undefined
            ? { promptVersion: obj.metrics.promptVersion }
            : {}),
        };
      }
    }
  }

  // Check structureSnapshot if present (#163)
  let validatedStructureSnapshot: NovelStructureSnapshotReferenceV1 | undefined;
  if (obj.structureSnapshot !== undefined) {
    const snapValidation = validateNovelStructureSnapshotReferenceV1(
      obj.structureSnapshot,
      { prefix: 'structureSnapshot' },
    );
    if (!snapValidation.valid) {
      errors.push(...snapValidation.errors);
    } else {
      validatedStructureSnapshot = snapValidation.value;
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
      mediaFormat: 'NOVEL',
      htmlKey: obj.htmlKey,
      segmentCount: obj.segmentCount,
      charCount: obj.charCount,
      htmlFileSizeBytes: obj.htmlFileSizeBytes,
      ...(obj.title ? { title: obj.title } : {}),
      ...(obj.language ? { language: obj.language } : {}),
      ...(validatedAssets ? { assets: validatedAssets } : {}),
      qa: validatedQa!,
      ...(validatedMetrics ? { metrics: validatedMetrics } : {}),
      ...(validatedStructureSnapshot
        ? { structureSnapshot: validatedStructureSnapshot }
        : {}),
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
      errors: [
        `Unsupported media format: ${mediaFormat}. Must be 'COMIC' or 'NOVEL'`,
      ],
    };
  }
}

export function validateTranslationInputManifestV1(
  data: unknown,
): ValidationResult<TranslationInputManifestV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      errors: ['Input manifest data must be a non-null object'],
    };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    [
      'version',
      'sourceLang',
      'targetLang',
      'provider',
      'model',
      'promptVersion',
      'glossarySnapshot',
      'glossaryHash',
      'externalConsent',
    ],
    'TranslationInputManifestV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  if (typeof obj.sourceLang !== 'string' || obj.sourceLang.trim() === '') {
    errors.push('sourceLang must be a non-empty string');
  }
  if (typeof obj.targetLang !== 'string' || obj.targetLang.trim() === '') {
    errors.push('targetLang must be a non-empty string');
  }
  if (typeof obj.provider !== 'string' || obj.provider.trim() === '') {
    errors.push('provider must be a non-empty string');
  }
  if (typeof obj.model !== 'string' || obj.model.trim() === '') {
    errors.push('model must be a non-empty string');
  }
  if (typeof obj.promptVersion !== 'string' || obj.promptVersion.trim() === '') {
    errors.push('promptVersion must be a non-empty string');
  }

  // Check glossaryHash: strict sha256 format
  if (
    typeof obj.glossaryHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(obj.glossaryHash)
  ) {
    errors.push(
      `glossaryHash must match format /^sha256:[0-9a-f]{64}$/, got '${obj.glossaryHash}'`,
    );
  }

  // Check glossarySnapshot
  const validatedGlossary: TranslationGlossaryTermSnapshot[] = [];
  if (!Array.isArray(obj.glossarySnapshot)) {
    errors.push('glossarySnapshot must be an array');
  } else {
    obj.glossarySnapshot.forEach((term: any, idx: number) => {
      if (!term || typeof term !== 'object' || Array.isArray(term)) {
        errors.push(`glossarySnapshot[${idx}] must be an object`);
        return;
      }
      assertNoUnknownKeys(
        term,
        ['sourceTerm', 'targetTerm', 'category'],
        `glossarySnapshot[${idx}]`,
        errors,
      );
      if (typeof term.sourceTerm !== 'string') {
        errors.push(`glossarySnapshot[${idx}].sourceTerm must be a string`);
      }
      if (typeof term.targetTerm !== 'string') {
        errors.push(`glossarySnapshot[${idx}].targetTerm must be a string`);
      }
      if (typeof term.category !== 'string') {
        errors.push(`glossarySnapshot[${idx}].category must be a string`);
      }
      if (errors.length === 0) {
        validatedGlossary.push({
          sourceTerm: term.sourceTerm,
          targetTerm: term.targetTerm,
          category: term.category,
        });
      }
    });
  }

  // Check externalConsent
  let validatedConsent: TranslationExternalConsentSnapshotV1 | undefined;
  if (
    !obj.externalConsent ||
    typeof obj.externalConsent !== 'object' ||
    Array.isArray(obj.externalConsent)
  ) {
    errors.push('externalConsent must be an object');
  } else {
    assertNoUnknownKeys(
      obj.externalConsent,
      ['consented', 'consentedAt', 'provider'],
      'TranslationExternalConsentSnapshotV1',
      errors,
    );

    if (typeof obj.externalConsent.consented !== 'boolean') {
      errors.push('externalConsent.consented must be a boolean');
    }

    if (
      typeof obj.externalConsent.provider !== 'string' ||
      obj.externalConsent.provider !== obj.provider
    ) {
      errors.push(
        `externalConsent.provider ('${obj.externalConsent?.provider}') must match root provider ('${obj.provider}')`,
      );
    }

    if (obj.externalConsent.consented === true) {
      if (!isValidRfc3339WithTimezone(obj.externalConsent.consentedAt)) {
        errors.push(
          'externalConsent.consentedAt must be a valid RFC3339 timestamp string with timezone when consented is true',
        );
      }
    } else if (obj.externalConsent.consented === false) {
      if (obj.externalConsent.consentedAt !== null) {
        errors.push(
          'externalConsent.consentedAt must be null when consented is false',
        );
      }
    }

    if (errors.length === 0) {
      validatedConsent = {
        consented: obj.externalConsent.consented,
        consentedAt: obj.externalConsent.consentedAt,
        provider: obj.externalConsent.provider,
      };
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
      sourceLang: obj.sourceLang,
      targetLang: obj.targetLang,
      provider: obj.provider,
      model: obj.model,
      promptVersion: obj.promptVersion,
      glossarySnapshot: validatedGlossary,
      glossaryHash: obj.glossaryHash,
      externalConsent: validatedConsent!,
    },
  };
}

export function validateMangaReviewSourceManifestV1(
  data: unknown,
): ValidationResult<MangaReviewSourceManifestV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Manifest data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'pages'],
    'MangaReviewSourceManifestV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  if (!Array.isArray(obj.pages)) {
    errors.push('pages must be an array');
  } else if (obj.pages.length === 0) {
    errors.push('pages array must not be empty');
  }

  const validatedPages: MangaReviewSourcePageV1[] = [];
  const seenPages = new Set<number>();
  if (Array.isArray(obj.pages)) {
    obj.pages.forEach((p: any, idx: number) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`pages[${idx}] must be an object`);
        return;
      }
      assertNoUnknownKeys(
        p,
        ['page', 'storageKey', 'width', 'height'],
        `pages[${idx}]`,
        errors,
      );

      if (!isSafePositiveInteger(p.page)) {
        errors.push(`pages[${idx}].page must be an integer >= 1`);
      } else {
        if (seenPages.has(p.page)) {
          errors.push(
            `DUPLICATE_SOURCE_REVIEW_PAGE_NUMBER: Duplicate page number ${p.page} in sourceReview`,
          );
        }
        seenPages.add(p.page);
      }
      if (typeof p.storageKey !== 'string' || p.storageKey.trim() === '') {
        errors.push(`pages[${idx}].storageKey must be a non-empty string`);
      }
      if (p.width !== undefined && !isSafePositiveInteger(p.width)) {
        errors.push(`pages[${idx}].width must be a positive integer`);
      }
      if (p.height !== undefined && !isSafePositiveInteger(p.height)) {
        errors.push(`pages[${idx}].height must be a positive integer`);
      }

      if (errors.length === 0) {
        validatedPages.push({
          page: p.page,
          storageKey: p.storageKey,
          ...(p.width ? { width: p.width } : {}),
          ...(p.height ? { height: p.height } : {}),
        });
      }
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      pages: validatedPages,
    },
  };
}

export function validateMangaCleanBaseManifestV1(
  data: unknown,
): ValidationResult<MangaCleanBaseManifestV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Manifest data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'pages'],
    'MangaCleanBaseManifestV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  if (!Array.isArray(obj.pages)) {
    errors.push('pages must be an array');
  }

  const validatedPages: MangaCleanBasePageV1[] = [];
  if (Array.isArray(obj.pages)) {
    obj.pages.forEach((p: any, idx: number) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`pages[${idx}] must be an object`);
        return;
      }
      assertNoUnknownKeys(
        p,
        ['page', 'cleanBaseKey'],
        `pages[${idx}]`,
        errors,
      );

      if (!isSafePositiveInteger(p.page)) {
        errors.push(`pages[${idx}].page must be an integer >= 1`);
      }
      if (typeof p.cleanBaseKey !== 'string' || p.cleanBaseKey.trim() === '') {
        errors.push(`cleanBaseKey must be a non-empty string`);
      }

      if (errors.length === 0) {
        validatedPages.push({
          page: p.page,
          cleanBaseKey: p.cleanBaseKey,
        });
      }
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      pages: validatedPages,
    },
  };
}

// ----------------------------------------------------------------------
// Novel Structure Snapshot Runtime Validators (#163)
// ----------------------------------------------------------------------

export function validateNovelStructureSnapshotReferenceV1(
  data: unknown,
  options?: { prefix?: string },
): ValidationResult<NovelStructureSnapshotReferenceV1> {
  const prefix = options?.prefix ? `${options.prefix}.` : '';
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      errors: [`${prefix.replace(/\.$/, '') || 'data'} must be a non-null object`],
    };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'storageKey', 'sha256', 'segmenterVersion', 'sourceStructureFingerprint'],
    `${prefix}NovelStructureSnapshotReferenceV1`,
    errors,
  );

  if (obj.version !== 1) {
    errors.push(
      `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
    );
  }

  if (typeof obj.storageKey !== 'string' || obj.storageKey.trim() === '') {
    errors.push(`${prefix}storageKey must be a non-empty string`);
  }

  if (typeof obj.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(obj.sha256)) {
    errors.push(
      `${prefix}sha256 must be a 64-character lowercase hex string`,
    );
  }

  if (typeof obj.segmenterVersion !== 'string' || obj.segmenterVersion.trim() === '') {
    errors.push(`${prefix}segmenterVersion must be a non-empty string`);
  }

  if (
    typeof obj.sourceStructureFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(obj.sourceStructureFingerprint)
  ) {
    errors.push(
      `${prefix}sourceStructureFingerprint must match format 'sha256:<64hex>'`,
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      storageKey: obj.storageKey,
      sha256: obj.sha256,
      segmenterVersion: obj.segmenterVersion,
      sourceStructureFingerprint: obj.sourceStructureFingerprint,
    },
  };
}

function validateNovelInlineNodeSnapshot(
  node: any,
  context: string,
  errors: string[],
): NovelInlineNodeSnapshotV1 | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${context} must be an object`);
    return null;
  }
  if (!['TEXT', 'RUBY', 'STRONG', 'EMPHASIS', 'INLINE_IMAGE'].includes(node.type)) {
    errors.push(`${context}.type must be one of TEXT, RUBY, STRONG, EMPHASIS, INLINE_IMAGE, got '${node.type}'`);
    return null;
  }

  if (node.type === 'TEXT') {
    assertNoUnknownKeys(node, ['type', 'text'], context, errors);
    if (typeof node.text !== 'string') {
      errors.push(`${context}.text must be a string`);
    }
    return { type: 'TEXT', text: node.text ?? '' };
  } else if (node.type === 'RUBY') {
    assertNoUnknownKeys(node, ['type', 'baseText', 'rubyText', 'parenthesisText'], context, errors);
    if (typeof node.baseText !== 'string' || node.baseText.trim() === '') {
      errors.push(`${context}.baseText must be a non-empty string`);
    }
    if (typeof node.rubyText !== 'string' || node.rubyText.trim() === '') {
      errors.push(`${context}.rubyText must be a non-empty string`);
    }
    if (node.parenthesisText !== undefined && typeof node.parenthesisText !== 'string') {
      errors.push(`${context}.parenthesisText must be a string if provided`);
    }
    return {
      type: 'RUBY',
      baseText: node.baseText,
      rubyText: node.rubyText,
      ...(node.parenthesisText !== undefined ? { parenthesisText: node.parenthesisText } : {}),
    };
  } else if (node.type === 'STRONG' || node.type === 'EMPHASIS') {
    assertNoUnknownKeys(node, ['type', 'children'], context, errors);
    if (!Array.isArray(node.children)) {
      errors.push(`${context}.children must be an array of inline nodes`);
      return null;
    }
    const children: NovelInlineNodeSnapshotV1[] = [];
    node.children.forEach((c: any, idx: number) => {
      const validated = validateNovelInlineNodeSnapshot(c, `${context}.children[${idx}]`, errors);
      if (validated) children.push(validated);
    });
    return { type: node.type, children };
  } else if (node.type === 'INLINE_IMAGE') {
    assertNoUnknownKeys(node, ['type', 'src', 'alt'], context, errors);
    if (typeof node.src !== 'string' || node.src.trim() === '') {
      errors.push(`${context}.src must be a non-empty string`);
    }
    if (node.alt !== undefined && typeof node.alt !== 'string') {
      errors.push(`${context}.alt must be a string if provided`);
    }
    return {
      type: 'INLINE_IMAGE',
      src: node.src,
      ...(node.alt !== undefined ? { alt: node.alt } : {}),
    };
  }
  return null;
}

function validateNovelBlockNodeSnapshot(
  block: any,
  context: string,
  errors: string[],
): NovelBlockNodeSnapshotV1 | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    errors.push(`${context} must be an object`);
    return null;
  }
  if (!['HEADING', 'PARAGRAPH', 'BLOCKQUOTE', 'ILLUSTRATION', 'DIVIDER'].includes(block.type)) {
    errors.push(`${context}.type must be one of HEADING, PARAGRAPH, BLOCKQUOTE, ILLUSTRATION, DIVIDER, got '${block.type}'`);
    return null;
  }

  if (block.type === 'HEADING') {
    assertNoUnknownKeys(block, ['type', 'level', 'children'], context, errors);
    if (!Number.isInteger(block.level) || block.level < 1 || block.level > 6) {
      errors.push(`${context}.level must be an integer between 1 and 6`);
    }
    if (!Array.isArray(block.children)) {
      errors.push(`${context}.children must be an array`);
      return null;
    }
    const children: NovelInlineNodeSnapshotV1[] = [];
    block.children.forEach((c: any, idx: number) => {
      const v = validateNovelInlineNodeSnapshot(c, `${context}.children[${idx}]`, errors);
      if (v) children.push(v);
    });
    return { type: 'HEADING', level: block.level, children };
  } else if (block.type === 'PARAGRAPH') {
    assertNoUnknownKeys(block, ['type', 'children'], context, errors);
    if (!Array.isArray(block.children)) {
      errors.push(`${context}.children must be an array`);
      return null;
    }
    const children: NovelInlineNodeSnapshotV1[] = [];
    block.children.forEach((c: any, idx: number) => {
      const v = validateNovelInlineNodeSnapshot(c, `${context}.children[${idx}]`, errors);
      if (v) children.push(v);
    });
    return { type: 'PARAGRAPH', children };
  } else if (block.type === 'BLOCKQUOTE') {
    assertNoUnknownKeys(block, ['type', 'children'], context, errors);
    if (!Array.isArray(block.children)) {
      errors.push(`${context}.children must be an array`);
      return null;
    }
    const children: NovelBlockNodeSnapshotV1[] = [];
    block.children.forEach((c: any, idx: number) => {
      const v = validateNovelBlockNodeSnapshot(c, `${context}.children[${idx}]`, errors);
      if (v) children.push(v);
    });
    return { type: 'BLOCKQUOTE', children };
  } else if (block.type === 'ILLUSTRATION') {
    assertNoUnknownKeys(block, ['type', 'src', 'alt', 'caption', 'width', 'height'], context, errors);
    if (typeof block.src !== 'string' || block.src.trim() === '') {
      errors.push(`${context}.src must be a non-empty string`);
    }
    if (block.alt !== undefined && typeof block.alt !== 'string') {
      errors.push(`${context}.alt must be a string if provided`);
    }
    if (block.caption !== undefined && typeof block.caption !== 'string') {
      errors.push(`${context}.caption must be a string if provided`);
    }
    if (block.width !== undefined && !isSafePositiveInteger(block.width)) {
      errors.push(`${context}.width must be a positive safe integer if provided`);
    }
    if (block.height !== undefined && !isSafePositiveInteger(block.height)) {
      errors.push(`${context}.height must be a positive safe integer if provided`);
    }
    return {
      type: 'ILLUSTRATION',
      src: block.src,
      ...(block.alt !== undefined ? { alt: block.alt } : {}),
      ...(block.caption !== undefined ? { caption: block.caption } : {}),
      ...(block.width !== undefined ? { width: block.width } : {}),
      ...(block.height !== undefined ? { height: block.height } : {}),
    };
  } else if (block.type === 'DIVIDER') {
    assertNoUnknownKeys(block, ['type'], context, errors);
    return { type: 'DIVIDER' };
  }
  return null;
}

export function validateNovelStructureSnapshotV1(
  data: unknown,
): ValidationResult<NovelStructureSnapshotV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Manifest data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'segmenterVersion', 'sourceStructureFingerprint', 'document', 'segments', 'anchorMaps'],
    'NovelStructureSnapshotV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [
        `MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`,
      ],
    };
  }

  if (typeof obj.segmenterVersion !== 'string' || obj.segmenterVersion.trim() === '') {
    errors.push('segmenterVersion must be a non-empty string');
  }

  if (
    typeof obj.sourceStructureFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(obj.sourceStructureFingerprint)
  ) {
    errors.push("sourceStructureFingerprint must match format 'sha256:<64hex>'");
  }

  // Validate document
  let validatedDocument: CanonicalNovelDocumentSnapshotV1 | undefined;
  if (!obj.document || typeof obj.document !== 'object' || Array.isArray(obj.document)) {
    errors.push('document must be a non-null object');
  } else {
    assertNoUnknownKeys(
      obj.document,
      ['title', 'language', 'format', 'metadata', 'blocks'],
      'document',
      errors,
    );

    if (obj.document.title !== undefined && typeof obj.document.title !== 'string') {
      errors.push('document.title must be a string if provided');
    }
    if (typeof obj.document.language !== 'string' || obj.document.language.trim() === '') {
      errors.push('document.language must be a non-empty string');
    }
    if (typeof obj.document.format !== 'string' || obj.document.format.trim() === '') {
      errors.push('document.format must be a non-empty string');
    }
    if (
      obj.document.metadata !== undefined &&
      (typeof obj.document.metadata !== 'object' || obj.document.metadata === null || Array.isArray(obj.document.metadata))
    ) {
      errors.push('document.metadata must be an object if provided');
    }

    if (!Array.isArray(obj.document.blocks)) {
      errors.push('document.blocks must be an array');
    } else {
      const blocks: NovelBlockNodeSnapshotV1[] = [];
      obj.document.blocks.forEach((b: any, idx: number) => {
        const v = validateNovelBlockNodeSnapshot(b, `document.blocks[${idx}]`, errors);
        if (v) blocks.push(v);
      });
      validatedDocument = {
        ...(obj.document.title !== undefined ? { title: obj.document.title } : {}),
        language: obj.document.language ?? 'ja',
        format: obj.document.format ?? 'html',
        ...(obj.document.metadata !== undefined ? { metadata: obj.document.metadata } : {}),
        blocks,
      };
    }
  }

  // Validate segments
  const validatedSegments: NovelSegmentSnapshotV1[] = [];
  if (!Array.isArray(obj.segments) || obj.segments.length === 0) {
    errors.push('segments must be a non-empty array');
  } else {
    const seenBlockIds = new Set<string>();
    const seenSortOrders = new Set<number>();

    obj.segments.forEach((seg: any, idx: number) => {
      if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
        errors.push(`segments[${idx}] must be an object`);
        return;
      }
      assertNoUnknownKeys(
        seg,
        ['anchorBlockId', 'sortOrder', 'blockType'],
        `segments[${idx}]`,
        errors,
      );

      if (typeof seg.anchorBlockId !== 'string' || seg.anchorBlockId.trim() === '') {
        errors.push(`segments[${idx}].anchorBlockId must be a non-empty string`);
      } else {
        if (seenBlockIds.has(seg.anchorBlockId)) {
          errors.push(`Duplicate anchorBlockId in segments: '${seg.anchorBlockId}'`);
        }
        seenBlockIds.add(seg.anchorBlockId);
      }

      if (!isSafePositiveInteger(seg.sortOrder)) {
        errors.push(`segments[${idx}].sortOrder must be a positive integer >= 1`);
      } else {
        if (seenSortOrders.has(seg.sortOrder)) {
          errors.push(`Duplicate sortOrder in segments: ${seg.sortOrder}`);
        }
        seenSortOrders.add(seg.sortOrder);
      }

      if (!Object.values(NovelBlockType).includes(seg.blockType)) {
        errors.push(
          `segments[${idx}].blockType must be one of ${Object.values(NovelBlockType).join(', ')}, got '${seg.blockType}'`,
        );
      }

      if (errors.length === 0) {
        validatedSegments.push({
          anchorBlockId: seg.anchorBlockId,
          sortOrder: seg.sortOrder,
          blockType: seg.blockType,
        });
      }
    });

    // Check contiguous sortOrder 1..n
    const n = obj.segments.length;
    for (let order = 1; order <= n; order++) {
      if (!seenSortOrders.has(order)) {
        errors.push(`NON_CONTIGUOUS_SEGMENTS: Missing sortOrder ${order} in 1..${n} sequence`);
      }
    }
  }

  // Validate anchorMaps
  const validatedAnchorMaps: Record<string, NovelAnchorMapEntrySnapshotV1[]> = {};
  if (!obj.anchorMaps || typeof obj.anchorMaps !== 'object' || Array.isArray(obj.anchorMaps)) {
    errors.push('anchorMaps must be an object');
  } else {
    const validSegmentIds = new Set(validatedSegments.map((s) => s.anchorBlockId));

    for (const [blockId, entries] of Object.entries(obj.anchorMaps)) {
      if (!validSegmentIds.has(blockId)) {
        errors.push(
          `ANCHOR_MAP_ORPHAN_BLOCK: Anchor map key '${blockId}' does not exist in segments list`,
        );
      }

      if (!Array.isArray(entries)) {
        errors.push(`anchorMaps['${blockId}'] must be an array`);
        continue;
      }

      const seenAnchorIds = new Set<string>();
      const validatedEntries: NovelAnchorMapEntrySnapshotV1[] = [];

      entries.forEach((entry: any, eIdx: number) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`anchorMaps['${blockId}'][${eIdx}] must be an object`);
          return;
        }

        assertNoUnknownKeys(
          entry,
          ['anchorId', 'tagType', 'rubyText', 'parenthesisText', 'imageSrc', 'imageAlt'],
          `anchorMaps['${blockId}'][${eIdx}]`,
          errors,
        );

        if (typeof entry.anchorId !== 'string' || entry.anchorId.trim() === '') {
          errors.push(`anchorMaps['${blockId}'][${eIdx}].anchorId must be a non-empty string`);
        } else {
          if (seenAnchorIds.has(entry.anchorId)) {
            errors.push(
              `Duplicate anchorId '${entry.anchorId}' in anchor map for block '${blockId}'`,
            );
          }
          seenAnchorIds.add(entry.anchorId);
        }

        if (!['S', 'E', 'R', 'IMG'].includes(entry.tagType)) {
          errors.push(
            `anchorMaps['${blockId}'][${eIdx}].tagType must be one of S, E, R, IMG, got '${entry.tagType}'`,
          );
        }

        if (entry.rubyText !== undefined && typeof entry.rubyText !== 'string') {
          errors.push(`anchorMaps['${blockId}'][${eIdx}].rubyText must be a string if provided`);
        }
        if (entry.parenthesisText !== undefined && typeof entry.parenthesisText !== 'string') {
          errors.push(`anchorMaps['${blockId}'][${eIdx}].parenthesisText must be a string if provided`);
        }
        if (entry.imageSrc !== undefined && typeof entry.imageSrc !== 'string') {
          errors.push(`anchorMaps['${blockId}'][${eIdx}].imageSrc must be a string if provided`);
        }
        if (entry.imageAlt !== undefined && typeof entry.imageAlt !== 'string') {
          errors.push(`anchorMaps['${blockId}'][${eIdx}].imageAlt must be a string if provided`);
        }

        if (errors.length === 0) {
          validatedEntries.push({
            anchorId: entry.anchorId,
            tagType: entry.tagType,
            ...(entry.rubyText !== undefined ? { rubyText: entry.rubyText } : {}),
            ...(entry.parenthesisText !== undefined ? { parenthesisText: entry.parenthesisText } : {}),
            ...(entry.imageSrc !== undefined ? { imageSrc: entry.imageSrc } : {}),
            ...(entry.imageAlt !== undefined ? { imageAlt: entry.imageAlt } : {}),
          });
        }
      });

      // Sort entries deterministically by anchorId
      validatedEntries.sort((a, b) => a.anchorId.localeCompare(b.anchorId));
      validatedAnchorMaps[blockId] = validatedEntries;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Sort segments by sortOrder
  validatedSegments.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    valid: true,
    errors: [],
    value: {
      version: 1,
      segmenterVersion: obj.segmenterVersion,
      sourceStructureFingerprint: obj.sourceStructureFingerprint,
      document: validatedDocument!,
      segments: validatedSegments,
      anchorMaps: validatedAnchorMaps,
    },
  };
}
