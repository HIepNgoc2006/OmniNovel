import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
const AdmZip = require('adm-zip');

import {
  ChapterArtifactType,
  ChapterArtifactStatus,
  ChapterArtifactDto,
  OfflineBundleManifest,
  OfflineBundleFileEntry,
  MediaAssetType,
} from '@omninovel/shared';

import { ChapterArtifact } from './entities/chapter-artifact.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { Chapter } from './entities/chapter.entity';
import { StorageService } from '../storage/storage.service';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class CanonicalPackagingService {
  private readonly logger = new Logger(CanonicalPackagingService.name);

  constructor(
    @InjectRepository(ChapterArtifact)
    private readonly artifactRepo: Repository<ChapterArtifact>,
    @InjectRepository(ChapterVersion)
    private readonly versionRepo: Repository<ChapterVersion>,
    @InjectRepository(Chapter)
    private readonly chapterRepo: Repository<Chapter>,
    @InjectRepository(MediaAsset)
    private readonly mediaAssetRepo: Repository<MediaAsset>,
    @InjectQueue('chapter-packaging')
    private readonly packagingQueue: Queue,
    private readonly storageService: StorageService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Deterministic Job ID format: pkg_${chapterVersionId}_${artifactType}
   * Tuyệt đối không chứa dấu hai chấm ':' vì là separator nội bộ của BullMQ/Redis.
   */
  public getDeterministicJobId(
    chapterVersionId: string,
    artifactType: ChapterArtifactType,
  ): string {
    return `pkg_${chapterVersionId}_${artifactType}`;
  }

  /**
   * Lấy trạng thái artifact hiện tại kèm presigned download URL nếu đã READY
   */
  async getArtifactStatus(
    chapterVersionId: string,
    artifactType: ChapterArtifactType = ChapterArtifactType.OFFLINE_BUNDLE,
  ): Promise<ChapterArtifactDto> {
    const artifact = await this.artifactRepo.findOne({
      where: { chapterVersionId, artifactType },
    });

    if (!artifact || artifact.status === ChapterArtifactStatus.MISSING) {
      return {
        status: ChapterArtifactStatus.MISSING,
        artifactReady: false,
        artifactType,
        chapterVersionId,
        downloadUrl: null,
        fileSizeBytes: null,
        sha256: null,
      };
    }

    // Kiểm tra stall/orphan cho BUILDING
    if (artifact.status === ChapterArtifactStatus.BUILDING) {
      const isStale =
        Date.now() - new Date(artifact.updatedAt).getTime() > 15 * 60 * 1000;
      if (isStale) {
        artifact.status = ChapterArtifactStatus.FAILED;
        artifact.errorMessage = 'PACKAGING_STALLED_TIMEOUT';
        await this.artifactRepo.save(artifact);
        return {
          status: ChapterArtifactStatus.FAILED,
          artifactReady: false,
          artifactType,
          chapterVersionId,
          errorMessage: artifact.errorMessage,
        };
      }

      return {
        status: ChapterArtifactStatus.BUILDING,
        artifactReady: false,
        artifactType,
        chapterVersionId,
        retryAfter: 5,
      };
    }

    if (artifact.status === ChapterArtifactStatus.FAILED) {
      return {
        status: ChapterArtifactStatus.FAILED,
        artifactReady: false,
        artifactType,
        chapterVersionId,
        errorMessage: artifact.errorMessage,
      };
    }

    // Status: READY -> Ký presigned URL
    let downloadUrl: string | null = null;
    let expiresAt: string | null = null;
    if (artifact.storageKey) {
      const version = await this.versionRepo.findOne({
        where: { id: chapterVersionId },
        relations: ['chapter', 'chapter.storyEdition', 'chapter.storyEdition.story'],
      });
      const isManga = version?.chapter?.storyEdition?.story?.mediaFormat !== 'NOVEL';
      const ttlSeconds = 3600;
      downloadUrl = await this.storageService.createInternalDownloadUrl(
        artifact.storageKey,
        isManga,
        ttlSeconds,
      );
      expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    }

    return {
      status: ChapterArtifactStatus.READY,
      artifactReady: true,
      artifactType,
      chapterVersionId,
      downloadUrl,
      fileSizeBytes: artifact.fileSizeBytes ? Number(artifact.fileSizeBytes) : null,
      sha256: artifact.sha256Hash,
      expiresAt,
    };
  }

  /**
   * Kích hoạt hoặc đưa tác vụ đóng gói vào hàng đợi BullMQ bền vững
   */
  async enqueuePackaging(params: {
    chapterId: string;
    chapterVersionId: string;
    artifactType?: ChapterArtifactType;
  }): Promise<ChapterArtifactDto> {
    const artifactType =
      params.artifactType || ChapterArtifactType.OFFLINE_BUNDLE;

    // 1. Kiểm tra trạng thái hiện tại trong CSDL
    let artifact = await this.artifactRepo.findOne({
      where: { chapterVersionId: params.chapterVersionId, artifactType },
    });

    if (artifact && artifact.status === ChapterArtifactStatus.READY) {
      return this.getArtifactStatus(params.chapterVersionId, artifactType);
    }

    const jobId = this.getDeterministicJobId(params.chapterVersionId, artifactType);

    // 2. Chống deadlock khi retry sau failure: Gỡ bỏ job failed/completed cũ nếu tồn tại
    const existingJob = await this.packagingQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'failed' || state === 'completed') {
        try {
          await existingJob.remove();
          this.logger.log(`[BullMQ] Removed old ${state} job: ${jobId}`);
        } catch (err: any) {
          this.logger.warn(`[BullMQ] Could not remove old job ${jobId}: ${err.message}`);
        }
      } else if (state === 'active' || state === 'waiting' || state === 'delayed') {
        return {
          status: ChapterArtifactStatus.BUILDING,
          artifactReady: false,
          artifactType,
          chapterVersionId: params.chapterVersionId,
          retryAfter: 5,
        };
      }
    }

    // 3. Atomically upsert CSDL ChapterArtifact -> BUILDING
    if (!artifact) {
      artifact = this.artifactRepo.create({
        chapterVersionId: params.chapterVersionId,
        artifactType,
        status: ChapterArtifactStatus.BUILDING,
        errorMessage: null,
      });
    } else {
      artifact.status = ChapterArtifactStatus.BUILDING;
      artifact.errorMessage = null;
    }
    await this.artifactRepo.save(artifact);

    // 4. Enqueue BullMQ Job
    await this.packagingQueue.add(
      'package-chapter-version',
      {
        chapterId: params.chapterId,
        chapterVersionId: params.chapterVersionId,
        artifactType,
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return {
      status: ChapterArtifactStatus.BUILDING,
      artifactReady: false,
      artifactType,
      chapterVersionId: params.chapterVersionId,
      retryAfter: 5,
    };
  }

  /**
   * Đánh dấu artifact thất bại khi BullMQ processor gặp lỗi không thể phục hồi
   */
  async markArtifactFailed(
    chapterVersionId: string,
    artifactType: ChapterArtifactType,
    errorMessage: string,
  ): Promise<void> {
    await this.artifactRepo.update(
      { chapterVersionId, artifactType },
      {
        status: ChapterArtifactStatus.FAILED,
        errorMessage,
      },
    );
  }

  /**
   * Tiến trình đóng gói cốt lõi được gọi bởi BullMQ processor
   */
  async processPackagingJob(data: {
    chapterId: string;
    chapterVersionId: string;
    artifactType: ChapterArtifactType;
  }): Promise<void> {
    const { chapterId, chapterVersionId, artifactType } = data;

    this.logger.log(
      `[Packaging] Processing ${artifactType} for chapterVersion=${chapterVersionId}`,
    );

    // 1. Tải ChapterVersion đầy đủ kèm quan hệ
    const version = await this.versionRepo.findOne({
      where: { id: chapterVersionId },
      relations: [
        'chapter',
        'chapter.storyEdition',
        'chapter.storyEdition.story',
        'mediaAssets',
      ],
    });

    if (!version) {
      throw new NotFoundException(
        `ChapterVersion ${chapterVersionId} không tồn tại.`,
      );
    }

    const chapter = version.chapter;
    const story = chapter?.storyEdition?.story;
    if (!story) {
      throw new NotFoundException(
        `Không tìm thấy Story tương ứng cho ChapterVersion ${chapterVersionId}.`,
      );
    }

    const isManga = story.mediaFormat !== 'NOVEL';
    const canonicalKey =
      artifactType === ChapterArtifactType.TRANSLATION_SOURCE
        ? `artifacts/chapters/${chapter.id}/versions/${version.id}/source-package.zip`
        : `artifacts/chapters/${chapter.id}/versions/${version.id}/offline-bundle.zip`;

    // 2. Gom media assets sắp xếp theo sortOrder ASC
    const assets = (version.mediaAssets || []).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );

    if (assets.length === 0) {
      throw new Error(
        `ChapterVersion ${chapterVersionId} không có MediaAsset nào để đóng gói.`,
      );
    }

    // 3. Khởi tạo ZIP container
    const zip = new AdmZip();
    const manifestFiles: OfflineBundleFileEntry[] = [];

    if (story.mediaFormat === 'NOVEL') {
      // NOVEL Packaging: Canonical raw HTML + illustrations
      let novelContentPath = 'content.html';
      const htmlAsset = assets.find(
        (a) => a.assetType === MediaAssetType.NOVEL_HTML,
      );

      if (!htmlAsset) {
        throw new Error(
          `Phiên bản tiểu thuyết ${chapterVersionId} thiếu MediaAsset NOVEL_HTML.`,
        );
      }

      const rawHtmlBuffer = await this.storageService.getInternalObjectBuffer(
        htmlAsset.storageKey,
        false,
      );
      let rawHtml = rawHtmlBuffer.toString('utf8');

      // Đóng gói các tệp ảnh minh họa (ILLUSTRATION)
      const illustrations = assets.filter(
        (a) => a.assetType === MediaAssetType.ILLUSTRATION,
      );

      for (const ill of illustrations) {
        const illBuffer = await this.storageService.getInternalObjectBuffer(
          ill.storageKey,
          false,
        );
        const illHash = crypto
          .createHash('sha256')
          .update(illBuffer)
          .digest('hex');
        const relativePath = `illustrations/ill_${String(ill.sortOrder).padStart(4, '0')}.webp`;

        zip.addFile(relativePath, illBuffer);

        manifestFiles.push({
          path: relativePath,
          assetId: ill.id,
          assetType: MediaAssetType.ILLUSTRATION,
          mimeType: 'image/webp',
          size: illBuffer.length,
          sha256: illHash,
          sortOrder: ill.sortOrder,
          width: ill.width,
          height: ill.height,
        });

        // Rewrite relative link trong HTML nếu có
        rawHtml = rawHtml.split(ill.storageKey).join(relativePath);
      }

      const finalHtmlBuffer = Buffer.from(rawHtml, 'utf8');
      const htmlHash = crypto
        .createHash('sha256')
        .update(finalHtmlBuffer)
        .digest('hex');

      zip.addFile(novelContentPath, finalHtmlBuffer);

      manifestFiles.unshift({
        path: novelContentPath,
        assetId: htmlAsset.id,
        assetType: MediaAssetType.NOVEL_HTML,
        mimeType: 'text/html',
        size: finalHtmlBuffer.length,
        sha256: htmlHash,
        sortOrder: htmlAsset.sortOrder,
      });

      const manifest: OfflineBundleManifest = {
        schemaVersion: 1,
        bundleType: 'OFFLINE_READER',
        chapterId: chapter.id,
        chapterVersionId: version.id,
        storyId: story.id,
        storyTitle: story.title,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
        mediaFormat: 'NOVEL',
        publicationFormat: story.publicationFormat,
        language: version.language || 'vi',
        versionNumber: version.versionNumber,
        versionType: version.versionType,
        createdAt: new Date().toISOString(),
        files: manifestFiles,
        novelMetadata: {
          contentPath: novelContentPath,
        },
      };

      zip.addFile(
        'manifest.json',
        Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      );
    } else {
      // COMIC / MANGA / WEBTOON Packaging
      for (const asset of assets) {
        const fileBuffer = await this.storageService.getInternalObjectBuffer(
          asset.storageKey,
          true,
        );
        const fileHash = crypto
          .createHash('sha256')
          .update(fileBuffer)
          .digest('hex');
        const relativePath = `pages/page_${String(asset.sortOrder).padStart(4, '0')}.webp`;

        zip.addFile(relativePath, fileBuffer);

        manifestFiles.push({
          path: relativePath,
          assetId: asset.id,
          assetType: MediaAssetType.MANGA_PAGE,
          mimeType: 'image/webp',
          size: fileBuffer.length,
          sha256: fileHash,
          sortOrder: asset.sortOrder,
          width: asset.width,
          height: asset.height,
        });
      }

      const manifest: OfflineBundleManifest = {
        schemaVersion: 1,
        bundleType: 'OFFLINE_READER',
        chapterId: chapter.id,
        chapterVersionId: version.id,
        storyId: story.id,
        storyTitle: story.title,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
        mediaFormat: 'COMIC',
        publicationFormat: story.publicationFormat,
        language: version.language || 'vi',
        versionNumber: version.versionNumber,
        versionType: version.versionType,
        createdAt: new Date().toISOString(),
        files: manifestFiles,
        novelMetadata: null,
      };

      zip.addFile(
        'manifest.json',
        Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      );
    }

    // 4. Tạo Buffer ZIP, tính SHA-256 hash và kích thước byte
    const zipBuffer = zip.toBuffer();
    const zipSha256 = crypto
      .createHash('sha256')
      .update(zipBuffer)
      .digest('hex');

    // 5. Upload lên MinIO qua StorageService
    await this.storageService.uploadInternalBuffer(
      canonicalKey,
      zipBuffer,
      'application/zip',
      isManga,
    );

    // 6. Atomic CSDL Commit -> READY
    await this.artifactRepo.upsert(
      {
        chapterVersionId: version.id,
        artifactType,
        status: ChapterArtifactStatus.READY,
        storageKey: canonicalKey,
        fileSizeBytes: zipBuffer.length.toString(),
        sha256Hash: zipSha256,
        manifestMetadata: {
          totalFiles: manifestFiles.length,
          mediaFormat: story.mediaFormat,
        } as any,
        errorMessage: null,
        updatedAt: new Date(),
      },
      ['chapterVersionId', 'artifactType'],
    );

    this.logger.log(
      `[Packaging] Success ${artifactType} for chapterVersion=${chapterVersionId}: size=${zipBuffer.length}, sha256=${zipSha256}`,
    );
  }
}
