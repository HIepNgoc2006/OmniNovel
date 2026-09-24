import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In } from 'typeorm';
import { Chapter } from './entities/chapter.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { Volume } from './entities/volume.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { ChapterArtifact } from './entities/chapter-artifact.entity';
import { CanonicalPackagingService } from './canonical-packaging.service';
import { ChapterErrorReport } from './entities/chapter-error-report.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { Story } from '../stories/entities/story.entity';
import { CreateChapterReportDto } from './dto/create-chapter-report.dto';
import {
  ChapterVersionType,
  GlobalRole,
  StoryMemberRole,
  StoryVisibility,
  StudioChapterVersionSummaryDto,
  ChapterReportStatus,
  ChapterReportErrorType,
  ChapterArtifactType,
  ChapterArtifactStatus,
  ChapterArtifactDto,
  TriggerChapterPackagingResponse,
} from '@omninovel/shared';

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
    @InjectRepository(ChapterErrorReport)
    private reportRepository: Repository<ChapterErrorReport>,
    @InjectRepository(ChapterArtifact)
    private artifactRepository: Repository<ChapterArtifact>,
    private packagingService: CanonicalPackagingService,
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

  async findVersionsForStudio(
    chapterId: string,
  ): Promise<StudioChapterVersionSummaryDto[]> {
    const chapter = await this.chapterRepository.findOne({
      where: { id: chapterId },
    });

    if (!chapter) {
      throw new NotFoundException('Chương truyện không tồn tại.');
    }

    const versions = await this.versionRepository.find({
      where: { chapterId },
      order: { versionNumber: 'DESC' },
    });

    const versionIds = versions.map((v) => v.id);
    let artifactMap = new Map<string, ChapterArtifact>();
    if (versionIds.length > 0) {
      const artifacts = await this.artifactRepository.find({
        where: {
          chapterVersionId: In(versionIds),
          artifactType: ChapterArtifactType.OFFLINE_BUNDLE,
        },
      });
      artifactMap = new Map(artifacts.map((a) => [a.chapterVersionId, a]));
    }

    return versions.map((version) => {
      const artifact = artifactMap.get(version.id);
      return {
        id: version.id,
        chapterId: version.chapterId,
        versionNumber: version.versionNumber,
        versionType: version.versionType,
        language: version.language,
        isPublished: version.isPublished,
        sourceVersionId: version.sourceVersionId,
        createdAt: version.createdAt.toISOString(),
        artifactReady: artifact?.status === ChapterArtifactStatus.READY,
        artifactStatus: artifact?.status || ChapterArtifactStatus.MISSING,
      };
    });
  }

  async getArtifactStatus(
    chapterId: string,
    versionId: string,
    artifactType: ChapterArtifactType = ChapterArtifactType.OFFLINE_BUNDLE,
  ): Promise<ChapterArtifactDto> {
    const version = await this.versionRepository.findOne({
      where: { id: versionId, chapterId },
    });
    if (!version) {
      throw new NotFoundException('Phiên bản chương truyện không tồn tại.');
    }
    return this.packagingService.getArtifactStatus(versionId, artifactType);
  }

  async triggerPackaging(
    chapterId: string,
    versionId: string,
    artifactType: ChapterArtifactType = ChapterArtifactType.OFFLINE_BUNDLE,
  ): Promise<TriggerChapterPackagingResponse> {
    const version = await this.versionRepository.findOne({
      where: { id: versionId, chapterId },
    });
    if (!version) {
      throw new NotFoundException('Phiên bản chương truyện không tồn tại.');
    }
    return this.packagingService.enqueuePackaging({
      chapterId,
      chapterVersionId: versionId,
      artifactType,
    });
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

  /**
   * Xác minh tính hợp lệ và quyền đọc của exact rendered version:
   * 1. Chapter tồn tại và Story tồn tại
   * 2. Quyền đọc Story (nếu PRIVATE -> yêu cầu ADMIN hoặc Story Member)
   * 3. Version tồn tại và thuộc đúng Chapter
   * 4. Version đã published HOẶC user là staff (OWNER/EDITOR/TRANSLATOR/ADMIN)
   */
  async resolveReadableChapterVersion(
    chapterId: string,
    chapterVersionId: string,
    user: any,
    manager?: EntityManager,
  ) {
    const chapterRepo = manager ? manager.getRepository(Chapter) : this.chapterRepository;
    const versionRepo = manager ? manager.getRepository(ChapterVersion) : this.versionRepository;

    const chapter = await chapterRepo.findOne({
      where: { id: chapterId },
      relations: ['storyEdition', 'storyEdition.story'],
    });

    if (!chapter) {
      throw new NotFoundException('Không tìm thấy chương truyện yêu cầu.');
    }

    const story = chapter.storyEdition?.story;
    if (!story) {
      throw new NotFoundException('Không tìm thấy bộ truyện tương ứng với chương này.');
    }

    // Lấy role của user trong story
    let userStoryRole: StoryMemberRole | null = null;
    if (user && user.id) {
      const queryRunner = manager || this.dataSource;
      const memberRes = await queryRunner.query(
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

    // 1. Kiểm tra Story Visibility (nếu PRIVATE)
    if (story.visibility === StoryVisibility.PRIVATE) {
      if (!user || !user.id) {
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

    // 2. Tìm version theo ID và xác minh thuộc đúng Chapter
    const candidateVersion = await versionRepo.findOne({
      where: { id: chapterVersionId },
    });

    if (!candidateVersion) {
      throw new NotFoundException('Không tìm thấy phiên bản (chapterVersionId) yêu cầu.');
    }

    if (candidateVersion.chapterId !== chapter.id) {
      throw new BadRequestException({
        code: 'CHAPTER_REPORT_VERSION_MISMATCH',
        message: 'Phiên bản (chapterVersionId) chỉ định không thuộc về chương truyện này.',
      });
    }

    // 3. Kiểm tra chính sách truy cập phiên bản (Version Access Policy)
    if (!candidateVersion.isPublished) {
      if (!user || !user.id) {
        throw new ForbiddenException(
          'Bản nháp chưa công bố yêu cầu đăng nhập với quyền hợp lệ.',
        );
      }
      if (!hasAdminOrStaffAccess) {
        throw new ForbiddenException(
          'Chỉ OWNER, EDITOR, TRANSLATOR hoặc ADMIN mới có quyền truy cập phiên bản chưa công bố này.',
        );
      }
    }

    return { chapter, version: candidateVersion, story };
  }

  /**
   * Tạo báo cáo lỗi chương truyện (POST /api/v1/chapters/:id/reports)
   * Enforces:
   * - Mutual exclusion: pageNumber XOR anchorBlockId
   * - Pessimistic write lock trên dòng Chapter
   * - resolveReadableChapterVersion (Story access + Version hierarchy + Published check)
   * - NULL-safe duplicate check: reporterId + chapterId + chapterVersionId + errorType + location
   *   trong 10 phút với status IN ('PENDING', 'INVESTIGATING')
   */
  async createReport(
    chapterId: string,
    dto: CreateChapterReportDto,
    user: any,
  ) {
    if (!user || !user.id) {
      throw new ForbiddenException('Bạn cần đăng nhập để gửi báo cáo lỗi.');
    }

    // Structured XOR validation
    if (dto.pageNumber != null && dto.anchorBlockId != null) {
      throw new BadRequestException({
        code: 'CHAPTER_REPORT_MUTUAL_EXCLUSION',
        message: 'Báo cáo chỉ được chứa một trong hai: pageNumber hoặc anchorBlockId, không được chứa cả hai.',
      });
    }

    if (dto.pageNumber != null && dto.pageNumber < 1) {
      throw new BadRequestException('pageNumber phải lớn hơn hoặc bằng 1.');
    }

    return await this.dataSource.transaction(async (manager) => {
      // 1. Khóa pessimistic_write trên dòng Chapter
      const chapterLock = await manager.findOne(Chapter, {
        where: { id: chapterId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!chapterLock) {
        throw new NotFoundException('Không tìm thấy chương truyện yêu cầu.');
      }

      // 2. Kiểm tra quyền truy cập và version invariant
      const { chapter, version } = await this.resolveReadableChapterVersion(
        chapterId,
        dto.chapterVersionId,
        user,
        manager,
      );

      // 3. NULL-safe SQL Duplicate Check
      const existingDup = await manager.query(
        `SELECT id FROM chapter_error_reports
         WHERE reporter_id = $1
           AND chapter_id = $2
           AND chapter_version_id = $3
           AND error_type = $4
           AND page_number IS NOT DISTINCT FROM $5
           AND anchor_block_id IS NOT DISTINCT FROM $6
           AND status IN ('PENDING', 'INVESTIGATING')
           AND created_at >= NOW() - INTERVAL '10 minutes'
         LIMIT 1`,
        [
          user.id,
          chapter.id,
          version.id,
          dto.errorType,
          dto.pageNumber ?? null,
          dto.anchorBlockId ?? null,
        ],
      );

      if (existingDup && existingDup.length > 0) {
        throw new ConflictException({
          code: 'CHAPTER_REPORT_DUPLICATE',
          message: 'Bạn đã gửi một báo cáo tương tự cho phần nội dung này gần đây. Báo cáo đang được xử lý.',
        });
      }

      // 4. Lưu báo cáo mới
      const report = manager.create(ChapterErrorReport, {
        reporterId: user.id,
        chapterId: chapter.id,
        chapterVersionId: version.id,
        pageNumber: dto.pageNumber ?? null,
        anchorBlockId: dto.anchorBlockId ?? null,
        errorType: dto.errorType,
        description: dto.description?.trim() || '',
        status: ChapterReportStatus.PENDING,
      });

      const saved = await manager.save(report);

      return {
        success: true,
        reportId: saved.id,
        status: ChapterReportStatus.PENDING,
        message: 'Báo cáo lỗi chương truyện đã được ghi nhận thành công.',
      };
    });
  }
}

