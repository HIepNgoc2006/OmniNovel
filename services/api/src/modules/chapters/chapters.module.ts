import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { ChaptersService } from './chapters.service';
import { ChaptersController } from './chapters.controller';
import { CanonicalPackagingService } from './canonical-packaging.service';
import { ChapterPackagingProcessor } from './chapter-packaging.processor';
import { Chapter } from './entities/chapter.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { Volume } from './entities/volume.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { ChapterArtifact } from './entities/chapter-artifact.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { ChapterErrorReport } from './entities/chapter-error-report.entity';
import { StorageModule } from '../storage/storage.module';
import { RedisModule } from '../../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Chapter,
      ChapterVersion,
      Volume,
      MediaAsset,
      ChapterArtifact,
      StoryEdition,
      ChapterErrorReport,
    ]),
    BullModule.registerQueue({
      name: 'chapter-packaging',
    }),
    JwtModule.register({}),
    StorageModule,
    RedisModule,
  ],
  controllers: [ChaptersController],
  providers: [
    ChaptersService,
    CanonicalPackagingService,
    ChapterPackagingProcessor,
    StoryMemberGuard,
  ],
  exports: [ChaptersService, CanonicalPackagingService, TypeOrmModule],
})
export class ChaptersModule {}

