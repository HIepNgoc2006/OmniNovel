import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { StorageModule } from '../storage/storage.module';
import { TranslationJob } from './entities/translation-job.entity';
import { TranslationProject } from './entities/translation-project.entity';
import { TranslationGlossary } from './entities/translation-glossary.entity';
import { TranslationSegment } from './entities/translation-segment.entity';
import { ChapterVersion } from '../chapters/entities/chapter-version.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import { MediaAsset } from '../chapters/entities/media-asset.entity';
import { UploadSession } from '../storage/entities/upload-session.entity';
import { StoryMember } from '../stories/entities/story-member.entity';
import { TranslationService } from './translation.service';
import { TranslationProcessor } from './translation.processor';
import { TranslationMaterializationProcessor } from './translation-materialization.processor';
import { TranslationWatchdogService } from './translation-watchdog.service';
import { TranslationGateway } from './translation.gateway';
import { TranslationController } from './translation.controller';
import { InternalAiController } from './internal-ai.controller';
import { InternalServiceKeyGuard } from '../../common/guards/internal-service-key.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TranslationJob,
      TranslationProject,
      TranslationGlossary,
      TranslationSegment,
      ChapterVersion,
      Chapter,
      MediaAsset,
      UploadSession,
      StoryMember,
    ]),
    BullModule.registerQueue(
      {
        name: 'translation',
      },
      {
        name: 'translation-materialization',
      },
    ),
    StorageModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') ||
          'super_secret_jwt_key_omninovel_2026',
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION') || '15m',
        },
      }),
    }),
  ],
  controllers: [TranslationController, InternalAiController],
  providers: [
    TranslationService,
    TranslationProcessor,
    TranslationMaterializationProcessor,
    TranslationWatchdogService,
    TranslationGateway,
    InternalServiceKeyGuard,
  ],
  exports: [
    TranslationService,
    TranslationProcessor,
    TranslationMaterializationProcessor,
    TranslationWatchdogService,
    TranslationGateway,
  ],
})
export class TranslationModule {}
