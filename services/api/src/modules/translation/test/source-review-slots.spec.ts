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
import { ApplyTranslationMode } from '../dto/apply-translation-job.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('Source Review Slots & Package-Backed Manga Verification (#159)', () => {
  let service: TranslationService;
  let jobRepo: any;
  let storageService: any;
  let dataSource: any;

  const validJobId = '550e8400-e29b-41d4-a716-446655440000';

  const baseMangaJob: any = {
    id: validJobId,
    attemptCount: 1,
    status: TranslationJobStatus.PREPROCESSING,
    sourceVersionId: 'ver-src-1',
    sourceUploadSessionId: 'sess-zip-1',
    sourceUploadSession: {
      id: 'sess-zip-1',
      fileType: 'MANGA_ZIP',
    },
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
      createInternalUploadUrl: jest
        .fn()
        .mockImplementation((key) => `https://minio.local/put/${key}`),
      headInternalObject: jest.fn().mockResolvedValue(true),
      statInternalObject: jest.fn().mockImplementation((key: string) => {
        let contentType = 'image/jpeg';
        if (key.endsWith('.png')) contentType = 'image/png';
        if (key.endsWith('.webp')) contentType = 'image/webp';
        if (key.endsWith('.avif')) contentType = 'image/avif';
        return {
          exists: true,
          contentLength: 2048,
          contentType,
        };
      }),
      deleteInternalObject: jest.fn().mockResolvedValue(undefined),
      deleteInternalPrefix: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      query: jest.fn(),
      transaction: jest.fn().mockImplementation((cb) =>
        cb({
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue({
            ...baseMangaJob,
            status: TranslationJobStatus.QUALITY_CHECK,
          }),
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
        {
          provide: getRepositoryToken(StoryMember),
          useValue: {
            findOne: jest.fn().mockResolvedValue({ role: 'OWNER' }),
          },
        },
        { provide: StorageService, useValue: storageService },
        {
          provide: TranslationGateway,
          useValue: {
            broadcastJobProgress: jest.fn(),
            broadcastJobReady: jest.fn(),
            broadcastJobFailed: jest.fn(),
            broadcastJobCanceled: jest.fn(),
          },
        },
        {
          provide: TranslationProcessor,
          useValue: { abortAttempt: jest.fn() },
        },
        { provide: DataSource, useValue: dataSource },
        {
          provide: 'BullQueue_translation',
          useValue: { getJob: jest.fn() },
        },
        {
          provide: 'BullQueue_translation-materialization',
          useValue: { getJob: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  describe('createSourceReviewUploadUrls (Slot Protocol - #159)', () => {
    it('should grant slots when job is in PREPROCESSING and attempt matches', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.PREPROCESSING,
        attemptCount: 1,
      });

      const res = await service.createSourceReviewUploadUrls(validJobId, 1, [
        { pageNumber: 1, mimeType: 'image/jpeg' },
        { pageNumber: 2, mimeType: 'image/png' },
        { pageNumber: 3, mimeType: 'image/webp' },
        { pageNumber: 4, mimeType: 'image/avif' },
      ]);

      expect(res.jobId).toBe(validJobId);
      expect(res.attemptNumber).toBe(1);
      expect(res.sourcePages).toHaveLength(4);

      // Verify canonical keys mapping
      expect(res.sourcePages[0].storageKey).toBe(
        `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
      );
      expect(res.sourcePages[1].storageKey).toBe(
        `ai/jobs/${validJobId}/source-review/attempt-1/page_2.png`,
      );
      expect(res.sourcePages[2].storageKey).toBe(
        `ai/jobs/${validJobId}/source-review/attempt-1/page_3.webp`,
      );
      expect(res.sourcePages[3].storageKey).toBe(
        `ai/jobs/${validJobId}/source-review/attempt-1/page_4.avif`,
      );
    });

    it('should reject when job is NOT in PREPROCESSING (Least-Privilege Gate)', async () => {
      const forbiddenStatuses = [
        TranslationJobStatus.CREATED,
        TranslationJobStatus.QUEUED,
        TranslationJobStatus.OCR,
        TranslationJobStatus.TRANSLATING,
        TranslationJobStatus.INPAINTING,
        TranslationJobStatus.TYPESETTING,
        TranslationJobStatus.QUALITY_CHECK,
      ];

      for (const status of forbiddenStatuses) {
        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          status,
        });

        await expect(
          service.createSourceReviewUploadUrls(validJobId, 1, [
            { pageNumber: 1, mimeType: 'image/jpeg' },
          ]),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('should reject stale attempt number', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.PREPROCESSING,
        attemptCount: 2, // Current is 2
      });

      // Request with attempt 1
      await expect(
        service.createSourceReviewUploadUrls(validJobId, 1, [
          { pageNumber: 1, mimeType: 'image/jpeg' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate page numbers', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.PREPROCESSING,
        attemptCount: 1,
      });

      await expect(
        service.createSourceReviewUploadUrls(validJobId, 1, [
          { pageNumber: 1, mimeType: 'image/jpeg' },
          { pageNumber: 1, mimeType: 'image/png' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid MIME types', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.PREPROCESSING,
        attemptCount: 1,
      });

      await expect(
        service.createSourceReviewUploadUrls(validJobId, 1, [
          { pageNumber: 1, mimeType: 'image/gif' as any },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject non-COMIC stories', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        project: {
          storyEdition: {
            story: { mediaFormat: MediaFormat.NOVEL },
          },
        },
      });

      await expect(
        service.createSourceReviewUploadUrls(validJobId, 1, [
          { pageNumber: 1, mimeType: 'image/jpeg' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('READY_FOR_REVIEW Gate & Package Enforcement (#159)', () => {
    const validManifestPages = [
      {
        page: 1,
        storageKey: `ai/jobs/${validJobId}/attempt-1/page_0001.webp`,
        previewKey: `ai/jobs/${validJobId}/attempt-1/page_0001.webp`,
        width: 1200,
        height: 1800,
        fileSizeBytes: 1024,
      },
      {
        page: 2,
        storageKey: `ai/jobs/${validJobId}/attempt-1/page_0002.webp`,
        previewKey: `ai/jobs/${validJobId}/attempt-1/page_0002.webp`,
        width: 1200,
        height: 1800,
        fileSizeBytes: 1024,
      },
    ];

    const validCleanBases = [
      {
        page: 1,
        cleanBaseKey: `ai/jobs/${validJobId}/review-base/attempt-1/page_1.webp`,
      },
      {
        page: 2,
        cleanBaseKey: `ai/jobs/${validJobId}/review-base/attempt-1/page_2.webp`,
      },
    ];

    const validSourceReview = {
      version: 1 as const,
      pages: [
        {
          page: 1,
          storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
        },
        {
          page: 2,
          storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_2.png`,
        },
      ],
    };

    it('should reject MANGA_ZIP job without sourceReview at READY_FOR_REVIEW (SOURCE_REVIEW_REQUIRED)', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        sourceUploadSession: { fileType: 'MANGA_ZIP' },
      });

      const manifestWithoutSourceReview: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validManifestPages,
        cleanBases: validCleanBases,
      };

      await expect(
        service.handleWorkerEvent(validJobId, {
          eventId: 'evt-1',
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          sequence: 1,
          attemptNumber: 1,
          progress: 100,
          resultManifest: manifestWithoutSourceReview,
        }),
      ).rejects.toThrow(/SOURCE_REVIEW_REQUIRED/);
    });

    it('should reject MANGA_ZIP job with incomplete sourceReview pages (SOURCE_REVIEW_PAGE_COVERAGE_MISMATCH)', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        sourceUploadSession: { fileType: 'MANGA_ZIP' },
      });

      const incompleteSourceReview = {
        version: 1 as const,
        pages: [
          {
            page: 1,
            storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
          },
          // Missing page 2!
        ],
      };

      const manifest: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validManifestPages,
        cleanBases: validCleanBases,
        sourceReview: incompleteSourceReview,
      };

      await expect(
        service.handleWorkerEvent(validJobId, {
          eventId: 'evt-2',
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          sequence: 1,
          attemptNumber: 1,
          progress: 100,
          resultManifest: manifest,
        }),
      ).rejects.toThrow(/SOURCE_REVIEW_PAGE_COVERAGE_MISMATCH/);
    });

    it('should reject sourceReview storageKey that escapes canonical jail or attempt', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        sourceUploadSession: { fileType: 'MANGA_ZIP' },
      });

      const forgedSourceReview = {
        version: 1 as const,
        pages: [
          {
            page: 1,
            // Wrong attempt: attempt-2 key in attempt-1 callback!
            storageKey: `ai/jobs/${validJobId}/source-review/attempt-2/page_1.jpg`,
          },
          {
            page: 2,
            storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_2.png`,
          },
        ],
      };

      const manifest: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validManifestPages,
        cleanBases: validCleanBases,
        sourceReview: forgedSourceReview,
      };

      await expect(
        service.handleWorkerEvent(validJobId, {
          eventId: 'evt-3',
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          sequence: 1,
          attemptNumber: 1,
          progress: 100,
          resultManifest: manifest,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when storage HEAD returns Content-Type mismatching extension', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        sourceUploadSession: { fileType: 'MANGA_ZIP' },
      });

      // Key ends with .jpg, but S3 stat returns image/png
      storageService.statInternalObject.mockImplementationOnce(() => ({
        exists: true,
        contentLength: 1024,
        contentType: 'image/png', // Mismatch!
      }));

      const manifest: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validManifestPages,
        cleanBases: validCleanBases,
        sourceReview: validSourceReview,
      };

      await expect(
        service.handleWorkerEvent(validJobId, {
          eventId: 'evt-4',
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          sequence: 1,
          attemptNumber: 1,
          progress: 100,
          resultManifest: manifest,
        }),
      ).rejects.toThrow(/ARTIFACT_INVALID_CONTENT_TYPE/);
    });

    it('should NOT require sourceReview for MANGA_IMAGE session', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        ...baseMangaJob,
        status: TranslationJobStatus.QUALITY_CHECK,
        sourceUploadSession: { fileType: 'MANGA_IMAGE' }, // Single image, not package
      });

      const manifestWithoutSourceReview: MangaResultManifestV1 = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validManifestPages,
        cleanBases: validCleanBases,
      };

      const res = await service.handleWorkerEvent(validJobId, {
        eventId: 'evt-5',
        stage: TranslationJobStatus.READY_FOR_REVIEW,
        sequence: 1,
        attemptNumber: 1,
        progress: 100,
        resultManifest: manifestWithoutSourceReview,
      });

      expect(res.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
    });
  });

  describe('APPLIED Full Prefix Cleanup (#159)', () => {
    it('should call deleteInternalPrefix on post-commit APPLIED lifecycle', async () => {
      const mangaJobWithSourceReview = {
        ...baseMangaJob,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${validJobId}/attempt-1/p1.webp`,
              previewKey: `ai/jobs/${validJobId}/attempt-1/p1.webp`,
              width: 100,
              height: 100,
              fileSizeBytes: 100,
            },
          ],
          sourceReview: {
            version: 1,
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
              },
            ],
          },
        },
      };

      dataSource.transaction.mockImplementation(async (cb: any) => {
        return cb({
          query: jest.fn(),
          findOne: jest.fn().mockImplementation((entity, opts) => {
            if (entity === TranslationJob) return mangaJobWithSourceReview;
            if (entity === Chapter)
              return { id: 'chap-1', activeVersionId: null };
            return null;
          }),
          save: jest.fn().mockImplementation((entity, data) => data),
          create: jest.fn().mockImplementation((entity, data) => ({
            id: 'new-ver-1',
            ...data,
          })),
        });
      });

      await service.applyJob(
        validJobId,
        { mode: ApplyTranslationMode.CREATE_ALTERNATE_VERSION },
        { id: 'user-1' },
      );

      // Must call deleteInternalPrefix with exact job-scoped source-review prefix
      expect(storageService.deleteInternalPrefix).toHaveBeenCalledWith(
        `ai/jobs/${validJobId}/source-review/`,
        true,
      );
    });
  });
});
