import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { User } from '../modules/users/entities/user.entity';
import { UserProgression } from '../modules/users/entities/user-progression.entity';
import { RankTheme } from '../modules/users/entities/rank-theme.entity';
import { RankLevel } from '../modules/users/entities/rank-level.entity';
import { Story } from '../modules/stories/entities/story.entity';
import { StoryMember } from '../modules/stories/entities/story-member.entity';
import { StoryEdition } from '../modules/stories/entities/story-edition.entity';
import { Genre } from '../modules/stories/entities/genre.entity';
import { Creator } from '../modules/stories/entities/creator.entity';
import { Volume } from '../modules/chapters/entities/volume.entity';
import { Chapter } from '../modules/chapters/entities/chapter.entity';
import { ChapterVersion } from '../modules/chapters/entities/chapter-version.entity';
import { MediaAsset } from '../modules/chapters/entities/media-asset.entity';
import { UploadSession } from '../modules/storage/entities/upload-session.entity';
import { RewardTransaction } from '../modules/gamification/entities/reward-transaction.entity';
import { DailyCheckin } from '../modules/gamification/entities/daily-checkin.entity';
import { LevelReward } from '../modules/gamification/entities/level-reward.entity';
import { UserClaimedLevelReward } from '../modules/gamification/entities/user-claimed-level-reward.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5433),
        username: config.get<string>('DB_USER', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres_password_secure'),
        database: config.get<string>('DB_NAME', 'omninovel_db'),
        synchronize: false, // Bắt buộc false theo ADR-011
        entities: [
          User,
          UserProgression,
          RankTheme,
          RankLevel,
          Story,
          StoryMember,
          StoryEdition,
          Genre,
          Creator,
          Volume,
          Chapter,
          ChapterVersion,
          MediaAsset,
          UploadSession,
          RewardTransaction,
          DailyCheckin,
          LevelReward,
          UserClaimedLevelReward,
        ],
        logging: config.get<string>('NODE_ENV') === 'development' ? ['error', 'warn'] : false,
      }),
    }),
  ],
})
export class DatabaseModule {}
