import { Test, TestingModule } from '@nestjs/testing';
import { TranslationService } from '../translation.service';
import { StorageService } from '../../storage/storage.service';
import { TranslationJob } from '../entities/translation-job.entity';
import { TranslationProject } from '../entities/translation-project.entity';
import { TranslationGlossary } from '../entities/translation-glossary.entity';
import { TranslationSegment } from '../entities/translation-segment.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { UploadSession } from '../../storage/entities/upload-session.entity';
import { StoryMember } from '../../stories/entities/story-member.entity';
import { TranslationGateway } from '../translation.gateway';
import { TranslationProcessor } from '../translation.processor';
import { DataSource } from 'typeorm';
import {
  MediaFormat,
  TranslationJobStatus,
} from '@omninovel/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('Novel Structure Snapshot Upload Protocol (#163)', () => {
  let service: TranslationService;
  let jobRepo: any;
  let storageService: any;
  let dataSource: any;

  const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const expectedChecksumBase64 = Buffer.from(validSha256, 'hex').toString('base64');

  const validNovelJob = {
    id: 'd9b2d63d-a232-4d1a-9694-81b859942a11',
    attemptCount: 1,
    status: TranslationJobStatus.PREPROCESSING,
    sourceVersionId: 'ver-src-1',
    project: {
      id: 'proj-1',
      targetLanguage: 'vi',
      storyEdition: {
        id: 'ed-1',
        story: {
          id: 'story-1',
          mediaFormat: MediaFormat.NOVEL,
        },
      },
    },
    sourceVersion: {
      id: 'ver-src-1',
      chapterId: 'chap-1',
      chapter: {
        id: 'chap-1',
        storyEditionId: 'ed-1',
      },
    },
  };

  beforeEach(async () => {
    jobRepo = {
      findOne: jest.fn().mockResolvedValue(validNovelJob),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    storageService = {
      createInternalUploadUrl: jest
        .fn()
        .mockImplementation((key) => `https://minio.local/put/${key}`),
      statInternalObject: jest.fn().mockResolvedValue({
        exists: true,
        contentLength: 2048,
        contentType: 'application/json',
      }),
      hashInternalObjectSha256: jest.fn().mockResolvedValue({
        exists: true,
        sha256: validSha256,
        size: 2048,
        contentType: 'application/json',
      }),
    };

    dataSource = {
      query: jest.fn(),
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: jobRepo },
        { provide: getRepositoryToken(TranslationProject), useValue: {} },
        { provide: getRepositoryToken(TranslationGlossary), useValue: {} },
        { provide: getRepositoryToken(TranslationSegment), useValue: {} },
        { provide: getRepositoryToken(ChapterVersion), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(UploadSession), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: 'BullQueue_translation', useValue: {} },
        { provide: 'BullQueue_translation-materialization', useValue: {} },
        { provide: StorageService, useValue: storageService },
        {
          provide: TranslationGateway,
          useValue: { server: { to: jest.fn().mockReturnValue({ emit: jest.fn() }) } },
        },
        { provide: TranslationProcessor, useValue: {} },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  it('should successfully grant presigned upload URL bound to SHA256 checksum', async () => {
    const res = await service.createStructureSnapshotUploadUrl(
      validNovelJob.id,
      1,
      validSha256,
    );

    const expectedKey = `ai/jobs/${validNovelJob.id}/structure/${validSha256}.json`;
    expect(res).toEqual({
      jobId: validNovelJob.id,
      attemptNumber: 1,
      storageKey: expectedKey,
      uploadUrl: `https://minio.local/put/${expectedKey}`,
      sha256: validSha256,
    });

    expect(storageService.createInternalUploadUrl).toHaveBeenCalledWith(
      expectedKey,
      'application/json',
      false, // novel bucket
      900,
      expectedChecksumBase64,
    );
  });

  it('should reject if sha256 is invalid (not 64 lowercase hex chars)', async () => {
    await expect(
      service.createStructureSnapshotUploadUrl(validNovelJob.id, 1, 'invalid-hash'),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createStructureSnapshotUploadUrl(
        validNovelJob.id,
        1,
        validSha256.toUpperCase(),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject if job is not found', async () => {
    jobRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.createStructureSnapshotUploadUrl('non-existent-id', 1, validSha256),
    ).rejects.toThrow(NotFoundException);
  });

  it('should reject if job is not in PREPROCESSING stage (Narrow State Gate)', async () => {
    const invalidStatuses = [
      TranslationJobStatus.CREATED,
      TranslationJobStatus.TRANSLATING,
      TranslationJobStatus.READY_FOR_REVIEW,
      TranslationJobStatus.APPLIED,
      TranslationJobStatus.FAILED,
    ];

    for (const status of invalidStatuses) {
      jobRepo.findOne.mockResolvedValueOnce({
        ...validNovelJob,
        status,
      });

      await expect(
        service.createStructureSnapshotUploadUrl(validNovelJob.id, 1, validSha256),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('should reject if attemptNumber does not match job.attemptCount', async () => {
    jobRepo.findOne.mockResolvedValueOnce({
      ...validNovelJob,
      attemptCount: 2,
    });

    await expect(
      service.createStructureSnapshotUploadUrl(validNovelJob.id, 1, validSha256),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject if media format is COMIC instead of NOVEL', async () => {
    jobRepo.findOne.mockResolvedValueOnce({
      ...validNovelJob,
      project: {
        ...validNovelJob.project,
        storyEdition: {
          story: {
            mediaFormat: MediaFormat.COMIC,
          },
        },
      },
    });

    await expect(
      service.createStructureSnapshotUploadUrl(validNovelJob.id, 1, validSha256),
    ).rejects.toThrow(BadRequestException);
  });
});
