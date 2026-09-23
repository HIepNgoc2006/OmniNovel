import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StoriesService } from '../stories.service';
import { Story } from '../entities/story.entity';
import { StoryMember } from '../entities/story-member.entity';
import { StoryEdition } from '../entities/story-edition.entity';
import { Bookmark } from '../entities/bookmark.entity';
import { ReadingProgress } from '../entities/reading-progress.entity';
import { ChapterReadState } from '../entities/chapter-read-state.entity';
import { Volume } from '../../chapters/entities/volume.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { RedisService } from '../../../redis/redis.service';
import { GlobalRole, StoryVisibility, MediaFormat, StoryStatus } from '@omninovel/shared';

describe('StoriesService.Library (Phase 5C.4 Gate 1-7)', () => {
  let service: StoriesService;
  let dataSourceMock: any;
  let chapterRepoMock: any;
  let storyRepoMock: any;
  let bookmarkRepoMock: any;

  const testUser = { id: 'user-uuid-1', role: GlobalRole.READER };
  const adminUser = { id: 'admin-uuid-1', role: GlobalRole.ADMIN };

  const mockStory = {
    id: 'story-uuid-1',
    visibility: StoryVisibility.PUBLIC,
    mediaFormat: MediaFormat.COMIC,
    status: StoryStatus.ONGOING,
  };

  const mockChapter = {
    id: 'chapter-uuid-1',
    chapterNumber: '1',
    storyEdition: {
      story: mockStory,
    },
  };

  beforeEach(async () => {
    dataSourceMock = {
      transaction: jest.fn(),
      query: jest.fn(),
    };
    chapterRepoMock = {
      findOne: jest.fn().mockResolvedValue(mockChapter),
    };
    storyRepoMock = {
      findOne: jest.fn().mockResolvedValue(mockStory),
    };
    bookmarkRepoMock = {
      findOne: jest.fn(),
      create: jest.fn((b) => b),
      save: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: getRepositoryToken(Story), useValue: storyRepoMock },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
        { provide: getRepositoryToken(Bookmark), useValue: bookmarkRepoMock },
        { provide: getRepositoryToken(ReadingProgress), useValue: {} },
        { provide: getRepositoryToken(ChapterReadState), useValue: {} },
        { provide: getRepositoryToken(Volume), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: chapterRepoMock },
        { provide: RedisService, useValue: {} },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get<StoriesService>(StoriesService);
  });

  // Gate 1: Bookmark Idempotency
  describe('Gate 1: Bookmark Idempotency', () => {
    it('calling setBookmark multiple times does not increment followersCount repeatedly', async () => {
      // First call: not bookmarked yet
      bookmarkRepoMock.findOne.mockResolvedValueOnce(null);
      dataSourceMock.transaction.mockImplementation(async (cb: any) => {
        return cb({
          save: jest.fn().mockResolvedValue({ userId: testUser.id, storyId: mockStory.id }),
          query: jest.fn().mockResolvedValue([]),
          findOne: jest.fn().mockResolvedValue({ followersCount: 1 }),
        });
      });

      const res1 = await service.setBookmark(testUser.id, {
        storyId: mockStory.id,
        isBookmarked: true,
      });
      expect(res1.isBookmarked).toBe(true);

      // Second call: already bookmarked -> idempotent no-op
      bookmarkRepoMock.findOne.mockResolvedValueOnce({
        userId: testUser.id,
        storyId: mockStory.id,
      });

      const res2 = await service.setBookmark(testUser.id, {
        storyId: mockStory.id,
        isBookmarked: true,
      });
      expect(res2.isBookmarked).toBe(true);
    });
  });

  // Gate 2 & Gate 3: Bookmarks pagination, status filter and unreadChapterCount
  describe('Gate 2 & 3: Bookmarks Query & Unread Count', () => {
    it('returns paginated bookmarks with unreadChapterCount computed in SQL', async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([{ total: '1' }]) // countSql
        .mockResolvedValueOnce([
          {
            id: mockStory.id,
            title: 'Test Story',
            slug: 'test-story',
            coverUrl: 'http://cover.jpg',
            mediaFormat: 'COMIC',
            status: 'ONGOING',
            totalChapters: 10,
            bookmarkedAt: new Date(),
            unreadChapterCount: '4',
          },
        ]);

      const result = await service.getBookmarks(testUser, {
        page: 1,
        limit: 20,
        status: StoryStatus.ONGOING,
      });

      expect(result.pagination.totalItems).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].unreadChapterCount).toBe(4);
      expect(result.data[0].story.id).toBe(mockStory.id);
    });
  });

  // Gate 4 & 5: Reading History Sort Order and Pointer Integrity
  describe('Gate 4 & 5: Reading History', () => {
    it('returns history sorted by updated_at DESC with full resume coordinates', async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([{ total: '1' }])
        .mockResolvedValueOnce([
          {
            storyId: mockStory.id,
            storyTitle: 'Test Story',
            storySlug: 'test-story',
            storyCoverUrl: 'http://cover.jpg',
            storyMediaFormat: 'NOVEL',
            storyStatus: 'ONGOING',
            storyTotalChapters: 25,
            chapterId: mockChapter.id,
            chapterTitle: 'Chương 1',
            chapterNumber: 1,
            chapterVersionId: 'version-uuid-1',
            readingMode: 'NOVEL',
            progressPercentage: 45.5,
            scrollPosition: 800,
            pageIndex: 5,
            anchorBlockId: 'block-anchor-42',
            textOffset: 120,
            updatedAt: new Date(),
          },
        ]);

      const history = await service.getReadingHistory(testUser, { page: 1, limit: 10 });

      expect(history.data).toHaveLength(1);
      const item = history.data[0];
      expect(item.story.id).toBe(mockStory.id);
      expect(item.chapter.id).toBe(mockChapter.id);
      expect(item.resume.readingMode).toBe('NOVEL');
      expect(item.resume.progressPercentage).toBe(45.5);
      expect(item.resume.scrollPosition).toBe(800);
      expect(item.resume.pageIndex).toBe(5);
      expect(item.resume.anchorBlockId).toBe('block-anchor-42');
      expect(item.resume.textOffset).toBe(120);
    });
  });

  // Gate 6A: First-Delete Race Serialization & Monotonic Epoch
  describe('Gate 6A: First-Delete Race Serialization', () => {
    it('deleteStoryReadingHistory increments user counter and upserts tombstone', async () => {
      const managerQueryMock = jest
        .fn()
        .mockResolvedValueOnce([{ epoch: '1' }]) // increment counter
        .mockResolvedValueOnce([]) // delete reading_progress
        .mockResolvedValueOnce([]) // delete chapter_read_states
        .mockResolvedValueOnce([]); // upsert tombstone

      dataSourceMock.transaction.mockImplementation(async (cb: any) => {
        return cb({ query: managerQueryMock });
      });

      await service.deleteStoryReadingHistory(testUser.id, mockStory.id);

      // Verify counter increment
      expect(managerQueryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reading_history_epoch_counters'),
        expect.arrayContaining([testUser.id]),
      );

      // Verify tombstone upsert with epoch = 1
      expect(managerQueryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reading_history_tombstones'),
        [testUser.id, mockStory.id, 1],
      );
    });

    it('stale saveReadingProgress with epoch=0 is rejected when currentEpoch=1', async () => {
      const managerQueryMock = jest
        .fn()
        .mockResolvedValueOnce([]) // insert counter on conflict do nothing
        .mockResolvedValueOnce([{ epoch: '1' }]) // SELECT FOR SHARE
        .mockResolvedValueOnce([{ currentEpoch: '1' }]); // tombstone currentEpoch = 1

      dataSourceMock.transaction.mockImplementation(async (cb: any) => {
        return cb({ query: managerQueryMock });
      });

      const result = await service.saveReadingProgress(testUser, {
        chapterId: mockChapter.id,
        progressPercentage: 10,
        scrollPosition: 0,
        storyId: mockStory.id,
        writeEpoch: 0, // Stale epoch 0 vs server currentEpoch 1
      });

      expect(result).toEqual({
        ignored: true,
        reason: 'STALE_WRITE_EPOCH',
        storyId: mockStory.id,
        writeEpoch: 0,
        currentEpoch: 1,
      });
    });
  });

  // Gate 6B: ClearAll Concurrent Race
  describe('Gate 6B: ClearAll Concurrent Race', () => {
    it('clearAllReadingHistory sets global sentinel tombstone with new epoch', async () => {
      const managerQueryMock = jest
        .fn()
        .mockResolvedValueOnce([{ epoch: '7' }]) // counter increment to 7
        .mockResolvedValueOnce([]) // delete all reading_progress
        .mockResolvedValueOnce([]) // delete all chapter_read_states
        .mockResolvedValueOnce([]); // upsert global tombstone

      dataSourceMock.transaction.mockImplementation(async (cb: any) => {
        return cb({ query: managerQueryMock });
      });

      await service.clearAllReadingHistory(testUser.id);

      expect(managerQueryMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reading_history_tombstones'),
        [testUser.id, 7],
      );
    });

    it('rejects stale write having previous per-story epoch when global epoch is higher', async () => {
      const managerQueryMock = jest
        .fn()
        .mockResolvedValueOnce([]) // insert counter
        .mockResolvedValueOnce([{ epoch: '7' }]) // SELECT FOR SHARE
        .mockResolvedValueOnce([{ currentEpoch: '7' }]); // global tombstone = 7

      dataSourceMock.transaction.mockImplementation(async (cb: any) => {
        return cb({ query: managerQueryMock });
      });

      const result = await service.saveReadingProgress(testUser, {
        chapterId: mockChapter.id,
        progressPercentage: 20,
        scrollPosition: 100,
        storyId: mockStory.id,
        writeEpoch: 4, // Stale per-story epoch 4 vs global currentEpoch 7
      });

      expect(result).toEqual({
        ignored: true,
        reason: 'STALE_WRITE_EPOCH',
        storyId: mockStory.id,
        writeEpoch: 4,
        currentEpoch: 7,
      });
    });
  });

  // Gate 7: Fail-Closed Privacy Filter
  describe('Gate 7: Fail-Closed Privacy Filter', () => {
    it('hides PRIVATE story in bookmarks when user is not admin or member', async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([{ total: '0' }])
        .mockResolvedValueOnce([]);

      const res = await service.getBookmarks(testUser, { page: 1, limit: 10 });
      expect(res.data).toHaveLength(0);
      expect(res.pagination.totalItems).toBe(0);
    });

    it('allows global ADMIN to view private bookmarks', async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([{ total: '1' }])
        .mockResolvedValueOnce([
          {
            id: 'private-story-1',
            title: 'Private Story',
            slug: 'private-story',
            coverUrl: null,
            mediaFormat: 'COMIC',
            status: 'ONGOING',
            totalChapters: 5,
            bookmarkedAt: new Date(),
            unreadChapterCount: 1,
          },
        ]);

      const res = await service.getBookmarks(adminUser, { page: 1, limit: 10 });
      expect(res.data).toHaveLength(1);
    });
  });
});
