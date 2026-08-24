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
import { Volume } from '../chapters/entities/volume.entity';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Story,
      StoryMember,
      StoryEdition,
      Genre,
      Creator,
      Volume,
    ]),
    JwtModule.register({}),
  ],
  controllers: [StoriesController],
  providers: [StoriesService, StoryMemberGuard],
  exports: [StoriesService, TypeOrmModule],
})
export class StoriesModule {}
