import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TranslationJobStatus } from '@omninovel/shared';
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

describe('TranslationService.handleJobFailure Post-Commit Ordering & Invariants', () => {
  let service: TranslationService;
  let mockGateway: {
    broadcastJobFailed: jest.Mock;
  };
  let mockDataSource: {
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    mockGateway = {
      broadcastJobFailed: jest.fn(),
    };

    mockDataSource = {
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: {} },
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
        { provide: StorageService, useValue: {} },
        { provide: TranslationGateway, useValue: mockGateway },
        { provide: TranslationProcessor, useValue: {} },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  it('ORDERING: should broadcast job_failed strictly AFTER transaction resolves and commits', async () => {
    const jobId = 'job-fail-order-test';
    const errorTrace = 'Stack trace details...';
    const executionOrder: string[] = [];

    const mockJob: Partial<TranslationJob> = {
      id: jobId,
      status: TranslationJobStatus.OCR,
    };

    mockDataSource.transaction.mockImplementation(async (callback) => {
      executionOrder.push('transaction_start');
      let queryCount = 0;
      const mockManager = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          queryCount++;
          if (queryCount === 1) {
            executionOrder.push('query_for_update');
          } else {
            executionOrder.push('atomic_sql_update');
            expect(sql).toContain('UPDATE translation_jobs');
            expect(sql).toContain('workspace_revision = workspace_revision + 1');
          }
        }),
        findOne: jest.fn().mockResolvedValue(mockJob),
      };

      const res = await callback(mockManager);
      executionOrder.push('transaction_commit');
      return res;
    });

    mockGateway.broadcastJobFailed.mockImplementation((id: string) => {
      executionOrder.push('broadcast_job_failed');
      expect(id).toBe(jobId);
    });

    await service.handleJobFailure(jobId, errorTrace);

    expect(mockGateway.broadcastJobFailed).toHaveBeenCalledWith(jobId);
    expect(executionOrder).toEqual([
      'transaction_start',
      'query_for_update',
      'atomic_sql_update',
      'transaction_commit',
      'broadcast_job_failed',
    ]);
  });

  it('ROLLBACK: should NOT broadcast job_failed if transaction throws an error', async () => {
    const jobId = 'job-fail-rollback-test';
    const errorTrace = 'Stack trace details...';

    mockDataSource.transaction.mockImplementation(async (callback) => {
      let queryCount = 0;
      const mockManager = {
        query: jest.fn().mockImplementation(async () => {
          queryCount++;
          if (queryCount === 1) return [];
          throw new Error('DB connection killed during commit');
        }),
        findOne: jest.fn().mockResolvedValue({
          id: jobId,
          status: TranslationJobStatus.OCR,
        }),
      };
      return callback(mockManager);
    });

    await expect(service.handleJobFailure(jobId, errorTrace)).rejects.toThrow(
      'DB connection killed during commit',
    );

    expect(mockGateway.broadcastJobFailed).not.toHaveBeenCalled();
  });

  it('TERMINAL STATE: should NOT broadcast job_failed if job is already in READY_FOR_REVIEW', async () => {
    const jobId = 'job-fail-terminal-ready';
    const errorTrace = 'Late worker failure...';

    mockDataSource.transaction.mockImplementation(async (callback) => {
      const mockManager = {
        query: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue({
          id: jobId,
          status: TranslationJobStatus.READY_FOR_REVIEW,
        }),
        save: jest.fn(),
      };
      return callback(mockManager);
    });

    await service.handleJobFailure(jobId, errorTrace);

    expect(mockGateway.broadcastJobFailed).not.toHaveBeenCalled();
  });

  it('NOT FOUND: should NOT broadcast job_failed if job does not exist', async () => {
    const jobId = 'job-fail-not-found';
    const errorTrace = 'Some trace...';

    mockDataSource.transaction.mockImplementation(async (callback) => {
      const mockManager = {
        query: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(),
      };
      return callback(mockManager);
    });

    await service.handleJobFailure(jobId, errorTrace);

    expect(mockGateway.broadcastJobFailed).not.toHaveBeenCalled();
  });
});
