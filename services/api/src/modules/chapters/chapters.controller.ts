import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ChaptersService } from './chapters.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StoryMemberRole, ChapterVersionType } from '@omninovel/shared';
import { CreateChapterReportDto } from './dto/create-chapter-report.dto';

@Controller()
export class ChaptersController {
  constructor(private chaptersService: ChaptersService) {}

  // 1. Lấy nội dung chi tiết chương để đọc (Có Anti-Leech Rate Limit + OptionalJwtAuthGuard)
  @Get('chapters/:id')
  @UseGuards(OptionalJwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 60, ttlSeconds: 60, keyPrefix: 'chapter_read', scope: 'IP_AND_USER' })
  findById(
    @Param('id') chapterId: string,
    @Query('versionId') versionId?: string,
    @CurrentUser() user?: any,
  ) {
    return this.chaptersService.findById(chapterId, versionId, user);
  }

  // 2. Tạo chương mới trong Studio (Story OWNER, EDITOR hoặc Global ADMIN)
  @Post('studio/editions/:editionId/chapters')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  @HttpCode(HttpStatus.CREATED)
  createChapter(
    @Param('editionId') editionId: string,
    @Body() body: { chapterNumber: string; title?: string; volumeId?: string },
  ) {
    return this.chaptersService.createChapter(
      editionId,
      body.chapterNumber,
      body.title,
      body.volumeId,
    );
  }

  // 3. Lấy danh sách versions nhẹ cho Studio Job Creation (#146)
  @Get('studio/chapters/:id/versions')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(
    StoryMemberRole.OWNER,
    StoryMemberRole.EDITOR,
    StoryMemberRole.TRANSLATOR,
  )
  getVersionsForStudio(
    @Param('id', new ParseUUIDPipe({ version: '4' })) chapterId: string,
  ) {
    return this.chaptersService.findVersionsForStudio(chapterId);
  }

  // 3. Tạo version mới cho chapter (Story OWNER, EDITOR, TRANSLATOR hoặc Global ADMIN)
  @Post('studio/chapters/:id/versions')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(
    StoryMemberRole.OWNER,
    StoryMemberRole.EDITOR,
    StoryMemberRole.TRANSLATOR,
  )
  @HttpCode(HttpStatus.CREATED)
  createVersion(
    @Param('id') chapterId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { versionType: ChapterVersionType; language?: string; sourceVersionId?: string },
  ) {
    return this.chaptersService.createVersion(
      chapterId,
      body.versionType,
      body.language || 'vi',
      userId,
    );
  }

  // 4. Kích hoạt Active Version cho Chapter (Story OWNER, EDITOR hoặc Global ADMIN)
  @Patch('studio/chapters/:id/active-version')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  @HttpCode(HttpStatus.OK)
  setActiveVersion(
    @Param('id') chapterId: string,
    @Body('versionId') versionId: string,
  ) {
    return this.chaptersService.activateVersion(chapterId, versionId);
  }

  // 5. Báo cáo lỗi chương truyện (Độc giả đã xác thực, Rate-limited theo chapter)
  @Post('chapters/:id/reports')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({
    limit: 3,
    ttlSeconds: 60,
    keyPrefix: 'chapter_report',
    scope: 'IP_AND_USER',
    routeParam: 'id',
  })
  @HttpCode(HttpStatus.CREATED)
  createReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) chapterId: string,
    @Body() dto: CreateChapterReportDto,
    @CurrentUser() user: any,
  ) {
    return this.chaptersService.createReport(chapterId, dto, user);
  }
}

