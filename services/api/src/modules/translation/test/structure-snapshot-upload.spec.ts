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
import { ChapterArtifact } from '../../chapters/entities/chapter-artifact.entity';
import { CanonicalPackagingService } from '../../chapters/canonical-packaging.service';
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
        { provide: getRepositoryToken(ChapterArtifact), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: 'BullQueue_translation', useValue: {} },
        { provide: 'BullQueue_translation-materialization', useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: CanonicalPackagingService, useValue: {} },
        {
          provide: TranslationGateway,
          useValue: {
            server: { to: jest.fn().mockReturnValue({ emit: jest.fn() }) },
            broadcastJobReady: jest.fn(),
            broadcastJobProgress: jest.fn(),
          },
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

  describe('READY_FOR_REVIEW Structure Snapshot Gate (#163, P0.2, P0.4)', () => {
    const sampleSegments = [
      {
        sortOrder: 1,
        anchorBlockId: 'blk_0001_h1',
        blockType: 'HEADING',
        rawText: 'Header',
        translatedText: 'Tiêu đề',
      },
      {
        sortOrder: 2,
        anchorBlockId: 'blk_0002_p',
        blockType: 'NARRATION',
        rawText: 'Body',
        translatedText: 'Nội dung',
      },
    ];

    const validNovelManifest = {
      version: 1,
      mediaFormat: 'NOVEL',
      htmlKey: `ai/jobs/${validNovelJob.id}/attempt-1/novel_translated.html`,
      segmentCount: 2,
      charCount: [...'Tiêu đề'].length + [...'Nội dung'].length,
      htmlFileSizeBytes: 1024,
      title: 'Tiêu đề',
      language: 'vi',
      qa: {
        passed: true,
        score: 1.0,
        fingerprintMatch: true,
        issuesCount: 0,
        issues: [],
      },
      structureSnapshot: {
        version: 1,
        storageKey: `ai/jobs/${validNovelJob.id}/structure/${validSha256}.json`,
        sha256: validSha256,
        segmenterVersion: 'novel-v1',
        sourceStructureFingerprint: `sha256:${validSha256}`,
      },
    };

    beforeEach(() => {
      jobRepo.findOne.mockResolvedValue({
        ...validNovelJob,
        status: TranslationJobStatus.QUALITY_CHECK,
      });

      storageService.headInternalObject = jest.fn().mockResolvedValue(true);
      storageService.hashInternalObjectSha256 = jest.fn().mockResolvedValue({
        exists: true,
        sha256: validSha256,
        size: 2048,
        contentType: 'application/json',
      });

      const txJob = {
        ...validNovelJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        lastSequence: 0,
      };
      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue(txJob),
          save: jest.fn().mockImplementation((entity, data) => data || entity),
          createQueryBuilder: jest.fn(),
          create: jest.fn().mockImplementation((entity, data) => data),
          delete: jest.fn().mockResolvedValue(undefined),
        };
        return await cb(manager);
      });
    });

    it('should successfully pass READY_FOR_REVIEW when structureSnapshot is valid and verified in storage', async () => {
      const event: any = {
        eventId: 'e-ready-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: validNovelManifest,
        segments: sampleSegments,
      };

      const res = await service.handleWorkerEvent(validNovelJob.id, event);
      expect(res).toBeDefined();
      expect(storageService.hashInternalObjectSha256).toHaveBeenCalledWith(
        `ai/jobs/${validNovelJob.id}/structure/${validSha256}.json`,
        false,
        10 * 1024 * 1024,
      );
    });

    it('should reject when structureSnapshot is missing in new READY_FOR_REVIEW callback (P0.4)', async () => {
      const { structureSnapshot, ...legacyManifestWithoutSnapshot } = validNovelManifest;
      const event: any = {
        eventId: 'e-ready-missing-snap',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: legacyManifestWithoutSnapshot,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('Novel job bắt buộc phải có structureSnapshot trong resultManifest');
    });

    it('should reject when storageKey does not match canonical pattern or hash', async () => {
      const tamperedManifest = {
        ...validNovelManifest,
        structureSnapshot: {
          ...validNovelManifest.structureSnapshot,
          storageKey: `ai/jobs/${validNovelJob.id}/structure/stale_snapshot.json`,
        },
      };

      const event: any = {
        eventId: 'e-ready-tampered-key',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: tamperedManifest,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('không khớp với canonical path');
    });

    it('should reject when structure snapshot object does not exist in MinIO (P0.2)', async () => {
      storageService.hashInternalObjectSha256.mockResolvedValueOnce({
        exists: false,
        size: 0,
      });

      const event: any = {
        eventId: 'e-ready-non-existent-snap',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: validNovelManifest,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('không tồn tại trong MinIO storage');
    });

    it('should reject when structure snapshot object size is empty (size <= 0) (P0.2)', async () => {
      storageService.hashInternalObjectSha256.mockResolvedValueOnce({
        exists: true,
        size: 0,
        contentType: 'application/json',
        sha256: validSha256,
      });

      const event: any = {
        eventId: 'e-ready-empty-snap',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: validNovelManifest,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('rỗng (size <= 0)');
    });

    it('should reject when structure snapshot has invalid contentType (P0.2)', async () => {
      storageService.hashInternalObjectSha256.mockResolvedValueOnce({
        exists: true,
        size: 2048,
        contentType: 'text/plain',
        sha256: validSha256,
      });

      const event: any = {
        eventId: 'e-ready-wrong-ct-snap',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: validNovelManifest,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('có contentType không hợp lệ');
    });

    it('should reject when actual streamed SHA-256 does not match manifest reference (P0.2)', async () => {
      const differentHash = 'a'.repeat(64);
      storageService.hashInternalObjectSha256.mockResolvedValueOnce({
        exists: true,
        size: 2048,
        contentType: 'application/json',
        sha256: differentHash,
      });

      const event: any = {
        eventId: 'e-ready-hash-mismatch-snap',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: validNovelManifest,
        segments: sampleSegments,
      };

      await expect(
        service.handleWorkerEvent(validNovelJob.id, event),
      ).rejects.toThrow('không khớp với sha256 trong manifest reference');
    });
  });
});
