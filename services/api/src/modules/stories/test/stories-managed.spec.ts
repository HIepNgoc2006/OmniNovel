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
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';

describe('StoriesService.findManagedStories (#144)', () => {
  let service: StoriesService;
  let storyRepo: any;

  const adminUser = { id: 'admin-1', role: GlobalRole.ADMIN };
  const editorUser = { id: 'user-2', role: GlobalRole.READER };

  beforeEach(async () => {
    storyRepo = {
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: getRepositoryToken(Story), useValue: storyRepo },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
        { provide: getRepositoryToken(Bookmark), useValue: {} },
        { provide: getRepositoryToken(ReadingProgress), useValue: {} },
        { provide: getRepositoryToken(ChapterReadState), useValue: {} },
        { provide: getRepositoryToken(Volume), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: RedisService, useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get<StoriesService>(StoriesService);
  });

  it('should allow admin to list all managed stories without story_members filter', async () => {
    const qbMock: any = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [
          {
            id: 'story-1',
            title: 'Chainsaw Man',
            createdAt: new Date('2026-09-01T00:00:00Z'),
            updatedAt: new Date('2026-09-01T00:00:00Z'),
          },
        ],
        1,
      ]),
    };
    storyRepo.createQueryBuilder.mockReturnValue(qbMock);

    const result = await service.findManagedStories(adminUser, { page: 1, limit: 20 });

    expect(qbMock.andWhere).not.toHaveBeenCalled();
    expect(qbMock.orderBy).toHaveBeenCalledWith('story.createdAt', 'DESC');
    expect(qbMock.addOrderBy).toHaveBeenCalledWith('story.id', 'DESC');
    expect(result.data.length).toBe(1);
    expect(result.pagination).toEqual({
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
  });

  it('should restrict non-admin to stories with OWNER/EDITOR/TRANSLATOR role', async () => {
    const qbMock: any = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    storyRepo.createQueryBuilder.mockReturnValue(qbMock);

    await service.findManagedStories(editorUser, { page: 1, limit: 20 });

    expect(qbMock.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS ('),
      expect.objectContaining({
        userId: editorUser.id,
        roles: [
          StoryMemberRole.OWNER,
          StoryMemberRole.EDITOR,
          StoryMemberRole.TRANSLATOR,
        ],
      }),
    );
  });

  it('should apply search filter and deterministic sorting', async () => {
    const qbMock: any = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    storyRepo.createQueryBuilder.mockReturnValue(qbMock);

    await service.findManagedStories(adminUser, { page: 2, limit: 15, search: 'Hero' });

    expect(qbMock.andWhere).toHaveBeenCalledWith('story.title ILIKE :search', {
      search: '%Hero%',
    });
    expect(qbMock.skip).toHaveBeenCalledWith(15);
    expect(qbMock.take).toHaveBeenCalledWith(15);
    expect(qbMock.orderBy).toHaveBeenCalledWith('story.createdAt', 'DESC');
    expect(qbMock.addOrderBy).toHaveBeenCalledWith('story.id', 'DESC');
  });
});
