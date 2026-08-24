import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { RequireStoryRole } from '../../common/decorators/require-story-role.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StoryMemberRole, GlobalRole } from '@omninovel/shared';

@Controller()
export class StorageController {
  constructor(private storageService: StorageService) {}

  // 1. Tạo phiên Upload và nhận Presigned PUT URL (Yêu cầu UPLOADER, TRANSLATOR, EDITOR, OWNER hoặc ADMIN)
  @Post('uploads/sessions')
  @UseGuards(JwtAuthGuard, StoryMemberGuard, RateLimitGuard)
  @RequireStoryRole(
    StoryMemberRole.OWNER,
    StoryMemberRole.EDITOR,
    StoryMemberRole.TRANSLATOR,
    StoryMemberRole.UPLOADER,
  )
  @RateLimit({ limit: 15, ttlSeconds: 60, keyPrefix: 'upload_session', scope: 'USER' })
  @HttpCode(HttpStatus.CREATED)
  createUploadSession(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateUploadSessionDto,
  ) {
    return this.storageService.createUploadSession(userId, dto);
  }

  // 2. Finalize & Validate Magic Bytes & Promote sang Final Media
  @Post('uploads/sessions/:id/finalize')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 15, ttlSeconds: 60, keyPrefix: 'upload_finalize', scope: 'USER' })
  @HttpCode(HttpStatus.OK)
  finalizeUploadSession(
    @Param('id') sessionId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: GlobalRole,
  ) {
    return this.storageService.finalizeUploadSession(sessionId, userId, userRole);
  }

  // 3. Lấy Presigned GET URL cho Media Asset (Có Anti-Leech Rate Limit + Privacy Check)
  @Get('storage/media-url/:assetId')
  @UseGuards(OptionalJwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 60, ttlSeconds: 60, keyPrefix: 'media_download', scope: 'IP_AND_USER' })
  getMediaDownloadUrl(
    @Param('assetId') assetId: string,
    @CurrentUser() user?: any,
  ) {
    return this.storageService.getMediaDownloadUrl(assetId, user);
  }
}
