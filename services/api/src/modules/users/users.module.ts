import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserProgression } from './entities/user-progression.entity';
import { RankTheme } from './entities/rank-theme.entity';
import { RankLevel } from './entities/rank-level.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserProgression, RankTheme, RankLevel]),
  ],
  exports: [TypeOrmModule],
})
export class UsersModule {}
