import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { StoriesService } from './stories.service';
import { StoriesController } from './stories.controller';
import { Story } from './entities/story.entity';
import { StoryMember } from './entities/story-member.entity';
import { StoryEdition } from './entities/story-edition.entity';
import { Genre } from './entities/genre.entity';
import { Creator } from './entities/creator.entity';
import { Bookmark } from './entities/bookmark.entity';
import { ReadingProgress } from './entities/reading-progress.entity';
import { ChapterReadState } from './entities/chapter-read-state.entity';
import { ReadingHistoryEpochCounter } from './entities/reading-history-epoch-counter.entity';
import { ReadingHistoryTombstone } from './entities/reading-history-tombstone.entity';
import { Volume } from '../chapters/entities/volume.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Story,
      StoryMember,
      StoryEdition,
      Genre,
      Creator,
      Bookmark,
      ReadingProgress,
      ChapterReadState,
      ReadingHistoryEpochCounter,
      ReadingHistoryTombstone,
      Volume,
      Chapter,
    ]),
    JwtModule.register({}),
    SyncModule,
  ],
  controllers: [StoriesController],
  providers: [StoriesService, StoryMemberGuard],
  exports: [StoriesService, TypeOrmModule],
})
export class StoriesModule {}
