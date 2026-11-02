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
import { SyncLogEmitter } from '../../sync/services/sync-log-emitter.service';
import { GlobalRole, StoryVisibility, MediaFormat } from '@omninovel/shared';

describe('StoriesService.ReadingProgress Contract Parity (Phase 5B.0)', () => {
  let service: StoriesService;
  let dataSourceMock: any;
  let chapterRepoMock: any;
  let storyRepoMock: any;

  const testUser = { id: 'user-uuid-1', role: GlobalRole.READER };
  const mockStory = {
    id: 'story-uuid-1',
    visibility: StoryVisibility.PUBLIC,
    mediaFormat: MediaFormat.COMIC,
  };
  const mockChapter = {
    id: 'chapter-uuid-1',
    chapterNumber: '5',
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: getRepositoryToken(Story), useValue: storyRepoMock },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
        { provide: getRepositoryToken(Bookmark), useValue: {} },
        { provide: getRepositoryToken(ReadingProgress), useValue: {} },
        { provide: getRepositoryToken(ChapterReadState), useValue: {} },
        { provide: getRepositoryToken(Volume), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: chapterRepoMock },
        { provide: RedisService, useValue: {} },
        { provide: DataSource, useValue: dataSourceMock },
        {
          provide: SyncLogEmitter,
          useValue: {
            lockAndAcquireUserSyncState: jest.fn().mockResolvedValue({ currentSyncRevision: 0n, minActiveRevision: 0n }),
            emit: jest.fn().mockResolvedValue('1'),
            emitBatch: jest.fn().mockResolvedValue('1'),
          },
        },
      ],
    }).compile();

    service = module.get<StoriesService>(StoriesService);
  });

  it('saveReadingProgress should persist and return 1-based pageIndex, anchorBlockId and textOffset', async () => {
    const managerQueryMock = jest
      .fn()
      .mockResolvedValueOnce([]) // insert counter
      .mockResolvedValueOnce([{ epoch: '0' }]) // SELECT FOR SHARE
      .mockResolvedValueOnce([{ currentEpoch: '0' }]) // resolve currentEpoch = 0
      .mockResolvedValueOnce([]) // upsert reading_progress
      .mockResolvedValueOnce([{ max_progress_percentage: 55.5 }]); // upsert chapter_read_states RETURNING max_progress_percentage

    dataSourceMock.transaction.mockImplementation(async (cb: any) => {
      return cb({ query: managerQueryMock });
    });

    const result = await service.saveReadingProgress(testUser, {
      chapterId: 'chapter-uuid-1',
      progressPercentage: 55.5,
      scrollPosition: 1200,
      pageIndex: 12,
      anchorBlockId: 'block-anchor-uuid',
      textOffset: 450,
      storyId: 'story-uuid-1',
      writeEpoch: 0,
    });

    expect(result.pageIndex).toBe(12);
    expect(result.anchorBlockId).toBe('block-anchor-uuid');
    expect(result.textOffset).toBe(450);
    expect(result.progressPercentage).toBe(55.5);
    expect(result.storyId).toBe('story-uuid-1');
    expect(result.writeEpoch).toBe(0);

    // Verify SQL parameters in upsert
    expect(managerQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('page_index = EXCLUDED.page_index'),
      expect.arrayContaining([
        testUser.id,
        'story-uuid-1',
        'chapter-uuid-1',
        null,
        'WEBTOON',
        55.5,
        1200,
        12,
        'block-anchor-uuid',
        450,
      ]),
    );
  });

  it('getReadingProgress should return default pageIndex=1 and null offsets when no progress exists', async () => {
    dataSourceMock.query.mockResolvedValueOnce([{ currentEpoch: '0' }]); // tombstones
    dataSourceMock.query.mockResolvedValueOnce([]); // no progress
    dataSourceMock.query.mockResolvedValueOnce([]); // no read chapters

    const result = await service.getReadingProgress(testUser, 'story-uuid-1');

    expect(result.pageIndex).toBe(1);
    expect(result.anchorBlockId).toBeNull();
    expect(result.textOffset).toBe(0);
    expect(result.progressPercentage).toBe(0);
    expect(result.writeEpoch).toBe(0);
  });

  it('getReadingProgress should return stored pageIndex, anchorBlockId and textOffset', async () => {
    dataSourceMock.query.mockResolvedValueOnce([{ currentEpoch: '2' }]); // tombstones
    dataSourceMock.query.mockResolvedValueOnce([
      {
        storyId: 'story-uuid-1',
        chapterId: 'chapter-uuid-1',
        chapterVersionId: null,
        readingMode: 'WEBTOON',
        progressPercentage: 75.0,
        scrollPosition: 2500,
        pageIndex: 18,
        anchorBlockId: 'block-99',
        textOffset: 120,
        updatedAt: new Date('2026-09-22T08:00:00Z'),
      },
    ]);
    dataSourceMock.query.mockResolvedValueOnce([{ chapterId: 'chapter-uuid-1' }]);

    const result = await service.getReadingProgress(testUser, 'story-uuid-1');

    expect(result.pageIndex).toBe(18);
    expect(result.anchorBlockId).toBe('block-99');
    expect(result.textOffset).toBe(120);
    expect(result.progressPercentage).toBe(75.0);
    expect(result.readChapterIds).toContain('chapter-uuid-1');
    expect(result.writeEpoch).toBe(2);
  });
});
