import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
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
    const endpoint = this.configService.get<string>('MINIO_ENDPOINT', 'localhost');
    const port = this.configService.get<number>('MINIO_PORT', 9000);
    const useSSL = this.configService.get<boolean>('MINIO_USE_SSL', false);
    const accessKey = this.configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin');
    const secretKey = this.configService.get<string>('MINIO_SECRET_KEY', 'minioadmin');

    this.mangaBucket = this.configService.get<string>('MINIO_BUCKET_MANGA', 'manga-media');
    this.novelBucket = this.configService.get<string>('MINIO_BUCKET_NOVEL', 'novel-media');

    this.s3Client = new S3Client({
      endpoint: `${useSSL ? 'https' : 'http'}://${endpoint}:${port}`,
      region: 'us-east-1',
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true, // Bắt buộc đối với MinIO S3
    });
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

    // Cấp Presigned PUT URL vào Quarantine Prefix
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: quarantineKey,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900, // 15 phút
    });

    return {
      sessionId: session.id,
      uploadUrl,
      bucket,
      quarantineKey,
      expiresIn: 900,
    };
  }

  // 2. FINALIZE, VALIDATE MAGIC BYTES & PROMOTE FILE
  async finalizeUploadSession(sessionId: string, userId: string, userRole?: GlobalRole) {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Không tìm thấy phiên tải lên.');
    }

    // Invariant 1: Kiểm tra quyền sở hữu phiên hoặc quyền Story Member / Admin
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
      }
    }

    // Invariant 2: Chống Double-Finalize
    if (session.status !== UploadSessionStatus.PENDING) {
      throw new BadRequestException(`Phiên upload đang ở trạng thái ${session.status} (Không thể finalize lại).`);
    }

    // Invariant 3: Kiểm tra hết hạn phiên
    if (new Date() > new Date(session.expiresAt)) {
      session.status = UploadSessionStatus.EXPIRED;
      session.errorMessage = 'Phiên tải lên đã hết hạn 15 phút.';
      await this.sessionRepository.save(session);
      const isManga =
        session.fileType === AllowedUploadFileType.MANGA_IMAGE ||
        session.fileType === AllowedUploadFileType.MANGA_ZIP;
      await this.deleteObject(isManga ? this.mangaBucket : this.novelBucket, session.quarantineKey);
      throw new BadRequestException('Phiên tải lên đã hết hạn (Expired).');
    }

    const isManga =
      session.fileType === AllowedUploadFileType.MANGA_IMAGE ||
      session.fileType === AllowedUploadFileType.MANGA_ZIP;
    const bucket = isManga ? this.mangaBucket : this.novelBucket;

    // 1. Kiểm tra sự tồn tại của file trong Quarantine
    let headData: any;
    try {
      headData = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: session.quarantineKey,
        }),
      );
    } catch {
      session.status = UploadSessionStatus.FAILED;
      session.errorMessage = 'File chưa được tải lên MinIO quarantine.';
      await this.sessionRepository.save(session);
      throw new BadRequestException('Không tìm thấy file đã tải lên trong vùng cách ly (Quarantine).');
    }

    const actualSize = headData.ContentLength || 0;
    if (actualSize === 0) {
      await this.deleteObject(bucket, session.quarantineKey);
      session.status = UploadSessionStatus.FAILED;
      session.errorMessage = 'File rỗng (0 bytes).';
      await this.sessionRepository.save(session);
      throw new BadRequestException('File tải lên rỗng.');
    }

    if (actualSize > 524288000) { // 500MB
      await this.deleteObject(bucket, session.quarantineKey);
      session.status = UploadSessionStatus.FAILED;
      session.errorMessage = 'File tải lên vượt quá dung lượng tối đa 500MB.';
      await this.sessionRepository.save(session);
      throw new BadRequestException('File tải lên vượt quá giới hạn cho phép (500MB).');
    }

    // 2. Đọc nội dung để xác thực Magic Bytes & Security Boundary
    const getObj = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: session.quarantineKey,
      }),
    );

    const streamToBuffer = async (stream: any): Promise<Buffer> => {
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };

    const fileBuffer = await streamToBuffer(getObj.Body);

    try {
      this.validateFileContent(session.fileType as AllowedUploadFileType, fileBuffer);
    } catch (err: any) {
      // Validation thất bại -> Xóa khỏi Quarantine và đánh dấu FAILED
      await this.deleteObject(bucket, session.quarantineKey);
      session.status = UploadSessionStatus.FAILED;
      session.errorMessage = err.message;
      await this.sessionRepository.save(session);
      throw err;
    }

    // 3. Promote: Chuyển từ Quarantine sang Final Key
    const fileExt = this.getFileExtension(session.fileType as AllowedUploadFileType);
    const finalKey = `media/editions/${session.storyEditionId}/${uuidv4()}${fileExt}`;

    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${session.quarantineKey}`,
        Key: finalKey,
      }),
    );

    // Xóa object trong Quarantine
    await this.deleteObject(bucket, session.quarantineKey);

    // 4. Transactional DB updates & Compensation
    let createdAsset: MediaAsset | null = null;
    try {
      await this.dataSource.transaction(async (manager) => {
        session.finalKey = finalKey;
        session.status = UploadSessionStatus.PROMOTED;
        session.completedAt = new Date();
        await manager.save(session);

        if (session.chapterVersionId) {
          const assetCount = await manager.count(MediaAsset, {
            where: { versionId: session.chapterVersionId },
          });

          const assetType = isManga ? MediaAssetType.MANGA_PAGE : MediaAssetType.NOVEL_HTML;
          const mediaAsset = manager.create(MediaAsset, {
            versionId: session.chapterVersionId,
            sortOrder: assetCount + 1,
            assetType,
            storageKey: finalKey,
            fileSizeBytes: actualSize.toString(),
          });
          createdAsset = await manager.save(mediaAsset);
        }
      });
    } catch (err) {
      // Compensation: xóa file promoted nếu DB transaction fail
      await this.deleteObject(bucket, finalKey);
      throw err;
    }

    return {
      success: true,
      sessionId: session.id,
      finalKey,
      status: session.status,
      mediaAsset: createdAsset,
    };
  }

  // 3. CẤP PRESIGNED GET URL THEO PRIVACY & PERMISSION MATRIX
  async getMediaDownloadUrl(assetId: string, user?: any) {
    const asset = await this.mediaAssetRepository.findOne({
      where: { id: assetId },
      relations: [
        'chapterVersion',
        'chapterVersion.chapter',
        'chapterVersion.chapter.storyEdition',
        'chapterVersion.chapter.storyEdition.story',
      ],
    });

    if (!asset) {
      throw new NotFoundException('Không tìm thấy tài nguyên media yêu cầu.');
    }

    const story = asset.chapterVersion?.chapter?.storyEdition?.story;
    const isManga = asset.assetType === MediaAssetType.MANGA_PAGE;
    const bucket = isManga ? this.mangaBucket : this.novelBucket;

    // Kiểm tra Privacy Policy
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

    // Cấp Presigned GET URL ngắn hạn 15 phút (900s)
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

  private validateFileContent(fileType: AllowedUploadFileType, buffer: Buffer) {
    if (fileType === AllowedUploadFileType.MANGA_IMAGE) {
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
    } else if (fileType === AllowedUploadFileType.MANGA_ZIP) {
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
      if (entries.length > 1000) {
        throw new BadRequestException('File ZIP chứa hơn 1000 entries (Vượt quá giới hạn an toàn).');
      }

      let totalUncompressedSize = 0;
      for (const entry of entries) {
        if (entry.entryName.includes('..') || entry.entryName.startsWith('/') || entry.entryName.startsWith('\\')) {
          throw new BadRequestException('Phát hiện tấn công Path Traversal / Zip Slip trong file ZIP.');
        }
        totalUncompressedSize += entry.header.size;
      }

      if (totalUncompressedSize > 500 * 1024 * 1024) {
        throw new BadRequestException('Tổng dung lượng giải nén vượt quá 500MB (Phát hiện Zip Bomb).');
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
    }
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
}
