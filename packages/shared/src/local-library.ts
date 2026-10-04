/**
 * CLIENT-SIDE LOCAL STORAGE CONTRACTS ONLY.
 *
 * INVARIANT: These interfaces define client-side persistence contracts for IndexedDB (Web)
 * and SQLite (Mobile). They are STRICTLY FORBIDDEN from being serialized or transmitted as
 * Network DTOs to Backend Core APIs.
 *
 * In Phase 7B (Claim Protocol), all non-authoritative presentation cache fields
 * (title, slug, coverUrl, chapterTitle, chapterNumber) MUST be stripped prior to upload.
 */

export interface LocalBookmark {
  /**
   * Partition scope: 'guest:<guestProfileId>' or 'account:<userId>'
   */
  ownerScope: string;

  /**
   * Canonical story identifier
   */
  storyId: string;

  /**
   * Non-authoritative presentation cache for offline UI rendering
   */
  title: string;

  /**
   * Non-authoritative presentation cache for routing
   */
  slug?: string;

  /**
   * Non-authoritative presentation cache for image display
   */
  coverUrl?: string;

  /**
   * ISO 8601 creation timestamp
   */
  createdAt: string;
}

export interface LocalReadingProgress {
  /**
   * Partition scope: 'guest:<guestProfileId>' or 'account:<userId>'
   */
  ownerScope: string;

  /**
   * Canonical story identifier
   */
  storyId: string;

  /**
   * Canonical chapter identifier currently being read
   */
  chapterId: string;

  /**
   * Canonical chapter version identifier (if applicable)
   */
  chapterVersionId?: string | null;

  /**
   * Active reading mode ('WEBTOON' | 'MANGA_PAGED' | 'NOVEL' | string)
   */
  readingMode: 'WEBTOON' | 'MANGA_PAGED' | 'NOVEL' | string;

  /**
   * Reading completion percentage (0.0 to 100.0)
   */
  progressPercentage: number;

  /**
   * Continuous scroll position in pixels
   */
  scrollPosition: number;

  /**
   * 1-based page index for paged media (Manga Paged, PDF, EPUB)
   */
  pageIndex: number;

  /**
   * DOM Block identifier anchor for Light Novel Reader
   */
  anchorBlockId?: string | null;

  /**
   * Character text offset within anchor block for Light Novel Reader
   */
  textOffset?: number | null;

  /**
   * ISO 8601 formatted update timestamp
   */
  updatedAt: string;

  /**
   * Local device timestamp in Unix epoch milliseconds.
   *
   * CRITICAL INVARIANT:
   * Diagnostic & local ordering ONLY. NEVER use as conflict authority in Phase 7B Claim
   * or Phase 7C Multi-device Sync. The server remains the sole authoritative arbiter.
   */
  deviceTimestamp: number;
}

export interface LocalReadingHistory {
  /**
   * Partition scope: 'guest:<guestProfileId>' or 'account:<userId>'
   */
  ownerScope: string;

  /**
   * Canonical story identifier
   */
  storyId: string;

  /**
   * Canonical chapter identifier read
   */
  chapterId: string;

  /**
   * Canonical chapter version identifier (if applicable)
   */
  chapterVersionId?: string | null;

  /**
   * Non-authoritative presentation cache
   */
  storyTitle: string;

  /**
   * Non-authoritative presentation cache
   */
  storySlug?: string;

  /**
   * Non-authoritative presentation cache
   */
  storyCoverUrl?: string;

  /**
   * Non-authoritative presentation cache
   */
  chapterNumber: string | number;

  /**
   * Non-authoritative presentation cache
   */
  chapterTitle?: string;

  /**
   * Progress percentage at time of read
   */
  progressPercentage: number;

  /**
   * ISO 8601 formatted last read timestamp (Snapshot semantics: 1 row per chapter)
   */
  lastReadAt: string;
}
