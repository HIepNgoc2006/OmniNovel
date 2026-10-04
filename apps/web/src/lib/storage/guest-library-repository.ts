import {
  LocalBookmark,
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

export class GuestLibraryRepository {
  constructor(
    private readonly dbClient: IndexedDbClient = indexedDbClient,
    private readonly coordinator: ActiveScopeCoordinator = activeScopeCoordinator
  ) {}

  private async getGuestScope(): Promise<string> {
    const scope = await this.coordinator.waitForResolvedScope();
    assertGuestScope(scope);
    return scope;
  }

  // ==================== BOOKMARKS ====================

  async getBookmarks(): Promise<LocalBookmark[]> {
    const scope = await this.getGuestScope();
    return this.dbClient.getBookmarks(scope);
  }

  async getBookmark(storyId: string): Promise<LocalBookmark | null> {
    const scope = await this.getGuestScope();
    return this.dbClient.getBookmark(scope, storyId);
  }

  async saveBookmark(bookmark: Omit<LocalBookmark, 'ownerScope'>): Promise<void> {
    const scope = await this.getGuestScope();
    const fullBookmark: LocalBookmark = {
      ...bookmark,
      ownerScope: scope,
    };
    return this.dbClient.putBookmark(fullBookmark);
  }

  async removeBookmark(storyId: string): Promise<void> {
    const scope = await this.getGuestScope();
    return this.dbClient.deleteBookmark(scope, storyId);
  }

  // ==================== READING HISTORY ====================

  async getHistory(): Promise<LocalReadingHistory[]> {
    const scope = await this.getGuestScope();
    return this.dbClient.getHistory(scope);
  }

  async deleteStoryHistory(storyId: string): Promise<void> {
    const scope = await this.getGuestScope();
    return this.dbClient.deleteStoryHistory(scope, storyId);
  }

  async clearAllHistory(): Promise<void> {
    const scope = await this.getGuestScope();
    return this.dbClient.clearAllHistory(scope);
  }

  async purgeGuestScope(): Promise<void> {
    const scope = await this.getGuestScope();
    return this.dbClient.purgeScope(scope);
  }
}

export const guestLibraryRepository = new GuestLibraryRepository();
