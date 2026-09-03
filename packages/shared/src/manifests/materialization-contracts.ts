import {
  NovelBlockType,
  JS_MAX_SAFE_INTEGER,
  ValidationResult,
  MangaResultManifestPageV1,
  NovelResultQaV1,
  TranslationResultManifestV1,
  MangaResultManifestV1,
  NovelResultManifestV1,
} from './translation-manifests';

// ----------------------------------------------------------------------
// Materialization Snapshot Contracts (Version 1)
// ----------------------------------------------------------------------

export interface TranslationSegmentSnapshotV1 {
  id: string;
  version: number;
  pageNumber: number | null;
  bboxX: number | null;
  bboxY: number | null;
  bboxW: number | null;
  bboxH: number | null;
  anchorBlockId: string | null;
  sortOrder: number;
  rawText: string;
  translatedText: string;
  blockType: NovelBlockType | null;
}

export interface MaterializationSnapshotV1 {
  version: 1;
  jobId: string;
  targetRevision: number;
  mediaFormat: 'COMIC' | 'NOVEL';
  segments: TranslationSegmentSnapshotV1[];
}

export interface MaterializationJobData {
  jobId: string;
  targetRevision: number;
  mediaFormat: 'COMIC' | 'NOVEL';
  snapshotKey: string;
  snapshotSha256: string;
  outputPrefix: string;
}

export type MaterializationOutcome =
  | 'APPLIED'
  | 'ALREADY_APPLIED'
  | 'STALE_DISCARDED';

// ----------------------------------------------------------------------
// Selective Materialization Output Contracts (Version 1)
// ----------------------------------------------------------------------

export interface ComicMaterializationResultV1 {
  version: 1;
  mediaFormat: 'COMIC';
  pages: MangaResultManifestPageV1[];
}

export interface NovelMaterializationResultV1 {
  version: 1;
  mediaFormat: 'NOVEL';
  htmlKey: string;
  htmlFileSizeBytes: number;
  segmentCount: number;
  charCount: number;
  qa: NovelResultQaV1;
}

// ----------------------------------------------------------------------
// Helpers & Regex
// ----------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// ----------------------------------------------------------------------
// Pure Semantic Runtime Validators
// ----------------------------------------------------------------------

/**
 * Validate MaterializationSnapshotV1 with strict format-specific geometry rules
 */
export function validateMaterializationSnapshotV1(
  data: unknown,
): ValidationResult<MaterializationSnapshotV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Snapshot data must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'jobId', 'targetRevision', 'mediaFormat', 'segments'],
    'MaterializationSnapshotV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [`MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`],
    };
  }

  if (typeof obj.jobId !== 'string' || !UUID_REGEX.test(obj.jobId)) {
    errors.push(`jobId must be a valid UUID string, got '${obj.jobId}'`);
  }

  if (!isSafePositiveInteger(obj.targetRevision)) {
    errors.push('targetRevision must be a positive safe integer (>= 1)');
  }

  if (obj.mediaFormat !== 'COMIC' && obj.mediaFormat !== 'NOVEL') {
    errors.push(`mediaFormat must be 'COMIC' or 'NOVEL', got '${obj.mediaFormat}'`);
  }

  if (!Array.isArray(obj.segments)) {
    errors.push('segments must be an array');
  } else if (obj.segments.length === 0) {
    errors.push('segments array must not be empty');
  }

  const isComic = obj.mediaFormat === 'COMIC';
  const isNovel = obj.mediaFormat === 'NOVEL';
  const validatedSegments: TranslationSegmentSnapshotV1[] = [];

  if (Array.isArray(obj.segments)) {
    for (let i = 0; i < obj.segments.length; i++) {
      const seg = obj.segments[i];
      const prefix = `segments[${i}]`;

      if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
        errors.push(`${prefix} must be a non-null object`);
        continue;
      }

      assertNoUnknownKeys(
        seg,
        [
          'id',
          'version',
          'pageNumber',
          'bboxX',
          'bboxY',
          'bboxW',
          'bboxH',
          'anchorBlockId',
          'sortOrder',
          'rawText',
          'translatedText',
          'blockType',
        ],
        prefix,
        errors,
      );

      if (typeof seg.id !== 'string' || !UUID_REGEX.test(seg.id)) {
        errors.push(`${prefix}.id must be a valid UUID string`);
      }

      if (!isSafePositiveInteger(seg.version)) {
        errors.push(`${prefix}.version must be a positive safe integer (>= 1)`);
      }

      if (!isSafeNonNegativeInteger(seg.sortOrder)) {
        errors.push(`${prefix}.sortOrder must be a non-negative safe integer (>= 0)`);
      }

      if (typeof seg.rawText !== 'string') {
        errors.push(`${prefix}.rawText must be a string`);
      }

      if (typeof seg.translatedText !== 'string') {
        errors.push(`${prefix}.translatedText must be a string`);
      }

      if (isComic) {
        // Comic geometry & topology invariants
        if (!isSafePositiveInteger(seg.pageNumber)) {
          errors.push(`${prefix}.pageNumber must be a positive safe integer for COMIC`);
        }
        if (typeof seg.bboxX !== 'number' || !Number.isFinite(seg.bboxX) || seg.bboxX < 0) {
          errors.push(`${prefix}.bboxX must be a finite non-negative number for COMIC`);
        }
        if (typeof seg.bboxY !== 'number' || !Number.isFinite(seg.bboxY) || seg.bboxY < 0) {
          errors.push(`${prefix}.bboxY must be a finite non-negative number for COMIC`);
        }
        if (typeof seg.bboxW !== 'number' || !Number.isFinite(seg.bboxW) || seg.bboxW <= 0) {
          errors.push(`${prefix}.bboxW must be a finite positive number (> 0) for COMIC`);
        }
        if (typeof seg.bboxH !== 'number' || !Number.isFinite(seg.bboxH) || seg.bboxH <= 0) {
          errors.push(`${prefix}.bboxH must be a finite positive number (> 0) for COMIC`);
        }
        if (seg.anchorBlockId !== null && seg.anchorBlockId !== undefined) {
          errors.push(`${prefix}.anchorBlockId must be null for COMIC`);
        }
        if (seg.blockType !== null && seg.blockType !== undefined) {
          errors.push(`${prefix}.blockType must be null for COMIC`);
        }
      } else if (isNovel) {
        // Novel structure invariants
        if (seg.pageNumber !== null && seg.pageNumber !== undefined) {
          errors.push(`${prefix}.pageNumber must be null for NOVEL`);
        }
        if (seg.bboxX !== null && seg.bboxX !== undefined) {
          errors.push(`${prefix}.bboxX must be null for NOVEL`);
        }
        if (seg.bboxY !== null && seg.bboxY !== undefined) {
          errors.push(`${prefix}.bboxY must be null for NOVEL`);
        }
        if (seg.bboxW !== null && seg.bboxW !== undefined) {
          errors.push(`${prefix}.bboxW must be null for NOVEL`);
        }
        if (seg.bboxH !== null && seg.bboxH !== undefined) {
          errors.push(`${prefix}.bboxH must be null for NOVEL`);
        }
        if (typeof seg.anchorBlockId !== 'string' || seg.anchorBlockId.trim().length === 0) {
          errors.push(`${prefix}.anchorBlockId must be a non-empty string for NOVEL`);
        }
        if (
          !seg.blockType ||
          !Object.values(NovelBlockType).includes(seg.blockType as NovelBlockType)
        ) {
          errors.push(
            `${prefix}.blockType must be one of [${Object.values(NovelBlockType).join(', ')}] for NOVEL`,
          );
        }
      }

      validatedSegments.push({
        id: String(seg.id),
        version: Number(seg.version),
        pageNumber: seg.pageNumber === null || seg.pageNumber === undefined ? null : Number(seg.pageNumber),
        bboxX: seg.bboxX === null || seg.bboxX === undefined ? null : Number(seg.bboxX),
        bboxY: seg.bboxY === null || seg.bboxY === undefined ? null : Number(seg.bboxY),
        bboxW: seg.bboxW === null || seg.bboxW === undefined ? null : Number(seg.bboxW),
        bboxH: seg.bboxH === null || seg.bboxH === undefined ? null : Number(seg.bboxH),
        anchorBlockId: seg.anchorBlockId ? String(seg.anchorBlockId) : null,
        sortOrder: Number(seg.sortOrder),
        rawText: String(seg.rawText),
        translatedText: String(seg.translatedText),
        blockType: seg.blockType ? (seg.blockType as NovelBlockType) : null,
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
      jobId: String(obj.jobId),
      targetRevision: Number(obj.targetRevision),
      mediaFormat: obj.mediaFormat as 'COMIC' | 'NOVEL',
      segments: validatedSegments,
    },
  };
}

/**
 * Validate ComicMaterializationResultV1
 */
export function validateComicMaterializationResultV1(
  data: unknown,
): ValidationResult<ComicMaterializationResultV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Comic materialization result must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'mediaFormat', 'pages'],
    'ComicMaterializationResultV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [`MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`],
    };
  }

  if (obj.mediaFormat !== 'COMIC') {
    errors.push(`mediaFormat must be 'COMIC', got '${obj.mediaFormat}'`);
  }

  if (!Array.isArray(obj.pages)) {
    errors.push('pages must be an array');
  } else if (obj.pages.length === 0) {
    errors.push('pages array must not be empty');
  }

  const validatedPages: MangaResultManifestPageV1[] = [];

  if (Array.isArray(obj.pages)) {
    const seenPages = new Set<number>();
    for (let i = 0; i < obj.pages.length; i++) {
      const page = obj.pages[i];
      const prefix = `pages[${i}]`;

      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }

      assertNoUnknownKeys(
        page,
        ['page', 'storageKey', 'previewKey', 'width', 'height', 'fileSizeBytes', 'fileSize'],
        prefix,
        errors,
      );

      const pageNum = page.page;
      if (!isSafePositiveInteger(pageNum)) {
        errors.push(`${prefix}.page must be a positive integer`);
      } else {
        if (seenPages.has(pageNum)) {
          errors.push(`Duplicate page number detected: ${pageNum}`);
        }
        seenPages.add(pageNum);
      }

      if (typeof page.storageKey !== 'string' || page.storageKey.trim() === '') {
        errors.push(`${prefix}.storageKey must be a non-empty string`);
      }

      if (typeof page.previewKey !== 'string' || page.previewKey.trim() === '') {
        errors.push(`${prefix}.previewKey must be a non-empty string`);
      }

      if (!isSafePositiveInteger(page.width)) {
        errors.push(`${prefix}.width must be a positive integer`);
      }

      if (!isSafePositiveInteger(page.height)) {
        errors.push(`${prefix}.height must be a positive integer`);
      }

      const rawSizeBytes = page.fileSizeBytes ?? page.fileSize;
      if (!isSafePositiveInteger(rawSizeBytes)) {
        errors.push(`${prefix}.fileSizeBytes must be a positive safe integer`);
      }

      validatedPages.push({
        page: Number(pageNum),
        storageKey: String(page.storageKey),
        previewKey: String(page.previewKey),
        width: Number(page.width),
        height: Number(page.height),
        fileSizeBytes: Number(rawSizeBytes),
      });
    }

    // Sequence check: pages must start at 1 and be contiguous
    for (let i = 1; i <= obj.pages.length; i++) {
      if (!seenPages.has(i)) {
        errors.push(`Non-contiguous page sequence: missing page ${i}`);
        break;
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
      mediaFormat: 'COMIC',
      pages: validatedPages,
    },
  };
}

/**
 * Validate NovelMaterializationResultV1
 */
export function validateNovelMaterializationResultV1(
  data: unknown,
): ValidationResult<NovelMaterializationResultV1> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Novel materialization result must be a non-null object'] };
  }

  const obj = data as Record<string, any>;

  assertNoUnknownKeys(
    obj,
    ['version', 'mediaFormat', 'htmlKey', 'htmlFileSizeBytes', 'segmentCount', 'charCount', 'qa'],
    'NovelMaterializationResultV1',
    errors,
  );

  if (obj.version !== 1) {
    return {
      valid: false,
      errors: [`MISSING_OR_INVALID_VERSION: Expected version 1, got ${obj.version}`],
    };
  }

  if (obj.mediaFormat !== 'NOVEL') {
    errors.push(`mediaFormat must be 'NOVEL', got '${obj.mediaFormat}'`);
  }

  if (typeof obj.htmlKey !== 'string' || obj.htmlKey.trim() === '') {
    errors.push('htmlKey must be a non-empty string');
  }

  if (!isSafePositiveInteger(obj.htmlFileSizeBytes)) {
    errors.push('htmlFileSizeBytes must be a positive safe integer');
  }

  if (!isSafeNonNegativeInteger(obj.segmentCount)) {
    errors.push('segmentCount must be a non-negative integer');
  }

  if (!isSafeNonNegativeInteger(obj.charCount)) {
    errors.push('charCount must be a non-negative integer');
  }

  // Validate QA block
  if (!obj.qa || typeof obj.qa !== 'object' || Array.isArray(obj.qa)) {
    errors.push('qa must be an object');
  } else {
    assertNoUnknownKeys(
      obj.qa,
      ['passed', 'score', 'fingerprintMatch', 'issuesCount', 'issues'],
      'qa',
      errors,
    );
    if (typeof obj.qa.passed !== 'boolean') {
      errors.push('qa.passed must be a boolean');
    } else if (obj.qa.passed !== true) {
      errors.push('qa.passed must be true for completed materialization');
    }
    if (typeof obj.qa.score !== 'number' || obj.qa.score < 0 || obj.qa.score > 1) {
      errors.push('qa.score must be a number between 0 and 1');
    }
    if (typeof obj.qa.fingerprintMatch !== 'boolean') {
      errors.push('qa.fingerprintMatch must be a boolean');
    }
    if (!isSafeNonNegativeInteger(obj.qa.issuesCount)) {
      errors.push('qa.issuesCount must be a non-negative integer');
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
      htmlKey: String(obj.htmlKey),
      htmlFileSizeBytes: Number(obj.htmlFileSizeBytes),
      segmentCount: Number(obj.segmentCount),
      charCount: Number(obj.charCount),
      qa: {
        passed: Boolean(obj.qa.passed),
        score: Number(obj.qa.score),
        fingerprintMatch: Boolean(obj.qa.fingerprintMatch),
        issuesCount: Number(obj.qa.issuesCount),
        ...(Array.isArray(obj.qa.issues) ? { issues: obj.qa.issues } : {}),
      },
    },
  };
}

/**
 * Canonical Result Equality Checker
 * Pure function comparing the authoritative DB manifest with the materialization candidate.
 * Used identically in both read-only preflight and under-lock FOR UPDATE transaction.
 */
export function isMaterializationResultEqual(
  currentManifest: TranslationResultManifestV1 | null | undefined,
  candidate: ComicMaterializationResultV1 | NovelMaterializationResultV1,
  mediaFormat: 'COMIC' | 'NOVEL' | string,
): boolean {
  if (!currentManifest) return false;

  if (mediaFormat === 'COMIC') {
    if (currentManifest.mediaFormat !== 'COMIC') return false;
    const curPages = (currentManifest as MangaResultManifestV1).pages;
    const canPages = (candidate as ComicMaterializationResultV1).pages;
    if (!curPages || !canPages) return false;
    if (curPages.length !== canPages.length) return false;

    for (let i = 0; i < curPages.length; i++) {
      const cp = curPages[i];
      const np = canPages[i];
      if (
        cp.page !== np.page ||
        cp.storageKey !== np.storageKey ||
        cp.previewKey !== np.previewKey ||
        Number(cp.width) !== Number(np.width) ||
        Number(cp.height) !== Number(np.height) ||
        Number(cp.fileSizeBytes) !== Number(np.fileSizeBytes)
      ) {
        return false;
      }
    }
    return true;
  }

  if (mediaFormat === 'NOVEL') {
    if (currentManifest.mediaFormat !== 'NOVEL') return false;
    const cur = currentManifest as NovelResultManifestV1;
    const can = candidate as NovelMaterializationResultV1;

    if (
      cur.htmlKey !== can.htmlKey ||
      Number(cur.htmlFileSizeBytes) !== Number(can.htmlFileSizeBytes) ||
      Number(cur.segmentCount) !== Number(can.segmentCount) ||
      Number(cur.charCount) !== Number(can.charCount)
    ) {
      return false;
    }

    // QA Comparison
    if (!cur.qa || !can.qa) return false;
    if (
      cur.qa.passed !== can.qa.passed ||
      Number(cur.qa.score) !== Number(can.qa.score) ||
      cur.qa.fingerprintMatch !== can.qa.fingerprintMatch ||
      Number(cur.qa.issuesCount) !== Number(can.qa.issuesCount)
    ) {
      return false;
    }

    // QA Issues Deep Comparison
    const curIssues = cur.qa.issues || [];
    const canIssues = can.qa.issues || [];
    if (curIssues.length !== canIssues.length) return false;
    for (let i = 0; i < curIssues.length; i++) {
      const ci = curIssues[i];
      const ni = canIssues[i];
      if (
        ci.severity !== ni.severity ||
        ci.ruleId !== ni.ruleId ||
        ci.message !== ni.message
      ) {
        return false;
      }
    }

    return true;
  }

  return false;
}

