import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { RedisService } from '../../../redis/redis.service';

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  sid?: string;
  jti?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private redisService: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>(
        'JWT_SECRET',
        'super_secret_jwt_key_omninovel_2026',
      ),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc tài khoản đã bị khóa.');
    }

    // Xác thực tính hợp lệ tức thời của phiên qua sid trên Redis
    if (payload.sid) {
      const sessionActive = await this.redisService.get(`auth_session:${user.id}:${payload.sid}`);
      if (!sessionActive) {
        throw new UnauthorizedException('Phiên làm việc đã bị thu hồi hoặc đã hết hạn.');
      }
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      sessionId: payload.sid,
    };
  }
}
