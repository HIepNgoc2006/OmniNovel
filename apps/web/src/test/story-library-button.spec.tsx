import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import React from 'react';
import { StoryLibraryButton } from '../components/story/story-library-button';
import { activeScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import { guestLibraryRepository } from '../lib/storage/guest-library-repository';
import * as storiesApi from '../lib/api/stories';

vi.mock('../lib/api/stories', () => ({
  setBookmarkApi: vi.fn(),
  getBookmarkStatusApi: vi.fn(),
}));

describe('7A.4d: StoryLibraryButton (Bookmark semantics decoupled from follower count)', () => {
  beforeEach(async () => {
    localStorage.clear();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Guest Mode Invariants', () => {
    beforeEach(async () => {
      await activeScopeCoordinator.onAuthStatusChanged('anonymous');
    });

    it('toggles bookmark into IndexedDB with ZERO API calls and follower count untouched', async () => {
      const onFollowersCountChange = vi.fn();
      const setBookmarkSpy = vi.spyOn(storiesApi, 'setBookmarkApi');

      render(
        <StoryLibraryButton
          storyId="story-guest-bm-1"
          storyTitle="Guest Test Story"
          storySlug="guest-test-story"
          storyCoverUrl="/cover.jpg"
          onFollowersCountChange={onFollowersCountChange}
        />
      );

      // Initially not bookmarked
      const button = await screen.findByRole('button');
      expect(button).toHaveTextContent('Lưu Vào Thư Viện');

      // Click to bookmark
      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(async () => {
        expect(button).toHaveTextContent('Đã Lưu Vào Thư Viện');
      });

      // INVARIANT 1: Persisted in IndexedDB Guest Library
      const bookmark = await guestLibraryRepository.getBookmark('story-guest-bm-1');
      expect(bookmark).not.toBeNull();
      expect(bookmark?.title).toBe('Guest Test Story');
      expect(bookmark?.slug).toBe('guest-test-story');

      // INVARIANT 2: ZERO API calls to /library/bookmarks
      expect(setBookmarkSpy).toHaveBeenCalledTimes(0);

      // INVARIANT 3: Follower count callback NEVER triggered for Guest
      expect(onFollowersCountChange).toHaveBeenCalledTimes(0);

      // Click again to unbookmark
      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(async () => {
        expect(button).toHaveTextContent('Lưu Vào Thư Viện');
      });

      const deletedBookmark = await guestLibraryRepository.getBookmark('story-guest-bm-1');
      expect(deletedBookmark).toBeNull();
      expect(setBookmarkSpy).toHaveBeenCalledTimes(0);
      expect(onFollowersCountChange).toHaveBeenCalledTimes(0);
    });

    it('loads existing bookmark from IndexedDB on initial mount', async () => {
      await guestLibraryRepository.saveBookmark({
        storyId: 'story-existing',
        title: 'Existing Title',
        slug: 'existing-slug',
        createdAt: new Date().toISOString(),
      });

      render(
        <StoryLibraryButton
          storyId="story-existing"
          storyTitle="Existing Title"
          storySlug="existing-slug"
        />
      );

      const button = await screen.findByRole('button');
      await waitFor(() => {
        expect(button).toHaveTextContent('Đã Lưu Vào Thư Viện');
      });
    });
  });

  describe('2. Authenticated Account Invariants', () => {
    beforeEach(async () => {
      await activeScopeCoordinator.onAuthStatusChanged('authenticated', 'usr-test-account-123');
    });

    it('delegates bookmarking to server API and updates follower count on success', async () => {
      const onFollowersCountChange = vi.fn();
      const saveGuestSpy = vi.spyOn(guestLibraryRepository, 'saveBookmark');

      vi.spyOn(storiesApi, 'setBookmarkApi').mockResolvedValue({
        isBookmarked: true,
        followersCount: 42,
      });

      render(
        <StoryLibraryButton
          storyId="story-account-1"
          storyTitle="Account Story"
          storySlug="account-story"
          initialIsBookmarked={false}
          onFollowersCountChange={onFollowersCountChange}
        />
      );

      const button = await screen.findByRole('button');
      expect(button).toHaveTextContent('Lưu Vào Thư Viện');

      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(() => {
        expect(storiesApi.setBookmarkApi).toHaveBeenCalledWith({
          storyId: 'story-account-1',
          isBookmarked: true,
        });
      });

      await waitFor(() => {
        expect(button).toHaveTextContent('Đã Lưu Vào Thư Viện');
      });

      // Followers count updated via callback
      expect(onFollowersCountChange).toHaveBeenCalledWith(42);

      // Guest repository NEVER written
      expect(saveGuestSpy).toHaveBeenCalledTimes(0);
    });
  });
});
