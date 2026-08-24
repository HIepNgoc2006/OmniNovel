import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { ReadChapterRewardDto } from './dto/read-chapter-reward.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('gamification')
export class GamificationController {
  constructor(private gamificationService: GamificationService) {}

  // 1. Điểm danh hàng ngày
  @Post('check-in')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 10, ttlSeconds: 60, keyPrefix: 'gamification_checkin', scope: 'USER' })
  @HttpCode(HttpStatus.OK)
  checkIn(@CurrentUser('id') userId: string) {
    return this.gamificationService.checkIn(userId);
  }

  // 2. Nhận EXP khi đọc chương truyện (Chống cày farm & Cap 100 EXP/ngày)
  @Post('read-chapter')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 30, ttlSeconds: 60, keyPrefix: 'gamification_read_exp', scope: 'USER' })
  @HttpCode(HttpStatus.OK)
  rewardReadChapter(
    @CurrentUser('id') userId: string,
    @Body() dto: ReadChapterRewardDto,
  ) {
    return this.gamificationService.rewardReadChapter(userId, dto.chapterId);
  }

  // 3. Lấy thông tin chi tiết tiến trình độc giả
  @Get('progression')
  @UseGuards(JwtAuthGuard)
  getProgression(@CurrentUser('id') userId: string) {
    return this.gamificationService.getProgression(userId);
  }

  // 4. Trang bị Rank Theme
  @Post('themes/:themeId/equip')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  equipTheme(
    @CurrentUser('id') userId: string,
    @Param('themeId') themeId: string,
  ) {
    return this.gamificationService.equipTheme(userId, themeId);
  }

  // 5. Nhận thưởng mốc cấp độ
  @Post('level-rewards/:milestoneLevel/claim')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  claimLevelReward(
    @CurrentUser('id') userId: string,
    @Param('milestoneLevel', ParseIntPipe) milestoneLevel: number,
  ) {
    return this.gamificationService.claimLevelReward(userId, milestoneLevel);
  }

  // 6. Bảng xếp hạng cấp bậc độc giả (Public)
  @Get('leaderboard')
  getLeaderboard(@Query('limit') limit?: string) {
    const take = limit ? parseInt(limit, 10) : 20;
    return this.gamificationService.getLeaderboard(take);
  }

  // 7. Lịch sử biến động sổ cái phần thưởng
  @Get('history')
  @UseGuards(JwtAuthGuard)
  getHistory(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.gamificationService.getHistory(userId, pageNum, limitNum);
  }
}
