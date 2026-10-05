import { LocalReadingProgress } from '@omninovel/shared';
import { ReadingHistoryMetadata, guestReadingStateRepository } from './guest-reading-state-repository';
import { accountReadingStateRepository } from './account-reading-state-repository';

export interface UpdateReadingProgressInput {
  progressPercentage: number;
  scrollPosition?: number;
  pageIndex?: number;
  anchorBlockId?: string | null;
  textOffset?: number | null;
  storyTitle?: string;
  storySlug?: string;
  storyCoverUrl?: string;
  chapterNumber?: string | number;
  chapterTitle?: string;
}

export type PersistenceStatus = 'ready' | 'saving' | 'unavailable' | 'error';

export interface ReadingStateRepository {
  getProgress(storyId: string): Promise<LocalReadingProgress | null>;
  saveProgress(
    progress: Omit<LocalReadingProgress, 'ownerScope'>,
    historyMeta?: ReadingHistoryMetadata
  ): Promise<void>;
  getReadChapterIds(storyId: string): Promise<string[]>;
}

export class ScopeNotResolvedError extends Error {
  constructor(state: string) {
    super(`Cannot get ReadingStateRepository: Active scope is not resolved (current state: "${state}").`);
    this.name = 'ScopeNotResolvedError';
  }
}

export function getReadingStateRepository(
  coordinatorState: string,
  guestRepo: ReadingStateRepository = guestReadingStateRepository,
  accountRepo: ReadingStateRepository = accountReadingStateRepository
): ReadingStateRepository {
  if (coordinatorState === 'ACCOUNT') {
    return accountRepo;
  }
  if (coordinatorState === 'GUEST') {
    return guestRepo;
  }
  throw new ScopeNotResolvedError(coordinatorState);
}
