import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StoriesService } from './stories.service';
import { CreateStoryDto } from './dto/create-story.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Controller()
export class StoriesController {
  constructor(
    private storiesService: StoriesService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  // 1. Danh sách truyện công khai
  @Get('stories')
  findAll(@Query() query: { page?: number; limit?: number; format?: string }) {
    return this.storiesService.findAll(query);
  }

  // 2. Featured stories feed
  @Get('stories/featured')
  getFeatured() {
    return this.storiesService.getFeatured();
  }

  // 3. Rankings
  @Get('stories/rankings')
  getRankings() {
    return this.storiesService.getRankings();
  }

  // 4. Chi tiết truyện theo slug (Có kiểm tra Privacy nếu là PRIVATE)
  @Get('stories/:slug')
  async findBySlug(@Param('slug') slug: string, @Req() req: any) {
    const authHeader = req.headers?.authorization;
    let user: any = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        user = this.jwtService.verify(token, {
          secret: this.configService.get<string>(
            'JWT_SECRET',
            'super_secret_jwt_key_omninovel_2026',
          ),
        });
        user.id = user.sub;
      } catch {}
    }

    return this.storiesService.findBySlug(slug, user);
  }

  // 5. Tạo bộ truyện mới trong Studio (Yêu cầu Global TRANSLATOR hoặc ADMIN)
  @Post('studio/stories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStoryDto,
  ) {
    return this.storiesService.create(userId, dto);
  }

  // 6. Tạo Edition mới (Yêu cầu Story EDITOR hoặc OWNER)
  @Post('studio/stories/:id/editions')
  @UseGuards(JwtAuthGuard, RolesGuard, StoryMemberGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  @HttpCode(HttpStatus.CREATED)
  createEdition(
    @Param('id') storyId: string,
    @Body() body: { editionName: string; language?: string },
  ) {
    return this.storiesService.createEdition(
      storyId,
      body.editionName,
      body.language || 'vi',
    );
  }

  // 7. Tạo Volume mới (Yêu cầu Story EDITOR hoặc OWNER)
  @Post('studio/editions/:editionId/volumes')
  @UseGuards(JwtAuthGuard, RolesGuard, StoryMemberGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  @HttpCode(HttpStatus.CREATED)
  createVolume(
    @Param('editionId') editionId: string,
    @Body() body: { volumeNumber: number; title: string },
  ) {
    return this.storiesService.createVolume(
      editionId,
      body.volumeNumber,
      body.title,
    );
  }

  // 8. Cập nhật Visibility (PUBLIC, UNLISTED, PRIVATE - Chỉ OWNER hoặc ADMIN)
  @Patch('stories/:id/visibility')
  @UseGuards(JwtAuthGuard)
  updateVisibility(
    @Param('id') storyId: string,
    @Body() dto: UpdateVisibilityDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: GlobalRole,
  ) {
    return this.storiesService.updateVisibility(
      storyId,
      dto.visibility,
      userId,
      userRole,
    );
  }
}
