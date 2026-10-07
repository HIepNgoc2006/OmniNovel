import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from './account.controller';
import { AccountSessionsController } from './account-sessions.controller';
import { AccountService } from './account.service';
import { AccountPurgeService } from './account-purge.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserProgression]),
    AuthModule,
  ],
  controllers: [AccountController, AccountSessionsController],
  providers: [AccountService, AccountPurgeService],
  exports: [AccountService, AccountPurgeService],
})
export class AccountModule {}
