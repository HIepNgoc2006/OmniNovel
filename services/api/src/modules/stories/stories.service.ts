import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Story } from './entities/story.entity';
import { StoryMember } from './entities/story-member.entity';
import { StoryEdition } from './entities/story-edition.entity';
import { Bookmark } from './entities/bookmark.entity';
import { Volume } from '../chapters/entities/volume.entity';
import { CreateStoryDto } from './dto/create-story.dto';
import { FindStoriesQueryDto } from './dto/find-stories-query.dto';
import { SetBookmarkDto } from './dto/set-bookmark.dto';
import {
  GlobalRole,
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
    @InjectRepository(Volume)
    private volumeRepository: Repository<Volume>,
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

  async findAll(query: FindStoriesQueryDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(50, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const qb = this.storyRepository
      .createQueryBuilder('story')
      .leftJoinAndSelect('story.genres', 'genre')
      .where('story.visibility = :visibility', { visibility: StoryVisibility.PUBLIC });

    if (query.format) {
      qb.andWhere('story.mediaFormat = :format', { format: query.format });
    }

    if (query.status) {
      qb.andWhere('story.status = :status', { status: query.status });
    }

    const keyword = query.q || query.search;
    if (keyword) {
      qb.andWhere(
        '(LOWER(story.title) LIKE :kw OR LOWER(COALESCE(story.summary, \'\')) LIKE :kw)',
        { kw: `%${keyword.toLowerCase()}%` },
      );
    }

    if (query.genre) {
      const genreSlug = query.genre.toLowerCase();
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM story_genres sg
          JOIN genres g ON g.id = sg.genre_id
          WHERE sg.story_id = story.id
            AND (LOWER(g.slug) = :genreSlug OR LOWER(g.name) = :genreSlug)
        )`,
        { genreSlug },
      );
    }

    const sort = query.sort || 'LATEST';
    if (sort === 'VIEWS') {
      qb.orderBy('story.viewsCount', 'DESC').addOrderBy('story.id', 'ASC');
    } else if (sort === 'POPULAR') {
      qb.orderBy('story.followersCount', 'DESC')
        .addOrderBy('story.viewsCount', 'DESC')
        .addOrderBy('story.id', 'ASC');
    } else {
      // LATEST: Sắp xếp theo thời gian cập nhật mới nhất, fallback thời gian tạo
      qb.orderBy('story.updatedAt', 'DESC')
        .addOrderBy('story.createdAt', 'DESC')
        .addOrderBy('story.id', 'ASC');
    }

    qb.skip(skip).take(limit);

    const [stories, total] = await qb.getManyAndCount();
    const data = await this.attachLatestChapters(stories);

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
       WHERE se.story_id = ANY($1) AND cv.is_published = TRUE
       ORDER BY se.story_id, CAST(c.chapter_number AS NUMERIC) DESC`,
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
