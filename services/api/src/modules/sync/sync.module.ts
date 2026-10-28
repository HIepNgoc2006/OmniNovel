import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSyncState,
      SyncChangeLog,
      SyncTombstone,
      SyncMutationReceipt,
    ]),
  ],
  providers: [
    BookmarkConflictResolver,
    ProgressConflictResolver,
    HistoryConflictResolver,
    PreferenceConflictResolver,
    FollowConflictResolver,
    ConflictResolverDispatcher,
  ],
  exports: [
    TypeOrmModule,
    BookmarkConflictResolver,
    ProgressConflictResolver,
    HistoryConflictResolver,
    PreferenceConflictResolver,
    FollowConflictResolver,
    ConflictResolverDispatcher,
  ],
})
export class SyncModule {}
