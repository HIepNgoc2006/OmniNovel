import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoriesService } from './stories.service';
import { StoriesController } from './stories.controller';
import { Story } from './entities/story.entity';
import { StoryMember } from './entities/story-member.entity';
import { StoryEdition } from './entities/story-edition.entity';
import { Genre } from './entities/genre.entity';
import { Creator } from './entities/creator.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Story,
      StoryMember,
      StoryEdition,
      Genre,
      Creator,
    ]),
  ],
  controllers: [StoriesController],
  providers: [StoriesService],
  exports: [StoriesService, TypeOrmModule],
})
export class StoriesModule {}
