import { ReadingMode } from '../index.js';

/**
 * Lifecycle status of a guest data claim session
 */
export enum GuestClaimStatus {
  PREPARED = 'PREPARED',
  COMMITTED = 'COMMITTED',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
}

/**
 * Explicit resolution choice for conflicting progress tuples
 */
export enum ConflictResolution {
  KEEP_CLOUD = 'KEEP_CLOUD',
  USE_GUEST = 'USE_GUEST',
}

/**
 * Minimal bookmark tuple transferred from guest profile
 */
export interface GuestBookmarkItem {
  storyId: string;
  createdAt?: string;
}

/**
 * Chapter read-state record transferred from guest profile history
 */
export interface GuestHistoryItem {
  storyId: string;
  chapterId: string;
  progressPercentage: number;
  completedAt?: string | null;
  lastReadAt?: string;
}

/**
 * Canonical 7-tuple reading progress record transferred from guest profile
 */
export interface GuestProgressItem {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode: ReadingMode;
  /**
   * 1-based page index (must be >= 1)
   */
  pageIndex: number;
  scrollPosition: number;
  progressPercentage: number;
  anchorBlockId?: string | null;
  textOffset?: number | null;
  updatedAt?: string;
}

/**
 * Request payload for POST /api/v1/account/guest-claims/prepare
 */
export interface PrepareGuestClaimPayload {
  guestProfileId: string;
  bookmarks?: GuestBookmarkItem[];
  history?: GuestHistoryItem[];
  progress?: GuestProgressItem[];
}

/**
 * Progress conflict representation between cloud account and incoming guest state
 */
export interface ReadingProgressConflict {
  storyId: string;
  cloudProgress: {
    chapterId: string;
    chapterVersionId?: string | null;
    readingMode: ReadingMode;
    pageIndex: number;
    scrollPosition: number;
    progressPercentage: number;
    anchorBlockId?: string | null;
    textOffset?: number | null;
    updatedAt: string;
  };
  guestProgress: {
    chapterId: string;
    chapterVersionId?: string | null;
    readingMode: ReadingMode;
    pageIndex: number;
    scrollPosition: number;
    progressPercentage: number;
    anchorBlockId?: string | null;
    textOffset?: number | null;
    updatedAt?: string;
  };
}

/**
 * Response payload for POST /api/v1/account/guest-claims/prepare
 */
export interface GuestClaimPreviewResult {
  claimId: string;
  status: GuestClaimStatus;
  stateFingerprint: string;
  expiresAt: string;
  bookmarksToImport: number;
  historyToImport: number;
  progressToImport: number;
  conflictsCount: number;
  readStatesIgnoredAntiResurrectionCount: number;
  conflicts: ReadingProgressConflict[];
}

/**
 * Request payload for POST /api/v1/account/guest-claims/:claimId/commit
 */
export interface CommitGuestClaimPayload {
  expectedStateFingerprint: string;
  conflictDecisions?: Record<string, ConflictResolution>;
}

/**
 * Response payload for POST /api/v1/account/guest-claims/:claimId/commit
 */
export interface GuestClaimCommitResult {
  claimId: string;
  status: GuestClaimStatus;
  committedAt: string;
  summary: {
    bookmarksImported: number;
    historyMerged: number;
    progressUpdated: number;
    conflictsResolved: number;
  };
}

/**
 * Response payload for GET /api/v1/account/guest-claims/:claimId/status
 */
export interface GuestClaimStatusResult {
  claimId: string;
  status: GuestClaimStatus;
  expiresAt: string;
  committedAt?: string | null;
  previewData: GuestClaimPreviewResult;
  resultSummary?: GuestClaimCommitResult['summary'] | null;
}
