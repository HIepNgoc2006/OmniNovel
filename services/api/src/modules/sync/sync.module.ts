import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UserSyncState } from './entities/user-sync-state.entity';
import { SyncChangeLog } from './entities/sync-change-log.entity';
import { SyncTombstone } from './entities/sync-tombstone.entity';
import { SyncMutationReceipt } from './entities/sync-mutation-receipt.entity';
import {
  BookmarkConflictResolver,
  ConflictResolverDispatcher,
  FollowConflictResolver,
  HistoryConflictResolver,
  PreferenceConflictResolver,
  ProgressConflictResolver,
} from './resolvers';
import { SyncLogEmitter } from './services/sync-log-emitter.service';
import { SyncService } from './services/sync.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSyncState,
      SyncChangeLog,
      SyncTombstone,
      SyncMutationReceipt,
    ]),
    ConfigModule,
  ],
  controllers: [SyncController],
  providers: [
    BookmarkConflictResolver,
    ProgressConflictResolver,
    HistoryConflictResolver,
    PreferenceConflictResolver,
    FollowConflictResolver,
    ConflictResolverDispatcher,
    SyncLogEmitter,
    SyncService,
  ],
  exports: [
    TypeOrmModule,
    BookmarkConflictResolver,
    ProgressConflictResolver,
    HistoryConflictResolver,
    PreferenceConflictResolver,
    FollowConflictResolver,
    ConflictResolverDispatcher,
    SyncLogEmitter,
    SyncService,
  ],
})
export class SyncModule {}
