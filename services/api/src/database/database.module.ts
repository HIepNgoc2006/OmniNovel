import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildPostgresConnectionOptions } from './database.config';
import { validateTestDatabaseTarget } from '../common/guards/test-isolation-guard';
import { User } from '../modules/users/entities/user.entity';
import { UserProgression } from '../modules/users/entities/user-progression.entity';
import { RankTheme } from '../modules/users/entities/rank-theme.entity';
import { RankLevel } from '../modules/users/entities/rank-level.entity';
import { Story } from '../modules/stories/entities/story.entity';
import { StoryMember } from '../modules/stories/entities/story-member.entity';
import { StoryEdition } from '../modules/stories/entities/story-edition.entity';
import { Genre } from '../modules/stories/entities/genre.entity';
import { Creator } from '../modules/stories/entities/creator.entity';
import { Bookmark } from '../modules/stories/entities/bookmark.entity';
import { ReadingProgress } from '../modules/stories/entities/reading-progress.entity';
import { ChapterReadState } from '../modules/stories/entities/chapter-read-state.entity';
import { Volume } from '../modules/chapters/entities/volume.entity';
import { Chapter } from '../modules/chapters/entities/chapter.entity';
import { ChapterVersion } from '../modules/chapters/entities/chapter-version.entity';
import { MediaAsset } from '../modules/chapters/entities/media-asset.entity';
import { ChapterArtifact } from '../modules/chapters/entities/chapter-artifact.entity';
import { UploadSession } from '../modules/storage/entities/upload-session.entity';
import { RewardTransaction } from '../modules/gamification/entities/reward-transaction.entity';
import { DailyCheckin } from '../modules/gamification/entities/daily-checkin.entity';
import { LevelReward } from '../modules/gamification/entities/level-reward.entity';
import { UserClaimedLevelReward } from '../modules/gamification/entities/user-claimed-level-reward.entity';
import { TranslationProject } from '../modules/translation/entities/translation-project.entity';
import { TranslationGlossary } from '../modules/translation/entities/translation-glossary.entity';
import { TranslationJob } from '../modules/translation/entities/translation-job.entity';
import { TranslationSegment } from '../modules/translation/entities/translation-segment.entity';
import { GuestClaim } from '../modules/claims/entities/guest-claim.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pgOptions = buildPostgresConnectionOptions({
          databaseUrl: config.get<string>('DATABASE_URL'),
          host: config.get<string>('DB_HOST'),
          port: config.get<number>('DB_PORT'),
          username: config.get<string>('DB_USER'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_NAME'),
          ssl: config.get<boolean | string>('DB_SSL'),
        });

        if (config.get<string>('NODE_ENV') === 'test') {
          validateTestDatabaseTarget({
            host: pgOptions.host,
            port: pgOptions.port,
            database: pgOptions.database,
            url: pgOptions.url,
          });
        }

        return {
          type: 'postgres',
          ...pgOptions,
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
          Bookmark,
          ReadingProgress,
          ChapterReadState,
          Volume,
          Chapter,
          ChapterVersion,
          MediaAsset,
          ChapterArtifact,
          UploadSession,
          RewardTransaction,
          DailyCheckin,
          LevelReward,
          UserClaimedLevelReward,
          TranslationProject,
          TranslationGlossary,
          TranslationJob,
          TranslationSegment,
          GuestClaim,
        ],
        logging: config.get<string>('NODE_ENV') === 'development' ? ['error', 'warn'] : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
