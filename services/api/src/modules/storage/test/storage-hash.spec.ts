import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PayloadTooLargeException } from '@nestjs/common';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { StorageService } from '../storage.service';
import { UploadSession } from '../entities/upload-session.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { StoryEdition } from '../../stories/entities/story-edition.entity';

describe('StorageService.hashInternalObjectSha256 (#163)', () => {
  let service: StorageService;
  let s3SendMock: jest.Mock;

  beforeEach(async () => {
    s3SendMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: getRepositoryToken(UploadSession), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(StoryEdition), useValue: {} },
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
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    (service as any).s3Client = {
      send: s3SendMock,
    };
  });

  it('should stream object and calculate sha256 hash correctly', async () => {
    const payload = JSON.stringify({ version: 1, message: 'test' });
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');

    s3SendMock.mockResolvedValueOnce({
      ContentType: 'application/json',
      Body: Readable.from([Buffer.from(payload)]),
    });

    const res = await service.hashInternalObjectSha256(
      'ai/jobs/123/structure/abc.json',
      false,
      10 * 1024 * 1024,
    );

    expect(res.exists).toBe(true);
    expect(res.sha256).toBe(expectedSha256);
    expect(res.size).toBe(Buffer.byteLength(payload));
    expect(res.contentType).toBe('application/json');
  });

  it('should return exists: false when object not found in storage', async () => {
    const error404: any = new Error('NoSuchKey');
    error404.name = 'NoSuchKey';
    s3SendMock.mockRejectedValueOnce(error404);

    const res = await service.hashInternalObjectSha256(
      'ai/jobs/123/structure/notfound.json',
      false,
    );

    expect(res.exists).toBe(false);
    expect(res.size).toBe(0);
    expect(res.sha256).toBeUndefined();
  });

  it('should throw PayloadTooLargeException when object size exceeds maxBytes', async () => {
    const chunk1 = Buffer.alloc(600, 'a');
    const chunk2 = Buffer.alloc(600, 'b');

    s3SendMock.mockResolvedValueOnce({
      ContentType: 'application/json',
      Body: Readable.from([chunk1, chunk2]),
    });

    await expect(
      service.hashInternalObjectSha256(
        'ai/jobs/123/structure/toolarge.json',
        false,
        1000, // 1000 bytes max
      ),
    ).rejects.toThrow(PayloadTooLargeException);
  });
});
