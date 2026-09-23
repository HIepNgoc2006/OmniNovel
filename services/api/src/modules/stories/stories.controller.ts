import {
  Controller,
  Get,
  Post,
  Put,
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
import { FindStoriesQueryDto } from './dto/find-stories-query.dto';
import { FindManagedStoriesQueryDto } from './dto/find-managed-stories-query.dto';
import { SetBookmarkDto } from './dto/set-bookmark.dto';
import { UpdateReadingProgressDto } from './dto/update-reading-progress.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';

@Controller()
export class StoriesController {
  constructor(private storiesService: StoriesService) {}

  // 1. Danh sách truyện công khai (hỗ trợ search, genre, format, status, sort LATEST/VIEWS/POPULAR)
  @Get('stories')
  findAll(@Query() query: FindStoriesQueryDto) {
    return this.storiesService.findAll(query);
  }

  // 2. Featured stories feed
  @Get('stories/featured')
  getFeatured() {
    return this.storiesService.getFeatured();
  }

  // 3. Rankings feed
  @Get('stories/rankings')
  getRankings() {
    return this.storiesService.getRankings();
  }

  // 3b. Danh sách thể loại công khai (Canonical Genres)
  @Get('genres')
  getGenres() {
    return this.storiesService.getGenres();
  }

  // 4. Chi tiết truyện theo slug (Sử dụng OptionalJwtAuthGuard chuẩn xác thực tài khoản)
  @Get('stories/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  findBySlug(@Param('slug') slug: string, @CurrentUser() user?: any) {
    return this.storiesService.findBySlug(slug, user);
  }

  // 5. Quản lý Thư viện / Bookmarks (FR-LIB-02)
  @Post('library/bookmarks')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  setBookmark(
    @CurrentUser('id') userId: string,
    @Body() dto: SetBookmarkDto,
  ) {
    return this.storiesService.setBookmark(userId, dto);
  }

  @Get('library/bookmarks/:storyId')
  @UseGuards(OptionalJwtAuthGuard)
  getBookmarkStatus(
    @Param('storyId') storyId: string,
    @CurrentUser('id') userId?: string,
  ) {
    return this.storiesService.getBookmarkStatus(userId, storyId);
  }

  // 6. Quản lý Tiến độ đọc (Reading Progress)
  @Put('library/reading-progress')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  saveReadingProgress(
    @CurrentUser() user: any,
    @Body() dto: UpdateReadingProgressDto,
  ) {
    return this.storiesService.saveReadingProgress(user, dto);
  }

  @Get('library/reading-progress/:storyId')
  @UseGuards(JwtAuthGuard)
  getReadingProgress(
    @Param('storyId') storyId: string,
    @CurrentUser() user: any,
  ) {
    return this.storiesService.getReadingProgress(user, storyId);
  }

  // 7. Quản lý bộ truyện trong Studio (Global ADMIN hoặc StoryMember: OWNER/EDITOR/TRANSLATOR)
  @Get('studio/stories')
  @UseGuards(JwtAuthGuard)
  getManagedStories(
    @CurrentUser() user: any,
    @Query() query: FindManagedStoriesQueryDto,
  ) {
    return this.storiesService.findManagedStories(user, query);
  }

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

  // 6. Tạo Edition mới (Story OWNER hoặc Global ADMIN)
  @Post('studio/stories/:id/editions')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(StoryMemberRole.OWNER)
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

  // 7. Tạo Volume mới (Story OWNER, EDITOR hoặc Global ADMIN)
  @Post('studio/editions/:editionId/volumes')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
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
