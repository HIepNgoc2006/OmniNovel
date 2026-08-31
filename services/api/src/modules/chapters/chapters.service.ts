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
import { ChapterVersionType, GlobalRole, StoryMemberRole, StoryVisibility } from '@omninovel/shared';

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
    if (!story) {
      throw new NotFoundException('Không tìm thấy bộ truyện tương ứng với chương này.');
    }

    // Helper: Lấy role của user trong story
    let userStoryRole: StoryMemberRole | null = null;
    if (user && user.id) {
      const memberRes = await this.dataSource.query(
        `SELECT role FROM story_members WHERE story_id = $1 AND user_id = $2`,
        [story.id, user.id],
      );
      if (memberRes && memberRes.length > 0) {
        userStoryRole = memberRes[0].role as StoryMemberRole;
      }
    }

    const hasAdminOrStaffAccess =
      user?.role === GlobalRole.ADMIN ||
      userStoryRole === StoryMemberRole.OWNER ||
      userStoryRole === StoryMemberRole.EDITOR ||
      userStoryRole === StoryMemberRole.TRANSLATOR;

    // 1. Kiểm tra quyền truy cập Story (nếu Story là PRIVATE)
    if (story.visibility === StoryVisibility.PRIVATE) {
      if (!user) {
        throw new ForbiddenException(
          'Chương truyện này thuộc bộ truyện riêng tư (PRIVATE). Vui lòng đăng nhập.',
        );
      }

      if (user.role !== GlobalRole.ADMIN && !userStoryRole) {
        throw new ForbiddenException(
          'Bạn không có quyền truy cập chương truyện riêng tư này.',
        );
      }
    }

    const targetVersionId = versionId || chapter.activeVersionId;
    let version: ChapterVersion | null = null;

    if (targetVersionId) {
      // Tìm version theo ID và xác minh thuộc đúng Chapter
      const candidateVersion = await this.versionRepository.findOne({
        where: { id: targetVersionId },
      });

      if (!candidateVersion) {
        throw new NotFoundException('Không tìm thấy phiên bản (versionId) yêu cầu.');
      }

      if (candidateVersion.chapterId !== chapter.id) {
        throw new BadRequestException(
          'Phiên bản (versionId) chỉ định không thuộc về chương truyện này (Hierarchy Violation).',
        );
      }

      // Kiểm tra chính sách truy cập phiên bản (Version Access Policy)
      if (!candidateVersion.isPublished) {
        if (!user) {
          throw new ForbiddenException(
            'Bản nháp (Draft) chưa công bố yêu cầu đăng nhập với quyền hợp lệ.',
          );
        }
        if (!hasAdminOrStaffAccess) {
          throw new ForbiddenException(
            'Chỉ OWNER, EDITOR, TRANSLATOR hoặc ADMIN mới có quyền xem bản nháp này.',
          );
        }
      }

      version = candidateVersion;
    }

    let mediaAssets: MediaAsset[] = [];
    if (version) {
      mediaAssets = await this.mediaAssetRepository.find({
        where: { versionId: version.id },
        order: { sortOrder: 'ASC' },
      });
    }

    // 2. Lấy danh sách availableVersions
    const allVersions = await this.versionRepository.find({
      where: { chapterId: chapter.id },
      order: { versionNumber: 'DESC' },
    });

    const availableVersions = hasAdminOrStaffAccess
      ? allVersions
      : allVersions.filter((v) => v.isPublished);

    // 3. Tính toán Canonical Navigation trong cùng StoryEdition
    const currentNum = Number(chapter.chapterNumber);

    const prevQuery = await this.dataSource.query(
      `SELECT c.id, c.chapter_number AS "chapterNumber", c.title
       FROM chapters c
       JOIN chapter_versions cv ON cv.id = c.active_version_id
       WHERE c.story_edition_id = $1
         AND cv.is_published = TRUE
         AND CAST(c.chapter_number AS NUMERIC) < $2
       ORDER BY CAST(c.chapter_number AS NUMERIC) DESC, c.created_at DESC
       LIMIT 1`,
      [chapter.storyEditionId, currentNum],
    );

    const nextQuery = await this.dataSource.query(
      `SELECT c.id, c.chapter_number AS "chapterNumber", c.title
       FROM chapters c
       JOIN chapter_versions cv ON cv.id = c.active_version_id
       WHERE c.story_edition_id = $1
         AND cv.is_published = TRUE
         AND CAST(c.chapter_number AS NUMERIC) > $2
       ORDER BY CAST(c.chapter_number AS NUMERIC) ASC, c.created_at ASC
       LIMIT 1`,
      [chapter.storyEditionId, currentNum],
    );

    // Tăng lượt xem chapter
    await this.chapterRepository.increment({ id: chapter.id }, 'viewsCount', 1);

    const formattedMediaAssets = mediaAssets.map((a) => ({
      id: a.id,
      sortOrder: a.sortOrder,
      assetType: a.assetType,
      storageKey: a.storageKey,
      width: a.width,
      height: a.height,
    }));

    return {
      story: {
        id: story.id,
        slug: story.slug,
        title: story.title,
        mediaFormat: story.mediaFormat,
        visibility: story.visibility,
      },
      chapter: {
        id: chapter.id,
        storyEditionId: chapter.storyEditionId,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        activeVersionId: chapter.activeVersionId,
        viewsCount: chapter.viewsCount,
      },
      activeVersion: version
        ? {
            id: version.id,
            versionNumber: version.versionNumber,
            versionType: version.versionType,
            language: version.language,
            isPublished: version.isPublished,
            createdAt: version.createdAt,
          }
        : null,
      availableVersions: availableVersions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        versionType: v.versionType,
        language: v.language,
        isPublished: v.isPublished,
        createdAt: v.createdAt,
      })),
      mediaAssets: formattedMediaAssets,
      pages: formattedMediaAssets,
      navigation: {
        previous: prevQuery.length > 0 ? prevQuery[0] : null,
        next: nextQuery.length > 0 ? nextQuery[0] : null,
      },
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
