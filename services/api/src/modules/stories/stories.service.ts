import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Story } from './entities/story.entity';
import { StoryMember } from './entities/story-member.entity';
import { StoryEdition } from './entities/story-edition.entity';
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
    private redisService: RedisService,
  ) {}

  async create(userId: string, dto: CreateStoryDto) {
    const slug = this.generateSlug(dto.title);

    const existingSlug = await this.storyRepository.findOne({ where: { slug } });
    const finalSlug = existingSlug ? `${slug}-${Date.now().toString().slice(-4)}` : slug;

    const story = this.storyRepository.create({
      ...dto,
      slug: finalSlug,
      createdBy: userId,
      visibility: StoryVisibility.PUBLIC,
    });

    const savedStory = await this.storyRepository.save(story);

    // Gán người tạo làm Story OWNER trong bảng story_members (Canonical Ownership)
    const member = this.storyMemberRepository.create({
      storyId: savedStory.id,
      userId,
      role: StoryMemberRole.OWNER,
    });
    await this.storyMemberRepository.save(member);

    // Tạo default StoryEdition (Dòng xuất bản mặc định)
    const defaultEdition = this.editionRepository.create({
      storyId: savedStory.id,
      editionName: 'Bản Tiếng Việt Chuẩn',
      language: 'vi',
      isDefault: true,
    });
    await this.editionRepository.save(defaultEdition);

    // Xóa cache featured & list
    await this.redisService.del('stories:featured');

    return {
      storyId: savedStory.id,
      title: savedStory.title,
      slug: savedStory.slug,
      defaultEditionId: defaultEdition.id,
    };
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

  async findBySlug(slug: string) {
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

    // Cache 5 phút
    await this.redisService.set(cacheKey, JSON.stringify(result), 300);
    return result;
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

    // Kiểm tra quyền: Admin hoặc Story Owner
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
