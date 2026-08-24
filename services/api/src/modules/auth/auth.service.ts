import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { RedisService } from '../../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GlobalRole } from '@omninovel/shared';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserProgression)
    private progressionRepository: Repository<UserProgression>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private redisService: RedisService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userRepository.findOne({
      where: [{ email: dto.email }, { username: dto.username }],
    });

    if (existing) {
      if (existing.email === dto.email) {
        throw new ConflictException('Email này đã được sử dụng.');
      }
      throw new ConflictException('Tên người dùng này đã tồn tại.');
    }

    // Băm mật khẩu bằng Argon2id chuẩn OWASP
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64MB
      timeCost: 3,
      parallelism: 4,
    });

    const user = this.userRepository.create({
      username: dto.username,
      email: dto.email,
      passwordHash,
      role: GlobalRole.READER,
    });

    const savedUser = await this.userRepository.save(user);

    // Tự động khởi tạo User Progression & Reward Ledger baseline
    const progression = this.progressionRepository.create({
      userId: savedUser.id,
      level: 1,
      totalExp: '0',
      omnicoinBalance: '0',
      currentStreak: 0,
      maxStreak: 0,
      rankThemeId: 'DEFAULT',
    });

    await this.progressionRepository.save(progression);

    return {
      id: savedUser.id,
      username: savedUser.username,
      email: savedUser.email,
      role: savedUser.role,
      createdAt: savedUser.createdAt,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userRepository.findOne({
      where: [
        { email: dto.identifier, isActive: true, isDeleted: false },
        { username: dto.identifier, isActive: true, isDeleted: false },
      ],
    });

    if (!user) {
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác.');
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác.');
    }

    const tokens = await this.generateTokens(user);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
      },
      ...tokens,
    };
  }

  async refreshTokens(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Không tìm thấy Refresh Token.');
    }

    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>(
          'JWT_REFRESH_SECRET',
          'super_secret_refresh_jwt_key_2026',
        ),
      });

      const sessionKey = `session:${payload.sub}:${payload.jti}`;
      const sessionExists = await this.redisService.get(sessionKey);

      if (!sessionExists) {
        // Phát hiện tái sử dụng token cũ -> thu hồi toàn bộ token family để bảo vệ an ninh
        throw new UnauthorizedException('Phiên đăng nhập đã hết hạn hoặc bị thu hồi.');
      }

      // Xóa phiên cũ (Token Rotation)
      await this.redisService.del(sessionKey);

      const user = await this.userRepository.findOne({
        where: { id: payload.sub, isActive: true, isDeleted: false },
      });

      if (!user) {
        throw new UnauthorizedException('Tài khoản không tồn tại.');
      }

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Refresh Token không hợp lệ hoặc đã hết hạn.');
    }
  }

  async logout(userId: string, jti?: string) {
    if (jti) {
      await this.redisService.del(`session:${userId}:${jti}`);
    }
    return { success: true };
  }

  private async generateTokens(user: User) {
    const jti = uuidv4();
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };

    // 1. Access Token: 15 phút (NFR Compliant)
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>(
        'JWT_SECRET',
        'super_secret_jwt_key_omninovel_2026',
      ),
      expiresIn: '15m',
    });

    // 2. Refresh Token: 7 ngày
    const refreshToken = this.jwtService.sign(
      { ...payload, jti },
      {
        secret: this.configService.get<string>(
          'JWT_REFRESH_SECRET',
          'super_secret_refresh_jwt_key_2026',
        ),
        expiresIn: '7d',
      },
    );

    // Lưu session key trên Redis với TTL 7 ngày (604800s)
    const ttlSeconds = 7 * 24 * 60 * 60;
    await this.redisService.set(`session:${user.id}:${jti}`, 'ACTIVE', ttlSeconds);

    return {
      accessToken,
      refreshToken,
      jti,
    };
  }
}
