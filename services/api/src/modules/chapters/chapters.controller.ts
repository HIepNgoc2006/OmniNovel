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
} from '@nestjs/common';
import { ChaptersService } from './chapters.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StoryMemberRole, ChapterVersionType } from '@omninovel/shared';

@Controller()
export class ChaptersController {
  constructor(private chaptersService: ChaptersService) {}

  // 1. Lấy nội dung chi tiết chương để đọc (Sử dụng OptionalJwtAuthGuard)
  @Get('chapters/:id')
  @UseGuards(OptionalJwtAuthGuard)
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
    @Body()
    body: {
      versionType: ChapterVersionType;
      language?: string;
    },
  ) {
    return this.chaptersService.createVersion(
      chapterId,
      body.versionType,
      body.language || 'vi',
      userId,
    );
  }

  // 4. Kích hoạt Active Version cho chapter (Chỉ Story EDITOR, OWNER hoặc Global ADMIN)
  @Patch('studio/chapters/:id/active-version')
  @UseGuards(JwtAuthGuard, StoryMemberGuard)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  activateVersion(
    @Param('id') chapterId: string,
    @Body('versionId') versionId: string,
  ) {
    return this.chaptersService.activateVersion(chapterId, versionId);
  }
}
