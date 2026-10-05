import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import React from 'react';
import LibraryPage from '../app/(site)/(public)/library/page';
import { activeScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import { guestLibraryRepository } from '../lib/storage/guest-library-repository';
import { guestReadingStateRepository } from '../lib/storage/guest-reading-state-repository';
import * as storiesApi from '../lib/api/stories';

vi.mock('../lib/api/stories', () => ({
  getBookmarksApi: vi.fn().mockResolvedValue({ items: [], meta: { totalItems: 0, page: 1, limit: 20, totalPages: 0 } }),
  setBookmarkApi: vi.fn(),
  getBookmarkStatusApi: vi.fn(),
  getReadingHistoryApi: vi.fn().mockResolvedValue({ items: [], meta: { totalItems: 0, page: 1, limit: 20, totalPages: 0 } }),
  deleteStoryReadingHistoryApi: vi.fn().mockResolvedValue(undefined),
  clearAllReadingHistoryApi: vi.fn().mockResolvedValue(undefined),
}));

describe('7A.4e: Library Page Integration (Guest & Account Library)', () => {
  beforeEach(async () => {
    localStorage.clear();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
    await activeScopeCoordinator.onAuthStatusChanged('anonymous');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders guest bookmarks from IndexedDB and allows removing an item', async () => {
    await guestLibraryRepository.saveBookmark({
      storyId: 'story-g-1',
      title: 'Solo Leveling Guest',
      slug: 'solo-leveling-guest',
      coverUrl: '/cover1.jpg',
      createdAt: new Date().toISOString(),
    });

    render(<LibraryPage />);

    // Shows bookmark item
    await waitFor(() => {
      expect(screen.getByText('Solo Leveling Guest')).toBeInTheDocument();
    });

    // Remove button click
    const removeBtn = screen.getByTitle('Xóa khỏi thư viện');
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    await waitFor(async () => {
      expect(screen.queryByText('Solo Leveling Guest')).not.toBeInTheDocument();
    });

    const bookmarks = await guestLibraryRepository.getBookmarks();
    expect(bookmarks.length).toBe(0);
  });

  it('renders guest reading history, allows individual delete and clear all', async () => {
    await guestReadingStateRepository.saveProgress(
      {
        storyId: 'story-hist-1',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        progressPercentage: 85,
        scrollPosition: 1500,
        pageIndex: 1,
        updatedAt: new Date().toISOString(),
        deviceTimestamp: Date.now(),
      },
      {
        storyTitle: 'Omniscient Reader',
        storySlug: 'orv',
        chapterNumber: '1',
        chapterTitle: 'Khởi đầu',
      }
    );

    render(<LibraryPage />);

    // Switch to History tab
    const historyTabBtn = await screen.findByRole('button', { name: /Lịch Sử Đọc/i });
    await act(async () => {
      fireEvent.click(historyTabBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Omniscient Reader')).toBeInTheDocument();
    });
    expect(screen.getByText(/Chương 1/i)).toBeInTheDocument();

    // Clear all history
    const clearAllBtn = screen.getByRole('button', { name: /Xóa tất cả/i });
    await act(async () => {
      fireEvent.click(clearAllBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText('Omniscient Reader')).not.toBeInTheDocument();
    });

    const history = await guestLibraryRepository.getHistory();
    expect(history.length).toBe(0);
  });

  it('rotates to fresh empty library on logout', async () => {
    await guestLibraryRepository.saveBookmark({
      storyId: 'story-session-1',
      title: 'Session Story',
      slug: 'session-story',
      createdAt: new Date().toISOString(),
    });

    const { rerender } = render(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getAllByText('Session Story').length).toBeGreaterThan(0);
    });

    // Simulate logout rotation
    await act(async () => {
      await activeScopeCoordinator.onLogout();
    });

    rerender(<LibraryPage />);

    await waitFor(() => {
      expect(screen.queryAllByText('Session Story').length).toBe(0);
    });
  });

  it('renders and manages Account server reading history via Core API and NEVER calls Guest repository', async () => {
    await activeScopeCoordinator.onAuthStatusChanged('authenticated', 'usr-test-account-lib');

    vi.mocked(storiesApi.getBookmarksApi).mockResolvedValue({
      items: [],
      meta: { totalItems: 0, page: 1, limit: 20, totalPages: 0 },
    });

    vi.mocked(storiesApi.getReadingHistoryApi).mockResolvedValue({
      items: [
        {
          storyId: 'story-server-hist',
          storyTitle: 'Server Tracked Novel',
          storySlug: 'server-tracked-novel',
          storyCoverUrl: '/cover.png',
          chapterId: 'chap-server-1',
          chapterNumber: '5',
          chapterTitle: 'Trận Chiến Cuối',
          readingMode: 'NOVEL',
          progressPercentage: 92,
          scrollPosition: 3000,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
        },
        {
          storyId: 'story-server-hist-2',
          storyTitle: 'Another Server Story',
          storySlug: 'another-story',
          chapterId: 'chap-2',
          chapterNumber: '1',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
          scrollPosition: 500,
          pageIndex: 1,
          updatedAt: new Date().toISOString(),
        },
      ],
      meta: { totalItems: 2, page: 1, limit: 20, totalPages: 1 },
    });

    vi.mocked(storiesApi.deleteStoryReadingHistoryApi).mockResolvedValue(undefined);
    vi.mocked(storiesApi.clearAllReadingHistoryApi).mockResolvedValue(undefined);
    const guestDeleteSpy = vi.spyOn(guestLibraryRepository, 'deleteStoryHistory');
    const guestClearSpy = vi.spyOn(guestLibraryRepository, 'clearAllHistory');

    render(<LibraryPage />);

    // Switch to History tab
    const historyTabBtn = await screen.findByRole('button', { name: /Lịch Sử Đọc/i });
    await act(async () => {
      fireEvent.click(historyTabBtn);
    });

    // Expect server history items to appear
    await waitFor(() => {
      expect(screen.getByText('Server Tracked Novel')).toBeInTheDocument();
    });
    expect(screen.getByText('Another Server Story')).toBeInTheDocument();
    expect(screen.getByText(/Chương 5/i)).toBeInTheDocument();

    // Delete first individual history item
    const deleteBtns = screen.getAllByTitle('Xóa khỏi lịch sử');
    await act(async () => {
      fireEvent.click(deleteBtns[0]);
    });

    // Invariant: called server delete API, NEVER called guest repo
    expect(storiesApi.deleteStoryReadingHistoryApi).toHaveBeenCalledWith('story-server-hist');
    expect(guestDeleteSpy).toHaveBeenCalledTimes(0);

    // Verify first item removed, second item remains
    await waitFor(() => {
      expect(screen.queryByText('Server Tracked Novel')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Another Server Story')).toBeInTheDocument();

    // Clear all remaining history items
    const clearAllBtn = screen.getByRole('button', { name: /Xóa tất cả/i });
    await act(async () => {
      fireEvent.click(clearAllBtn);
    });

    // Invariant: called server clear API, NEVER called guest repo
    expect(storiesApi.clearAllReadingHistoryApi).toHaveBeenCalledTimes(1);
    expect(guestClearSpy).toHaveBeenCalledTimes(0);

    // Verify empty state appears
    await waitFor(() => {
      expect(screen.getByText('Chưa Có Lịch Sử Đọc')).toBeInTheDocument();
    });
  });
});
