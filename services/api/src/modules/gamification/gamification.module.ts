import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';
import { UserProgression } from '../users/entities/user-progression.entity';
import { RankTheme } from '../users/entities/rank-theme.entity';
import { RankLevel } from '../users/entities/rank-level.entity';
import { RewardTransaction } from './entities/reward-transaction.entity';
import { DailyCheckin } from './entities/daily-checkin.entity';
import { LevelReward } from './entities/level-reward.entity';
import { UserClaimedLevelReward } from './entities/user-claimed-level-reward.entity';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserProgression,
      RankTheme,
      RankLevel,
      RewardTransaction,
      DailyCheckin,
      LevelReward,
      UserClaimedLevelReward,
    ]),
    RedisModule,
  ],
  controllers: [GamificationController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
