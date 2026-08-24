import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Chapter } from './entities/chapter.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { Volume } from './entities/volume.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { Story } from '../stories/entities/story.entity';
import { ChapterVersionType, GlobalRole, StoryVisibility } from '@omninovel/shared';

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
    @InjectRepository(StoryEdition)
    private editionRepository: Repository<StoryEdition>,
    private dataSource: DataSource,
  ) {}

  async findById(id: string, versionId?: string, user?: any) {
    const chapter = await this.chapterRepository.findOne({
      where: { id },
      relations: ['storyEdition', 'storyEdition.story', 'volume', 'activeVersion'],
    });

    if (!chapter) {
      throw new NotFoundException('Không tìm thấy chương truyện yêu cầu.');
    }

    const story = chapter.storyEdition?.story;
    if (story && story.visibility === StoryVisibility.PRIVATE) {
      if (!user) {
        throw new ForbiddenException(
          'Chương truyện này thuộc bộ truyện riêng tư (PRIVATE). Vui lòng đăng nhập.',
        );
      }

      if (user.role !== GlobalRole.ADMIN) {
        const isMember = await this.dataSource.query(
          `SELECT 1 FROM story_members WHERE story_id = $1 AND user_id = $2`,
          [story.id, user.id],
        );
        if (!isMember || isMember.length === 0) {
          throw new ForbiddenException('Bạn không có quyền truy cập chương truyện riêng tư này.');
        }
      }
    }

    const targetVersionId = versionId || chapter.activeVersionId;

    // Nếu người dùng yêu cầu xem versionId khác activeVersionId (ví dụ bản nháp draft)
    if (versionId && versionId !== chapter.activeVersionId) {
      if (!user) {
        throw new ForbiddenException('Bản nháp (Draft) chưa công bố yêu cầu đăng nhập.');
      }
      if (user.role !== GlobalRole.ADMIN) {
        const isMember = await this.dataSource.query(
          `SELECT 1 FROM story_members WHERE story_id = $1 AND user_id = $2`,
          [story?.id, user.id],
        );
        if (!isMember || isMember.length === 0) {
          throw new ForbiddenException('Bạn không có quyền xem bản nháp này.');
        }
      }
    }

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
    // 1. Kiểm tra Volume có thuộc về đúng Story Edition hay không (Hierarchy Validation)
    if (volumeId) {
      const volume = await this.volumeRepository.findOne({
        where: { id: volumeId, storyEditionId },
      });

      if (!volume) {
        throw new BadRequestException(
          'Tập truyện (Volume) chỉ định không thuộc về ấn bản (Edition) này (Hierarchy Invariant Violation).',
        );
      }
    }

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
      volumeId: volumeId || null,
    });

    return this.chapterRepository.save(chapter);
  }

  async createVersion(
    chapterId: string,
    versionType: ChapterVersionType,
    language = 'vi',
    createdBy?: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      // Pessimistic lock để ngăn race condition khi cấp phát versionNumber
      const chapter = await manager.findOne(Chapter, {
        where: { id: chapterId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!chapter) {
        throw new NotFoundException('Chương truyện không tồn tại.');
      }

      const latestVersion = await manager.findOne(ChapterVersion, {
        where: { chapterId },
        order: { versionNumber: 'DESC' },
      });

      const versionNumber = latestVersion ? latestVersion.versionNumber + 1 : 1;

      const version = manager.create(ChapterVersion, {
        chapterId,
        versionNumber,
        versionType,
        language,
        createdBy,
        isPublished: true,
      });

      const savedVersion = await manager.save(version);

      if (!chapter.activeVersionId) {
        chapter.activeVersionId = savedVersion.id;
        await manager.save(chapter);
      }

      return savedVersion;
    });
  }

  async activateVersion(chapterId: string, versionId: string) {
    const chapter = await this.chapterRepository.findOne({ where: { id: chapterId } });
    if (!chapter) {
      throw new NotFoundException('Chương truyện không tồn tại.');
    }

    // Same-chapter invariant check
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
