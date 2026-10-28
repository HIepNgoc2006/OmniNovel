import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StoriesService } from '../stories.service';
import { Story } from '../entities/story.entity';
import { StoryMember } from '../entities/story-member.entity';
import { StoryEdition } from '../entities/story-edition.entity';
import { Bookmark } from '../entities/bookmark.entity';
import { Genre } from '../entities/genre.entity';
import { ReadingProgress } from '../entities/reading-progress.entity';
import { ChapterReadState } from '../entities/chapter-read-state.entity';
import { Volume } from '../../chapters/entities/volume.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { RedisService } from '../../../redis/redis.service';
import { SyncLogEmitter } from '../../sync/services/sync-log-emitter.service';

describe('StoriesService.getGenres (#199)', () => {
  let service: StoriesService;
  let dataSourceMock: any;
  let genreRepoMock: any;

  beforeEach(async () => {
    genreRepoMock = {
      find: jest.fn(),
    };

    dataSourceMock = {
      getRepository: jest.fn().mockImplementation((entity) => {
        if (entity === Genre) return genreRepoMock;
        return {};
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: getRepositoryToken(Story), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
        { provide: getRepositoryToken(Bookmark), useValue: {} },
        { provide: getRepositoryToken(ReadingProgress), useValue: {} },
        { provide: getRepositoryToken(ChapterReadState), useValue: {} },
        { provide: getRepositoryToken(Volume), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
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

  it('should return genres ordered by name ASC from canonical Genre repository', async () => {
    const mockGenres = [
      { id: 1, name: 'Action', slug: 'action' },
      { id: 2, name: 'Comedy', slug: 'comedy' },
      { id: 3, name: 'Fantasy', slug: 'fantasy' },
    ];
    genreRepoMock.find.mockResolvedValue(mockGenres);

    const result = await service.getGenres();

    expect(dataSourceMock.getRepository).toHaveBeenCalledWith(Genre);
    expect(genreRepoMock.find).toHaveBeenCalledWith({
      order: { name: 'ASC' },
    });
    expect(result).toEqual(mockGenres);
    expect(result[0].id).toBe(1);
    expect(typeof result[0].id).toBe('number');
  });
});
