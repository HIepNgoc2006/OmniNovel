import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ChaptersService } from './chapters.service';
import { ChaptersController } from './chapters.controller';
import { Chapter } from './entities/chapter.entity';
import { ChapterVersion } from './entities/chapter-version.entity';
import { Volume } from './entities/volume.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { ChapterErrorReport } from './entities/chapter-error-report.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Chapter,
      ChapterVersion,
      Volume,
      MediaAsset,
      StoryEdition,
      ChapterErrorReport,
    ]),
    JwtModule.register({}),
  ],
  controllers: [ChaptersController],
  providers: [ChaptersService, StoryMemberGuard],
  exports: [ChaptersService, TypeOrmModule],
})
export class ChaptersModule {}
