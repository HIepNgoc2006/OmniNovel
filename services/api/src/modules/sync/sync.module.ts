import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSyncState } from './entities/user-sync-state.entity';
import { SyncChangeLog } from './entities/sync-change-log.entity';
import { SyncTombstone } from './entities/sync-tombstone.entity';
import { SyncMutationReceipt } from './entities/sync-mutation-receipt.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSyncState,
      SyncChangeLog,
      SyncTombstone,
      SyncMutationReceipt,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class SyncModule {}
