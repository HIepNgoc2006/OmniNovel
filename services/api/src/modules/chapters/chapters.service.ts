import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chapter } from './entities/chapter.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { Volume } from './entities/volume.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { ChapterVersionType } from '@omninovel/shared';

@Injectable()
export class ChaptersService {
  constructor(
    @InjectRepository(Chapter)
    private chapterRepository: Repository<Chapter>,
    @InjectRepository(ChapterVersion)
    private versionRepository: Repository<ChapterVersion>,
    @InjectRepository(Volume)
    private volumeRepository: Repository<Volume>,
    @InjectRepository(MediaAsset)
    private mediaAssetRepository: Repository<MediaAsset>,
  ) {}

  async findById(id: string, versionId?: string) {
    const chapter = await this.chapterRepository.findOne({
      where: { id },
      relations: ['storyEdition', 'volume', 'activeVersion'],
    });

    if (!chapter) {
      throw new NotFoundException('Không tìm thấy chương truyện yêu cầu.');
    }

    const targetVersionId = versionId || chapter.activeVersionId;
    let version: ChapterVersion | null = null;
    let mediaAssets: MediaAsset[] = [];

    if (targetVersionId) {
      version = await this.versionRepository.findOne({
        where: { id: targetVersionId, chapterId: chapter.id },
      });

      if (version) {
        mediaAssets = await this.mediaAssetRepository.find({
          where: { versionId: version.id },
          order: { sortOrder: 'ASC' },
        });
      }
    }

    // Tăng lượt xem chapter
    await this.chapterRepository.increment({ id: chapter.id }, 'viewsCount', 1);

    return {
      chapter: {
        id: chapter.id,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        activeVersionId: chapter.activeVersionId,
        viewsCount: chapter.viewsCount,
      },
      activeVersion: version,
      pages: mediaAssets,
    };
  }

  async createChapter(
    storyEditionId: string,
    chapterNumber: string,
    title?: string,
    volumeId?: string,
  ) {
    const existing = await this.chapterRepository.findOne({
      where: { storyEditionId, chapterNumber },
    });

    if (existing) {
      throw new BadRequestException(
        `Chương số ${chapterNumber} đã tồn tại trong ấn bản này.`,
      );
    }

    const chapter = this.chapterRepository.create({
      storyEditionId,
      chapterNumber,
      title,
      volumeId,
    });

    return this.chapterRepository.save(chapter);
  }

  async createVersion(
    chapterId: string,
    versionType: ChapterVersionType,
    language = 'vi',
    createdBy?: string,
  ) {
    const chapter = await this.chapterRepository.findOne({ where: { id: chapterId } });
    if (!chapter) {
      throw new NotFoundException('Chương truyện không tồn tại.');
    }

    const latestVersion = await this.versionRepository.findOne({
      where: { chapterId },
      order: { versionNumber: 'DESC' },
    });

    const versionNumber = latestVersion ? latestVersion.versionNumber + 1 : 1;

    const version = this.versionRepository.create({
      chapterId,
      versionNumber,
      versionType,
      language,
      createdBy,
      isPublished: true,
    });

    const savedVersion = await this.versionRepository.save(version);

    // Nếu chapter chưa có active version thì tự động gán version đầu tiên làm active
    if (!chapter.activeVersionId) {
      chapter.activeVersionId = savedVersion.id;
      await this.chapterRepository.save(chapter);
    }

    return savedVersion;
  }

  async activateVersion(chapterId: string, versionId: string) {
    const chapter = await this.chapterRepository.findOne({ where: { id: chapterId } });
    if (!chapter) {
      throw new NotFoundException('Chương truyện không tồn tại.');
    }

    // Kiểm tra tính bất biến same-chapter
    const version = await this.versionRepository.findOne({
      where: { id: versionId, chapterId },
    });

    if (!version) {
      throw new BadRequestException(
        'Phiên bản chỉ định không thuộc về chương truyện này (Same-Chapter Invariant Violation).',
      );
    }

    chapter.activeVersionId = version.id;
    await this.chapterRepository.save(chapter);

    return {
      chapterId: chapter.id,
      activeVersionId: chapter.activeVersionId,
      versionNumber: version.versionNumber,
    };
  }
}
