import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
import { ChapterArtifact } from '../../chapters/entities/chapter-artifact.entity';
import { CanonicalPackagingService } from '../../chapters/canonical-packaging.service';
import {
  GlobalRole,
  MediaFormat,
  StoryMemberRole,
  TranslationJobStatus,
} from '@omninovel/shared';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('Translation Foundation (#144, #148, #155 Read-only)', () => {
  let service: TranslationService;
  let jobRepo: any;
  let projectRepo: any;
  let segmentRepo: any;
  let storyMemberRepo: any;
  let dataSource: any;

  const adminUser = { id: 'admin-1', role: GlobalRole.ADMIN };
  const translatorUser = { id: 'user-1', role: GlobalRole.TRANSLATOR };

  beforeEach(async () => {
    jobRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    projectRepo = {
      createQueryBuilder: jest.fn(),
    };

    segmentRepo = {
      createQueryBuilder: jest.fn(),
    };

    storyMemberRepo = {
      findOne: jest.fn(),
    };

    dataSource = {
      query: jest.fn(),
      transaction: jest.fn().mockImplementation((...args: any[]) => {
        const callback = typeof args[0] === 'function' ? args[0] : args[1];
        const managerMock = {
          findOne: jobRepo.findOne,
          find: segmentRepo.find,
          count: segmentRepo.count,
          createQueryBuilder: segmentRepo.createQueryBuilder,
          getRepository: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationSegment) return segmentRepo;
            if (entity === TranslationJob) return jobRepo;
            if (entity === StoryMember) return storyMemberRepo;
            return {};
          }),
          query: dataSource.query,
        };
        return callback(managerMock);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: jobRepo },
        { provide: getRepositoryToken(TranslationProject), useValue: projectRepo },
        { provide: getRepositoryToken(TranslationGlossary), useValue: {} },
        { provide: getRepositoryToken(TranslationSegment), useValue: segmentRepo },
        { provide: getRepositoryToken(ChapterVersion), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(UploadSession), useValue: {} },
        { provide: getRepositoryToken(ChapterArtifact), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: storyMemberRepo },
        { provide: 'BullQueue_translation', useValue: {} },
        { provide: 'BullQueue_translation-materialization', useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: CanonicalPackagingService, useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: TranslationGateway, useValue: {} },
        { provide: TranslationProcessor, useValue: {} },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  describe('#144: getProjects()', () => {
    it('should query projects with deterministic ordering and lateral latestJob without N+1', async () => {
      const qbMock: any = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [
            {
              id: 'proj-1',
              storyEditionId: 'edition-1',
              sourceLanguage: 'ja',
              targetLanguage: 'vi',
              createdAt: new Date('2026-09-01T00:00:00Z'),
              storyEdition: {
                story: { id: 'story-1' },
              },
            },
          ],
          raw: [
            {
              latest_job_id: 'job-1',
              latest_job_status: TranslationJobStatus.READY_FOR_REVIEW,
              latest_job_progress: 100,
            },
          ],
        }),
      };
      projectRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getProjects(adminUser, { page: 1, limit: 20 });

      expect(projectRepo.createQueryBuilder).toHaveBeenCalledWith('project');
      expect(qbMock.getCount).toHaveBeenCalled();
      expect(qbMock.orderBy).toHaveBeenCalledWith('project.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('project.id', 'DESC');
      expect(result.data.length).toBe(1);
      expect(result.data[0].latestJob).toEqual({
        id: 'job-1',
        status: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
      });
      expect(result.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('should enforce story membership filter for non-admin user', async () => {
      const qbMock: any = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
      };
      projectRepo.createQueryBuilder.mockReturnValue(qbMock);

      await service.getProjects(translatorUser, { page: 1, limit: 20 });

      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS ('),
        expect.objectContaining({ userId: translatorUser.id }),
      );
    });
  });

  describe('#144: getJobs()', () => {
    it('should paginate jobs with deterministic sort and filter support', async () => {
      const qbMock: any = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([
          [
            {
              id: 'job-1',
              projectId: 'proj-1',
              status: TranslationJobStatus.TRANSLATING,
              progressPercentage: 45,
              provider: 'OPENAI',
              modelName: 'gpt-4o-mini',
              createdAt: new Date(),
              startedAt: new Date(),
              heartbeatAt: new Date('2026-09-01T00:05:00Z'),
              completedAt: null,
              project: {
                sourceLanguage: 'ja',
                targetLanguage: 'vi',
                storyEdition: {
                  id: 'edition-1',
                  editionName: 'Bản Dịch Chuẩn',
                  story: {
                    id: 'story-1',
                    title: 'One Piece',
                    slug: 'one-piece',
                    mediaFormat: MediaFormat.COMIC,
                  },
                },
              },
              sourceVersion: {
                chapter: { id: 'chap-1', chapterNumber: '100.00', title: 'Chapter 100' },
              },
            },
          ],
          1,
        ]),
      };
      jobRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getJobs(adminUser, {
        storyId: 'story-1',
        status: TranslationJobStatus.TRANSLATING,
        page: 1,
        limit: 10,
      });

      expect(qbMock.andWhere).toHaveBeenCalledWith('story.id = :storyId', { storyId: 'story-1' });
      expect(qbMock.andWhere).toHaveBeenCalledWith('job.status = :status', {
        status: TranslationJobStatus.TRANSLATING,
      });
      expect(qbMock.orderBy).toHaveBeenCalledWith('job.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('job.id', 'DESC');
      expect(result.data.length).toBe(1);
      expect(result.data[0].storyTitle).toBe('One Piece');
      expect(result.data[0].storySlug).toBe('one-piece');
      expect(result.data[0].mediaFormat).toBe(MediaFormat.COMIC);
      expect(result.data[0].storyEditionId).toBe('edition-1');
      expect(result.data[0].editionName).toBe('Bản Dịch Chuẩn');
      expect(result.data[0].chapterNumber).toBe('100.00');
      expect(typeof result.data[0].createdAt).toBe('string');
      expect(result.data[0].heartbeatAt).toBe('2026-09-01T00:05:00.000Z');
      expect(result.pagination.total).toBe(1);
    });

    it('should prefer multi-status filtering and apply server-side search before pagination', async () => {
      const qbMock: any = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      jobRepo.createQueryBuilder.mockReturnValue(qbMock);

      await service.getJobs(adminUser, {
        statuses: [
          TranslationJobStatus.QUEUED,
          TranslationJobStatus.TRANSLATING,
        ],
        status: TranslationJobStatus.FAILED,
        search: '  chapter 100  ',
        page: 2,
        limit: 10,
      });

      expect(qbMock.andWhere).toHaveBeenCalledWith(
        'job.status IN (:...statuses)',
        {
          statuses: [
            TranslationJobStatus.QUEUED,
            TranslationJobStatus.TRANSLATING,
          ],
        },
      );
      expect(qbMock.andWhere).not.toHaveBeenCalledWith(
        'job.status = :status',
        expect.anything(),
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('story.title ILIKE :search'),
        { search: '%chapter 100%' },
      );
      expect(qbMock.skip).toHaveBeenCalledWith(10);
      expect(qbMock.take).toHaveBeenCalledWith(10);
    });
  });

  describe('#148: getJob()', () => {
    it('should return slim authoritative metadata and SQL aggregate reviewSummary with safe error', async () => {
      const mockJob = {
        id: 'job-100',
        status: TranslationJobStatus.FAILED,
        progressPercentage: 40,
        provider: 'OPENAI',
        modelName: 'gpt-4o-mini',
        promptVersion: 'manga-ja-vi-v1',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        startedAt: new Date('2026-09-01T10:01:00Z'),
        heartbeatAt: new Date('2026-09-01T10:05:00Z'),
        completedAt: new Date('2026-09-01T10:05:00Z'),
        expiresAt: null,
        errorTrace: 'InternalServerException at /internal/secrets/token=sensitive_token_123',
        inputManifest: {
          glossarySnapshot: [
            { sourceTerm: 'ルフィ', targetTerm: 'Luffy', category: 'CHARACTER_NAME' },
          ],
        },
        project: {
          id: 'proj-1',
          sourceLanguage: 'ja',
          targetLanguage: 'vi',
          storyEdition: {
            id: 'ed-1',
            editionName: 'Bản Tiếng Việt Chuẩn',
            language: 'vi',
            isDefault: true,
            story: {
              id: 'story-1',
              title: 'One Piece',
              slug: 'one-piece',
              mediaFormat: MediaFormat.COMIC,
            },
          },
        },
        sourceVersion: {
          id: 'ver-src-1',
          versionNumber: 1,
          chapter: {
            id: 'chap-1',
            chapterNumber: '1.00',
            title: 'Romance Dawn',
          },
        },
        targetVersion: null,
      };

      jobRepo.findOne.mockResolvedValue(mockJob);
      storyMemberRepo.findOne.mockResolvedValue({
        storyId: 'story-1',
        userId: translatorUser.id,
        role: StoryMemberRole.TRANSLATOR,
      });

      dataSource.query.mockResolvedValue([
        {
          segment_count: 50,
          verified_count: 35,
          page_count: 12,
          block_count: 0,
        },
      ]);

      const result = await service.getJob('job-100', translatorUser);

      expect(result.job.id).toBe('job-100');
      expect(result.job.status).toBe(TranslationJobStatus.FAILED);
      expect(result.job.createdAt).toBe('2026-09-01T10:00:00.000Z');
      expect(result.context.story.title).toBe('One Piece');
      expect(result.context.chapter.chapterNumber).toBe('1.00');
      expect(result.context.sourceVersion.versionNumber).toBe(1);
      expect(result.context.targetVersion).toBeNull();
      expect(result.reviewSummary).toEqual({
        segmentCount: 50,
        verifiedCount: 35,
        pageCount: 12,
        resultPageCount: null,
        blockCount: null, // Comic format -> blockCount must be null
      });
      expect(result.glossarySnapshot).toHaveLength(1);
      // Safe sanitized error (never leak internal tokens or paths)
      expect(result.error).toEqual({
        code: 'TRANSLATION_JOB_FAILED',
        message: 'Translation job failed. Please retry or review job diagnostics.',
      });
      // Invariant: segments and diffPreviewUrls must NOT exist on response
      expect((result as any).segments).toBeUndefined();
      expect((result as any).diffPreviewUrls).toBeUndefined();
    });

    it('#178: should compute authoritative resultPageCount from resultManifest for COMIC in READY_FOR_REVIEW', async () => {
      const mockJobReady = {
        id: 'job-ready-comic',
        status: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        provider: 'OPENAI',
        modelName: 'gpt-4o-mini',
        promptVersion: 'manga-ja-vi-v1',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        startedAt: new Date('2026-09-01T10:01:00Z'),
        heartbeatAt: new Date('2026-09-01T10:05:00Z'),
        completedAt: new Date('2026-09-01T10:05:00Z'),
        expiresAt: null,
        errorTrace: null,
        inputManifest: null,
        resultManifest: {
          version: 1,
          mediaFormat: 'COMIC',
          pages: [
            { page: 1, storageKey: 'k1', previewKey: 'p1', width: 800, height: 1200, fileSizeBytes: 1024 },
            { page: 2, storageKey: 'k2', previewKey: 'p2', width: 800, height: 1200, fileSizeBytes: 1024 },
            { page: 3, storageKey: 'k3', previewKey: 'p3', width: 800, height: 1200, fileSizeBytes: 1024 },
            { page: 4, storageKey: 'k4', previewKey: 'p4', width: 800, height: 1200, fileSizeBytes: 1024 },
            { page: 5, storageKey: 'k5', previewKey: 'p5', width: 800, height: 1200, fileSizeBytes: 1024 },
          ],
        },
        project: {
          id: 'proj-1',
          sourceLanguage: 'ja',
          targetLanguage: 'vi',
          storyEdition: {
            id: 'ed-1',
            editionName: 'Bản Tiếng Việt Chuẩn',
            language: 'vi',
            isDefault: true,
            story: {
              id: 'story-1',
              title: 'One Piece',
              slug: 'one-piece',
              mediaFormat: MediaFormat.COMIC,
            },
          },
        },
        sourceVersion: {
          id: 'ver-src-1',
          versionNumber: 1,
          chapter: {
            id: 'chap-1',
            chapterNumber: '1.00',
            title: 'Romance Dawn',
          },
        },
        targetVersion: null,
      };

      jobRepo.findOne.mockResolvedValue(mockJobReady);
      storyMemberRepo.findOne.mockResolvedValue({
        storyId: 'story-1',
        userId: translatorUser.id,
        role: StoryMemberRole.TRANSLATOR,
      });

      // SQL aggregation: segments exist only on pages 1, 3, 5 (3 distinct pages)
      dataSource.query.mockResolvedValue([
        {
          segment_count: 6,
          verified_count: 4,
          page_count: 3,
          block_count: 0,
        },
      ]);

      const result = await service.getJob('job-ready-comic', translatorUser);

      expect(result.reviewSummary).toEqual({
        segmentCount: 6,
        verifiedCount: 4,
        pageCount: 3,
        resultPageCount: 5,
        blockCount: null,
      });
      expect(result.reviewSummary.pageCount).toBe(3);
      expect(result.reviewSummary.resultPageCount).toBe(5);
    });

    describe('#178 / F14 regression: resultPageCount validation with full-schema fixtures', () => {
      const baseJob = {
        id: 'job-corrupt-manifest',
        status: TranslationJobStatus.READY_FOR_REVIEW,
        progressPercentage: 100,
        provider: 'OPENAI',
        modelName: 'gpt-4o-mini',
        promptVersion: 'manga-ja-vi-v1',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        startedAt: new Date('2026-09-01T10:01:00Z'),
        heartbeatAt: new Date('2026-09-01T10:05:00Z'),
        completedAt: new Date('2026-09-01T10:05:00Z'),
        expiresAt: null,
        errorTrace: null,
        inputManifest: null,
        project: {
          id: 'proj-1',
          sourceLanguage: 'ja',
          targetLanguage: 'vi',
          storyEdition: {
            id: 'ed-1',
            editionName: 'Bản Tiếng Việt Chuẩn',
            language: 'vi',
            isDefault: true,
            story: {
              id: 'story-1',
              title: 'One Piece',
              slug: 'one-piece',
              mediaFormat: MediaFormat.COMIC,
            },
          },
        },
        sourceVersion: {
          id: 'ver-src-1',
          versionNumber: 1,
          chapter: {
            id: 'chap-1',
            chapterNumber: '1.00',
            title: 'Romance Dawn',
          },
        },
        targetVersion: null,
      };

      const createValidPage = (page: number, overrides = {}) => ({
        page,
        storageKey: `ai/jobs/job-corrupt-manifest/attempt-1/page_${page}.webp`,
        previewKey: `ai/jobs/job-corrupt-manifest/attempt-1/page_${page}.webp`,
        width: 1200,
        height: 1800,
        fileSizeBytes: 102400,
        ...overrides,
      });

      beforeEach(() => {
        storyMemberRepo.findOne.mockResolvedValue({
          storyId: 'story-1',
          userId: translatorUser.id,
          role: StoryMemberRole.TRANSLATOR,
        });

        dataSource.query.mockResolvedValue([
          {
            segment_count: 2,
            verified_count: 0,
            page_count: 2,
            block_count: 0,
          },
        ]);
      });

      it('should yield resultPageCount === null if COMIC resultManifest has duplicate page numbers [1, 1] with full schema', async () => {
        jobRepo.findOne.mockResolvedValue({
          ...baseJob,
          resultManifest: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              createValidPage(1, { storageKey: 'k1', previewKey: 'p1' }),
              createValidPage(1, { storageKey: 'k2', previewKey: 'p2' }),
            ],
          },
        });
        const result = await service.getJob('job-corrupt-manifest', translatorUser);
        expect(result.reviewSummary.resultPageCount).toBeNull();
      });

      it('should yield resultPageCount === null if COMIC resultManifest has non-contiguous pages [1, 3] with full schema', async () => {
        jobRepo.findOne.mockResolvedValue({
          ...baseJob,
          resultManifest: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              createValidPage(1),
              createValidPage(3),
            ],
          },
        });
        const result = await service.getJob('job-corrupt-manifest', translatorUser);
        expect(result.reviewSummary.resultPageCount).toBeNull();
      });

      it('should yield resultPageCount === null if COMIC resultManifest starts at page 2 [2, 3] with full schema', async () => {
        jobRepo.findOne.mockResolvedValue({
          ...baseJob,
          resultManifest: {
            version: 1,
            mediaFormat: 'COMIC',
            pages: [
              createValidPage(2),
              createValidPage(3),
            ],
          },
        });
        const result = await service.getJob('job-corrupt-manifest', translatorUser);
        expect(result.reviewSummary.resultPageCount).toBeNull();
      });

      it('should yield resultPageCount === null if COMIC resultManifest is corrupt / malformed string JSON', async () => {
        jobRepo.findOne.mockResolvedValue({
          ...baseJob,
          resultManifest: 'not-valid-json{',
        });
        const result = await service.getJob('job-corrupt-manifest', translatorUser);
        expect(result.reviewSummary.resultPageCount).toBeNull();
      });
    });

    describe('#178 Acceptance Matrix: resultPageCount across status, format, and manifest representation', () => {
      const validComicPages = [
        {
          page: 1,
          storageKey: 'ai/jobs/j1/attempt-1/p1.webp',
          previewKey: 'ai/jobs/j1/attempt-1/p1.webp',
          width: 1000,
          height: 1500,
          fileSizeBytes: 204800,
        },
        {
          page: 2,
          storageKey: 'ai/jobs/j1/attempt-1/p2.webp',
          previewKey: 'ai/jobs/j1/attempt-1/p2.webp',
          width: 1000,
          height: 1500,
          fileSizeBytes: 204800,
        },
      ];

      const validComicManifestObj = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: validComicPages,
      };

      const validComicManifestJsonStr = JSON.stringify(validComicManifestObj);

      beforeEach(() => {
        storyMemberRepo.findOne.mockResolvedValue({
          storyId: 'story-1',
          userId: translatorUser.id,
          role: StoryMemberRole.TRANSLATOR,
        });

        dataSource.query.mockResolvedValue([
          {
            segment_count: 5,
            verified_count: 5,
            page_count: 2,
            block_count: 0,
          },
        ]);
      });

      it.each([
        {
          desc: 'COMIC in READY_FOR_REVIEW with valid manifest object returns N (2)',
          status: TranslationJobStatus.READY_FOR_REVIEW,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestObj,
          expectedCount: 2,
        },
        {
          desc: 'COMIC in APPLIED with valid manifest object returns N (2)',
          status: TranslationJobStatus.APPLIED,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestObj,
          expectedCount: 2,
        },
        {
          desc: 'COMIC in READY_FOR_REVIEW with valid manifest JSON string returns same count N (2)',
          status: TranslationJobStatus.READY_FOR_REVIEW,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestJsonStr,
          expectedCount: 2,
        },
        {
          desc: 'COMIC in APPLIED with valid manifest JSON string returns same count N (2)',
          status: TranslationJobStatus.APPLIED,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestJsonStr,
          expectedCount: 2,
        },
        {
          desc: 'COMIC in QUEUED (non-ready) returns null despite valid manifest',
          status: TranslationJobStatus.QUEUED,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestObj,
          expectedCount: null,
        },
        {
          desc: 'COMIC in PREPROCESSING (non-ready) returns null despite valid manifest',
          status: TranslationJobStatus.PREPROCESSING,
          mediaFormat: MediaFormat.COMIC,
          resultManifest: validComicManifestObj,
          expectedCount: null,
        },
        {
          desc: 'NOVEL in READY_FOR_REVIEW returns null',
          status: TranslationJobStatus.READY_FOR_REVIEW,
          mediaFormat: MediaFormat.NOVEL,
          resultManifest: {
            version: 1,
            mediaFormat: 'NOVEL',
            htmlKey: 'k',
            htmlFileSizeBytes: 100,
            segmentCount: 1,
            charCount: 10,
            qa: { passed: true, score: 1.0, fingerprintMatch: true, issuesCount: 0 },
          },
          expectedCount: null,
        },
        {
          desc: 'NOVEL in APPLIED returns null',
          status: TranslationJobStatus.APPLIED,
          mediaFormat: MediaFormat.NOVEL,
          resultManifest: null,
          expectedCount: null,
        },
      ])('$desc', async ({ status, mediaFormat, resultManifest, expectedCount }) => {
        jobRepo.findOne.mockResolvedValue({
          id: 'job-matrix-test',
          status,
          progressPercentage: 100,
          provider: 'OPENAI',
          modelName: 'gpt-4o-mini',
          promptVersion: 'v1',
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: new Date('2026-09-01T10:00:00Z'),
          startedAt: new Date('2026-09-01T10:01:00Z'),
          heartbeatAt: new Date('2026-09-01T10:05:00Z'),
          completedAt: new Date('2026-09-01T10:05:00Z'),
          expiresAt: null,
          errorTrace: null,
          inputManifest: null,
          resultManifest,
          project: {
            id: 'proj-1',
            sourceLanguage: 'ja',
            targetLanguage: 'vi',
            storyEdition: {
              id: 'ed-1',
              editionName: 'Bản Tiếng Việt Chuẩn',
              language: 'vi',
              isDefault: true,
              story: {
                id: 'story-1',
                title: 'Story Matrix',
                slug: 'story-matrix',
                mediaFormat,
              },
            },
          },
          sourceVersion: {
            id: 'ver-src-1',
            versionNumber: 1,
            chapter: { id: 'chap-1', chapterNumber: '1.00', title: 'Chap 1' },
          },
          targetVersion: null,
        });

        const result = await service.getJob('job-matrix-test', translatorUser);
        expect(result.reviewSummary.resultPageCount).toBe(expectedCount);
      });
    });

    it('should throw NotFoundException if job does not exist', async () => {
      jobRepo.findOne.mockResolvedValue(null);

      await expect(service.getJob('non-existent', adminUser)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('#155: getJobSegments()', () => {
    it('should return paginated segments sorted by page_number, sort_order, id for Comic with ISO dates', async () => {
      const mockJob = {
        id: 'job-comic',
        project: {
          storyEdition: {
            story: { id: 'story-1', mediaFormat: MediaFormat.COMIC },
          },
        },
      };

      jobRepo.findOne.mockResolvedValue(mockJob);

      const qbMock: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([
          [
            {
              id: 'seg-1',
              jobId: 'job-comic',
              pageNumber: 3,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 10,
              bboxY: 20,
              bboxW: 100,
              bboxH: 50,
              rawText: 'こんにちは',
              translatedText: 'Xin chào',
              confidence: 0.95,
              isHumanVerified: false,
              createdAt: new Date('2026-09-01T00:00:00Z'),
            },
          ],
          1,
        ]),
      };

      segmentRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.getJobSegments('job-comic', adminUser, {
        page: 1,
        limit: 50,
        pageNumber: 3,
      });

      expect(qbMock.where).toHaveBeenCalledWith('segment.jobId = :jobId', {
        jobId: 'job-comic',
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith('segment.pageNumber = :pageNumber', {
        pageNumber: 3,
      });
      expect(qbMock.orderBy).toHaveBeenCalledWith('segment.pageNumber', 'ASC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('segment.sortOrder', 'ASC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('segment.id', 'ASC');
      expect(result.data.length).toBe(1);
      expect(result.data[0].pageNumber).toBe(3);
      expect(result.data[0].translatedText).toBe('Xin chào');
      expect(result.data[0].createdAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('should throw NotFoundException if story context is missing (fail-closed security)', async () => {
      jobRepo.findOne.mockResolvedValue({
        id: 'job-broken',
        project: null,
      });

      await expect(
        service.getJobSegments('job-broken', adminUser, { page: 1 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject unauthorized user without story permissions', async () => {
      jobRepo.findOne.mockResolvedValue({
        id: 'job-1',
        project: {
          storyEdition: {
            story: { id: 'story-secret', mediaFormat: MediaFormat.COMIC },
          },
        },
      });
      storyMemberRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getJobSegments('job-1', translatorUser, { page: 1 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
