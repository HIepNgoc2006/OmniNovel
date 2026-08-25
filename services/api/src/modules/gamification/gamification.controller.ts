import {
  Controller,
  Post,
  Get,
  Patch,
  Query,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { ReadChapterRewardDto } from './dto/read-chapter-reward.dto';
import { ChangeRankThemeDto } from './dto/change-rank-theme.dto';
import { ClaimLevelRewardDto } from './dto/claim-level-reward.dto';
import { RewardType } from './entities/reward-transaction.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('gamification')
export class GamificationController {
  constructor(private gamificationService: GamificationService) {}

  // 1. Lấy thông tin chi tiết tiến trình độc giả (GET /gamification/progression)
  @Get('progression')
  @UseGuards(JwtAuthGuard)
  getProgression(@CurrentUser('id') userId: string) {
    return this.gamificationService.getProgression(userId);
  }

  // 2. Điểm danh hàng ngày (POST /gamification/checkin) - Canonical API Contract
  @Post('checkin')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 10, ttlSeconds: 60, keyPrefix: 'gamification_checkin', scope: 'USER' })
  @HttpCode(HttpStatus.OK)
  checkIn(
    @CurrentUser('id') userId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.gamificationService.checkIn(userId, idempotencyKey);
  }

  // 3. Thay đổi chủ đề cấp bậc (PATCH /gamification/rank-theme) - Canonical API Contract
  @Patch('rank-theme')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  changeRankTheme(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangeRankThemeDto,
  ) {
    return this.gamificationService.changeRankTheme(userId, dto.themeId);
  }

  // 4. Nhận thưởng mốc cấp độ (POST /gamification/rewards/claim) - Canonical API Contract
  @Post('rewards/claim')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  claimLevelReward(
    @CurrentUser('id') userId: string,
    @Body() dto: ClaimLevelRewardDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.gamificationService.claimLevelReward(
      userId,
      dto.milestoneLevel,
      idempotencyKey,
    );
  }

  // 5. Truy vấn lịch sử giao dịch sổ cái (GET /gamification/transactions) - Canonical API Contract
  @Get('transactions')
  @UseGuards(JwtAuthGuard)
  getTransactions(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('rewardType') rewardType?: RewardType,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.gamificationService.getTransactions(
      userId,
      pageNum,
      limitNum,
      rewardType,
    );
  }

  // 6. Thưởng EXP đọc chương truyện (POST /gamification/read-chapter)
  @Post('read-chapter')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 30, ttlSeconds: 60, keyPrefix: 'gamification_read_exp', scope: 'USER' })
  @HttpCode(HttpStatus.OK)
  rewardReadChapter(
    @CurrentUser() user: any,
    @Body() dto: ReadChapterRewardDto,
  ) {
    return this.gamificationService.rewardReadChapter(user, dto);
  }

  // 7. Bảng xếp hạng cấp bậc độc giả (GET /gamification/leaderboard)
  @Get('leaderboard')
  getLeaderboard(@Query('limit') limit?: string) {
    const take = limit ? parseInt(limit, 10) : 20;
    return this.gamificationService.getLeaderboard(take);
  }
}
