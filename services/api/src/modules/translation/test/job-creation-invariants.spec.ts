import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TranslationService } from '../translation.service';
import { TranslationJob } from '../entities/translation-job.entity';
import { TranslationProject } from '../entities/translation-project.entity';
import { TranslationGlossary } from '../entities/translation-glossary.entity';
import { TranslationSegment } from '../entities/translation-segment.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { UploadSession } from '../../storage/entities/upload-session.entity';
import { StoryMember } from '../../stories/entities/story-member.entity';
import { StorageService } from '../../storage/storage.service';
import { TranslationGateway } from '../translation.gateway';
import { TranslationProcessor } from '../translation.processor';
import { DataSource } from 'typeorm';
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';

describe('Job Creation Backend Authority Invariants (#146 Task 2)', () => {
  let service: TranslationService;
  let versionRepo: any;
  let jobRepo: any;
  let storyMemberRepo: any;
  let dataSource: any;

  const mockUser = { id: 'user-translator-1', role: GlobalRole.TRANSLATOR };
  const validVersionId = '11111111-1111-4111-8111-111111111111';
  const idempotencyKey = '22222222-2222-4222-8222-222222222222';

  const mockSourceVersion = {
    id: validVersionId,
    language: 'ja',
    chapter: {
      id: 'chap-1',
      storyEdition: {
        id: 'edition-1',
        story: {
          id: 'story-1',
          mediaFormat: 'COMIC',
        },
      },
    },
  };

  beforeEach(async () => {
    versionRepo = {
      findOne: jest.fn().mockResolvedValue(mockSourceVersion),
    };

    jobRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    storyMemberRepo = {
      findOne: jest.fn().mockResolvedValue({
        storyId: 'story-1',
        userId: mockUser.id,
        role: StoryMemberRole.TRANSLATOR,
      }),
    };

    dataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: jobRepo },
        { provide: getRepositoryToken(TranslationProject), useValue: { findOne: jest.fn(), create: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(TranslationGlossary), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(TranslationSegment), useValue: {} },
        { provide: getRepositoryToken(ChapterVersion), useValue: versionRepo },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: { count: jest.fn().mockResolvedValue(5) } },
        { provide: getRepositoryToken(UploadSession), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(StoryMember), useValue: storyMemberRepo },
        { provide: 'BullQueue_translation', useValue: { add: jest.fn() } },
        { provide: 'BullQueue_translation-materialization', useValue: { add: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: TranslationGateway, useValue: { emitJobStateChange: jest.fn() } },
        { provide: TranslationProcessor, useValue: {} },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  it('rejects with BadRequestException when sourceLang does not match ChapterVersion.language', async () => {
    const dto = {
      chapterVersionId: validVersionId,
      sourceLang: 'en', // Version is 'ja'
      targetLang: 'vi',
      provider: 'MOCK',
    };

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(/SOURCE_LANGUAGE_MISMATCH/);
  });

  it('rejects with BadRequestException when targetLang is identical to sourceLang', async () => {
    const dto = {
      chapterVersionId: validVersionId,
      sourceLang: 'ja',
      targetLang: 'ja', // identical
      provider: 'MOCK',
    };

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(/IDENTICAL_LANGUAGES/);
  });

  it('rejects with NotFoundException when ChapterVersion does not exist', async () => {
    versionRepo.findOne.mockResolvedValueOnce(null);

    const dto = {
      chapterVersionId: '00000000-0000-4000-8000-000000000000',
      sourceLang: 'ja',
      targetLang: 'vi',
      provider: 'MOCK',
    };

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects with BadRequestException and SOURCE_VERSION_ARTIFACT_UNAVAILABLE when source version has no promoted upload session (#165)', async () => {
    const dto = {
      chapterVersionId: validVersionId,
      sourceLang: 'ja',
      targetLang: 'vi',
      provider: 'MOCK',
    };

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createJob(mockUser, dto, idempotencyKey),
    ).rejects.toThrow(/SOURCE_VERSION_ARTIFACT_UNAVAILABLE/);
  });
});

