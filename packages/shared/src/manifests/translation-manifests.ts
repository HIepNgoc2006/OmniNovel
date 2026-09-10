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
