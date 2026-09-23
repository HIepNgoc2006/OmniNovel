import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Story } from './entities/story.entity';
import { StoryMember } from './entities/story-member.entity';
import { StoryEdition } from './entities/story-edition.entity';
import { Bookmark } from './entities/bookmark.entity';
import { Genre } from './entities/genre.entity';
import { ReadingProgress } from './entities/reading-progress.entity';
import { ChapterReadState } from './entities/chapter-read-state.entity';
import { Volume } from '../chapters/entities/volume.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import { CreateStoryDto } from './dto/create-story.dto';
import { FindStoriesQueryDto } from './dto/find-stories-query.dto';
import { FindManagedStoriesQueryDto } from './dto/find-managed-stories-query.dto';
import { SetBookmarkDto } from './dto/set-bookmark.dto';
import { UpdateReadingProgressDto } from './dto/update-reading-progress.dto';
import {
  GlobalRole,
  MediaFormat,
  ManagedStorySummaryDto,
  PaginatedResponse,
  StoryMemberRole,
  StoryVisibility,
} from '@omninovel/shared';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class StoriesService {
  constructor(
    @InjectRepository(Story)
    private storyRepository: Repository<Story>,
    @InjectRepository(StoryMember)
    private storyMemberRepository: Repository<StoryMember>,
    @InjectRepository(StoryEdition)
    private editionRepository: Repository<StoryEdition>,
    @InjectRepository(Bookmark)
    private bookmarkRepository: Repository<Bookmark>,
    @InjectRepository(ReadingProgress)
    private readingProgressRepository: Repository<ReadingProgress>,
    @InjectRepository(ChapterReadState)
    private chapterReadStateRepository: Repository<ChapterReadState>,
    @InjectRepository(Volume)
    private volumeRepository: Repository<Volume>,
    @InjectRepository(Chapter)
    private chapterRepository: Repository<Chapter>,
    private redisService: RedisService,
    private dataSource: DataSource,
  ) {}

  async create(userId: string, dto: CreateStoryDto) {
    const slug = this.generateSlug(dto.title);
    const existingSlug = await this.storyRepository.findOne({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now().toString().slice(-4)}` : slug;

    // Transaction bảo toàn tính toàn vẹn của Story + Owner Member + Default Edition
    return this.dataSource.transaction(async (manager) => {
      const story = manager.create(Story, {
        ...dto,
        slug: finalSlug,
        createdBy: userId,
        visibility: StoryVisibility.PUBLIC,
      });
      const savedStory = await manager.save(story);

      // Gán người tạo làm Story OWNER
      const member = manager.create(StoryMember, {
        storyId: savedStory.id,
        userId,
        role: StoryMemberRole.OWNER,
      });
      await manager.save(member);

      // Tạo Default Edition
      const defaultEdition = manager.create(StoryEdition, {
        storyId: savedStory.id,
        editionName: 'Bản Tiếng Việt Chuẩn',
        language: 'vi',
        isDefault: true,
      });
      const savedEdition = await manager.save(defaultEdition);

      await this.redisService.del('stories:featured');
      await this.redisService.del('stories:rankings');

      return {
        storyId: savedStory.id,
        title: savedStory.title,
        slug: savedStory.slug,
        defaultEditionId: savedEdition.id,
      };
    });
  }

  async findManagedStories(user: any, query: FindManagedStoriesQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const qb = this.storyRepository.createQueryBuilder('story');

    if (user.role !== GlobalRole.ADMIN) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM story_members sm
          WHERE sm.story_id = story.id
            AND sm.user_id = :userId
            AND sm.role IN (:...roles)
        )`,
        {
          userId: user.id,
          roles: [
            StoryMemberRole.OWNER,
            StoryMemberRole.EDITOR,
            StoryMemberRole.TRANSLATOR,
          ],
        },
      );
    }

    if (query.search && query.search.trim()) {
      qb.andWhere('story.title ILIKE :search', {
        search: `%${query.search.trim()}%`,
      });
    }

    qb.orderBy('story.createdAt', 'DESC')
      .addOrderBy('story.id', 'DESC')
      .skip(skip)
      .take(limit);

    const [stories, total] = await qb.getManyAndCount();

    const data: ManagedStorySummaryDto[] = stories.map((s) => ({
      id: s.id,
      title: s.title,
      slug: s.slug,
      mediaFormat: s.mediaFormat,
      publicationFormat: s.publicationFormat,
      originCountry: s.originCountry,
      originalLanguage: s.originalLanguage,
      coverUrl: s.coverUrl || null,
      status: s.status,
      visibility: s.visibility,
      summary: s.summary || null,
      viewsCount: s.viewsCount || '0',
      followersCount: s.followersCount,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findAll(query: FindStoriesQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const params: any[] = [];
    const whereClauses: string[] = [`s.visibility = 'PUBLIC'`];

    if (query.format) {
      params.push(query.format);
      whereClauses.push(`s.media_format = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      whereClauses.push(`s.status = $${params.length}`);
    }

    const searchTerm = query.q || query.search;
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      whereClauses.push(`(s.title ILIKE $${params.length} OR COALESCE(s.summary, '') ILIKE $${params.length})`);
    }

    if (query.genre) {
      params.push(query.genre.toLowerCase());
      whereClauses.push(
        `EXISTS (
          SELECT 1 FROM story_genres sg
          JOIN genres g ON g.id = sg.genre_id
          WHERE sg.story_id = s.id
            AND (LOWER(g.slug) = $${params.length} OR LOWER(g.name) = $${params.length})
        )`,
      );
    }

    const whereSql = whereClauses.join(' AND ');

    // Đếm tổng số truyện khớp điều kiện
    const countResult = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM stories s WHERE ${whereSql}`,
      params,
    );
    const total = countResult[0]?.total || 0;

    // Xác định mệnh đề sắp xếp
    const sort = query.sort || 'LATEST';
    let orderSql = '';
    if (sort === 'VIEWS') {
      orderSql = 'ORDER BY s.views_count DESC, s.id ASC';
    } else if (sort === 'POPULAR') {
      orderSql = 'ORDER BY s.followers_count DESC, s.views_count DESC, s.id ASC';
    } else {
      // LATEST: Sắp xếp theo ngày xuất bản của chương mới nhất thuộc ấn bản mặc định (default edition), fallback s.created_at
      orderSql = `ORDER BY (
        SELECT MAX(c.created_at)
        FROM chapters c
        JOIN story_editions se ON se.id = c.story_edition_id
        JOIN chapter_versions cv ON cv.id = c.active_version_id
        WHERE se.story_id = s.id
          AND se.is_default = TRUE
          AND cv.is_published = TRUE
      ) DESC NULLS LAST, s.created_at DESC, s.id ASC`;
    }

    // Truy vấn phân trang lấy danh sách ID truyện theo thứ tự
    const queryParams = [...params, limit, skip];
    const limitParamIdx = params.length + 1;
    const skipParamIdx = params.length + 2;

    const idRows = await this.dataSource.query(
      `SELECT s.id FROM stories s WHERE ${whereSql} ${orderSql} LIMIT $${limitParamIdx} OFFSET $${skipParamIdx}`,
      queryParams,
    );

    const storyIds = idRows.map((r: any) => r.id);
    if (storyIds.length === 0) {
      return {
        data: [],
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    // Tải các entity hoàn chỉnh kèm genres
    const storiesRaw = await this.storyRepository.find({
      where: { id: In(storyIds) },
      relations: ['genres'],
    });

    // Giữ đúng thứ tự pagination đã được DB sắp xếp
    const storyMap = new Map(storiesRaw.map((s) => [s.id, s]));
    const orderedStories = storyIds.map((id: string) => storyMap.get(id)!).filter(Boolean);

    const data = await this.attachLatestChapters(orderedStories);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findBySlug(slug: string, user?: any) {
    const story = await this.storyRepository.findOne({
      where: { slug },
      relations: [
        'genres',
        'editions',
        'editions.volumes',
        'editions.chapters',
        'editions.chapters.activeVersion',
      ],
    });

    if (!story) {
      throw new NotFoundException('Không tìm thấy bộ truyện yêu cầu.');
    }

    // Bảo vệ Privacy Policy
    if (story.visibility === StoryVisibility.PRIVATE) {
      if (!user) {
        throw new ForbiddenException(
          'Bộ truyện này đang ở chế độ riêng tư (PRIVATE). Vui lòng đăng nhập.',
        );
      }

      if (user.role !== GlobalRole.ADMIN) {
        const isMember = await this.storyMemberRepository.findOne({
          where: { storyId: story.id, userId: user.id },
        });

        if (!isMember) {
          throw new ForbiddenException(
            'Bạn không có quyền truy cập vào bộ truyện riêng tư này.',
          );
        }
      }
    }

    return story;
  }

  async getFeatured() {
    const cacheKey = 'stories:featured';
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    const hotStoriesRaw = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC },
      relations: ['genres'],
      order: { viewsCount: 'DESC' },
      take: 10,
    });

    const hotStories = await this.attachLatestChapters(hotStoriesRaw);

    const result = {
      hotStories,
      banners: hotStories.slice(0, 5),
    };

    await this.redisService.set(cacheKey, JSON.stringify(result), 300);
    return result;
  }

  async getRankings() {
    const cacheKey = 'stories:rankings';
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {}
    }

    const topComicsRaw = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC, mediaFormat: 'COMIC' as any },
      relations: ['genres'],
      order: { viewsCount: 'DESC' },
      take: 10,
    });

    const topNovelsRaw = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC, mediaFormat: 'NOVEL' as any },
      relations: ['genres'],
      order: { viewsCount: 'DESC' },
      take: 10,
    });

    const topComics = await this.attachLatestChapters(topComicsRaw);
    const topNovels = await this.attachLatestChapters(topNovelsRaw);

    const result = { topComics, topNovels };
    await this.redisService.set(cacheKey, JSON.stringify(result), 300);
    return result;
  }

  async getGenres() {
    return this.dataSource.getRepository(Genre).find({
      order: { name: 'ASC' },
    });
  }

  async setBookmark(userId: string, dto: SetBookmarkDto) {
    const story = await this.storyRepository.findOne({ where: { id: dto.storyId } });
    if (!story) {
      throw new NotFoundException('Bộ truyện không tồn tại.');
    }

    return this.dataSource.transaction(async (manager) => {
      if (dto.isBookmarked) {
        // Idempotent insert
        const insertRes = await manager.query(
          `INSERT INTO bookmarks (user_id, story_id, created_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id, story_id) DO NOTHING
           RETURNING user_id`,
          [userId, dto.storyId],
        );
        if (insertRes && insertRes.length > 0) {
          await manager.query(
            `UPDATE stories SET followers_count = followers_count + 1 WHERE id = $1`,
            [dto.storyId],
          );
        }
      } else {
        // Idempotent delete
        const deleteRes = await manager.query(
          `DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2 RETURNING user_id`,
          [userId, dto.storyId],
        );
        if (deleteRes && deleteRes.length > 0) {
          await manager.query(
            `UPDATE stories SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = $1`,
            [dto.storyId],
          );
        }
      }

      const updated = await manager.findOne(Story, { where: { id: dto.storyId } });
      return {
        isBookmarked: dto.isBookmarked,
        followersCount: updated ? updated.followersCount : 0,
      };
    });
  }

  async getBookmarkStatus(userId: string | undefined, storyId: string) {
    if (!userId) {
      return { isBookmarked: false };
    }
    const bookmark = await this.bookmarkRepository.findOne({
      where: { userId, storyId },
    });
    return { isBookmarked: Boolean(bookmark) };
  }

  async saveReadingProgress(userOrId: any, dto: UpdateReadingProgressDto) {
    const userId = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    const isGlobalAdmin =
      typeof userOrId === 'object' &&
      (userOrId?.role === GlobalRole.ADMIN || userOrId?.globalRole === GlobalRole.ADMIN);

    const chapter = await this.chapterRepository.findOne({
      where: { id: dto.chapterId },
      relations: ['storyEdition', 'storyEdition.story'],
    });

    if (!chapter) {
      throw new NotFoundException('Không tìm thấy chương truyện.');
    }

    const derivedStoryId = chapter.storyEdition?.story?.id;
    if (!derivedStoryId) {
      throw new BadRequestException('Chương truyện không liên kết với bộ truyện hợp lệ.');
    }

    if (dto.storyId && dto.storyId !== derivedStoryId) {
      throw new BadRequestException('storyId không khớp với chương truyện (Hierarchy Mismatch).');
    }

    // 1. Kiểm tra quyền truy cập Story (PRIVATE story yêu cầu story member hoặc Admin)
    let userStoryRole: StoryMemberRole | null = null;
    if (userId) {
      const memberRes = await this.dataSource.query(
        `SELECT role FROM story_members WHERE story_id = $1 AND user_id = $2`,
        [derivedStoryId, userId],
      );
      if (memberRes && memberRes.length > 0) {
        userStoryRole = memberRes[0].role as StoryMemberRole;
      }
    }

    const hasAdminOrStaffAccess =
      isGlobalAdmin ||
      userStoryRole === StoryMemberRole.OWNER ||
      userStoryRole === StoryMemberRole.EDITOR ||
      userStoryRole === StoryMemberRole.TRANSLATOR;

    if (chapter.storyEdition?.story?.visibility === StoryVisibility.PRIVATE) {
      if (!isGlobalAdmin && !userStoryRole) {
        throw new ForbiddenException(
          'Bạn không có quyền truy cập chương truyện riêng tư này.',
        );
      }
    }

    // 2. Kiểm tra versionId và quyền truy cập Draft version
    if (dto.chapterVersionId) {
      const versionRows = await this.dataSource.query(
        `SELECT id, is_published AS "isPublished" FROM chapter_versions WHERE id = $1::uuid AND chapter_id = $2::uuid`,
        [dto.chapterVersionId, dto.chapterId],
      );
      if (!versionRows || versionRows.length === 0) {
        throw new BadRequestException('chapterVersionId không thuộc về chương truyện này.');
      }
      const ver = versionRows[0];
      if (!ver.isPublished && !hasAdminOrStaffAccess) {
        throw new ForbiddenException(
          'Chỉ OWNER, EDITOR, TRANSLATOR hoặc ADMIN mới có quyền truy cập bản nháp này.',
        );
      }
    }

    const readingMode =
      dto.readingMode ||
      (chapter.storyEdition?.story?.mediaFormat === MediaFormat.NOVEL
        ? 'NOVEL'
        : 'WEBTOON');
    const progressPercentage = Math.min(
      100,
      Math.max(0, Number(dto.progressPercentage) || 0),
    );
    const scrollPosition = Math.max(0, Number(dto.scrollPosition) || 0);
    const pageIndex =
      dto.pageIndex != null
        ? Math.max(1, Math.floor(Number(dto.pageIndex)))
        : 1;
    const anchorBlockId = dto.anchorBlockId || null;
    const textOffset =
      dto.textOffset != null
        ? Math.max(0, Math.floor(Number(dto.textOffset)))
        : 0;

    const completedAt = progressPercentage >= 80 ? new Date() : null;

    return this.dataSource.transaction(async (manager) => {
      // 1. Upsert reading_progress (Current resume pointer for user + story)
      await manager.query(
        `INSERT INTO reading_progress (
          user_id, story_id, chapter_id, chapter_version_id,
          reading_mode, progress_percentage, scroll_position,
          page_index, anchor_block_id, text_offset, updated_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5::varchar, $6::numeric, $7::numeric,
          $8::int, $9::varchar, $10::int, NOW()
        )
        ON CONFLICT (user_id, story_id) DO UPDATE SET
          chapter_id = EXCLUDED.chapter_id,
          chapter_version_id = EXCLUDED.chapter_version_id,
          reading_mode = EXCLUDED.reading_mode,
          progress_percentage = EXCLUDED.progress_percentage,
          scroll_position = EXCLUDED.scroll_position,
          page_index = EXCLUDED.page_index,
          anchor_block_id = EXCLUDED.anchor_block_id,
          text_offset = EXCLUDED.text_offset,
          updated_at = NOW()`,
        [
          userId,
          derivedStoryId,
          dto.chapterId,
          dto.chapterVersionId || null,
          readingMode,
          progressPercentage,
          scrollPosition,
          pageIndex,
          anchorBlockId,
          textOffset,
        ],
      );

      // 2. Upsert chapter_read_states (Read history & completion state per chapter)
      await manager.query(
        `INSERT INTO chapter_read_states (
          user_id, chapter_id, last_version_id, max_progress_percentage, completed_at, last_read_at
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::timestamptz, NOW())
        ON CONFLICT (user_id, chapter_id) DO UPDATE SET
          last_version_id = COALESCE(EXCLUDED.last_version_id, chapter_read_states.last_version_id),
          max_progress_percentage = GREATEST(chapter_read_states.max_progress_percentage, EXCLUDED.max_progress_percentage),
          completed_at = CASE
            WHEN chapter_read_states.completed_at IS NOT NULL THEN chapter_read_states.completed_at
            WHEN EXCLUDED.max_progress_percentage >= 80 THEN NOW()
            ELSE NULL
          END,
          last_read_at = NOW()`,
        [
          userId,
          dto.chapterId,
          dto.chapterVersionId || null,
          progressPercentage,
          completedAt,
        ],
      );

      return {
        storyId: derivedStoryId,
        chapterId: dto.chapterId,
        chapterVersionId: dto.chapterVersionId || null,
        readingMode,
        progressPercentage: Number(progressPercentage),
        scrollPosition: Number(scrollPosition),
        pageIndex: Number(pageIndex),
        anchorBlockId: anchorBlockId || null,
        textOffset: Number(textOffset),
        updatedAt: new Date(),
      };
    });
  }

  async getReadingProgress(userOrId: any, storyId: string) {
    const userId = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    const isGlobalAdmin =
      typeof userOrId === 'object' &&
      (userOrId?.role === GlobalRole.ADMIN || userOrId?.globalRole === GlobalRole.ADMIN);

    const story = await this.storyRepository.findOne({
      where: { id: storyId },
    });

    if (!story) {
      throw new NotFoundException('Không tìm thấy bộ truyện.');
    }

    if (story.visibility === StoryVisibility.PRIVATE && !isGlobalAdmin) {
      const memberRes = await this.dataSource.query(
        `SELECT role FROM story_members WHERE story_id = $1 AND user_id = $2`,
        [storyId, userId],
      );
      if (!memberRes || memberRes.length === 0) {
        throw new ForbiddenException('Bạn không có quyền truy cập truyện riêng tư này.');
      }
    }

    const progress = await this.dataSource.query(
      `SELECT
        rp.story_id AS "storyId",
        rp.chapter_id AS "chapterId",
        rp.chapter_version_id AS "chapterVersionId",
        rp.reading_mode AS "readingMode",
        CAST(rp.progress_percentage AS FLOAT) AS "progressPercentage",
        CAST(rp.scroll_position AS FLOAT) AS "scrollPosition",
        COALESCE(rp.page_index, 1) AS "pageIndex",
        rp.anchor_block_id AS "anchorBlockId",
        COALESCE(rp.text_offset, 0) AS "textOffset",
        rp.updated_at AS "updatedAt"
       FROM reading_progress rp
       WHERE rp.user_id = $1 AND rp.story_id = $2`,
      [userId, storyId],
    );

    const readChapters = await this.dataSource.query(
      `SELECT crs.chapter_id AS "chapterId"
       FROM chapter_read_states crs
       JOIN chapters c ON c.id = crs.chapter_id
       JOIN story_editions se ON se.id = c.story_edition_id
       WHERE crs.user_id = $1 AND se.story_id = $2 AND crs.max_progress_percentage >= 80`,
      [userId, storyId],
    );

    const readChapterIds = readChapters.map((r: any) => r.chapterId);

    if (!progress || progress.length === 0) {
      return {
        storyId,
        chapterId: null,
        chapterVersionId: null,
        readingMode: 'WEBTOON',
        progressPercentage: 0,
        scrollPosition: 0,
        pageIndex: 1,
        anchorBlockId: null,
        textOffset: 0,
        updatedAt: null,
        readChapterIds,
      };
    }

    const p = progress[0];
    return {
      storyId: p.storyId,
      chapterId: p.chapterId,
      chapterVersionId: p.chapterVersionId,
      readingMode: p.readingMode,
      progressPercentage: Number(p.progressPercentage) || 0,
      scrollPosition: Number(p.scrollPosition) || 0,
      pageIndex: Number(p.pageIndex) || 1,
      anchorBlockId: p.anchorBlockId || null,
      textOffset: Number(p.textOffset) || 0,
      updatedAt: p.updatedAt,
      readChapterIds,
    };
  }

  async createEdition(storyId: string, editionName: string, language = 'vi') {
    const existing = await this.editionRepository.findOne({
      where: { storyId, editionName },
    });

    if (existing) {
      throw new BadRequestException(`Ấn bản '${editionName}' đã tồn tại.`);
    }

    const edition = this.editionRepository.create({
      storyId,
      editionName,
      language,
      isDefault: false,
    });

    return this.editionRepository.save(edition);
  }

  async createVolume(storyEditionId: string, volumeNumber: number, title: string) {
    const existing = await this.volumeRepository.findOne({
      where: { storyEditionId, volumeNumber },
    });

    if (existing) {
      throw new BadRequestException(`Tập số ${volumeNumber} đã tồn tại trong ấn bản này.`);
    }

    const volume = this.volumeRepository.create({
      storyEditionId,
      volumeNumber,
      title,
    });

    return this.volumeRepository.save(volume);
  }

  async updateVisibility(
    storyId: string,
    visibility: StoryVisibility,
    userId: string,
    userRole: GlobalRole,
  ) {
    const story = await this.storyRepository.findOne({ where: { id: storyId } });
    if (!story) {
      throw new NotFoundException('Bộ truyện không tồn tại.');
    }

    if (userRole !== GlobalRole.ADMIN) {
      const membership = await this.storyMemberRepository.findOne({
        where: { storyId, userId, role: StoryMemberRole.OWNER },
      });

      if (!membership) {
        throw new ForbiddenException(
          'Chỉ có Chủ sở hữu (Owner) hoặc Quản trị viên mới được đổi trạng thái hiển thị của bộ truyện.',
        );
      }
    }

    story.visibility = visibility;
    await this.storyRepository.save(story);

    await this.redisService.del('stories:featured');
    await this.redisService.del('stories:rankings');

    return {
      storyId: story.id,
      visibility: story.visibility,
    };
  }

  private async attachLatestChapters(stories: Story[]) {
    if (!stories || stories.length === 0) return [];
    const storyIds = stories.map((s) => s.id);

    const latestChaptersRaw = await this.dataSource.query(
      `SELECT DISTINCT ON (se.story_id)
          c.id,
          c.chapter_number AS "chapterNumber",
          c.title,
          c.created_at AS "createdAt",
          se.story_id AS "storyId"
       FROM chapters c
       JOIN story_editions se ON se.id = c.story_edition_id
       JOIN chapter_versions cv ON cv.id = c.active_version_id
       WHERE se.story_id = ANY($1)
         AND se.is_default = TRUE
         AND cv.is_published = TRUE
       ORDER BY se.story_id, c.created_at DESC, c.chapter_number DESC`,
      [storyIds],
    );

    const latestMap = new Map<string, any>();
    for (const row of latestChaptersRaw) {
      latestMap.set(row.storyId, {
        id: row.id,
        chapterNumber: Number(row.chapterNumber) || row.chapterNumber,
        title: row.title,
        createdAt: row.createdAt,
      });
    }

    return stories.map((story) => ({
      ...story,
      genres: story.genres || [],
      latestChapter: latestMap.get(story.id) || null,
    }));
  }

  private generateSlug(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }
}
