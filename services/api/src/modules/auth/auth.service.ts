import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../../redis/redis.service';
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
    private dataSource: DataSource,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userRepository.findOne({
      where: [{ email: dto.email }, { username: dto.username }],
    });

    if (existing) {
      throw new ConflictException('Email hoặc tên người dùng đã tồn tại.');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB (OWASP Standard)
      timeCost: 3,
      parallelism: 4,
    });

    // Tạo User & UserProgression trong 1 Transaction nguyên tử
    return this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        username: dto.username,
        email: dto.email,
        passwordHash,
        role: GlobalRole.READER,
      });

      const savedUser = await manager.save(user);

      const progression = manager.create(UserProgression, {
        userId: savedUser.id,
        level: 1,
        totalExp: '0',
        currentExp: '0',
        streakDays: 0,
        activeTheme: 'DEFAULT',
      });

      await manager.save(progression);

      return {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        role: savedUser.role,
        createdAt: savedUser.createdAt,
      };
    });
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

    const familyId = uuidv4();
    const tokens = await this.generateTokens(user, familyId);
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

    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>(
          'JWT_REFRESH_SECRET',
          'super_secret_refresh_jwt_key_2026',
        ),
      });
    } catch {
      throw new UnauthorizedException('Refresh Token không hợp lệ hoặc đã hết hạn.');
    }

    const userId = payload.sub;
    const jti = payload.jti;
    const familyId = payload.familyId;

    if (!userId || !jti || !familyId) {
      throw new UnauthorizedException('Payload Refresh Token không hợp lệ.');
    }

    const revokedKey = `revoked_token:${userId}:${jti}`;
    const wasRevoked = await this.redisService.get(revokedKey);

    if (wasRevoked) {
      // PHÁT HIỆN HÀNH VI TÁI SỬ DỤNG TOKEN ĐÃ HỦY (Token Reuse Attack Detected!)
      // Thu hồi toàn bộ Token Family của user ngay lập tức
      await this.revokeTokenFamily(userId, familyId);
      throw new UnauthorizedException(
        'Phát hiện hành vi tái sử dụng phiên đăng nhập cũ. Toàn bộ phiên liên quan đã bị thu hồi để bảo vệ tài khoản.',
      );
    }

    const sessionKey = `session:${userId}:${jti}`;
    const sessionData = await this.redisService.get(sessionKey);

    if (!sessionData) {
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn hoặc bị thu hồi.');
    }

    // 1. Xóa session cũ (Token Rotation)
    await this.redisService.del(sessionKey);

    // 2. Ghi nhận jti cũ vào danh sách đã thu hồi (TTL 7 ngày)
    await this.redisService.set(revokedKey, familyId, 7 * 24 * 60 * 60);

    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không tồn tại.');
    }

    // 3. Cấp phát cặp Token mới giữ nguyên Family ID
    return this.generateTokens(user, familyId);
  }

  async getProfile(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không tồn tại.');
    }

    const permissions = {
      canCreateStory:
        user.role === GlobalRole.TRANSLATOR || user.role === GlobalRole.ADMIN,
      canModerate: user.role === GlobalRole.ADMIN,
      isAdmin: user.role === GlobalRole.ADMIN,
    };

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
      permissions,
    };
  }

  async logout(refreshToken?: string, userId?: string) {
    if (refreshToken) {
      try {
        const payload = this.jwtService.verify(refreshToken, {
          secret: this.configService.get<string>(
            'JWT_REFRESH_SECRET',
            'super_secret_refresh_jwt_key_2026',
          ),
        });
        const uid = payload.sub;
        const jti = payload.jti;
        const familyId = payload.familyId;
        if (uid && jti) {
          await this.redisService.del(`session:${uid}:${jti}`);
          await this.redisService.set(`revoked_token:${uid}:${jti}`, familyId, 7 * 24 * 60 * 60);
        }
      } catch {}
    }

    if (userId) {
      const redis = this.redisService.getClient();
      const keys = await redis.keys(`session:${userId}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
    return { success: true };
  }

  private async revokeTokenFamily(userId: string, familyId: string) {
    const redis = this.redisService.getClient();
    const familyKey = `family_sessions:${userId}:${familyId}`;
    const activeJtis = await redis.smembers(familyKey);

    for (const jti of activeJtis) {
      await this.redisService.del(`session:${userId}:${jti}`);
      await this.redisService.set(`revoked_token:${userId}:${jti}`, familyId, 7 * 24 * 60 * 60);
    }
    await redis.del(familyKey);
  }

  private async generateTokens(user: User, familyId: string) {
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

    // 2. Refresh Token: 7 ngày chứa jti & familyId
    const refreshToken = this.jwtService.sign(
      { ...payload, jti, familyId },
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
    await this.redisService.set(
      `session:${user.id}:${jti}`,
      JSON.stringify({ familyId, createdAt: new Date().toISOString() }),
      ttlSeconds,
    );

    // Ghi nhận vào tập hợp Token Family
    const redis = this.redisService.getClient();
    await redis.sadd(`family_sessions:${user.id}:${familyId}`, jti);
    await redis.expire(`family_sessions:${user.id}:${familyId}`, ttlSeconds);

    return {
      accessToken,
      refreshToken,
      jti,
      familyId,
    };
  }
}
