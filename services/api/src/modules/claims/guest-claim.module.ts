import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../../redis/redis.module';
import { GuestClaim } from './entities/guest-claim.entity';
import { GuestClaimService } from './guest-claim.service';
import { GuestClaimController } from './guest-claim.controller';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GuestClaim]),
    RedisModule,
    SyncModule,
  ],
  controllers: [GuestClaimController],
  providers: [GuestClaimService],
  exports: [GuestClaimService],
})
export class GuestClaimModule {}
