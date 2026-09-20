import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ChaptersService } from '../chapters.service';
import { Chapter } from '../entities/chapter.entity';
import { ChapterVersion } from '../entities/chapter-version.entity';
import { Volume } from '../entities/volume.entity';
import { MediaAsset } from '../entities/media-asset.entity';
import { StoryEdition } from '../../stories/entities/story-edition.entity';
import { ChapterVersionType } from '@omninovel/shared';

describe('Studio chapter versions (#146)', () => {
  let service: ChaptersService;
  let chapterRepository: { findOne: jest.Mock };
  let versionRepository: { find: jest.Mock };

  beforeEach(async () => {
    chapterRepository = {
      findOne: jest.fn(),
    };
    versionRepository = {
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChaptersService,
        {
          provide: getRepositoryToken(Chapter),
          useValue: chapterRepository,
        },
        {
          provide: getRepositoryToken(ChapterVersion),
          useValue: versionRepository,
        },
        {
          provide: getRepositoryToken(Volume),
          useValue: {},
        },
        {
          provide: getRepositoryToken(MediaAsset),
          useValue: {},
        },
        {
          provide: getRepositoryToken(StoryEdition),
          useValue: {},
        },
        {
          provide: DataSource,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get(ChaptersService);
  });

  it('returns lightweight canonical versions ordered by versionNumber DESC', async () => {
    chapterRepository.findOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
    });
    versionRepository.find.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        chapterId: '11111111-1111-4111-8111-111111111111',
        versionNumber: 3,
        versionType: ChapterVersionType.HUMAN_EDITED,
        language: 'ja',
        isPublished: false,
        sourceVersionId: '22222222-2222-4222-8222-222222222222',
        createdAt: new Date('2026-09-20T01:02:03.000Z'),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        chapterId: '11111111-1111-4111-8111-111111111111',
        versionNumber: 1,
        versionType: ChapterVersionType.RAW_ORIGINAL,
        language: 'ja',
        isPublished: true,
        sourceVersionId: null,
        createdAt: new Date('2026-09-19T01:02:03.000Z'),
      },
    ]);

    const result = await service.findVersionsForStudio(
      '11111111-1111-4111-8111-111111111111',
    );

    expect(chapterRepository.findOne).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(versionRepository.find).toHaveBeenCalledWith({
      where: { chapterId: '11111111-1111-4111-8111-111111111111' },
      order: { versionNumber: 'DESC' },
    });
    expect(result).toEqual([
      {
        id: '33333333-3333-4333-8333-333333333333',
        chapterId: '11111111-1111-4111-8111-111111111111',
        versionNumber: 3,
        versionType: ChapterVersionType.HUMAN_EDITED,
        language: 'ja',
        isPublished: false,
        sourceVersionId: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-09-20T01:02:03.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        chapterId: '11111111-1111-4111-8111-111111111111',
        versionNumber: 1,
        versionType: ChapterVersionType.RAW_ORIGINAL,
        language: 'ja',
        isPublished: true,
        sourceVersionId: null,
        createdAt: '2026-09-19T01:02:03.000Z',
      },
    ]);
  });

  it('throws NotFoundException when the chapter does not exist', async () => {
    chapterRepository.findOne.mockResolvedValue(null);

    await expect(
      service.findVersionsForStudio(
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(versionRepository.find).not.toHaveBeenCalled();
  });
});
