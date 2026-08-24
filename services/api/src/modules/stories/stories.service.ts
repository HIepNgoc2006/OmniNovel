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
import { Volume } from '../chapters/entities/volume.entity';
import { CreateStoryDto } from './dto/create-story.dto';
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

  async findAll(query: { page?: number; limit?: number; format?: string }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(50, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const qb = this.storyRepository
      .createQueryBuilder('story')
      .where('story.visibility = :visibility', { visibility: StoryVisibility.PUBLIC })
      .orderBy('story.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (query.format) {
      qb.andWhere('story.mediaFormat = :format', { format: query.format });
    }

    const [data, total] = await qb.getManyAndCount();

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

    const hotStories = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC },
      order: { viewsCount: 'DESC' },
      take: 10,
    });

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

    const topComics = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC, mediaFormat: 'COMIC' as any },
      order: { viewsCount: 'DESC' },
      take: 10,
    });

    const topNovels = await this.storyRepository.find({
      where: { visibility: StoryVisibility.PUBLIC, mediaFormat: 'NOVEL' as any },
      order: { viewsCount: 'DESC' },
      take: 10,
    });

    const result = { topComics, topNovels };
    await this.redisService.set(cacheKey, JSON.stringify(result), 300);
    return result;
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
