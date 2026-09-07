import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  MediaAssetType,
  MediaFormat,
  TranslationJobStatus,
  MangaResultManifestV1,
} from '@omninovel/shared';
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
import {
  FindJobPreviewsQueryDto,
  normalizePreviewWindow,
} from '../dto/find-job-previews-query.dto';

describe('Lazy Bounded Manga Preview API - Unit Tests (#155)', () => {
  describe('RED 0: Query Contract & Bounded Window', () => {
    it('accepts valid single pageNumber mode', () => {
      const window = normalizePreviewWindow({ pageNumber: 3 });
      expect(window).toEqual({ fromPage: 3, toPage: 3 });
    });

    it('accepts valid range mode with window <= 5', () => {
      const window = normalizePreviewWindow({ fromPage: 1, toPage: 5 });
      expect(window).toEqual({ fromPage: 1, toPage: 5 });
    });

    it('accepts valid range mode with single page (fromPage === toPage)', () => {
      const window = normalizePreviewWindow({ fromPage: 2, toPage: 2 });
      expect(window).toEqual({ fromPage: 2, toPage: 2 });
    });

    it('rejects when neither mode is provided (PREVIEW_WINDOW_REQUIRED)', () => {
      expect(() => normalizePreviewWindow({})).toThrow(BadRequestException);
      try {
        normalizePreviewWindow({});
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'PREVIEW_WINDOW_REQUIRED',
        });
      }
    });

    it('rejects when both pageNumber and range params are provided (PREVIEW_WINDOW_AMBIGUOUS)', () => {
      expect(() =>
        normalizePreviewWindow({ pageNumber: 1, fromPage: 1 }),
      ).toThrow(BadRequestException);

      try {
        normalizePreviewWindow({ pageNumber: 1, fromPage: 1, toPage: 3 });
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'PREVIEW_WINDOW_AMBIGUOUS',
        });
      }
    });

    it('rejects when only fromPage or only toPage is provided (PREVIEW_RANGE_INCOMPLETE)', () => {
      try {
        normalizePreviewWindow({ fromPage: 1 });
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'PREVIEW_RANGE_INCOMPLETE',
        });
      }

      try {
        normalizePreviewWindow({ toPage: 5 });
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'PREVIEW_RANGE_INCOMPLETE',
        });
      }
    });

    it('rejects when fromPage > toPage (INVALID_PREVIEW_RANGE)', () => {
      try {
        normalizePreviewWindow({ fromPage: 5, toPage: 1 });
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'INVALID_PREVIEW_RANGE',
        });
      }
    });

    it('rejects when window exceeds 5 pages (WINDOW_TOO_LARGE)', () => {
      try {
        normalizePreviewWindow({ fromPage: 1, toPage: 6 });
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'WINDOW_TOO_LARGE',
        });
      }
    });

    describe('Class-Validator Validation on Query DTO', () => {
      it('validates correct positive integers', async () => {
        const dto = plainToInstance(FindJobPreviewsQueryDto, {
          pageNumber: '3',
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it('rejects zero or negative pageNumber', async () => {
        const dtoZero = plainToInstance(FindJobPreviewsQueryDto, {
          pageNumber: '0',
        });
        const errorsZero = await validate(dtoZero);
        expect(errorsZero.length).toBeGreaterThan(0);

        const dtoNeg = plainToInstance(FindJobPreviewsQueryDto, {
          pageNumber: '-1',
        });
        const errorsNeg = await validate(dtoNeg);
        expect(errorsNeg.length).toBeGreaterThan(0);
      });

      it('rejects non-integer numbers', async () => {
        const dto = plainToInstance(FindJobPreviewsQueryDto, {
          fromPage: '1.5',
          toPage: '3',
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Service Execution (RED 1 - RED 5)', () => {
    let service: TranslationService;
    let jobRepo: any;
    let mediaAssetRepo: any;
    let storyMemberRepo: any;
    let storageService: any;
    let dataSource: any;

    const validJobId = '550e8400-e29b-41d4-a716-446655440000';
    const adminUser = { id: 'user-admin', role: 'ADMIN' };
    const memberUser = { id: 'user-editor', role: 'TRANSLATOR' };
    const nonMemberUser = { id: 'user-stranger', role: 'READER' };

    const validManifest: MangaResultManifestV1 = {
      version: 1,
      mediaFormat: 'COMIC',
      pages: [
        {
          page: 1,
          storageKey: `ai/jobs/${validJobId}/attempt-1/p1.webp`,
          previewKey: `ai/jobs/${validJobId}/attempt-1/p1.webp`,
          width: 800,
          height: 1200,
          fileSizeBytes: 54321,
        },
        {
          page: 2,
          storageKey: `ai/jobs/${validJobId}/attempt-1/p2.webp`,
          previewKey: `ai/jobs/${validJobId}/materializations/rev-1/page_2.webp`,
          width: 800,
          height: 1200,
          fileSizeBytes: 51200,
        },
        {
          page: 3,
          storageKey: `ai/jobs/${validJobId}/attempt-1/p3.webp`,
          previewKey: `ai/jobs/${validJobId}/attempt-1/p3.webp`,
          width: 800,
          height: 1200,
          fileSizeBytes: 49800,
        },
      ],
    };

    const baseMangaJob: any = {
      id: validJobId,
      attemptCount: 1,
      status: TranslationJobStatus.READY_FOR_REVIEW,
      sourceVersionId: 'ver-src-123',
      resultManifest: validManifest,
      project: {
        id: 'proj-1',
        storyEdition: {
          id: 'ed-1',
          story: {
            id: 'story-1',
            mediaFormat: MediaFormat.COMIC,
          },
        },
      },
    };

    beforeEach(async () => {
      jobRepo = {
        findOne: jest.fn().mockResolvedValue({ ...baseMangaJob }),
      };

      mediaAssetRepo = {
        find: jest.fn().mockResolvedValue([]),
      };

      storyMemberRepo = {
        findOne: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === memberUser.id) {
            return Promise.resolve({ role: 'EDITOR' });
          }
          return Promise.resolve(null);
        }),
      };

      storageService = {
        createInternalDownloadUrl: jest
          .fn()
          .mockImplementation(
            (key, isManga, expiresIn) =>
              `https://storage.local/get/${key}?expiresIn=${expiresIn}`,
          ),
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
          { provide: getRepositoryToken(MediaAsset), useValue: mediaAssetRepo },
          { provide: getRepositoryToken(UploadSession), useValue: {} },
          {
            provide: getRepositoryToken(StoryMember),
            useValue: storyMemberRepo,
          },
          { provide: StorageService, useValue: storageService },
          {
            provide: TranslationGateway,
            useValue: { broadcastJobProgress: jest.fn() },
          },
          {
            provide: TranslationProcessor,
            useValue: { abortAttempt: jest.fn() },
          },
          { provide: DataSource, useValue: dataSource },
          { provide: 'BullQueue_translation', useValue: {} },
          { provide: 'BullQueue_translation-materialization', useValue: {} },
        ],
      }).compile();

      service = module.get<TranslationService>(TranslationService);
    });

    describe('RED 1: Authorization, Media Type & Status Gates', () => {
      it('allows Global ADMIN to query previews', async () => {
        const res = await service.getJobPreviews(validJobId, adminUser, {
          pageNumber: 1,
        });
        expect(res).toBeDefined();
        expect(res.resultAssets.length).toBe(1);
      });

      it('allows Story member with EDITOR/TRANSLATOR role to query previews', async () => {
        const res = await service.getJobPreviews(validJobId, memberUser, {
          pageNumber: 1,
        });
        expect(res).toBeDefined();
        expect(res.resultAssets.length).toBe(1);
      });

      it('rejects non-member with ForbiddenException (403)', async () => {
        await expect(
          service.getJobPreviews(validJobId, nonMemberUser, {
            pageNumber: 1,
          }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('throws NotFoundException (404) when TranslationJob does not exist', async () => {
        jobRepo.findOne.mockResolvedValueOnce(null);
        await expect(
          service.getJobPreviews('non-existent-id', adminUser, {
            pageNumber: 1,
          }),
        ).rejects.toThrow(NotFoundException);
      });

      it('throws NotFoundException (404) when Story context is missing', async () => {
        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          project: null,
        });
        await expect(
          service.getJobPreviews(validJobId, adminUser, {
            pageNumber: 1,
          }),
        ).rejects.toThrow(NotFoundException);
      });

      it('rejects non-COMIC stories with PREVIEWS_ONLY_SUPPORTED_FOR_COMIC (400)', async () => {
        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          project: {
            storyEdition: {
              story: { id: 'story-novel', mediaFormat: MediaFormat.NOVEL },
            },
          },
        });

        try {
          await service.getJobPreviews(validJobId, adminUser, {
            pageNumber: 1,
          });
          fail('Should have thrown BadRequestException');
        } catch (err: any) {
          expect(err).toBeInstanceOf(BadRequestException);
          expect(err.getResponse()).toMatchObject({
            code: 'PREVIEWS_ONLY_SUPPORTED_FOR_COMIC',
          });
        }
      });

      it('rejects jobs not in READY_FOR_REVIEW status with PREVIEWS_NOT_AVAILABLE_FOR_STATUS (409)', async () => {
        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          status: TranslationJobStatus.TRANSLATING,
        });

        try {
          await service.getJobPreviews(validJobId, adminUser, {
            pageNumber: 1,
          });
          fail('Should have thrown ConflictException');
        } catch (err: any) {
          expect(err).toBeInstanceOf(ConflictException);
          expect(err.getResponse()).toMatchObject({
            code: 'PREVIEWS_NOT_AVAILABLE_FOR_STATUS',
          });
        }
      });
    });

    describe('RED 2: SOURCE_REVIEW Precedence & Key Jail', () => {
      it('uses sourceReview over MediaAsset when sourceReview is present', async () => {
        const manifestWithSourceReview: MangaResultManifestV1 = {
          ...validManifest,
          sourceReview: {
            version: 1,
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
                width: 1000,
                height: 1500,
              },
              {
                page: 2,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_2.png`,
                width: 1000,
                height: 1500,
              },
            ],
          },
        };

        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          resultManifest: manifestWithSourceReview,
        });

        const res = await service.getJobPreviews(validJobId, adminUser, {
          fromPage: 1,
          toPage: 2,
        });

        // MediaAsset repo find must NOT be called because sourceReview took precedence
        expect(mediaAssetRepo.find).not.toHaveBeenCalled();

        expect(res.sourceAssets).toHaveLength(2);
        expect(res.sourceAssets[0]).toEqual({
          kind: 'SOURCE_REVIEW',
          pageNumber: 1,
          width: 1000,
          height: 1500,
          url: `https://storage.local/get/ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg?expiresIn=900`,
        });
        expect(res.sourceAssets[1]).toEqual({
          kind: 'SOURCE_REVIEW',
          pageNumber: 2,
          width: 1000,
          height: 1500,
          url: `https://storage.local/get/ai/jobs/${validJobId}/source-review/attempt-1/page_2.png?expiresIn=900`,
        });
      });

      it('filters sourceReview pages strictly within requested window', async () => {
        const manifestWithSourceReview: MangaResultManifestV1 = {
          ...validManifest,
          sourceReview: {
            version: 1,
            pages: [
              {
                page: 1,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_1.jpg`,
              },
              {
                page: 2,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_2.png`,
              },
              {
                page: 3,
                storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_3.webp`,
              },
            ],
          },
        };

        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          resultManifest: manifestWithSourceReview,
        });

        const res = await service.getJobPreviews(validJobId, adminUser, {
          pageNumber: 2,
        });

        expect(res.sourceAssets).toHaveLength(1);
        expect(res.sourceAssets[0].pageNumber).toBe(2);
      });

      it('rejects sourceReview storageKey violating canonical namespace (500)', async () => {
        const maliciousManifest: MangaResultManifestV1 = {
          ...validManifest,
          sourceReview: {
            version: 1,
            pages: [
              {
                page: 1,
                // foreign job or path traversal
                storageKey: `ai/jobs/other-job/source-review/attempt-1/page_1.jpg`,
              },
            ],
          },
        };

        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          resultManifest: maliciousManifest,
        });

        await expect(
          service.getJobPreviews(validJobId, adminUser, { pageNumber: 1 }),
        ).rejects.toThrow(InternalServerErrorException);
      });
    });

    describe('RED 3: SOURCE_MEDIA Fallback', () => {
      it('falls back to media_assets when sourceReview is absent', async () => {
        const mockMediaAssets = [
          {
            id: 'media-asset-uuid-1',
            versionId: 'ver-src-123',
            sortOrder: 1,
            assetType: MediaAssetType.MANGA_PAGE,
            storageKey: 'media/editions/ed-1/page_1.jpg',
            width: 900,
            height: 1400,
          },
          {
            id: 'media-asset-uuid-2',
            versionId: 'ver-src-123',
            sortOrder: 2,
            assetType: MediaAssetType.MANGA_PAGE,
            storageKey: 'media/editions/ed-1/page_2.jpg',
            width: 900,
            height: 1400,
          },
        ];

        mediaAssetRepo.find.mockResolvedValueOnce(mockMediaAssets);

        const res = await service.getJobPreviews(validJobId, adminUser, {
          fromPage: 1,
          toPage: 2,
        });

        expect(mediaAssetRepo.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              versionId: 'ver-src-123',
              assetType: MediaAssetType.MANGA_PAGE,
            }),
            order: { sortOrder: 'ASC', id: 'ASC' },
          }),
        );

        expect(res.sourceAssets).toHaveLength(2);
        expect(res.sourceAssets[0]).toEqual({
          kind: 'SOURCE_MEDIA',
          id: 'media-asset-uuid-1',
          pageNumber: 1,
          width: 900,
          height: 1400,
          url: 'https://storage.local/get/media/editions/ed-1/page_1.jpg?expiresIn=900',
        });
        expect(res.sourceAssets[1]).toEqual({
          kind: 'SOURCE_MEDIA',
          id: 'media-asset-uuid-2',
          pageNumber: 2,
          width: 900,
          height: 1400,
          url: 'https://storage.local/get/media/editions/ed-1/page_2.jpg?expiresIn=900',
        });
      });

      it('returns empty sourceAssets array when no media assets exist in requested window', async () => {
        mediaAssetRepo.find.mockResolvedValueOnce([]);

        const res = await service.getJobPreviews(validJobId, adminUser, {
          pageNumber: 1,
        });

        expect(res.sourceAssets).toEqual([]);
      });
    });

    describe('RED 4: RESULT Asset Resolution & Namespace Verification', () => {
      it('resolves RESULT assets within window supporting initial output and materialized namespaces', async () => {
        const res = await service.getJobPreviews(validJobId, adminUser, {
          fromPage: 1,
          toPage: 2,
        });

        expect(res.resultAssets).toHaveLength(2);
        // Page 1: Initial output namespace
        expect(res.resultAssets[0]).toEqual({
          kind: 'RESULT',
          pageNumber: 1,
          width: 800,
          height: 1200,
          fileSizeBytes: 54321,
          url: `https://storage.local/get/ai/jobs/${validJobId}/attempt-1/p1.webp?expiresIn=900`,
        });
        // Page 2: Materialized namespace
        expect(res.resultAssets[1]).toEqual({
          kind: 'RESULT',
          pageNumber: 2,
          width: 800,
          height: 1200,
          fileSizeBytes: 51200,
          url: `https://storage.local/get/ai/jobs/${validJobId}/materializations/rev-1/page_2.webp?expiresIn=900`,
        });
      });

      it('rejects foreign or malformed previewKey namespaces (500)', async () => {
        const corruptedManifest: MangaResultManifestV1 = {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            {
              page: 1,
              storageKey: `ai/jobs/${validJobId}/attempt-1/p1.webp`,
              previewKey: `arbitrary/bucket/foreign-object.webp`,
              width: 800,
              height: 1200,
              fileSizeBytes: 100,
            },
          ],
        };

        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          resultManifest: corruptedManifest,
        });

        await expect(
          service.getJobPreviews(validJobId, adminUser, { pageNumber: 1 }),
        ).rejects.toThrow(InternalServerErrorException);
      });
    });

    describe('RED 5: Response Privacy & Bounded Presigning', () => {
      it('ensures zero leakage of internal storage keys, diffAssets, or buckets', async () => {
        const res = await service.getJobPreviews(validJobId, adminUser, {
          pageNumber: 1,
        });

        const resStr = JSON.stringify(res);
        expect(resStr).not.toContain('storageKey');
        expect(resStr).not.toContain('previewKey');
        expect(resStr).not.toContain('cleanBaseKey');
        expect(resStr).not.toContain('diffAssets');
        expect(resStr).not.toContain('manga-media');
      });

      it('bounds presign calls to at most 10 for a 5-page window (5 source + 5 result)', async () => {
        const fivePagesManifest: MangaResultManifestV1 = {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [1, 2, 3, 4, 5].map((page) => ({
            page,
            storageKey: `ai/jobs/${validJobId}/attempt-1/p${page}.webp`,
            previewKey: `ai/jobs/${validJobId}/attempt-1/p${page}.webp`,
            width: 800,
            height: 1200,
            fileSizeBytes: 50000,
          })),
          sourceReview: {
            version: 1,
            pages: [1, 2, 3, 4, 5].map((page) => ({
              page,
              storageKey: `ai/jobs/${validJobId}/source-review/attempt-1/page_${page}.jpg`,
            })),
          },
        };

        jobRepo.findOne.mockResolvedValueOnce({
          ...baseMangaJob,
          resultManifest: fivePagesManifest,
        });

        storageService.createInternalDownloadUrl.mockClear();

        const res = await service.getJobPreviews(validJobId, adminUser, {
          fromPage: 1,
          toPage: 5,
        });

        expect(res.sourceAssets).toHaveLength(5);
        expect(res.resultAssets).toHaveLength(5);
        expect(storageService.createInternalDownloadUrl).toHaveBeenCalledTimes(
          10,
        );
      });
    });
  });
});
