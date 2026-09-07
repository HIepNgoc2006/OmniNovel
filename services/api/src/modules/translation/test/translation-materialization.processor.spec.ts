import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { MaterializationJobData, TranslationJobStatus } from '@omninovel/shared';
import { TranslationJob } from '../entities/translation-job.entity';
import { StorageService } from '../../storage/storage.service';
import { TranslationService } from '../translation.service';
import { TranslationMaterializationProcessor } from '../translation-materialization.processor';

describe('TranslationMaterializationProcessor (#157)', () => {
  let processor: TranslationMaterializationProcessor;
  let jobRepo: jest.Mocked<Partial<Repository<TranslationJob>>>;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let configService: jest.Mocked<Partial<ConfigService>>;

  const mockJobId = '11111111-1111-4111-8111-111111111111';
  const mockSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const mockOutputPrefix = `ai/jobs/${mockJobId}/materializations/rev-2/`;
  const mockSnapshotKey = `${mockOutputPrefix}snapshots/${mockSha256}.json`;

  const validJobData: MaterializationJobData = {
    jobId: mockJobId,
    targetRevision: 2,
    mediaFormat: 'COMIC',
    snapshotKey: mockSnapshotKey,
    snapshotSha256: mockSha256,
    outputPrefix: mockOutputPrefix,
  };

  const createMockBullJob = (name: string, data: MaterializationJobData) => {
    return {
      name,
      data,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<MaterializationJobData>;
  };

  beforeEach(async () => {
    jobRepo = {
      findOne: jest.fn(),
    };

    storageService = {
      createInternalDownloadUrl: jest.fn().mockResolvedValue('https://minio.local/get/file'),
      createInternalUploadUrl: jest.fn().mockResolvedValue('https://minio.local/put/file'),
    };

    configService = {
      get: jest.fn().mockReturnValue('http://localhost:8001'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationMaterializationProcessor,
        { provide: TranslationService, useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: ConfigService, useValue: configService },
        { provide: getRepositoryToken(TranslationJob), useValue: jobRepo },
      ],
    }).compile();

    processor = module.get<TranslationMaterializationProcessor>(
      TranslationMaterializationProcessor,
    );
  });

  describe('RED 2: Processor job.name & Snapshot Integrity Sanity Checks', () => {
    it('should throw UnrecoverableError if job.name !== "materialize"', async () => {
      const job = createMockBullJob('invalid-job-name', validJobData);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        'UNSUPPORTED_MATERIALIZATION_JOB: invalid-job-name',
      );
    });

    it('should throw UnrecoverableError if snapshotSha256 is not 64-hex lowercase', async () => {
      const invalidData = {
        ...validJobData,
        snapshotSha256: 'not-a-valid-sha256',
        snapshotKey: `${mockOutputPrefix}snapshots/not-a-valid-sha256.json`,
      };
      const job = createMockBullJob('materialize', invalidData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
      } as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /INVALID_SNAPSHOT_SHA256/,
      );
    });

    it('should throw UnrecoverableError if outputPrefix does not match canonical structure', async () => {
      const invalidData = {
        ...validJobData,
        outputPrefix: `ai/jobs/other-job/materializations/rev-2/`,
      };
      const job = createMockBullJob('materialize', invalidData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
      } as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /INVALID_OUTPUT_PREFIX/,
      );
    });

    it('should throw UnrecoverableError if snapshotKey does not match outputPrefix + snapshots/hash.json', async () => {
      const invalidData = {
        ...validJobData,
        snapshotKey: `${mockOutputPrefix}wrong-path/snapshot.json`,
      };
      const job = createMockBullJob('materialize', invalidData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
      } as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /INVALID_SNAPSHOT_KEY/,
      );
    });
  });

  describe('RED 2: Revision Fencing & Stale Lifecycle', () => {
    it('should no-op ALREADY_MATERIALIZED if targetRevision === materializedRevision', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 2, // Already materialized!
      } as TranslationJob);

      await processor.process(job);

      expect(storageService.createInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('should no-op STALE if targetRevision !== reviewRevision', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 3, // Job has advanced to revision 3!
        materializedRevision: 1,
      } as TranslationJob);

      await processor.process(job);

      expect(storageService.createInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('should no-op STALE if targetRevision < materializedRevision', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 4,
        materializedRevision: 3, // Already past revision 2!
      } as TranslationJob);

      await processor.process(job);

      expect(storageService.createInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('should no-op if job.status !== READY_FOR_REVIEW', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.TRANSLATING, // Not in READY_FOR_REVIEW
        reviewRevision: 2,
        materializedRevision: 1,
      } as TranslationJob);

      await processor.process(job);

      expect(storageService.createInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('should no-op if mediaFormat !== "COMIC"', async () => {
      const novelJobData = { ...validJobData, mediaFormat: 'NOVEL' as const };
      const job = createMockBullJob('materialize', novelJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
      } as TranslationJob);

      await processor.process(job);

      expect(storageService.createInternalDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('RED 3: Pages == CleanBases == 1..N Verification & Presigned URLs', () => {
    it('should throw UnrecoverableError if resultManifest.pages is missing or empty', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        resultManifest: {
          pages: [],
        },
      } as unknown as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /MISSING_RESULT_MANIFEST_PAGES/,
      );
    });

    it('should throw UnrecoverableError if cleanBases is missing or empty', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        resultManifest: {
          pages: [{ page: 1 }, { page: 2 }],
          // cleanBases missing
        },
      } as unknown as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /MISSING_CLEAN_BASES/,
      );
    });

    it('should throw UnrecoverableError if cleanBases count != pages count', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        resultManifest: {
          pages: [{ page: 1 }, { page: 2 }],
          cleanBases: [{ page: 1, cleanBaseKey: 'clean/p1.png' }], // only 1 cleanBase for 2 pages
        },
      } as unknown as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /CLEAN_BASES_PAGE_MISMATCH/,
      );
    });

    it('should throw UnrecoverableError if cleanBases does not strictly cover 1..N or cleanBaseKey is missing', async () => {
      const job = createMockBullJob('materialize', validJobData);

      // Sparse / disjoint pages: page 1 and page 3 instead of 1 and 2
      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        resultManifest: {
          pages: [{ page: 1 }, { page: 2 }],
          cleanBases: [
            { page: 1, cleanBaseKey: 'clean/p1.png' },
            { page: 3, cleanBaseKey: 'clean/p3.png' }, // Invalid page 3
          ],
        },
      } as unknown as TranslationJob);

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      await expect(processor.process(job)).rejects.toThrow(
        /CLEAN_BASES_INCOMPLETE/,
      );
    });

    it('should generate presigned download/upload URLs for 1..N pages and NOT mutate TranslationJob to FAILED', async () => {
      const job = createMockBullJob('materialize', validJobData);

      jobRepo.findOne = jest.fn().mockResolvedValue({
        id: mockJobId,
        status: TranslationJobStatus.READY_FOR_REVIEW,
        reviewRevision: 2,
        materializedRevision: 1,
        resultManifest: {
          pages: [{ page: 1 }, { page: 2 }],
          cleanBases: [
            { page: 2, cleanBaseKey: 'clean/p2.png' },
            { page: 1, cleanBaseKey: 'clean/p1.png' },
          ],
        },
      } as unknown as TranslationJob);

      // Mock global fetch for AI worker dispatch (RED 4 will detail HTTP dispatch)
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'COMPLETED' }),
      });
      (global as any).fetch = mockFetch;

      await processor.process(job);

      // Verify snapshot download URL
      expect(storageService.createInternalDownloadUrl).toHaveBeenCalledWith(
        mockSnapshotKey,
        true,
        3600,
      );

      // Verify cleanBases download URLs for page 1 & 2
      expect(storageService.createInternalDownloadUrl).toHaveBeenCalledWith(
        'clean/p1.png',
        true,
        3600,
      );
      expect(storageService.createInternalDownloadUrl).toHaveBeenCalledWith(
        'clean/p2.png',
        true,
        3600,
      );

      // Verify upload URLs for page 1 & 2 WebP exact jail
      expect(storageService.createInternalUploadUrl).toHaveBeenCalledWith(
        `${mockOutputPrefix}page_1.webp`,
        'image/webp',
        true,
        3600,
      );
      expect(storageService.createInternalUploadUrl).toHaveBeenCalledWith(
        `${mockOutputPrefix}page_2.webp`,
        'image/webp',
        true,
        3600,
      );

      // Invariant: TranslationJob status MUST NOT be touched
      expect(jobRepo.save).toBeUndefined();
    });
  });
});
