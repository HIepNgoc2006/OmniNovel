import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
const AdmZip = require('adm-zip');
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import {
  CreateUploadSessionDto,
  AllowedUploadFileType,
} from './dto/create-upload-session.dto';
import { MediaAsset } from '../chapters/entities/media-asset.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { GlobalRole, StoryVisibility, MediaAssetType } from '@omninovel/shared';

@Injectable()
export class StorageService {
  private s3Client: S3Client;
  private mangaBucket: string;
  private novelBucket: string;

  constructor(
    @InjectRepository(UploadSession)
    private sessionRepository: Repository<UploadSession>,
    @InjectRepository(MediaAsset)
    private mediaAssetRepository: Repository<MediaAsset>,
    @InjectRepository(StoryEdition)
    private editionRepository: Repository<StoryEdition>,
    private configService: ConfigService,
    private dataSource: DataSource,
  ) {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    const provider = (
      this.configService.get<string>('STORAGE_PROVIDER') ||
      (nodeEnv === 'production' ? 'r2' : 'minio')
    ).toLowerCase();

    let endpoint: string;
    let region: string;
    let accessKey: string;
    let secretKey: string;
    let forcePathStyle: boolean;

    if (provider === 'r2' || nodeEnv === 'production') {
      // PRODUCTION / R2: BẮT BUỘC FAIL-FAST nếu thiếu bất kỳ biến nào, TUYỆT ĐỐI không fallback localhost / minioadmin
      const r2Endpoint = this.configService.get<string>('S3_ENDPOINT');
      const r2AccessKey =
        this.configService.get<string>('S3_ACCESS_KEY_ID') ||
        this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const r2SecretKey =
        this.configService.get<string>('S3_SECRET_ACCESS_KEY') ||
        this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
      const r2MangaBucket = this.configService.get<string>('S3_BUCKET_MANGA');
      const r2NovelBucket = this.configService.get<string>('S3_BUCKET_NOVEL');

      const missingVars: string[] = [];
      if (!r2Endpoint) missingVars.push('S3_ENDPOINT');
      if (!r2AccessKey) missingVars.push('S3_ACCESS_KEY_ID');
      if (!r2SecretKey) missingVars.push('S3_SECRET_ACCESS_KEY');
      if (!r2MangaBucket) missingVars.push('S3_BUCKET_MANGA');
      if (!r2NovelBucket) missingVars.push('S3_BUCKET_NOVEL');

      if (missingVars.length > 0) {
        throw new Error(
          `[StorageService] Production / R2 Storage Misconfiguration: Missing required environment variables: ${missingVars.join(', ')}. Fail-fast triggered.`,
        );
      }

      endpoint = r2Endpoint!;
      region = this.configService.get<string>('S3_REGION', 'auto');
      accessKey = r2AccessKey!;
      secretKey = r2SecretKey!;
      forcePathStyle = this.configService.get<boolean>('S3_FORCE_PATH_STYLE', false);

      this.mangaBucket = r2MangaBucket!;
      this.novelBucket = r2NovelBucket!;
    } else {
      // LOCAL DEV / CI: Hỗ trợ S3_* hoặc fallback về MINIO_*
      const s3Endpoint = this.configService.get<string>('S3_ENDPOINT');
      if (s3Endpoint) {
        endpoint = s3Endpoint;
      } else {
        const minioHost = this.configService.get<string>('MINIO_ENDPOINT', 'localhost');
        const minioPort = this.configService.get<number>('MINIO_PORT', 9000);
        const useSSL = this.configService.get<boolean>('MINIO_USE_SSL', false);
        endpoint = `${useSSL ? 'https' : 'http'}://${minioHost}:${minioPort}`;
      }

      region = this.configService.get<string>('S3_REGION', 'us-east-1');
      accessKey =
        this.configService.get<string>('S3_ACCESS_KEY_ID') ||
        this.configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin');
      secretKey =
        this.configService.get<string>('S3_SECRET_ACCESS_KEY') ||
        this.configService.get<string>('MINIO_SECRET_KEY', 'minioadmin');
      forcePathStyle = this.configService.get<boolean>('S3_FORCE_PATH_STYLE', true);

      this.mangaBucket =
        this.configService.get<string>('S3_BUCKET_MANGA') ||
        this.configService.get<string>('MINIO_BUCKET_MANGA', 'manga-media');
      this.novelBucket =
        this.configService.get<string>('S3_BUCKET_NOVEL') ||
        this.configService.get<string>('MINIO_BUCKET_NOVEL', 'novel-media');
    }

    this.s3Client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle,
    });
  }

  public getS3Client(): S3Client {
    return this.s3Client;
  }

  public getBucketConfig() {
    return {
      mangaBucket: this.mangaBucket,
      novelBucket: this.novelBucket,
    };
  }

  // 1. TẠO PHIÊN UPLOAD VÀ CẤP PRESIGNED PUT URL
  async createUploadSession(userId: string, dto: CreateUploadSessionDto) {
    const edition = await this.editionRepository.findOne({
      where: { id: dto.storyEditionId },
    });

    if (!edition) {
      throw new NotFoundException('Không tìm thấy ấn bản (StoryEdition) chỉ định.');
    }

    const isManga =
      dto.fileType === AllowedUploadFileType.MANGA_IMAGE ||
      dto.fileType === AllowedUploadFileType.MANGA_ZIP;
    const bucket = isManga ? this.mangaBucket : this.novelBucket;

    const fileExt = this.getFileExtension(dto.fileType);
    const sessionId = uuidv4();
    const quarantineKey = `quarantine/editions/${dto.storyEditionId}/${sessionId}/${uuidv4()}${fileExt}`;

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút

    const session = this.sessionRepository.create({
      id: sessionId,
      userId,
      storyEditionId: dto.storyEditionId,
      chapterVersionId: dto.chapterVersionId || null,
      fileType: dto.fileType,
      expectedSize: dto.expectedSize.toString(),
      quarantineKey,
      status: UploadSessionStatus.PENDING,
      expiresAt,
    });

    await this.sessionRepository.save(session);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: quarantineKey,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900,
    });

    return {
      sessionId: session.id,
      uploadUrl,
      bucket,
      quarantineKey,
      expiresIn: 900,
    };
  }

  // 2. FINALIZE: AUTH FIRST -> ATOMIC VALIDATING LOCK -> SIZE & DEEP VALIDATION -> PROMOTE
  async finalizeUploadSession(sessionId: string, userId: string, userRole?: GlobalRole) {
    // Bước 1: Load session kiểm tra sự tồn tại
    const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên tải lên.');
    }

    // Bước 2: Kiểm tra hết hạn phiên 15 phút
    if (new Date() > new Date(session.expiresAt)) {
      throw new BadRequestException('Phiên tải lên đã hết hạn (Expired).');
    }

    // Bước 3: Kiểm tra quyền sở hữu phiên hoặc quyền Story Member / Admin TRƯỚC KHI chuyển trạng thái (Ngăn chặn Authorization-triggered DoS)
    if (session.userId !== userId && userRole !== GlobalRole.ADMIN) {
      const edition = await this.editionRepository.findOne({
        where: { id: session.storyEditionId },
      });
      if (edition) {
        const isMember = await this.dataSource.query(
          `SELECT 1 FROM story_members WHERE story_id = $1 AND user_id = $2`,
          [edition.storyId, userId],
        );
        if (!isMember || isMember.length === 0) {
          throw new ForbiddenException('Bạn không có quyền hoàn tất phiên tải lên này.');
        }
      } else {
        throw new ForbiddenException('Bạn không có quyền hoàn tất phiên tải lên này.');
      }
    }

    // Bước 4: Chuyển trạng thái Atomic PENDING -> VALIDATING để chống Double-Finalize race condition
    const transitionResult = await this.dataSource.query(
      `UPDATE upload_sessions 
       SET status = 'VALIDATING' 
       WHERE id = $1 AND status = 'PENDING' 
       RETURNING *`,
      [sessionId],
    );

    const rows =
      Array.isArray(transitionResult) && Array.isArray(transitionResult[0])
        ? transitionResult[0]
        : transitionResult;

    if (!rows || rows.length === 0) {
      const fresh = await this.sessionRepository.findOne({ where: { id: sessionId } });
      throw new BadRequestException(
        `Phiên upload đang ở trạng thái ${fresh?.status || 'UNKNOWN'} (Không thể finalize lại).`,
      );
    }

    const isManga =
      session.fileType === AllowedUploadFileType.MANGA_IMAGE ||
      session.fileType === AllowedUploadFileType.MANGA_ZIP;
    const bucket = isManga ? this.mangaBucket : this.novelBucket;

    // Bước 5: Kiểm tra sự tồn tại của file trong MinIO Quarantine
    let headData: any;
    try {
      headData = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: session.quarantineKey,
        }),
      );
    } catch {
      await this.failSession(session, 'File chưa được tải lên MinIO quarantine.');
      throw new BadRequestException('Không tìm thấy file đã tải lên trong vùng cách ly (Quarantine).');
    }

    const actualSize = headData.ContentLength || 0;

    // Bước 6: Kiểm tra exact expectedSize match & 100MB limit theo Security SSoT
    const expectedSizeBytes = Number(session.expectedSize);
    if (actualSize !== expectedSizeBytes) {
      await this.failSession(
        session,
        `Kích thước file thực tế (${actualSize} bytes) không khớp với expectedSize (${expectedSizeBytes} bytes).`,
      );
      await this.deleteObject(bucket, session.quarantineKey);
      throw new BadRequestException(
        `Kích thước file thực tế (${actualSize} bytes) không khớp với expectedSize đã khai báo (${expectedSizeBytes} bytes).`,
      );
    }

    if (actualSize > 104857600) { // 100MB
      await this.failSession(session, 'File tải lên vượt quá dung lượng tối đa 100MB.');
      await this.deleteObject(bucket, session.quarantineKey);
      throw new BadRequestException('File tải lên vượt quá giới hạn an toàn 100MB.');
    }

    // Bước 7: Deep Content Validation & Magic Bytes Check
    try {
      if (session.fileType === AllowedUploadFileType.MANGA_IMAGE) {
        const rangeEnd = Math.min(actualSize - 1, 16383);
        const getHeaderObj = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: session.quarantineKey,
            Range: `bytes=0-${rangeEnd}`,
          }),
        );
        const headerBuffer = await this.streamToBuffer(getHeaderObj.Body);
        this.validateImageMagicBytes(headerBuffer);
      } else {
        const getFullObj = await this.s3Client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: session.quarantineKey,
          }),
        );
        const fullBuffer = await this.streamToBuffer(getFullObj.Body);
        this.validateArchiveOrDocument(session.fileType as AllowedUploadFileType, fullBuffer, actualSize);
      }
    } catch (err: any) {
      await this.failSession(session, err.message);
      await this.deleteObject(bucket, session.quarantineKey);
      if (err instanceof BadRequestException || err instanceof ForbiddenException) {
        throw err;
      }
      throw new BadRequestException(err.message || 'Lỗi xác thực dữ liệu file tải lên.');
    }

    // Bước 8: Promote: Di chuyển từ Quarantine sang Final Key
    const fileExt = this.getFileExtension(session.fileType as AllowedUploadFileType);
    const finalKey = `media/editions/${session.storyEditionId}/${uuidv4()}${fileExt}`;

    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${session.quarantineKey}`,
        Key: finalKey,
      }),
    );

    // Xóa object trong Quarantine sau khi copy thành công
    await this.deleteObject(bucket, session.quarantineKey);

    // Bước 9: Transactional DB Update & Compensation
    let createdAsset: MediaAsset | null = null;
    try {
      await this.dataSource.transaction(async (manager) => {
        session.finalKey = finalKey;
        session.status = UploadSessionStatus.PROMOTED;
        session.completedAt = new Date();
        await manager.save(session);

        // Chỉ tạo MediaAsset render-ready đối với MANGA_IMAGE đơn lẻ
        // Đối với MANGA_ZIP, NOVEL_EPUB, NOVEL_MD: giữ vai trò raw source package
        if (session.chapterVersionId && session.fileType === AllowedUploadFileType.MANGA_IMAGE) {
          const assetCount = await manager.count(MediaAsset, {
            where: { versionId: session.chapterVersionId },
          });

          const mediaAsset = manager.create(MediaAsset, {
            versionId: session.chapterVersionId,
            sortOrder: assetCount + 1,
            assetType: MediaAssetType.MANGA_PAGE,
            storageKey: finalKey,
            fileSizeBytes: actualSize.toString(),
          });
          createdAsset = await manager.save(mediaAsset);
        }
      });
    } catch (err) {
      await this.deleteObject(bucket, finalKey);
      throw err;
    }

    return {
      success: true,
      sessionId: session.id,
      finalKey,
      status: session.status,
      mediaAsset: createdAsset,
      isRawSourcePackage: session.fileType !== AllowedUploadFileType.MANGA_IMAGE,
    };
  }

  // 3. CẤP PRESIGNED GET URL THEO PRIVACY & PERMISSION MATRIX
  async getMediaDownloadUrl(assetId: string, user?: any) {
    const asset = await this.mediaAssetRepository.findOne({
      where: { id: assetId },
      relations: {
        chapterVersion: {
          chapter: {
            storyEdition: {
              story: true,
            },
          },
        },
      },
    });

    if (!asset) {
      throw new NotFoundException('Không tìm thấy tài nguyên media yêu cầu.');
    }

    const story = asset.chapterVersion?.chapter?.storyEdition?.story;
    const isManga = asset.assetType === MediaAssetType.MANGA_PAGE;
    const bucket = isManga ? this.mangaBucket : this.novelBucket;

    if (story && story.visibility === StoryVisibility.PRIVATE) {
      if (!user) {
        throw new ForbiddenException('Tài nguyên thuộc bộ truyện riêng tư. Vui lòng đăng nhập.');
      }
      if (user.role !== GlobalRole.ADMIN) {
        const isMember = await this.dataSource.query(
          `SELECT 1 FROM story_members WHERE story_id = $1 AND user_id = $2`,
          [story.id, user.id],
        );
        if (!isMember || isMember.length === 0) {
          throw new ForbiddenException('Bạn không có quyền tải tài nguyên media riêng tư này.');
        }
      }
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: asset.storageKey,
    });

    const downloadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900,
    });

    return {
      downloadUrl,
      expiresIn: 900,
    };
  }

  private validateImageMagicBytes(buffer: Buffer) {
    const isPNG =
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
    const isJPEG =
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;
    const isWebP =
      buffer.length >= 12 &&
      buffer.toString('utf8', 0, 4) === 'RIFF' &&
      buffer.toString('utf8', 8, 12) === 'WEBP';

    if (!isPNG && !isJPEG && !isWebP) {
      throw new BadRequestException(
        'Magic bytes không khớp với định dạng ảnh hợp lệ (PNG, JPEG, WEBP). Giảm thiểu rủi ro giả mạo MIME type.',
      );
    }
  }

  private validateArchiveOrDocument(
    fileType: AllowedUploadFileType,
    buffer: Buffer,
    actualCompressedSize: number,
  ) {
    if (fileType === AllowedUploadFileType.MANGA_ZIP) {
      const isZip =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);

      if (!isZip) {
        throw new BadRequestException('Magic bytes không khớp với định dạng ZIP hợp lệ.');
      }

      let zip: any;
      try {
        zip = new AdmZip(buffer);
      } catch {
        throw new BadRequestException('File ZIP bị lỗi cấu trúc hoặc hư hỏng.');
      }

      const entries = zip.getEntries();
      if (entries.length > 500) {
        throw new BadRequestException('File ZIP chứa hơn 500 entries (Vượt quá giới hạn Security SSoT).');
      }

      let totalUncompressedSize = 0;
      for (const entry of entries) {
        if (
          entry.entryName.includes('..') ||
          entry.entryName.startsWith('/') ||
          entry.entryName.startsWith('\\')
        ) {
          throw new BadRequestException('Phát hiện tấn công Path Traversal / Zip Slip trong file ZIP.');
        }
        totalUncompressedSize += entry.header.size;
      }

      if (totalUncompressedSize > 104857600) { // 100MB
        throw new BadRequestException('Tổng dung lượng giải nén vượt quá 100MB.');
      }

      const compressionRatio = totalUncompressedSize / Math.max(1, actualCompressedSize);
      if (compressionRatio > 100) {
        throw new BadRequestException('Tỷ lệ nén vượt quá 100:1 (Phát hiện tấn công Zip Bomb).');
      }
    } else if (fileType === AllowedUploadFileType.NOVEL_EPUB) {
      const isZip =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);

      if (!isZip) {
        throw new BadRequestException('Magic bytes không khớp với định dạng EPUB container hợp lệ.');
      }

      let zip: any;
      try {
        zip = new AdmZip(buffer);
      } catch {
        throw new BadRequestException('File EPUB bị lỗi cấu trúc container ZIP.');
      }

      const entries = zip.getEntries();
      if (entries.length > 500) {
        throw new BadRequestException('File EPUB chứa quá nhiều entries (> 500).');
      }

      // Xác thực cấu trúc chuẩn EPUB
      const mimetypeEntry = entries.find((e: any) => e.entryName === 'mimetype');
      const containerEntry = entries.find(
        (e: any) => e.entryName === 'META-INF/container.xml' || e.entryName === 'META-INF\\container.xml',
      );

      if (!mimetypeEntry || !containerEntry) {
        throw new BadRequestException(
          'File EPUB không đúng cấu trúc tiêu chuẩn (Thiếu mimetype hoặc META-INF/container.xml).',
        );
      }

      const mimetypeContent = mimetypeEntry.getData().toString('utf8').trim();
      if (!mimetypeContent.includes('application/epub+zip')) {
        throw new BadRequestException('Mimetype trong file EPUB không phải application/epub+zip.');
      }

      let totalUncompressedSize = 0;
      for (const entry of entries) {
        if (
          entry.entryName.includes('..') ||
          entry.entryName.startsWith('/') ||
          entry.entryName.startsWith('\\')
        ) {
          throw new BadRequestException('Phát hiện tấn công Path Traversal trong file EPUB.');
        }
        totalUncompressedSize += entry.header.size;
      }

      if (totalUncompressedSize > 104857600) {
        throw new BadRequestException('Tổng dung lượng giải nén EPUB vượt quá 100MB.');
      }
    } else if (fileType === AllowedUploadFileType.NOVEL_MD) {
      const text = buffer.toString('utf8');
      const dangerousPatterns = [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
        /javascript:/gi,
        /onerror\s*=/gi,
        /onload\s*=/gi,
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(text)) {
          throw new BadRequestException('Nội dung Markdown chứa mã script hoặc iframe nguy hiểm (XSS Blocked).');
        }
      }
    }
  }

  private async failSession(
    session: UploadSession,
    errorMessage: string,
    status = UploadSessionStatus.FAILED,
  ) {
    session.status = status;
    session.errorMessage = errorMessage;
    await this.sessionRepository.save(session);
  }

  private async streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private async deleteObject(bucket: string, key: string) {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    } catch {}
  }

  private getFileExtension(fileType: AllowedUploadFileType): string {
    switch (fileType) {
      case AllowedUploadFileType.MANGA_IMAGE:
        return '.img';
      case AllowedUploadFileType.MANGA_ZIP:
        return '.zip';
      case AllowedUploadFileType.NOVEL_EPUB:
        return '.epub';
      case AllowedUploadFileType.NOVEL_MD:
        return '.md';
      default:
        return '.bin';
    }
  }

  // 4. INTERNAL HELPER METHODS CHO TRANSLATION VÀ AI WORKER PIPELINE
  getInternalBucket(isManga = true): string {
    return isManga ? this.mangaBucket : this.novelBucket;
  }

  async deleteInternalObject(key: string, isManga = true): Promise<void> {
    const bucket = this.getInternalBucket(isManga);
    await this.deleteObject(bucket, key);
  }


  async createInternalDownloadUrl(key: string, isManga = true, expiresInSeconds = 900): Promise<string> {
    const bucket = this.getInternalBucket(isManga);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  async createInternalUploadUrl(
    key: string,
    contentType = 'image/webp',
    isManga = true,
    expiresInSeconds = 900,
    checksumSha256Base64?: string,
  ): Promise<string> {
    const bucket = this.getInternalBucket(isManga);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ...(checksumSha256Base64 ? { ChecksumSHA256: checksumSha256Base64 } : {}),
    });
    return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  async statInternalObject(key: string, isManga = true): Promise<InternalObjectMetadata> {
    const bucket = this.getInternalBucket(isManga);
    try {
      const res = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      return {
        exists: true,
        contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
        contentType: res.ContentType,
      };
    } catch (err: any) {
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return { exists: false, contentLength: null };
      }
      throw err;
    }
  }

  async headInternalObject(key: string, isManga = true): Promise<boolean> {
    const stat = await this.statInternalObject(key, isManga);
    return stat.exists;
  }

  /**
   * Tính mã băm SHA-256 của internal object bằng streaming để phòng ngừa tràn bộ nhớ (#163).
   * Kiểm tra giới hạn kích thước tối đa (mặc định 10MB cho snapshot JSON).
   */
  async hashInternalObjectSha256(
    key: string,
    isManga = false,
    maxBytes = 10 * 1024 * 1024,
  ): Promise<{
    exists: boolean;
    sha256?: string;
    size: number;
    contentType?: string;
  }> {
    const bucket = this.getInternalBucket(isManga);
    try {
      const res = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      if (!res.Body) {
        return { exists: false, size: 0 };
      }

      const hash = crypto.createHash('sha256');
      let totalBytes = 0;
      const stream = res.Body as any;

      for await (const chunk of stream) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          if (typeof stream.destroy === 'function') {
            stream.destroy();
          }
          throw new PayloadTooLargeException(
            `Object ${key} vượt quá kích thước tối đa cho phép (${maxBytes} bytes).`,
          );
        }
        hash.update(chunk);
      }

      return {
        exists: true,
        sha256: hash.digest('hex'),
        size: totalBytes,
        contentType: res.ContentType,
      };
    } catch (err: any) {
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return { exists: false, size: 0 };
      }
      throw err;
    }
  }

  async uploadInternalBuffer(
    key: string,
    buffer: Buffer,
    contentType = 'application/json',
    isManga = true,
  ): Promise<void> {
    const bucket = this.getInternalBucket(isManga);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
  }

  async getInternalObjectBuffer(key: string, isManga = true): Promise<Buffer> {
    const bucket = this.getInternalBucket(isManga);
    const res = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    if (!res.Body) {
      throw new NotFoundException(`Object ${key} không có nội dung dữ liệu.`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getSignedUrlForInternalRead(
    key: string,
    isManga = true,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const bucket = this.getInternalBucket(isManga);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Xóa toàn bộ các objects theo prefix nội bộ (#159, #172).
   * Yêu cầu an toàn nghiêm ngặt (Fail-Closed):
   * - Bắt buộc prefix bắt đầu bằng 'ai/jobs/' và kết thúc bằng '/'
   * - Không chứa path traversal '..'
   * - Phải có segment jobId là UUID hợp lệ (chặn blast radius bare 'ai/jobs/')
   */
  async deleteInternalPrefix(prefix: string, isManga = true): Promise<void> {
    if (
      !prefix ||
      typeof prefix !== 'string' ||
      !prefix.startsWith('ai/jobs/') ||
      !prefix.endsWith('/') ||
      prefix.includes('..')
    ) {
      throw new BadRequestException('INVALID_INTERNAL_DELETE_PREFIX');
    }

    const parts = prefix.split('/');
    // 'ai/jobs/{jobId}/...' -> parts[0] = 'ai', parts[1] = 'jobs', parts[2] = jobId
    if (parts.length < 4 || !parts[2] || !isUuid(parts[2])) {
      throw new BadRequestException(
        'INVALID_INTERNAL_DELETE_PREFIX: Must be job-scoped with a valid UUID',
      );
    }

    const bucket = this.getInternalBucket(isManga);
    let continuationToken: string | undefined;

    do {
      const listRes = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const objectsToDelete = (listRes.Contents || [])
        .map((obj) => ({ Key: obj.Key }))
        .filter(
          (item): item is { Key: string } =>
            typeof item.Key === 'string' && item.Key.length > 0,
        );

      if (objectsToDelete.length > 0) {
        const deleteRes = await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objectsToDelete,
              Quiet: true,
            },
          }),
        );

        if (deleteRes.Errors && deleteRes.Errors.length > 0) {
          const sample = deleteRes.Errors[0];
          throw new Error(
            `S3_DELETE_OBJECTS_FAILED: Failed to delete ${sample.Key} with code ${sample.Code}: ${sample.Message}`,
          );
        }
      }

      continuationToken = listRes.IsTruncated
        ? listRes.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }
}

export interface InternalObjectMetadata {
  exists: boolean;
  contentLength: number | null;
  contentType?: string;
}

