import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../../redis/redis.module';
import { GuestClaim } from './entities/guest-claim.entity';
import { GuestClaimService } from './guest-claim.service';
import { GuestClaimController } from './guest-claim.controller';

@Module({
  imports: [TypeOrmModule.forFeature([GuestClaim]), RedisModule],
  controllers: [GuestClaimController],
  providers: [GuestClaimService],
  exports: [GuestClaimService],
})
export class GuestClaimModule {}
