import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ChaptersService } from '../chapters.service';
import { ChaptersController } from '../chapters.controller';
import { Chapter } from '../entities/chapter.entity';
import { ChapterVersion } from '../entities/chapter-version.entity';
import { Volume } from '../entities/volume.entity';
import { MediaAsset } from '../entities/media-asset.entity';
import { ChapterErrorReport } from '../entities/chapter-error-report.entity';
import { ChapterArtifact } from '../entities/chapter-artifact.entity';
import { CanonicalPackagingService } from '../canonical-packaging.service';
import { StoryEdition } from '../../stories/entities/story-edition.entity';
import { RedisService } from '../../../redis/redis.service';
import { RATE_LIMIT_KEY } from '../../../common/decorators/rate-limit.decorator';
import {
  ChapterReportErrorType,
  ChapterReportStatus,
  GlobalRole,
  StoryMemberRole,
  StoryVisibility,
} from '@omninovel/shared';

describe('Chapter Content Reporting System (Phase 5C.6 Gates 2-5)', () => {
  let service: ChaptersService;
  let controller: ChaptersController;

  let mockChapterRepo: any;
  let mockVersionRepo: any;
  let mockReportRepo: any;
  let mockDataSource: any;
  let mockManager: any;

  const chapterId = '11111111-1111-4111-8111-111111111111';
  const versionId = '22222222-2222-4222-8222-222222222222';
  const storyId = '33333333-3333-4333-8333-333333333333';
  const reporterUser = { id: 'user-reader-1', role: GlobalRole.READER };
  const staffUser = { id: 'user-staff-1', role: GlobalRole.READER };
  const adminUser = { id: 'user-admin-1', role: GlobalRole.ADMIN };

  const publicStory = {
    id: storyId,
    visibility: StoryVisibility.PUBLIC,
  };

  const privateStory = {
    id: storyId,
    visibility: StoryVisibility.PRIVATE,
  };

  const sampleChapter = {
    id: chapterId,
    storyEdition: {
      story: publicStory,
    },
    activeVersionId: versionId,
  };

  const publishedVersion = {
    id: versionId,
    chapterId,
    versionNumber: 1,
    isPublished: true,
  };

  const unpublishedVersion = {
    id: versionId,
    chapterId,
    versionNumber: 2,
    isPublished: false,
  };

  beforeEach(async () => {
    mockManager = {
      findOne: jest.fn(),
      getRepository: jest.fn((entity) => {
        if (entity === Chapter) {
          return {
            findOne: jest.fn().mockImplementation((opts) => {
              if (opts?.where?.id === chapterId) return Promise.resolve(sampleChapter);
              return Promise.resolve(null);
            }),
          };
        }
        if (entity === ChapterVersion) {
          return {
            findOne: jest.fn().mockImplementation((opts) => {
              if (opts?.where?.id === versionId) return Promise.resolve(publishedVersion);
              return Promise.resolve(null);
            }),
          };
        }
        return {};
      }),
      query: jest.fn().mockResolvedValue([]),
      create: jest.fn((entity, data) => ({ id: 'report-new-uuid', ...data })),
      save: jest.fn((entity) => Promise.resolve({ id: 'report-new-uuid', ...entity })),
    };

    mockDataSource = {
      transaction: jest.fn((cb) => cb(mockManager)),
      query: jest.fn().mockResolvedValue([]),
    };

    mockChapterRepo = {
      findOne: jest.fn().mockImplementation((opts) => {
        if (opts?.where?.id === chapterId) return Promise.resolve(sampleChapter);
        return Promise.resolve(null);
      }),
    };

    mockVersionRepo = {
      findOne: jest.fn().mockImplementation((opts) => {
        if (opts?.where?.id === versionId) return Promise.resolve(publishedVersion);
        return Promise.resolve(null);
      }),
    };

    mockReportRepo = {
      create: jest.fn(),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChaptersController],
      providers: [
        ChaptersService,
        { provide: getRepositoryToken(Chapter), useValue: mockChapterRepo },
        { provide: getRepositoryToken(ChapterVersion), useValue: mockVersionRepo },
        { provide: getRepositoryToken(Volume), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
        { provide: getRepositoryToken(ChapterErrorReport), useValue: mockReportRepo },
        { provide: getRepositoryToken(ChapterArtifact), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: CanonicalPackagingService, useValue: { getArtifactStatus: jest.fn(), enqueuePackaging: jest.fn() } },
        { provide: DataSource, useValue: mockDataSource },
        { provide: RedisService, useValue: { checkRateLimit: jest.fn() } },
      ],
    }).compile();

    service = module.get<ChaptersService>(ChaptersService);
    controller = module.get<ChaptersController>(ChaptersController);
  });

  describe('Gate 2 — Access Policy & Exact Rendered Version Invariants', () => {
    it('PUBLIC story + published version -> 201 Created thành công cho độc giả', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);

      const res = await service.createReport(
        chapterId,
        {
          chapterVersionId: versionId,
          errorType: ChapterReportErrorType.IMAGE_CORRUPT,
          pageNumber: 3,
        },
        reporterUser,
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe(ChapterReportStatus.PENDING);
      expect(res.reportId).toBe('report-new-uuid');
    });

    it('Chapter không tồn tại -> 404 Not Found', async () => {
      mockManager.findOne.mockResolvedValue(null);

      await expect(
        service.createReport(
          '99999999-9999-4999-8999-999999999999',
          {
            chapterVersionId: versionId,
            errorType: ChapterReportErrorType.TYPO,
          },
          reporterUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('PRIVATE story + non-member reader -> 403 Forbidden', async () => {
      const privateChapter = {
        ...sampleChapter,
        storyEdition: { story: privateStory },
      };
      mockManager.findOne.mockResolvedValue(privateChapter);
      mockManager.getRepository = jest.fn(() => ({
        findOne: jest.fn().mockResolvedValue(privateChapter),
      }));
      mockManager.query.mockResolvedValue([]); // Không có role trong story_members

      await expect(
        service.createReport(
          chapterId,
          {
            chapterVersionId: versionId,
            errorType: ChapterReportErrorType.TYPO,
          },
          reporterUser,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Unpublished version + ordinary reader -> 403 Forbidden', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);
      mockManager.getRepository = jest.fn((entity) => {
        if (entity === Chapter) {
          return { findOne: jest.fn().mockResolvedValue(sampleChapter) };
        }
        if (entity === ChapterVersion) {
          return { findOne: jest.fn().mockResolvedValue(unpublishedVersion) };
        }
        return {};
      });
      mockManager.query.mockResolvedValue([]); // User thường không có role

      await expect(
        service.createReport(
          chapterId,
          {
            chapterVersionId: versionId,
            errorType: ChapterReportErrorType.TRANSLATION_ERROR,
          },
          reporterUser,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Unpublished version + story staff (TRANSLATOR) -> 201 Created', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);
      mockManager.getRepository = jest.fn((entity) => {
        if (entity === Chapter) {
          return { findOne: jest.fn().mockResolvedValue(sampleChapter) };
        }
        if (entity === ChapterVersion) {
          return { findOne: jest.fn().mockResolvedValue(unpublishedVersion) };
        }
        return {};
      });
      // User staff có role TRANSLATOR trong story
      mockManager.query.mockImplementation((sql: string) => {
        if (sql.includes('story_members')) {
          return Promise.resolve([{ role: StoryMemberRole.TRANSLATOR }]);
        }
        return Promise.resolve([]);
      });

      const res = await service.createReport(
        chapterId,
        {
          chapterVersionId: versionId,
          errorType: ChapterReportErrorType.TRANSLATION_ERROR,
          anchorBlockId: 'p-12',
        },
        staffUser,
      );

      expect(res.success).toBe(true);
      expect(res.status).toBe(ChapterReportStatus.PENDING);
    });

    it('Unpublished version + ADMIN -> 201 Created', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);
      mockManager.getRepository = jest.fn((entity) => {
        if (entity === Chapter) {
          return { findOne: jest.fn().mockResolvedValue(sampleChapter) };
        }
        if (entity === ChapterVersion) {
          return { findOne: jest.fn().mockResolvedValue(unpublishedVersion) };
        }
        return {};
      });
      mockManager.query.mockResolvedValue([]);

      const res = await service.createReport(
        chapterId,
        {
          chapterVersionId: versionId,
          errorType: ChapterReportErrorType.OTHER,
        },
        adminUser,
      );

      expect(res.success).toBe(true);
    });
  });

  describe('Gate 3 — Version Mismatch & Structured XOR Constraints', () => {
    it('Foreign chapterVersionId không thuộc chapter -> 400 CHAPTER_REPORT_VERSION_MISMATCH', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);
      const foreignVersion = {
        id: 'foreign-version-uuid',
        chapterId: 'other-chapter-uuid', // Không khớp chapterId
        isPublished: true,
      };
      mockManager.getRepository = jest.fn((entity) => {
        if (entity === Chapter) return { findOne: jest.fn().mockResolvedValue(sampleChapter) };
        if (entity === ChapterVersion) return { findOne: jest.fn().mockResolvedValue(foreignVersion) };
        return {};
      });

      try {
        await service.createReport(
          chapterId,
          {
            chapterVersionId: 'foreign-version-uuid',
            errorType: ChapterReportErrorType.IMAGE_CORRUPT,
          },
          reporterUser,
        );
        fail('Should throw BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({
          code: 'CHAPTER_REPORT_VERSION_MISMATCH',
        });
      }
    });

    it('Vừa có pageNumber vừa có anchorBlockId -> 400 CHAPTER_REPORT_MUTUAL_EXCLUSION', async () => {
      try {
        await service.createReport(
          chapterId,
          {
            chapterVersionId: versionId,
            errorType: ChapterReportErrorType.TYPO,
            pageNumber: 5,
            anchorBlockId: 'block-9',
          },
          reporterUser,
        );
        fail('Should throw BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({
          code: 'CHAPTER_REPORT_MUTUAL_EXCLUSION',
        });
      }
    });

    it('pageNumber < 1 -> 400 BadRequestException', async () => {
      await expect(
        service.createReport(
          chapterId,
          {
            chapterVersionId: versionId,
            errorType: ChapterReportErrorType.IMAGE_CORRUPT,
            pageNumber: 0,
          },
          reporterUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Gate 4 — Concurrency & NULL-safe Duplicate Semantics', () => {
    it('2 concurrent requests cùng tuple exact location -> 1 request 201, 1 request 409 CHAPTER_REPORT_DUPLICATE', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);

      let callCount = 0;
      mockManager.query.mockImplementation((sql: string) => {
        if (sql.includes('chapter_error_reports')) {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve([]); // Lần 1: Không có duplicate
          }
          // Lần 2: Đã có duplicate từ request 1 vừa commit
          return Promise.resolve([{ id: 'existing-dup-id' }]);
        }
        return Promise.resolve([]);
      });

      const payload = {
        chapterVersionId: versionId,
        errorType: ChapterReportErrorType.IMAGE_CORRUPT,
        pageNumber: 3,
      };

      const p1 = service.createReport(chapterId, payload, reporterUser);
      const p2 = service.createReport(chapterId, payload, reporterUser);

      const results = await Promise.allSettled([p1, p2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(ConflictException);
      expect(rejectedError.getResponse()).toMatchObject({
        code: 'CHAPTER_REPORT_DUPLICATE',
      });
    });

    it('Khác pageNumber -> cả 2 đều thành công 201', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);
      mockManager.query.mockResolvedValue([]); // Không trùng

      const r1 = await service.createReport(
        chapterId,
        {
          chapterVersionId: versionId,
          errorType: ChapterReportErrorType.IMAGE_CORRUPT,
          pageNumber: 3,
        },
        reporterUser,
      );

      const r2 = await service.createReport(
        chapterId,
        {
          chapterVersionId: versionId,
          errorType: ChapterReportErrorType.IMAGE_CORRUPT,
          pageNumber: 18,
        },
        reporterUser,
      );

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it('Whole chapter duplicate (cả 2 đều null page & anchor) -> request 1 201, request 2 409', async () => {
      mockManager.findOne.mockResolvedValue(sampleChapter);

      let queryCalls = 0;
      mockManager.query.mockImplementation((sql: string) => {
        if (sql.includes('chapter_error_reports')) {
          queryCalls++;
          if (queryCalls === 1) return Promise.resolve([]);
          return Promise.resolve([{ id: 'dup-whole-chapter' }]);
        }
        return Promise.resolve([]);
      });

      const wholeChapterDto = {
        chapterVersionId: versionId,
        errorType: ChapterReportErrorType.INAPPROPRIATE_CONTENT,
      };

      const res1 = await service.createReport(chapterId, wholeChapterDto, reporterUser);
      expect(res1.success).toBe(true);

      await expect(
        service.createReport(chapterId, wholeChapterDto, reporterUser),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Gate 5 — Rate Limit Decorator Metadata & RouteParam Configuration', () => {
    it('Endpoint POST chapters/:id/reports được gắn RateLimit với routeParam: "id" và scope IP_AND_USER', () => {
      const reflector = new Reflector();
      const rateLimitMeta = reflector.get(
        RATE_LIMIT_KEY,
        ChaptersController.prototype.createReport,
      );

      expect(rateLimitMeta).toBeDefined();
      expect(rateLimitMeta.limit).toBe(3);
      expect(rateLimitMeta.ttlSeconds).toBe(60);
      expect(rateLimitMeta.keyPrefix).toBe('chapter_report');
      expect(rateLimitMeta.routeParam).toBe('id');
      expect(rateLimitMeta.scope).toBe('IP_AND_USER');
    });
  });
});
