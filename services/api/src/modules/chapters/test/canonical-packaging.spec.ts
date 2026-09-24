import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
const AdmZip = require('adm-zip');

import {
  ChapterArtifactType,
  ChapterArtifactStatus,
  MediaAssetType,
} from '@omninovel/shared';

import { CanonicalPackagingService } from '../canonical-packaging.service';
import { ChapterPackagingProcessor } from '../chapter-packaging.processor';
import { ChapterArtifact } from '../entities/chapter-artifact.entity';
import { ChapterVersion } from '../entities/chapter-version.entity';
import { Chapter } from '../entities/chapter.entity';
import { MediaAsset } from '../entities/media-asset.entity';
import { StorageService } from '../../storage/storage.service';
import { RedisService } from '../../../redis/redis.service';

describe('CanonicalPackagingService & ChapterPackagingProcessor (#190 / Phase 5D)', () => {
  let service: CanonicalPackagingService;
  let processor: ChapterPackagingProcessor;
  let artifactRepo: any;
  let versionRepo: any;
  let chapterRepo: any;
  let mediaAssetRepo: any;
  let packagingQueue: any;
  let storageService: any;
  let redisService: any;

  const validVersionId = '11111111-1111-4111-8111-111111111111';
  const validChapterId = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    artifactRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'art-1' })),
      save: jest.fn().mockImplementation(async (entity) => entity),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };

    versionRepo = {
      findOne: jest.fn(),
    };

    chapterRepo = {
      findOne: jest.fn(),
    };

    mediaAssetRepo = {
      find: jest.fn(),
    };

    packagingQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'pkg_job_1' }),
    };

    storageService = {
      createInternalDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://storage.internal/presigned/download.zip'),
      getInternalObjectBuffer: jest.fn(),
      uploadInternalBuffer: jest.fn().mockResolvedValue(undefined),
    };

    redisService = {
      setnx: jest.fn().mockResolvedValue(true),
      renewLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanonicalPackagingService,
        ChapterPackagingProcessor,
        { provide: getRepositoryToken(ChapterArtifact), useValue: artifactRepo },
        { provide: getRepositoryToken(ChapterVersion), useValue: versionRepo },
        { provide: getRepositoryToken(Chapter), useValue: chapterRepo },
        { provide: getRepositoryToken(MediaAsset), useValue: mediaAssetRepo },
        { provide: 'BullQueue_chapter-packaging', useValue: packagingQueue },
        { provide: StorageService, useValue: storageService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<CanonicalPackagingService>(CanonicalPackagingService);
    processor = module.get<ChapterPackagingProcessor>(ChapterPackagingProcessor);
  });

  describe('Deterministic Job ID - BullMQ Safe Key Compliance', () => {
    it('generates canonical jobId without colons (:)', () => {
      const jobId = service.getDeterministicJobId(
        validVersionId,
        ChapterArtifactType.OFFLINE_BUNDLE,
      );

      expect(jobId).toBe(`pkg_${validVersionId}_${ChapterArtifactType.OFFLINE_BUNDLE}`);
      expect(jobId.includes(':')).toBe(false);
    });

    it('generates valid distinct jobId for TRANSLATION_SOURCE', () => {
      const jobId = service.getDeterministicJobId(
        validVersionId,
        ChapterArtifactType.TRANSLATION_SOURCE,
      );

      expect(jobId).toBe(`pkg_${validVersionId}_${ChapterArtifactType.TRANSLATION_SOURCE}`);
      expect(jobId.includes(':')).toBe(false);
    });
  });

  describe('enqueuePackaging - Deadlock & Concurrency Prevention', () => {
    it('returns existing status without re-enqueue when artifact is already READY', async () => {
      artifactRepo.findOne.mockResolvedValue({
        id: 'art-ready-1',
        chapterVersionId: validVersionId,
        artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        status: ChapterArtifactStatus.READY,
        storageKey: 'artifacts/test.zip',
        fileSizeBytes: '1024',
        sha256Hash: 'a'.repeat(64),
      });

      const result = await service.enqueuePackaging({
        chapterId: validChapterId,
        chapterVersionId: validVersionId,
      });

      expect(result.status).toBe(ChapterArtifactStatus.READY);
      expect(result.artifactReady).toBe(true);
      expect(packagingQueue.add).not.toHaveBeenCalled();
    });

    it('removes failed old job from BullMQ before re-adding to prevent BullMQ retry deadlock', async () => {
      const mockFailedJob = {
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      packagingQueue.getJob.mockResolvedValueOnce(mockFailedJob);

      artifactRepo.findOne.mockResolvedValueOnce({
        id: 'art-failed-1',
        chapterVersionId: validVersionId,
        artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        status: ChapterArtifactStatus.FAILED,
      });

      const result = await service.enqueuePackaging({
        chapterId: validChapterId,
        chapterVersionId: validVersionId,
      });

      expect(mockFailedJob.remove).toHaveBeenCalled();
      expect(artifactRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ChapterArtifactStatus.BUILDING,
          errorMessage: null,
        }),
      );
      expect(packagingQueue.add).toHaveBeenCalledWith(
        'package-chapter-version',
        expect.objectContaining({
          chapterId: validChapterId,
          chapterVersionId: validVersionId,
        }),
        expect.objectContaining({
          jobId: `pkg_${validVersionId}_${ChapterArtifactType.OFFLINE_BUNDLE}`,
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
      expect(result.status).toBe(ChapterArtifactStatus.BUILDING);
    });

    it('returns BUILDING without re-adding when job is currently active or waiting in BullMQ', async () => {
      const mockActiveJob = {
        getState: jest.fn().mockResolvedValue('active'),
        remove: jest.fn(),
      };
      packagingQueue.getJob.mockResolvedValueOnce(mockActiveJob);

      artifactRepo.findOne.mockResolvedValueOnce({
        id: 'art-bld-1',
        chapterVersionId: validVersionId,
        artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        status: ChapterArtifactStatus.BUILDING,
      });

      const result = await service.enqueuePackaging({
        chapterId: validChapterId,
        chapterVersionId: validVersionId,
      });

      expect(mockActiveJob.remove).not.toHaveBeenCalled();
      expect(packagingQueue.add).not.toHaveBeenCalled();
      expect(result.status).toBe(ChapterArtifactStatus.BUILDING);
    });
  });

  describe('ChapterPackagingProcessor - Redis Lock & Retry Attempt Guards', () => {
    it('acquires distributed lock with lease renewal and releases in finally', async () => {
      const processSpy = jest
        .spyOn(service, 'processPackagingJob')
        .mockResolvedValueOnce(undefined);

      const mockJob: any = {
        id: `pkg_${validVersionId}_OFFLINE_BUNDLE`,
        data: {
          chapterId: validChapterId,
          chapterVersionId: validVersionId,
          artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      };

      await processor.process(mockJob);

      expect(redisService.setnx).toHaveBeenCalledWith(
        `lock:package:${validVersionId}:${ChapterArtifactType.OFFLINE_BUNDLE}`,
        expect.any(String),
        120,
      );
      expect(processSpy).toHaveBeenCalled();
      expect(redisService.releaseLock).toHaveBeenCalled();
    });

    it('does not mark artifact FAILED on transient failure when attempts remain (attemptsMade < maxAttempts)', async () => {
      jest
        .spyOn(service, 'processPackagingJob')
        .mockRejectedValueOnce(new Error('S3 Transient Network Error'));

      const markFailedSpy = jest
        .spyOn(service, 'markArtifactFailed')
        .mockResolvedValueOnce(undefined);

      const mockJob: any = {
        id: `pkg_${validVersionId}_OFFLINE_BUNDLE`,
        data: {
          chapterId: validChapterId,
          chapterVersionId: validVersionId,
          artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        },
        attemptsMade: 0, // Attempt 1 of 3
        opts: { attempts: 3 },
      };

      await expect(processor.process(mockJob)).rejects.toThrow(
        'S3 Transient Network Error',
      );

      expect(markFailedSpy).not.toHaveBeenCalled();
      expect(redisService.releaseLock).toHaveBeenCalled();
    });

    it('marks artifact FAILED in DB when final attempt is exhausted (attemptsMade + 1 >= maxAttempts)', async () => {
      jest
        .spyOn(service, 'processPackagingJob')
        .mockRejectedValueOnce(new Error('Permanent Corrupted Asset Error'));

      const markFailedSpy = jest
        .spyOn(service, 'markArtifactFailed')
        .mockResolvedValueOnce(undefined);

      const mockJob: any = {
        id: `pkg_${validVersionId}_OFFLINE_BUNDLE`,
        data: {
          chapterId: validChapterId,
          chapterVersionId: validVersionId,
          artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        },
        attemptsMade: 2, // Attempt 3 of 3 (final)
        opts: { attempts: 3 },
      };

      await expect(processor.process(mockJob)).rejects.toThrow(
        'Permanent Corrupted Asset Error',
      );

      expect(markFailedSpy).toHaveBeenCalledWith(
        validVersionId,
        ChapterArtifactType.OFFLINE_BUNDLE,
        'Permanent Corrupted Asset Error',
      );
      expect(redisService.releaseLock).toHaveBeenCalled();
    });
  });

  describe('processPackagingJob - COMIC Packaging & Manifest Schema', () => {
    it('packages Comic pages into zip with valid manifest.json containing MANGA_PAGE entries and null novelMetadata', async () => {
      const mockPages = [
        {
          id: 'asset-p1',
          storageKey: 'manga/p1.webp',
          sortOrder: 1,
          width: 800,
          height: 1200,
          assetType: MediaAssetType.MANGA_PAGE,
        },
        {
          id: 'asset-p2',
          storageKey: 'manga/p2.webp',
          sortOrder: 2,
          width: 800,
          height: 1200,
          assetType: MediaAssetType.MANGA_PAGE,
        },
      ];

      versionRepo.findOne.mockResolvedValueOnce({
        id: validVersionId,
        versionNumber: 1,
        versionType: 'BASE',
        language: 'vi',
        chapter: {
          id: validChapterId,
          chapterNumber: '1',
          title: 'Hồi 1',
          storyEdition: {
            story: {
              id: 'story-comic-1',
              title: 'One Piece Manga',
              mediaFormat: 'COMIC',
              publicationFormat: 'PAGINATED',
            },
          },
        },
        mediaAssets: mockPages,
      });

      storageService.getInternalObjectBuffer.mockImplementation(
        async (key: string) => Buffer.from(`fake-image-bytes-for-${key}`),
      );

      let capturedZipBuffer: Buffer | null = null;
      storageService.uploadInternalBuffer.mockImplementation(
        async (key: string, buffer: Buffer) => {
          capturedZipBuffer = buffer;
        },
      );

      await service.processPackagingJob({
        chapterId: validChapterId,
        chapterVersionId: validVersionId,
        artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
      });

      expect(storageService.uploadInternalBuffer).toHaveBeenCalledWith(
        `artifacts/chapters/${validChapterId}/versions/${validVersionId}/offline-bundle.zip`,
        expect.any(Buffer),
        'application/zip',
        true,
      );

      // Verify ZIP contents and manifest
      expect(capturedZipBuffer).not.toBeNull();
      const zip = new AdmZip(capturedZipBuffer);
      const manifestEntry = zip.getEntry('manifest.json');
      expect(manifestEntry).toBeDefined();

      const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.bundleType).toBe('OFFLINE_READER');
      expect(manifest.mediaFormat).toBe('COMIC');
      expect(manifest.novelMetadata).toBeNull();
      expect(manifest.files).toHaveLength(2);
      expect(manifest.files[0].assetType).toBe(MediaAssetType.MANGA_PAGE);
      expect(manifest.files[0].path).toBe('pages/page_0001.webp');
      expect(manifest.files[1].path).toBe('pages/page_0002.webp');

      // Verify DB upsert
      expect(artifactRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          chapterVersionId: validVersionId,
          artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
          status: ChapterArtifactStatus.READY,
          storageKey: `artifacts/chapters/${validChapterId}/versions/${validVersionId}/offline-bundle.zip`,
        }),
        ['chapterVersionId', 'artifactType'],
      );
    });
  });

  describe('processPackagingJob - NOVEL Packaging & Manifest Schema', () => {
    it('packages Novel raw HTML + illustrations with rewritten relative URLs and typed novelMetadata', async () => {
      const mockRawHtml = `<p>Đoạn mở đầu</p><img src="storage/novels/ill_01.webp" /><p>Hết</p>`;
      const mockAssets = [
        {
          id: 'asset-html-1',
          storageKey: 'novels/chapter_content.html',
          sortOrder: 0,
          assetType: MediaAssetType.NOVEL_HTML,
        },
        {
          id: 'asset-ill-1',
          storageKey: 'storage/novels/ill_01.webp',
          sortOrder: 1,
          width: 1200,
          height: 800,
          assetType: MediaAssetType.ILLUSTRATION,
        },
      ];

      versionRepo.findOne.mockResolvedValueOnce({
        id: validVersionId,
        versionNumber: 1,
        versionType: 'BASE',
        language: 'vi',
        chapter: {
          id: validChapterId,
          chapterNumber: '1',
          title: 'Chương 1: Mở màn',
          storyEdition: {
            story: {
              id: 'story-novel-1',
              title: 'Chúa tể bóng tối',
              mediaFormat: 'NOVEL',
              publicationFormat: 'CONTINUOUS',
            },
          },
        },
        mediaAssets: mockAssets,
      });

      storageService.getInternalObjectBuffer.mockImplementation(
        async (key: string) => {
          if (key.endsWith('.html')) return Buffer.from(mockRawHtml, 'utf8');
          return Buffer.from('fake-illustration-image-binary');
        },
      );

      let capturedZipBuffer: Buffer | null = null;
      storageService.uploadInternalBuffer.mockImplementation(
        async (key: string, buffer: Buffer) => {
          capturedZipBuffer = buffer;
        },
      );

      await service.processPackagingJob({
        chapterId: validChapterId,
        chapterVersionId: validVersionId,
        artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
      });

      expect(capturedZipBuffer).not.toBeNull();
      const zip = new AdmZip(capturedZipBuffer);

      // Verify content.html has rewritten relative image path
      const contentHtmlEntry = zip.getEntry('content.html');
      expect(contentHtmlEntry).toBeDefined();
      const contentHtml = contentHtmlEntry.getData().toString('utf8');
      expect(contentHtml).toContain('illustrations/ill_0001.webp');
      expect(contentHtml).not.toContain('storage/novels/ill_01.webp');

      // Verify manifest.json
      const manifestEntry = zip.getEntry('manifest.json');
      const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
      expect(manifest.mediaFormat).toBe('NOVEL');
      expect(manifest.novelMetadata).toEqual({
        contentPath: 'content.html',
      });
      expect(manifest.files).toHaveLength(2);
      expect(manifest.files[0].assetType).toBe(MediaAssetType.NOVEL_HTML);
      expect(manifest.files[0].path).toBe('content.html');
      expect(manifest.files[1].assetType).toBe(MediaAssetType.ILLUSTRATION);
      expect(manifest.files[1].path).toBe('illustrations/ill_0001.webp');
    });
  });
});
