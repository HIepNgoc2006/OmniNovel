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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GlobalRole, ChapterVersionType } from '@omninovel/shared';

@Controller()
export class ChaptersController {
  constructor(private chaptersService: ChaptersService) {}

  // 1. Lấy nội dung chi tiết chương để đọc
  @Get('chapters/:id')
  findById(
    @Param('id') chapterId: string,
    @Query('versionId') versionId?: string,
  ) {
    return this.chaptersService.findById(chapterId, versionId);
  }

  // 2. Tạo chương mới trong Studio
  @Post('studio/editions/:editionId/chapters')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
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

  // 3. Tạo version mới cho chapter
  @Post('studio/chapters/:id/versions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
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

  // 4. Kích hoạt Active Version cho chapter
  @Patch('studio/chapters/:id/active-version')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(GlobalRole.TRANSLATOR, GlobalRole.ADMIN)
  activateVersion(
    @Param('id') chapterId: string,
    @Body('versionId') versionId: string,
  ) {
    return this.chaptersService.activateVersion(chapterId, versionId);
  }
}
