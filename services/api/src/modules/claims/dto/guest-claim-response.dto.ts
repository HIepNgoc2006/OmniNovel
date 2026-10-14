export interface ReadingProgressConflictDetail {
  storyId: string;
  storyTitle?: string;
  cloudProgress: {
    chapterId: string;
    readingMode: string;
    pageIndex: number;
    scrollPosition: number;
    progressPercentage: number;
    anchorBlockId?: string | null;
    textOffset?: number;
    updatedAt: string;
  };
  guestProgress: {
    chapterId: string;
    readingMode: string;
    pageIndex: number;
    scrollPosition: number;
    progressPercentage: number;
    anchorBlockId?: string | null;
    textOffset?: number;
    updatedAt: string;
  };
}

export interface GuestClaimPreviewResponseDto {
  claimId: string;
  status: string;
  stateFingerprint: string;
  expiresAt: string;
  bookmarksToImport: number;
  historyToImport: number;
  progressToImport: number;
  conflictsCount: number;
  readStatesIgnoredAntiResurrectionCount: number;
  conflicts: ReadingProgressConflictDetail[];
}

export interface ClaimFinalizedProgressItemDto {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode: string;
  pageIndex: number;
  scrollPosition: number;
  progressPercentage: number;
  anchorBlockId?: string | null;
  textOffset?: number | null;
  updatedAt: string;
  deviceTimestamp?: number | null;
}

export interface ClaimFinalizedChapterReadStateItemDto {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  progressPercentage: number;
  completedAt?: string | null;
  lastReadAt: string;
}

export interface GuestClaimFinalizationDataDto {
  tombstonedStoryIds: string[];
  finalizedProgress: ClaimFinalizedProgressItemDto[];
  finalizedChapterReadStates: ClaimFinalizedChapterReadStateItemDto[];
}

export interface GuestClaimCommitResponseDto {
  claimId: string;
  status: string;
  committedAt: string;
  summary: {
    bookmarksImported: number;
    historyMerged: number;
    progressUpdated: number;
    conflictsResolved: number;
  };
  finalization?: GuestClaimFinalizationDataDto | null;
}

export interface GuestClaimStatusResponseDto {
  claimId: string;
  status: string;
  stateFingerprint: string;
  createdAt: string;
  expiresAt: string;
  committedAt?: string | null;
  previewData: GuestClaimPreviewResponseDto;
  resultSummary?: {
    bookmarksImported: number;
    historyMerged: number;
    progressUpdated: number;
    conflictsResolved: number;
  } | null;
  finalization?: GuestClaimFinalizationDataDto | null;
}
