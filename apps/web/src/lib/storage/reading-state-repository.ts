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

export function getReadingStateRepository(
  coordinatorState: string
): ReadingStateRepository {
  if (coordinatorState === 'ACCOUNT') {
    return accountReadingStateRepository;
  }
  return guestReadingStateRepository;
}
