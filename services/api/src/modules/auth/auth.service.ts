import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ReactivateAccountDto } from './dto/reactivate-account.dto';
import { RedisService } from '../../redis/redis.service';
import { GlobalRole } from '@omninovel/shared';

export interface DeviceSessionMetadata {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  ip: string | null;
  userAgent: string | null;
  currentJti: string;
  isCurrentSession?: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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

  /**
   * Register mới với Auto-Login semantics (Option A Frozen Plan):
   * Tự động sinh familyId, tokens (kèm claim sid) và đăng ký session trên Redis.
   */
  async register(dto: RegisterDto, ip?: string, userAgent?: string) {
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
    const savedUser = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        username: dto.username,
        email: dto.email,
        passwordHash,
        role: GlobalRole.READER,
      });

      const userRecord = await manager.save(user);

      // Khởi tạo Hồ sơ Tiến trình chuẩn theo SSoT Gamification
      const progression = manager.create(UserProgression, {
        userId: userRecord.id,
        level: 1,
        totalExp: '0',
        omnicoinBalance: '0',
        currentStreak: 0,
        maxStreak: 0,
        lastCheckinDate: null,
        rankThemeId: 'DEFAULT',
      });

      await manager.save(progression);
      return userRecord;
    });

    // Tự động cấp session & tokens (Register Auto-Login)
    const familyId = uuidv4();
    const tokens = await this.generateTokens(savedUser, familyId, ip, userAgent);

    return {
      user: {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        role: savedUser.role,
        createdAt: savedUser.createdAt,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto, ip?: string, userAgent?: string) {
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
    const tokens = await this.generateTokens(user, familyId, ip, userAgent);
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

  async refreshTokens(refreshToken: string, ip?: string, userAgent?: string) {
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
    const familyId = payload.familyId || payload.sid;

    if (!userId || !jti || !familyId) {
      throw new UnauthorizedException('Payload Refresh Token không hợp lệ.');
    }

    const revokedKey = `revoked_token:${userId}:${jti}`;
    const wasRevoked = await this.redisService.get(revokedKey);

    if (wasRevoked) {
      // PHÁT HIỆN HÀNH VI TÁI SỬ DỤNG TOKEN ĐÃ HỦY (Token Reuse Attack Detected!)
      await this.revokeSession(userId, familyId);
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
      throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị vô hiệu hóa.');
    }

    // 3. Cấp phát cặp Token mới giữ nguyên Family ID
    return this.generateTokens(user, familyId, ip, userAgent);
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
        const familyId = payload.familyId || payload.sid;
        if (uid && familyId) {
          await this.revokeSession(uid, familyId);
        }
      } catch {}
    } else if (userId) {
      await this.revokeAllUserSessions(userId);
    }
    return { success: true };
  }

  // ==========================================
  // PASSWORD LIFECYCLE (Forgot, Reset, Change)
  // ==========================================

  /**
   * Quên mật khẩu: Tuân thủ tuyệt đối Anti-Enumeration Invariant.
   * Luôn trả về 200 OK với thông điệp cố định. Nếu user tồn tại, sinh token, hash SHA-256 lưu Redis (TTL 15m).
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.userRepository.findOne({
      where: { email: dto.email, isActive: true, isDeleted: false },
    });

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex'); // 64 ký tự hex
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      // Lưu HASH token vào Redis kèm userId, TTL 15 phút (900 giây)
      await this.redisService.set(`pwd_reset:${tokenHash}`, user.id, 15 * 60);

      this.logger.log(`Password reset requested for user ${user.id}. Token generated.`);
      // Trong môi trường production: Gửi rawToken qua email dịch vụ
    }

    return {
      success: true,
      message: 'Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.',
    };
  }

  /**
   * Đặt lại mật khẩu: So khớp SHA-256 token trên Redis, cập nhật password mới,
   * thu hồi toàn bộ phiên đăng nhập hiện có (Global Session Revocation).
   */
  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');
    const resetKey = `pwd_reset:${tokenHash}`;
    const userId = await this.redisService.get(resetKey);

    if (!userId) {
      throw new BadRequestException('Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new BadRequestException('Tài khoản không tồn tại hoặc đã bị vô hiệu hóa.');
    }

    const newPasswordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    user.passwordHash = newPasswordHash;
    await this.userRepository.save(user);

    // Xóa token khỏi Redis
    await this.redisService.del(resetKey);

    // Global Session Revocation: Thu hồi toàn bộ phiên
    await this.revokeAllUserSessions(userId);

    return {
      success: true,
      message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
    };
  }

  /**
   * Đổi mật khẩu: Xác thực mật khẩu cũ, cập nhật mật khẩu mới,
   * giữ nguyên current session (req.user.sessionId), thu hồi toàn bộ các phiên khác.
   */
  async changePassword(userId: string, currentSessionId: string, dto: ChangePasswordDto) {
    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị khóa.');
    }

    const isCurrentValid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!isCurrentValid) {
      throw new UnauthorizedException('Mật khẩu hiện tại không chính xác.');
    }

    const isSamePassword = await argon2.verify(user.passwordHash, dto.newPassword);
    if (isSamePassword) {
      throw new BadRequestException('Mật khẩu mới không được trùng với mật khẩu cũ.');
    }

    const newPasswordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    user.passwordHash = newPasswordHash;
    await this.userRepository.save(user);

    // Giữ lại phiên hiện tại, thu hồi toàn bộ phiên khác
    if (currentSessionId) {
      await this.revokeOtherSessions(userId, currentSessionId);
    }

    return {
      success: true,
      message: 'Đổi mật khẩu thành công.',
    };
  }

  // ==========================================
  // ACCOUNT REACTIVATION (Grace Period 30 Days)
  // ==========================================

  /**
   * Khôi phục tài khoản trong Grace Period:
   * Phân nhánh nghiêm ngặt 3 trường hợp:
   * 1. User không tồn tại (đã purge vĩnh viễn hoặc sai identifier) => 401 Unauthorized (Anti-enumeration)
   * 2. User tồn tại nhưng NOW >= scheduled_purge_at => 410 Gone / ACCOUNT_PURGED
   * 3. User tồn tại trong grace period (NOW < scheduled_purge_at) => xác thực password, khôi phục 100%, cấp tokens
   */
  async reactivateAccount(dto: ReactivateAccountDto, ip?: string, userAgent?: string) {
    const user = await this.userRepository.findOne({
      where: [
        { email: dto.identifier },
        { username: dto.identifier },
      ],
    });

    // Nhánh 1: Không tìm thấy user -> 401 Unauthorized chống enumeration
    if (!user) {
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác.');
    }

    // Nhánh 2: Tài khoản đã bị xóa và đã quá hạn scheduled_purge_at (chờ worker purge)
    if (user.isDeleted && user.scheduledPurgeAt && new Date() >= user.scheduledPurgeAt) {
      throw new HttpException(
        {
          statusCode: HttpStatus.GONE,
          message: 'Tài khoản đã quá thời hạn 30 ngày và không thể khôi phục.',
          error: 'ACCOUNT_PURGED',
        },
        HttpStatus.GONE,
      );
    }

    // Nhánh 3: Tài khoản đã soft delete nhưng còn trong grace period
    if (user.isDeleted && user.scheduledPurgeAt && new Date() < user.scheduledPurgeAt) {
      const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác.');
      }

      // Khôi phục tài khoản
      user.isActive = true;
      user.isDeleted = false;
      user.deletedAt = null;
      user.scheduledPurgeAt = null;
      await this.userRepository.save(user);

      // Cấp session mới
      const familyId = uuidv4();
      const tokens = await this.generateTokens(user, familyId, ip, userAgent);

      return {
        message: 'Khôi phục tài khoản thành công.',
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

    // Nhánh 4: Tài khoản đang hoạt động bình thường
    if (!user.isDeleted && user.isActive) {
      const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác.');
      }

      const familyId = uuidv4();
      const tokens = await this.generateTokens(user, familyId, ip, userAgent);

      return {
        message: 'Tài khoản đang hoạt động bình thường.',
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

    throw new UnauthorizedException('Tài khoản không hợp lệ hoặc đã bị vô hiệu hóa.');
  }

  // ==========================================
  // DEVICE SESSIONS MANAGEMENT (Redis Set & Metadata)
  // ==========================================

  async getUserSessions(userId: string, currentSessionId?: string): Promise<DeviceSessionMetadata[]> {
    const redis = this.redisService.getClient();
    const sessionKey = `user_sessions:${userId}`;
    const familyIds = await redis.smembers(sessionKey);

    const sessions: DeviceSessionMetadata[] = [];

    for (const fid of familyIds) {
      const metaKey = `auth_session:${userId}:${fid}`;
      const raw = await this.redisService.get(metaKey);
      if (!raw) {
        // Session đã hết hạn khỏi Redis, dọn sạch khỏi set
        await redis.srem(sessionKey, fid);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as DeviceSessionMetadata;
        parsed.isCurrentSession = parsed.sessionId === currentSessionId;
        sessions.push(parsed);
      } catch {
        await redis.srem(sessionKey, fid);
      }
    }

    // Sắp xếp theo lastActiveAt mới nhất
    return sessions.sort(
      (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    );
  }

  async revokeSession(userId: string, familyId: string) {
    const redis = this.redisService.getClient();
    await this.revokeTokenFamily(userId, familyId);
    await this.redisService.del(`auth_session:${userId}:${familyId}`);
    await redis.srem(`user_sessions:${userId}`, familyId);
    return { success: true };
  }

  async revokeOtherSessions(userId: string, currentSessionId: string) {
    const redis = this.redisService.getClient();
    const familyIds = await redis.smembers(`user_sessions:${userId}`);
    for (const fid of familyIds) {
      if (fid !== currentSessionId) {
        await this.revokeSession(userId, fid);
      }
    }
    return { success: true };
  }

  async revokeAllUserSessions(userId: string) {
    const redis = this.redisService.getClient();
    const familyIds = await redis.smembers(`user_sessions:${userId}`);
    for (const fid of familyIds) {
      await this.revokeSession(userId, fid);
    }
    // Dọn dẹp triệt để bất kỳ lingering key nào
    const sessionKeys = await redis.keys(`session:${userId}:*`);
    if (sessionKeys.length > 0) {
      await redis.del(...sessionKeys);
    }
    await this.redisService.del(`user_sessions:${userId}`);
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

  private async generateTokens(
    user: User,
    familyId: string,
    ip?: string,
    userAgent?: string,
  ) {
    const jti = uuidv4();
    const ttlSeconds = 7 * 24 * 60 * 60; // 7 ngày
    const now = new Date().toISOString();

    // Access Token payload chứa sid = familyId (P0 Invariant 11)
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      sid: familyId,
    };

    // 1. Access Token: 15 phút (NFR Compliant)
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>(
        'JWT_SECRET',
        'super_secret_jwt_key_omninovel_2026',
      ),
      expiresIn: '15m',
    });

    // 2. Refresh Token: 7 ngày chứa jti & familyId & sid
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

    // 3. Lưu session rotation key
    await this.redisService.set(
      `session:${user.id}:${jti}`,
      JSON.stringify({ familyId, createdAt: now }),
      ttlSeconds,
    );

    // 4. Ghi nhận vào tập hợp Token Family
    const redis = this.redisService.getClient();
    await redis.sadd(`family_sessions:${user.id}:${familyId}`, jti);
    await redis.expire(`family_sessions:${user.id}:${familyId}`, ttlSeconds);

    // 5. Quản lý Session Metadata ổn định trên Redis
    const metaKey = `auth_session:${user.id}:${familyId}`;
    const existingMetaRaw = await this.redisService.get(metaKey);
    let sessionMeta: DeviceSessionMetadata;

    if (existingMetaRaw) {
      try {
        sessionMeta = JSON.parse(existingMetaRaw);
        sessionMeta.lastActiveAt = now;
        sessionMeta.currentJti = jti;
        if (ip) sessionMeta.ip = ip;
        if (userAgent) sessionMeta.userAgent = userAgent;
      } catch {
        sessionMeta = {
          sessionId: familyId,
          createdAt: now,
          lastActiveAt: now,
          ip: ip || null,
          userAgent: userAgent || null,
          currentJti: jti,
        };
      }
    } else {
      sessionMeta = {
        sessionId: familyId,
        createdAt: now,
        lastActiveAt: now,
        ip: ip || null,
        userAgent: userAgent || null,
        currentJti: jti,
      };
    }

    await this.redisService.set(metaKey, JSON.stringify(sessionMeta), ttlSeconds);
    await redis.sadd(`user_sessions:${user.id}`, familyId);
    await redis.expire(`user_sessions:${user.id}`, ttlSeconds);

    return {
      accessToken,
      refreshToken,
      jti,
      familyId,
    };
  }
}
