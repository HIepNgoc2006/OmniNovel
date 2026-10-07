import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { PASSWORD_RESET_DELIVERY } from './interfaces/password-reset-delivery.interface';
import { PasswordResetDeliveryProvider } from './providers/password-reset-delivery.provider';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    TypeOrmModule.forFeature([User, UserProgression]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    {
      provide: PASSWORD_RESET_DELIVERY,
      useClass: PasswordResetDeliveryProvider,
    },
  ],
  exports: [AuthService, JwtStrategy, PassportModule, PASSWORD_RESET_DELIVERY],
})
export class AuthModule {}
