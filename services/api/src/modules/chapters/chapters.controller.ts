import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ChaptersService } from './chapters.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GlobalRole, StoryMemberRole, ChapterVersionType } from '@omninovel/shared';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Controller()
export class ChaptersController {
  constructor(
    private chaptersService: ChaptersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  // 1. Lấy nội dung chi tiết chương để đọc (Bảo vệ Privacy & Draft Version)
  @Get('chapters/:id')
  async findById(
    @Param('id') chapterId: string,
    @Query('versionId') versionId?: string,
    @Req() req?: any,
  ) {
    const authHeader = req?.headers?.authorization;
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

    return this.chaptersService.findById(chapterId, versionId, user);
  }

  // 2. Tạo chương mới trong Studio (Chặn IDOR qua StoryMemberGuard)
  @Post('studio/editions/:editionId/chapters')
  @UseGuards(JwtAuthGuard, RolesGuard, StoryMemberGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  @RequireStoryRole(
    StoryMemberRole.OWNER,
    StoryMemberRole.EDITOR,
    StoryMemberRole.TRANSLATOR,
    StoryMemberRole.UPLOADER,
  )
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

  // 3. Tạo version mới cho chapter (Chặn IDOR)
  @Post('studio/chapters/:id/versions')
  @UseGuards(JwtAuthGuard, RolesGuard, StoryMemberGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
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

  // 4. Kích hoạt Active Version cho chapter (Chỉ Story EDITOR, OWNER hoặc ADMIN)
  @Patch('studio/chapters/:id/active-version')
  @UseGuards(JwtAuthGuard, RolesGuard, StoryMemberGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  @RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)
  activateVersion(
    @Param('id') chapterId: string,
    @Body('versionId') versionId: string,
  ) {
    return this.chaptersService.activateVersion(chapterId, versionId);
  }
}
