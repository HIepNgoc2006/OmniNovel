import { LocalReadingProgress } from '@omninovel/shared';
import {
  saveReadingProgressApi,
  getReadingProgressApi,
} from '../api/stories';
import {
  rewardReadChapterApi,
  ReadChapterRewardResponse,
} from '../api/gamification';
import {
  ActiveScopeCoordinator,
  activeScopeCoordinator,
} from '../identity/active-scope-coordinator';
import {
  ReadingStateRepository,
} from './reading-state-repository';
import { ReadingHistoryMetadata } from './guest-reading-state-repository';

export class AccountReadingStateRepository implements ReadingStateRepository {
  private readChapterCache = new Map<string, string[]>();

  constructor(
    private readonly coordinator: ActiveScopeCoordinator = activeScopeCoordinator,
  ) {}

  private async getAccountScope(): Promise<string> {
    const scope = await this.coordinator.waitForResolvedScope();
    if (!scope || !scope.startsWith('account:')) {
      throw new Error(`Invalid scope for Account repository: "${scope}". Expected "account:<userId>".`);
    }
    return scope;
  }

  async getProgress(storyId: string): Promise<LocalReadingProgress | null> {
    const scope = await this.getAccountScope();
    try {
      const res = await getReadingProgressApi(storyId);
      if (res.readChapterIds && Array.isArray(res.readChapterIds)) {
        this.readChapterCache.set(storyId, res.readChapterIds);
      }
      if (!res.chapterId) {
        return null;
      }

      const isPaged = (res.readingMode || '').toUpperCase() === 'MANGA_PAGED';
      const rawPageIdx = Number((res as any).pageIndex);
      const pageIndex = isPaged
        ? (rawPageIdx > 0 ? rawPageIdx : (res.scrollPosition > 0 ? Math.round(res.scrollPosition) : 1))
        : (rawPageIdx > 0 ? rawPageIdx : 1);
      const scrollPosition = isPaged ? 0 : (res.scrollPosition || 0);

      return {
        ownerScope: scope,
        storyId,
        chapterId: res.chapterId,
        chapterVersionId: res.chapterVersionId || null,
        readingMode: res.readingMode || 'WEBTOON',
        progressPercentage: res.progressPercentage || 0,
        scrollPosition,
        pageIndex,
        anchorBlockId: (res as any).anchorBlockId || null,
        textOffset: (res as any).textOffset || null,
        updatedAt: typeof res.updatedAt === 'string' ? res.updatedAt : (res.updatedAt ? new Date(res.updatedAt).toISOString() : new Date().toISOString()),
        deviceTimestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async saveProgress(
    progress: Omit<LocalReadingProgress, 'ownerScope'>,
    _historyMeta?: ReadingHistoryMetadata,
  ): Promise<void> {
    await this.getAccountScope();

    const isPaged = (progress.readingMode || '').toUpperCase() === 'MANGA_PAGED';
    const pageIndex = progress.pageIndex > 0 ? progress.pageIndex : 1;
    // Compatibility mapping: encode pageIndex into scrollPosition for backend DTOs
    const scrollPosition = isPaged
      ? Math.round(progress.pageIndex > 0 ? progress.pageIndex : progress.scrollPosition || 1)
      : Math.round(progress.scrollPosition);

    await saveReadingProgressApi({
      storyId: progress.storyId,
      chapterId: progress.chapterId,
      chapterVersionId: progress.chapterVersionId || undefined,
      readingMode: progress.readingMode,
      progressPercentage: Math.round(progress.progressPercentage * 100) / 100,
      scrollPosition,
      pageIndex,
      anchorBlockId: progress.anchorBlockId || undefined,
      textOffset: progress.textOffset || undefined,
    } as any);

    if (progress.progressPercentage >= 80) {
      const cached = this.readChapterCache.get(progress.storyId) || [];
      if (!cached.includes(progress.chapterId)) {
        this.readChapterCache.set(progress.storyId, [...cached, progress.chapterId]);
      }
    }
  }

  async getReadChapterIds(storyId: string): Promise<string[]> {
    await this.getAccountScope();
    if (this.readChapterCache.has(storyId)) {
      return this.readChapterCache.get(storyId)!;
    }
    try {
      const res = await getReadingProgressApi(storyId);
      const ids = res.readChapterIds || [];
      this.readChapterCache.set(storyId, ids);
      return ids;
    } catch {
      return [];
    }
  }

  async claimChapterReward(input: {
    chapterId: string;
    readingDurationSeconds: number;
    progressPercentage: number;
  }): Promise<ReadChapterRewardResponse | null> {
    await this.getAccountScope();
    try {
      return await rewardReadChapterApi(input);
    } catch {
      return null;
    }
  }
}

export const accountReadingStateRepository = new AccountReadingStateRepository();
