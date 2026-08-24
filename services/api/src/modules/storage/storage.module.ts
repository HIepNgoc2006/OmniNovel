import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { UploadSession } from './entities/upload-session.entity';
import { MediaAsset } from '../chapters/entities/media-asset.entity';
import { StoryEdition } from '../stories/entities/story-edition.entity';
import { StoryMemberGuard } from '../../common/guards/story-member.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UploadSession,
      MediaAsset,
      StoryEdition,
    ]),
  ],
  controllers: [StorageController],
  providers: [StorageService, StoryMemberGuard],
  exports: [StorageService, TypeOrmModule],
})
export class StorageModule {}
