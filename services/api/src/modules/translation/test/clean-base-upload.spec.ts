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
  ChapterVersionType,
  MangaResultManifestV1,
} from '@omninovel/shared';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('Clean Base Uploads & Canonical Review Base Protocol (#162)', () => {
  let service: TranslationService;
  let jobRepo: any;
  let storageService: any;
  let dataSource: any;

  const validMangaJob = {
    id: 'job-manga-123',
    attemptCount: 1,
    status: TranslationJobStatus.QUALITY_CHECK,
    sourceVersionId: 'ver-src-1',
    project: {
      id: 'proj-1',
      targetLanguage: 'vi',
      storyEdition: {
        id: 'ed-1',
        story: {
          id: 'story-1',
          mediaFormat: MediaFormat.COMIC,
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
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    storageService = {
      createInternalUploadUrl: jest.fn().mockImplementation((key) => `https://minio.local/put/${key}`),
      headInternalObject: jest.fn().mockResolvedValue(true),
      statInternalObject: jest.fn().mockResolvedValue({ exists: true, contentLength: 1024, contentType: 'image/webp' }),
      deleteInternalObject: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      query: jest.fn(),
      transaction: jest.fn().mockImplementation((cb) =>
        cb({
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue(validMangaJob),
          save: jest.fn().mockImplementation((entity, data) => data),
          create: jest.fn().mockImplementation((entity, data) => data),
          delete: jest.fn().mockResolvedValue(undefined),
          createQueryBuilder: jest.fn(),
        }),
      ),
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
        { provide: getRepositoryToken(StoryMember), useValue: { findOne: jest.fn().mockResolvedValue({ role: 'OWNER' }) } },
        { provide: 'BullQueue_translation', useValue: {} },
        { provide: 'BullQueue_translation-materialization', useValue: {} },
        { provide: StorageService, useValue: storageService },
        {
          provide: TranslationGateway,
          useValue: {
            server: { to: () => ({ emit: () => {} }) },
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

  describe('createCleanBaseUploadUrls Protocol', () => {
    it('should reject when story is NOVEL (fail-closed)', async () => {
      jobRepo.findOne.mockResolvedValue({
        ...validMangaJob,
        project: {
          storyEdition: {
            story: { mediaFormat: MediaFormat.NOVEL },
          },
        },
      });

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [1, 2]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when story is undefined/missing', async () => {
      jobRepo.findOne.mockResolvedValue({
        ...validMangaJob,
        project: null,
        sourceVersion: null,
      });

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [1, 2]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when attemptNumber does not match current attemptCount', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 2, [1, 2]),
      ).rejects.toThrow('Attempt 2 không khớp với attempt hiện tại');
    });

    it('should reject when job is already in READY_FOR_REVIEW (immutable source context protection)', async () => {
      jobRepo.findOne.mockResolvedValue({
        ...validMangaJob,
        status: TranslationJobStatus.READY_FOR_REVIEW,
      });

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [1]),
      ).rejects.toThrow('Chỉ cho phép trong quá trình xử lý của Worker trước khi vào Review');
    });

    it('should reject when job is in terminal state (APPLIED, FAILED, CANCELED)', async () => {
      jobRepo.findOne.mockResolvedValue({
        ...validMangaJob,
        status: TranslationJobStatus.APPLIED,
      });

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [1]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate pages in request', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [1, 2, 1]),
      ).rejects.toThrow('Duplicate page number trong danh sách clean base: 1');
    });

    it('should reject invalid page numbers (< 1 or non-integer)', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      await expect(
        service.createCleanBaseUploadUrls('job-manga-123', 1, [0, 1]),
      ).rejects.toThrow('Page number không hợp lệ: 0');
    });

    it('should generate canonical review-base keys and presigned URLs for valid request', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      const result = await service.createCleanBaseUploadUrls('job-manga-123', 1, [1, 2]);

      expect(result.jobId).toBe('job-manga-123');
      expect(result.attemptNumber).toBe(1);
      expect(result.cleanBases).toHaveLength(2);
      expect(result.cleanBases[0]).toEqual({
        page: 1,
        storageKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp',
        uploadUrl: 'https://minio.local/put/ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp',
      });
      expect(result.cleanBases[1]).toEqual({
        page: 2,
        storageKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_2.webp',
        uploadUrl: 'https://minio.local/put/ai/jobs/job-manga-123/review-base/attempt-1/page_2.webp',
      });
    });
  });

  describe('READY_FOR_REVIEW Canonical Jail & Coverage Gate', () => {
    it('should reject cleanBaseKey violating canonical path', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      const invalidJailEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/attempt-1/page_1.webp' }, // Wrong namespace!
          ],
        },
      };

      await expect(
        service.handleWorkerEvent('job-manga-123', invalidJailEvent),
      ).rejects.toThrow('không khớp với canonical path');
    });

    it('should reject when comic manifest lacks cleanBases array on READY_FOR_REVIEW', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      const missingCleanBasesEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
        },
      };

      await expect(
        service.handleWorkerEvent('job-manga-123', missingCleanBasesEvent),
      ).rejects.toThrow('Comic result manifest bắt buộc phải có cleanBases khi READY_FOR_REVIEW');
    });

    it('should reject when cleanBases has missing pages (pages=[1, 2], cleanBases=[1]) (RED test)', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);

      const partialCoverageEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
            { page: 2, storageKey: 'ai/jobs/job-manga-123/attempt-1/p2.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p2.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      await expect(
        service.handleWorkerEvent('job-manga-123', partialCoverageEvent),
      ).rejects.toThrow('Số lượng cleanBases (1) không khớp với số lượng pages (2)');
    });

    it('should reject when clean base file is missing or empty in MinIO (stat check)', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);
      storageService.statInternalObject.mockResolvedValue({ exists: false, contentLength: null, contentType: null });

      const missingFileEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      await expect(
        service.handleWorkerEvent('job-manga-123', missingFileEvent),
      ).rejects.toThrow('ARTIFACT_NOT_FOUND_IN_STORAGE');
    });

    it('should reject when clean base file has invalid contentType in MinIO (stat check)', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);
      storageService.statInternalObject.mockResolvedValue({
        exists: true,
        contentLength: 50000,
        contentType: 'image/png',
      });

      const invalidMimeEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      await expect(
        service.handleWorkerEvent('job-manga-123', invalidMimeEvent),
      ).rejects.toThrow('ARTIFACT_INVALID_CONTENT_TYPE');
    });

    it('should accept when clean bases cover 100% pages with positive file size and image/webp contentType', async () => {
      jobRepo.findOne.mockResolvedValue(validMangaJob);
      storageService.statInternalObject.mockResolvedValue({
        exists: true,
        contentLength: 50000,
        contentType: 'image/webp',
      });

      const validEvent: any = {
        eventId: 'e-1',
        attemptNumber: 1,
        sequence: 1,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      const result = await service.handleWorkerEvent('job-manga-123', validEvent);
      expect(result.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
    });
  });

  describe('Materialization Clean Base Preservation Regression (#171, #162)', () => {
    it('should preserve cleanBases from original manifest in materialized manifest', async () => {
      const existingManifest: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp',
            previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp',
            width: 100,
            height: 100,
            fileSizeBytes: 100,
          },
        ],
        cleanBases: [
          { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
        ],
      };

      const jobInReview = {
        ...validMangaJob,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 1,
        materializedRevision: 0,
        resultManifest: existingManifest,
      };

      jobRepo.createQueryBuilder.mockReturnValue({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(jobInReview),
      });

      let updatedSetValues: any = null;
      const mockTxJobQb = {
        useTransaction: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(jobInReview),
      };
      const mockTxJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(mockTxJobQb),
      };

      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        return cb({
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue(jobInReview),
          getRepository: jest.fn().mockReturnValue(mockTxJobRepo),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockImplementation((val) => {
              updatedSetValues = val;
              return {
                where: jest.fn().mockReturnValue({
                  execute: jest.fn().mockResolvedValue({ affected: 1 }),
                }),
              };
            }),
          }),
        });
      });

      storageService.statInternalObject.mockResolvedValue({ exists: true, contentLength: 200, contentType: 'image/webp' });

      const dto: any = {
        targetRevision: 1,
        mediaFormat: 'COMIC',
        result: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: 'ai/jobs/job-manga-123/materializations/rev-1/page_1.webp',
              previewKey: 'ai/jobs/job-manga-123/materializations/rev-1/page_1.webp',
              width: 100,
              height: 100,
              fileSizeBytes: 200,
            },
          ],
        },
      };

      const res = await service.completeMaterialization('job-manga-123', dto);
      expect(res.outcome).toBe('APPLIED');
      expect(updatedSetValues).toBeDefined();
      expect(updatedSetValues.resultManifest.cleanBases).toEqual([
        { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
      ]);
    });
  });

  describe('Lifecycle Cleanup on Apply (Post-Commit Non-Blocking)', () => {
    it('should delete clean base objects outside transaction after successful apply', async () => {
      const mockJob = {
        ...validMangaJob,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 1,
        materializedRevision: 1,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        return cb({
          query: jest.fn(),
          findOne: jest.fn().mockImplementation((entity, opts) => {
            if (opts?.where?.id === 'job-manga-123') return mockJob;
            if (opts?.where?.chapterId === 'chap-1') return { versionNumber: 1 };
            if (opts?.where?.id === 'chap-1') return { id: 'chap-1', activeVersionId: 'ver-src-1' };
            return null;
          }),
          create: jest.fn().mockImplementation((entity, data) => ({ id: 'new-ver-1', ...data })),
          save: jest.fn().mockImplementation((entity, data) => data),
        });
      });

      const user = { id: 'user-1', role: 'ADMIN' };
      const applyDto: any = { mode: 'CREATE_ALTERNATE_VERSION' };

      const res = await service.applyJob('job-manga-123', applyDto, user);

      expect(res.chapterId).toBe('chap-1');
      expect(storageService.deleteInternalObject).toHaveBeenCalledWith(
        'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp',
        true,
      );
    });

    it('should not fail apply if storage delete throws (best-effort resilience)', async () => {
      const mockJob = {
        ...validMangaJob,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 1,
        materializedRevision: 1,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: 'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp' },
          ],
        },
      };

      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        return cb({
          query: jest.fn(),
          findOne: jest.fn().mockImplementation((entity, opts) => {
            if (opts?.where?.id === 'job-manga-123') return mockJob;
            if (opts?.where?.chapterId === 'chap-1') return { versionNumber: 1 };
            if (opts?.where?.id === 'chap-1') return { id: 'chap-1', activeVersionId: 'ver-src-1' };
            return null;
          }),
          create: jest.fn().mockImplementation((entity, data) => ({ id: 'new-ver-1', ...data })),
          save: jest.fn().mockImplementation((entity, data) => data),
        });
      });

      storageService.deleteInternalObject.mockRejectedValue(new Error('S3 timeout'));

      const user = { id: 'user-1', role: 'ADMIN' };
      const applyDto: any = { mode: 'CREATE_ALTERNATE_VERSION' };

      // Vẫn thành công, không ném exception ra ngoài
      const res = await service.applyJob('job-manga-123', applyDto, user);
      expect(res.chapterId).toBe('chap-1');
    });
  });

  describe('Retry Stale-PUT Isolation Regression (Blocker A)', () => {
    it('should isolate clean base keys by attempt and reject stale attempt manifest callback', async () => {
      // 1. job.attemptCount = 1
      const jobAttempt1 = {
        ...validMangaJob,
        attemptCount: 1,
        status: TranslationJobStatus.QUALITY_CHECK,
      };
      jobRepo.findOne.mockResolvedValue(jobAttempt1);

      // 2. attempt 1 obtains slot
      const slot1 = await service.createCleanBaseUploadUrls('job-manga-123', 1, [1]);
      expect(slot1.cleanBases[0].storageKey).toBe(
        'ai/jobs/job-manga-123/review-base/attempt-1/page_1.webp',
      );

      // 3. retry -> attemptCount = 2
      const jobAttempt2 = {
        ...validMangaJob,
        attemptCount: 2,
        status: TranslationJobStatus.QUALITY_CHECK,
      };
      jobRepo.findOne.mockResolvedValue(jobAttempt2);

      // 4. attempt 2 obtains authoritative slot
      const slot2 = await service.createCleanBaseUploadUrls('job-manga-123', 2, [1]);
      expect(slot2.cleanBases[0].storageKey).toBe(
        'ai/jobs/job-manga-123/review-base/attempt-2/page_1.webp',
      );

      // 5. Assert key attempt1 != key attempt2 (attempt-scoped isolation)
      expect(slot1.cleanBases[0].storageKey).not.toBe(slot2.cleanBases[0].storageKey);

      // 6. Stale Attempt 1 tries to submit READY callback using its old attempt-1 key when job is at attempt 2
      // Transaction returns STALE_ATTEMPT for eventDto.attemptNumber !== job.attemptCount
      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        return cb({
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue(jobAttempt2),
        });
      });

      const staleAttempt1Event: any = {
        eventId: 'e-stale-1',
        attemptNumber: 1, // stale attempt
        sequence: 10,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-1/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: slot1.cleanBases[0].storageKey },
          ],
        },
      };

      const staleResult = await service.handleWorkerEvent('job-manga-123', staleAttempt1Event);
      expect(staleResult).toEqual({
        received: true,
        ignored: true,
        reason: 'STALE_ATTEMPT',
      });

      // 7. Authoritative Attempt 2 submits READY callback with its attempt-2 key
      const jobAfterReady = {
        ...jobAttempt2,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        lastSequence: 11,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-2/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-2/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: slot2.cleanBases[0].storageKey },
          ],
        },
      };

      let savedManifest: any = null;
      dataSource.transaction = jest.fn().mockImplementation(async (cb) => {
        return cb({
          query: jest.fn().mockImplementation((sql, params) => {
            if (params && params[5]) {
              savedManifest = JSON.parse(params[5]);
            }
          }),
          findOne: jest.fn().mockResolvedValue(jobAttempt2),
          delete: jest.fn().mockResolvedValue(undefined),
          create: jest.fn().mockImplementation((entity, data) => data),
          save: jest.fn(),
        });
      });

      storageService.statInternalObject.mockResolvedValue({
        exists: true,
        contentLength: 45000,
        contentType: 'image/webp',
      });

      const validAttempt2Event: any = {
        eventId: 'e-auth-2',
        attemptNumber: 2,
        sequence: 11,
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        progress: 100,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'ai/jobs/job-manga-123/attempt-2/p1.webp', previewKey: 'ai/jobs/job-manga-123/attempt-2/p1.webp', width: 100, height: 100, fileSizeBytes: 100 },
          ],
          cleanBases: [
            { page: 1, cleanBaseKey: slot2.cleanBases[0].storageKey },
          ],
        },
      };

      const authResult = await service.handleWorkerEvent('job-manga-123', validAttempt2Event);
      expect(authResult.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
      expect(savedManifest).toBeDefined();
      expect(savedManifest.cleanBases[0].cleanBaseKey).toBe(
        'ai/jobs/job-manga-123/review-base/attempt-2/page_1.webp',
      );
    });
  });
});
