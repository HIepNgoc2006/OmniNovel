import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

describe('Segment Mutation & Freshness Gate (#147, #156)', () => {
  let service: TranslationService;
  let mockJobRepo: any;
  let mockSegmentRepo: any;
  let mockDataSource: any;
  let mockStoryMemberRepo: any;

  const mockUser = { id: 'user-1', role: 'USER' };
  const mockAdmin = { id: 'admin-1', role: 'ADMIN' };

  beforeEach(async () => {
    mockJobRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    mockSegmentRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    mockStoryMemberRepo = {
      findOne: jest.fn().mockResolvedValue({ role: 'EDITOR' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: mockJobRepo },
        { provide: getRepositoryToken(TranslationProject), useValue: {} },
        { provide: getRepositoryToken(TranslationGlossary), useValue: {} },
        { provide: getRepositoryToken(TranslationSegment), useValue: mockSegmentRepo },
        { provide: getRepositoryToken(ChapterVersion), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(UploadSession), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: mockStoryMemberRepo },
        { provide: StorageService, useValue: {} },
        { provide: TranslationGateway, useValue: { broadcastJobFailed: jest.fn() } },
        { provide: TranslationProcessor, useValue: {} },
        { provide: 'BullQueue_translation', useValue: { add: jest.fn() } },
        { provide: 'BullQueue_translation-materialization', useValue: { add: jest.fn(), getJob: jest.fn() } },
        {
          provide: DataSource,
          useFactory: () => {
            mockDataSource = {
              transaction: jest.fn(),
              query: jest.fn(),
            };
            return mockDataSource;
          },
        },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  describe('updateSegment() (#147)', () => {
    it('should throw BadRequestException if both translatedText and isHumanVerified are undefined', async () => {
      await expect(
        service.updateSegment('job-1', 'seg-1', mockUser, { expectedVersion: 1 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if job does not exist', async () => {
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue(null),
        };
        return await cb(manager);
      });

      await expect(
        service.updateSegment('job-missing', 'seg-1', mockAdmin, {
          translatedText: 'New Text',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException (NOT_REVIEWABLE) if job is not READY_FOR_REVIEW', async () => {
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue({
            id: 'job-1',
            status: TranslationJobStatus.TRANSLATING,
            project: { storyEdition: { story: { id: 'story-1' } } },
          }),
        };
        return await cb(manager);
      });

      await expect(
        service.updateSegment('job-1', 'seg-1', mockAdmin, {
          translatedText: 'New Text',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException (VERSION_CONFLICT) if expectedVersion does not match segment.version', async () => {
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationJob) {
              return Promise.resolve({
                id: 'job-1',
                status: TranslationJobStatus.READY_FOR_REVIEW,
                project: { storyEdition: { story: { id: 'story-1', mediaFormat: MediaFormat.COMIC } } },
              });
            }
            if (entity === TranslationSegment) {
              return Promise.resolve({
                id: 'seg-1',
                jobId: 'job-1',
                version: 5, // current is 5
                translatedText: 'Old Text',
                isHumanVerified: false,
              });
            }
          }),
        };
        return await cb(manager);
      });

      await expect(
        service.updateSegment('job-1', 'seg-1', mockAdmin, {
          translatedText: 'New Text',
          expectedVersion: 4, // expected 4 !== 5
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException (ANCHOR_TOPOLOGY_VIOLATION) if novel anchors are corrupted', async () => {
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationJob) {
              return Promise.resolve({
                id: 'job-1',
                status: TranslationJobStatus.READY_FOR_REVIEW,
                project: { storyEdition: { story: { id: 'story-1', mediaFormat: MediaFormat.NOVEL } } },
              });
            }
            if (entity === TranslationSegment) {
              return Promise.resolve({
                id: 'seg-1',
                jobId: 'job-1',
                version: 1,
                rawText: '彼は⟦S:0001⟧勇者⟦/S:0001⟧だ。',
                translatedText: 'Bản dịch cũ',
                isHumanVerified: false,
              });
            }
          }),
        };
        return await cb(manager);
      });

      await expect(
        service.updateSegment('job-1', 'seg-1', mockAdmin, {
          translatedText: 'Bản dịch làm mất tag anchor.',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle no-op correctly: return current segment and not increment version or reviewRevision', async () => {
      let queryCount = 0;
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('UPDATE translation_jobs')) {
              queryCount++;
            }
          }),
          findOne: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationJob) {
              return Promise.resolve({
                id: 'job-1',
                status: TranslationJobStatus.READY_FOR_REVIEW,
                project: { storyEdition: { story: { id: 'story-1', mediaFormat: MediaFormat.COMIC } } },
              });
            }
            if (entity === TranslationSegment) {
              return Promise.resolve({
                id: 'seg-1',
                jobId: 'job-1',
                version: 2,
                rawText: 'Raw',
                translatedText: 'Same Text',
                isHumanVerified: true,
                bboxX: null,
                bboxY: null,
                bboxW: null,
                bboxH: null,
                pageNumber: 1,
                sortOrder: 1,
                confidence: 0.95,
                createdAt: new Date('2026-09-01T00:00:00Z'),
              });
            }
          }),
        };
        return await cb(manager);
      });

      const result = await service.updateSegment('job-1', 'seg-1', mockAdmin, {
        translatedText: 'Same Text',
        isHumanVerified: true,
        expectedVersion: 2,
      });

      expect(result.version).toBe(2); // Untouched
      expect(queryCount).toBe(0); // review_revision query was never called
    });

    it('should increment version, increment reviewRevision, and auto-reset verification on text change', async () => {
      let reviewRevisionIncremented = false;
      const updatedMockSegment = {
        id: 'seg-1',
        jobId: 'job-1',
        version: 3, // incremented
        rawText: 'Raw',
        translatedText: 'Newly Translated Text',
        isHumanVerified: false, // auto-reset
        bboxX: null,
        bboxY: null,
        bboxW: null,
        bboxH: null,
        pageNumber: 1,
        sortOrder: 1,
        confidence: 0.95,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      };

      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('UPDATE translation_jobs SET review_revision = review_revision + 1')) {
              reviewRevisionIncremented = true;
            }
          }),
          findOne: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationJob) {
              return Promise.resolve({
                id: 'job-1',
                status: TranslationJobStatus.READY_FOR_REVIEW,
                project: { storyEdition: { story: { id: 'story-1', mediaFormat: MediaFormat.COMIC } } },
              });
            }
            if (entity === TranslationSegment) {
              return Promise.resolve({
                id: 'seg-1',
                jobId: 'job-1',
                version: 2,
                rawText: 'Raw',
                translatedText: 'Old Text',
                isHumanVerified: true, // was verified
              });
            }
          }),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }),
          findOneOrFail: jest.fn().mockResolvedValue(updatedMockSegment),
        };
        return await cb(manager);
      });

      const result = await service.updateSegment('job-1', 'seg-1', mockAdmin, {
        translatedText: 'Newly Translated Text',
        expectedVersion: 2,
        // isHumanVerified omitted -> must auto-reset to false
      });

      expect(result.version).toBe(3);
      expect(result.isHumanVerified).toBe(false);
      expect(reviewRevisionIncremented).toBe(true);
    });

    it('should increment version but NOT reviewRevision when only isHumanVerified changes', async () => {
      let reviewRevisionIncremented = false;
      const updatedMockSegment = {
        id: 'seg-1',
        jobId: 'job-1',
        version: 3,
        rawText: 'Raw',
        translatedText: 'Text Untouched',
        isHumanVerified: true, // verified
        bboxX: null,
        bboxY: null,
        bboxW: null,
        bboxH: null,
        pageNumber: 1,
        sortOrder: 1,
        confidence: 0.95,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      };

      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('UPDATE translation_jobs SET review_revision = review_revision + 1')) {
              reviewRevisionIncremented = true;
            }
          }),
          findOne: jest.fn().mockImplementation((entity) => {
            if (entity === TranslationJob) {
              return Promise.resolve({
                id: 'job-1',
                status: TranslationJobStatus.READY_FOR_REVIEW,
                project: { storyEdition: { story: { id: 'story-1', mediaFormat: MediaFormat.COMIC } } },
              });
            }
            if (entity === TranslationSegment) {
              return Promise.resolve({
                id: 'seg-1',
                jobId: 'job-1',
                version: 2,
                rawText: 'Raw',
                translatedText: 'Text Untouched',
                isHumanVerified: false,
              });
            }
          }),
          createQueryBuilder: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
          }),
          findOneOrFail: jest.fn().mockResolvedValue(updatedMockSegment),
        };
        return await cb(manager);
      });

      const result = await service.updateSegment('job-1', 'seg-1', mockAdmin, {
        isHumanVerified: true,
        expectedVersion: 2,
      });

      expect(result.version).toBe(3);
      expect(result.isHumanVerified).toBe(true);
      expect(reviewRevisionIncremented).toBe(false); // review_revision did NOT increment!
    });
  });

  describe('applyJob() Freshness Gate (#156)', () => {
    it('should throw ConflictException (ARTIFACT_STALE) when materializedRevision !== reviewRevision', async () => {
      mockDataSource.transaction.mockImplementation(async (cb: any) => {
        const manager = {
          query: jest.fn(),
          findOne: jest.fn().mockResolvedValue({
            id: 'job-stale',
            status: TranslationJobStatus.READY_FOR_REVIEW,
            reviewRevision: 3,
            materializedRevision: 1, // Stale!
            project: { storyEdition: { story: { id: 'story-1' } } },
            sourceVersion: { chapterId: 'ch-1' },
          }),
        };
        return await cb(manager);
      });

      await expect(
        service.applyJob(
          'job-stale',
          { mode: 'OVERWRITE_ACTIVE_VERSION' as any },
          mockAdmin,
          '11111111-1111-4111-8111-111111111111',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });
});
