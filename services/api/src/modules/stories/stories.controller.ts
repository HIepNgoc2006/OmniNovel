import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StoriesService } from './stories.service';
import { CreateStoryDto } from './dto/create-story.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GlobalRole } from '@omninovel/shared';

@Controller()
export class StoriesController {
  constructor(private storiesService: StoriesService) {}

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

  // 3. Chi tiết truyện theo slug
  @Get('stories/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.storiesService.findBySlug(slug);
  }

  // 4. Tạo bộ truyện mới trong Studio (Yêu cầu Global TRANSLATOR hoặc ADMIN)
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

  // 5. Cập nhật Visibility (PUBLIC, UNLISTED, PRIVATE)
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
