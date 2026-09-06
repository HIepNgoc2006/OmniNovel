import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { StorageService } from '../storage.service';
import { UploadSession } from '../entities/upload-session.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { StoryEdition } from '../../stories/entities/story-edition.entity';

describe('StorageService.deleteInternalPrefix Fail-Closed Security & Pagination (#159, Mandatory RED #0)', () => {
  let service: StorageService;
  let s3SendMock: jest.Mock;

  beforeEach(async () => {
    s3SendMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: getRepositoryToken(UploadSession),
          useValue: {},
        },
        {
          provide: getRepositoryToken(MediaAsset),
          useValue: {},
        },
        {
          provide: getRepositoryToken(StoryEdition),
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal: any) => {
              if (key === 'MINIO_BUCKET_MANGA') return 'manga-media';
              if (key === 'MINIO_BUCKET_NOVEL') return 'novel-media';
              return defaultVal;
            }),
          },
        },
        {
          provide: DataSource,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    // Gán mock s3Client.send
    (service as any).s3Client = {
      send: s3SendMock,
    };
  });

  describe('Prefix Validation & Blast Radius Protection (Mandatory RED #0)', () => {
    const invalidPrefixes = [
      { prefix: '', reason: 'empty prefix' },
      { prefix: 'ai/', reason: 'too broad: bucket-wide' },
      { prefix: 'ai/jobs/', reason: 'bare ai/jobs/ touches all jobs in bucket' },
      { prefix: 'ai/jobs//', reason: 'empty jobId segment' },
      { prefix: 'ai/jobs/../', reason: 'path traversal' },
      { prefix: 'ai/jobs/not-a-uuid/source-review/', reason: 'non-UUID jobId' },
      { prefix: 'ai/jobs/12345/source-review/', reason: 'invalid UUID length/format' },
      { prefix: 'ai/jobs/550e8400-e29b-41d4-a716-446655440000', reason: 'must end with slash' },
      { prefix: 'custom/path/550e8400-e29b-41d4-a716-446655440000/', reason: 'outside ai/jobs/ prefix jail' },
    ];

    invalidPrefixes.forEach(({ prefix, reason }) => {
      it(`should reject invalid prefix "${prefix}" (${reason}) with BadRequestException`, async () => {
        await expect(
          service.deleteInternalPrefix(prefix, true),
        ).rejects.toThrow(BadRequestException);
        expect(s3SendMock).not.toHaveBeenCalled();
      });
    });

    it('should accept valid job-scoped prefix ending with slash', async () => {
      const validPrefix = 'ai/jobs/550e8400-e29b-41d4-a716-446655440000/source-review/';
      s3SendMock.mockResolvedValueOnce({
        Contents: [{ Key: `${validPrefix}page_1.jpg` }],
        IsTruncated: false,
      }); // ListObjectsV2
      s3SendMock.mockResolvedValueOnce({
        Deleted: [{ Key: `${validPrefix}page_1.jpg` }],
        Errors: [],
      }); // DeleteObjects

      await expect(
        service.deleteInternalPrefix(validPrefix, true),
      ).resolves.not.toThrow();

      expect(s3SendMock).toHaveBeenCalledTimes(2);
    });

    it('should do nothing gracefully if prefix contains no objects', async () => {
      const validPrefix = 'ai/jobs/550e8400-e29b-41d4-a716-446655440000/source-review/';
      s3SendMock.mockResolvedValueOnce({
        Contents: [],
        IsTruncated: false,
      });

      await expect(
        service.deleteInternalPrefix(validPrefix, true),
      ).resolves.not.toThrow();

      // Only ListObjectsV2 called, DeleteObjects not called
      expect(s3SendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Pagination across >1000 objects', () => {
    it('should paginate using ContinuationToken and delete all batches', async () => {
      const validPrefix = 'ai/jobs/550e8400-e29b-41d4-a716-446655440000/source-review/';
      // Page 1: 1000 objects, truncated
      s3SendMock.mockResolvedValueOnce({
        Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `${validPrefix}obj_${i}.jpg` })),
        IsTruncated: true,
        NextContinuationToken: 'token-page-2',
      });
      // Delete page 1
      s3SendMock.mockResolvedValueOnce({
        Deleted: Array.from({ length: 1000 }, (_, i) => ({ Key: `${validPrefix}obj_${i}.jpg` })),
        Errors: [],
      });
      // Page 2: 50 objects, not truncated
      s3SendMock.mockResolvedValueOnce({
        Contents: Array.from({ length: 50 }, (_, i) => ({ Key: `${validPrefix}obj_${1000 + i}.jpg` })),
        IsTruncated: false,
      });
      // Delete page 2
      s3SendMock.mockResolvedValueOnce({
        Deleted: Array.from({ length: 50 }, (_, i) => ({ Key: `${validPrefix}obj_${1000 + i}.jpg` })),
        Errors: [],
      });

      await service.deleteInternalPrefix(validPrefix, true);

      expect(s3SendMock).toHaveBeenCalledTimes(4); // 2 Lists + 2 Deletes
    });
  });

  describe('DeleteObjects Partial Error Handling', () => {
    it('should throw an Error if DeleteObjectsCommand response contains Errors', async () => {
      const validPrefix = 'ai/jobs/550e8400-e29b-41d4-a716-446655440000/source-review/';
      s3SendMock.mockResolvedValueOnce({
        Contents: [{ Key: `${validPrefix}page_1.jpg` }],
        IsTruncated: false,
      });
      s3SendMock.mockResolvedValueOnce({
        Deleted: [],
        Errors: [
          {
            Key: `${validPrefix}page_1.jpg`,
            Code: 'AccessDenied',
            Message: 'Access Denied to delete object',
          },
        ],
      });

      await expect(
        service.deleteInternalPrefix(validPrefix, true),
      ).rejects.toThrow(/S3_DELETE_OBJECTS_FAILED/);
    });
  });
});
