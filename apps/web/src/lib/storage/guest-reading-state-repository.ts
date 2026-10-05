import {
  LocalReadingProgress,
  LocalReadingHistory,
} from '@omninovel/shared';
import {
  IndexedDbClient,
  indexedDbClient,
  assertGuestScope,
} from './indexed-db-client';
import {
  ActiveScopeCoordinator,
  activeScopeCoordinator,
} from '../identity/active-scope-coordinator';

export interface ReadingHistoryMetadata {
  storyTitle: string;
  storySlug?: string;
  storyCoverUrl?: string;
  chapterNumber: string | number;
  chapterTitle?: string;
}

export class GuestReadingStateRepository {
  constructor(
    private readonly dbClient: IndexedDbClient = indexedDbClient,
    private readonly coordinator: ActiveScopeCoordinator = activeScopeCoordinator
  ) {}

  /**
   * Resolves the active guest scope from coordinator and asserts guest invariant.
   */
  private async getGuestScope(): Promise<string> {
    const scope = await this.coordinator.waitForResolvedScope();
    assertGuestScope(scope);
    return scope;
  }

  /**
   * Retrieves current reading resume position for a story under active guest scope.
   */
  async getProgress(storyId: string): Promise<LocalReadingProgress | null> {
    const scope = await this.getGuestScope();
    return this.dbClient.getProgress(scope, storyId);
  }

  /**
   * Saves reading resume position for a story under active guest scope.
   * If historyMeta is provided, atomically records both progress and history.
   */
  async saveProgress(
    progress: Omit<LocalReadingProgress, 'ownerScope'>,
    historyMeta?: ReadingHistoryMetadata
  ): Promise<void> {
    if (historyMeta) {
      return this.recordSession(progress, historyMeta);
    }
    const scope = await this.getGuestScope();
    const fullProgress: LocalReadingProgress = {
      ...progress,
      ownerScope: scope,
    };
    return this.dbClient.putProgress(fullProgress);
  }

  /**
   * Atomically records both resume position and reading history item.
   * Monotonicity Invariant: history percentage = MAX(old, new).
   */
  async recordSession(
    progress: Omit<LocalReadingProgress, 'ownerScope'>,
    historyMeta: ReadingHistoryMetadata
  ): Promise<void> {
    const scope = await this.getGuestScope();

    const fullProgress: LocalReadingProgress = {
      ...progress,
      ownerScope: scope,
    };

    const fullHistory: LocalReadingHistory = {
      ownerScope: scope,
      storyId: progress.storyId,
      chapterId: progress.chapterId,
      chapterVersionId: progress.chapterVersionId || null,
      storyTitle: historyMeta.storyTitle,
      storySlug: historyMeta.storySlug,
      storyCoverUrl: historyMeta.storyCoverUrl,
      chapterNumber: historyMeta.chapterNumber,
      chapterTitle: historyMeta.chapterTitle,
      progressPercentage: progress.progressPercentage,
      lastReadAt: progress.updatedAt,
    };

    return this.dbClient.recordReadingSession(fullProgress, fullHistory);
  }

  /**
   * Computes completed chapter IDs based on >= 80% progress threshold.
   * Purely client-side from local history snapshot without network call.
   */
  async getReadChapterIds(storyId: string): Promise<string[]> {
    const scope = await this.getGuestScope();
    const history = await this.dbClient.getHistory(scope);
    const readChapters = new Set<string>();

    for (const item of history) {
      if (item.storyId === storyId && item.progressPercentage >= 80.0) {
        readChapters.add(item.chapterId);
      }
    }

    return Array.from(readChapters);
  }
}

export const guestReadingStateRepository = new GuestReadingStateRepository();
