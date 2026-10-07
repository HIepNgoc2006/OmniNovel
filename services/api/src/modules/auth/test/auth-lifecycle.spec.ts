import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AuthService } from '../auth.service';
import { User } from '../../users/entities/user.entity';
import { UserProgression } from '../../users/entities/user-progression.entity';
import { RedisService } from '../../../redis/redis.service';
import { JwtStrategy } from '../strategies/jwt.strategy';
import {
  PASSWORD_RESET_DELIVERY,
  IPasswordResetDelivery,
} from '../interfaces/password-reset-delivery.interface';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';

describe('AuthService - Account Lifecycle & Security Management (Task 7B.2 & 7B.2a)', () => {
  let service: AuthService;
  let userRepo: any;
  let progressionRepo: any;
  let jwtService: any;
  let redisService: any;
  let mockRedisClient: any;
  let dataSource: any;
  let mockResetDelivery: IPasswordResetDelivery;

  const mockUser: Partial<User> = {
    id: 'user-uuid-1',
    username: 'testreader',
    email: 'reader@example.com',
    passwordHash: '',
    role: 'READER' as any,
    isActive: true,
    isDeleted: false,
    deletedAt: null,
    scheduledPurgeAt: null,
    createdAt: new Date(),
  };

  beforeAll(async () => {
    mockUser.passwordHash = await argon2.hash('Password123!', {
      type: argon2.argon2id,
    });
  });

  beforeEach(async () => {
    mockRedisClient = {
      smembers: jest.fn().mockResolvedValue([]),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([]),
    };

    userRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve({ ...u })),
      create: jest.fn().mockImplementation((u) => ({ ...u })),
    };

    progressionRepo = {
      create: jest.fn().mockImplementation((p) => ({ ...p })),
      save: jest.fn().mockImplementation((p) => Promise.resolve({ ...p })),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-signed-jwt-token'),
      verify: jest.fn(),
    };

    redisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => {
        const mockManager = {
          create: jest.fn().mockImplementation((entityClass, data) => ({ ...data, id: 'user-uuid-1' })),
          save: jest.fn().mockImplementation((data) => Promise.resolve({ ...data, id: 'user-uuid-1' })),
        };
        return cb(mockManager);
      }),
    };

    mockResetDelivery = {
      sendResetToken: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserProgression), useValue: progressionRepo },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key, def) => def),
          },
        },
        { provide: RedisService, useValue: redisService },
        { provide: DataSource, useValue: dataSource },
        { provide: PASSWORD_RESET_DELIVERY, useValue: mockResetDelivery },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('1. Register Auto-Login & Access Token Session Claim', () => {
    it('should register user and automatically issue tokens containing sid familyId', async () => {
      userRepo.findOne.mockResolvedValue(null);

      const result = await service.register(
        { username: 'newuser', email: 'new@example.com', password: 'Password123!' },
        '127.0.0.1',
        'Mozilla/5.0',
      );

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBe('mock-signed-jwt-token');
      expect(result.refreshToken).toBe('mock-signed-jwt-token');
      expect(result.familyId).toBeDefined();

      // Verify sign was called with sid = familyId in access token payload
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-uuid-1',
          username: 'newuser',
          sid: result.familyId,
        }),
        expect.anything(),
      );

      // Verify auth_session metadata was stored in Redis
      expect(redisService.set).toHaveBeenCalledWith(
        `auth_session:user-uuid-1:${result.familyId}`,
        expect.stringContaining('"ip":"127.0.0.1"'),
        604800,
      );
      // Verify familyId added to user_sessions set
      expect(mockRedisClient.sadd).toHaveBeenCalledWith(
        'user_sessions:user-uuid-1',
        result.familyId,
      );
    });

    it('should throw ConflictException if username or email already exists', async () => {
      userRepo.findOne.mockResolvedValue(mockUser);

      await expect(
        service.register({ username: 'existing', email: 'exist@example.com', password: 'Password123!' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('2. Forgot & Reset Password Flow (Anti-Enumeration, Delivery & SHA-256 Hash)', () => {
    it('should return 200 OK with identical message when email does NOT exist (Anti-Enumeration)', async () => {
      userRepo.findOne.mockResolvedValue(null);

      const res = await service.forgotPassword({ email: 'nonexistent@example.com' });
      expect(res.success).toBe(true);
      expect(res.message).toBe('Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.');
      expect(redisService.set).not.toHaveBeenCalled();
      expect(mockResetDelivery.sendResetToken).not.toHaveBeenCalled();
    });

    it('should store SHA-256 hash in Redis and call PasswordResetDeliveryProvider with raw token (P0 Invariant)', async () => {
      userRepo.findOne.mockResolvedValue(mockUser);

      const res = await service.forgotPassword({ email: 'reader@example.com' });
      expect(res.success).toBe(true);
      expect(res.message).toBe('Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi.');

      // Verify Redis stored pwd_reset:<sha256> with TTL 900s
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^pwd_reset:[a-f0-9]{64}$/),
        mockUser.id,
        900,
      );

      // Verify delivery provider received the raw token and valid reset URL
      expect(mockResetDelivery.sendResetToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          email: mockUser.email,
          token: expect.stringMatching(/^[a-f0-9]{64}$/),
          resetUrl: expect.stringContaining('/reset-password?token='),
          expiresInSeconds: 900,
        }),
      );
    });

    it('resetPassword: should reject invalid or expired reset token with BadRequestException', async () => {
      redisService.get.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'invalid-token', newPassword: 'NewPassword123!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('resetPassword: should update password and revoke all sessions on valid token', async () => {
      const rawToken = 'valid-token-hex-123456';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      redisService.get.mockResolvedValue(mockUser.id);
      userRepo.findOne.mockResolvedValue({ ...mockUser });
      mockRedisClient.smembers.mockResolvedValue(['fam-1', 'fam-2']);

      const res = await service.resetPassword({ token: rawToken, newPassword: 'NewStrongPassword123!' });
      expect(res.success).toBe(true);
      expect(userRepo.save).toHaveBeenCalled();
      expect(redisService.del).toHaveBeenCalledWith(`pwd_reset:${tokenHash}`);

      // Verify all sessions were revoked
      expect(redisService.del).toHaveBeenCalledWith('user_sessions:user-uuid-1');
    });
  });

  describe('3. Change Password Flow', () => {
    it('should reject incorrect current password with UnauthorizedException', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        service.changePassword('user-uuid-1', 'current-sid', {
          currentPassword: 'WrongPassword!',
          newPassword: 'NewPassword123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject new password if identical to current password', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        service.changePassword('user-uuid-1', 'current-sid', {
          currentPassword: 'Password123!',
          newPassword: 'Password123!',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update password, keep current session and revoke all other sessions', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });
      mockRedisClient.smembers.mockResolvedValue(['current-sid', 'other-fam-1', 'other-fam-2']);

      const res = await service.changePassword('user-uuid-1', 'current-sid', {
        currentPassword: 'Password123!',
        newPassword: 'BrandNewPassword123!',
      });

      expect(res.success).toBe(true);
      expect(userRepo.save).toHaveBeenCalled();

      // Verify current session was NOT revoked, other sessions were revoked
      expect(mockRedisClient.srem).toHaveBeenCalledWith('user_sessions:user-uuid-1', 'other-fam-1');
      expect(mockRedisClient.srem).toHaveBeenCalledWith('user_sessions:user-uuid-1', 'other-fam-2');
      expect(mockRedisClient.srem).not.toHaveBeenCalledWith('user_sessions:user-uuid-1', 'current-sid');
    });
  });

  describe('4. Account Reactivation Invariants (Strict 3 Branches)', () => {
    it('Branch 1: should return generic 401 Unauthorized if user does not exist (Anti-Enumeration)', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.reactivateAccount({ identifier: 'unknown@example.com', password: 'Password123!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('Branch 2: should return 410 Gone (ACCOUNT_PURGED) if grace period has passed (NOW >= scheduledPurgeAt)', async () => {
      const pastPurgeUser = {
        ...mockUser,
        isDeleted: true,
        scheduledPurgeAt: new Date(Date.now() - 3600000), // 1 hour ago
      };
      userRepo.findOne.mockResolvedValue(pastPurgeUser);

      try {
        await service.reactivateAccount({ identifier: 'reader@example.com', password: 'Password123!' });
        fail('Should have thrown 410 Gone');
      } catch (err: any) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(410);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({ error: 'ACCOUNT_PURGED' }),
        );
      }
    });

    it('Branch 3: should reject with 401 Unauthorized if password is wrong during grace period', async () => {
      const deletedUserInGrace = {
        ...mockUser,
        isDeleted: true,
        scheduledPurgeAt: new Date(Date.now() + 86400000 * 20), // 20 days left
      };
      userRepo.findOne.mockResolvedValue(deletedUserInGrace);

      await expect(
        service.reactivateAccount({ identifier: 'reader@example.com', password: 'WrongPassword!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('Branch 3: should restore account and issue new tokens when password is correct within grace period', async () => {
      const deletedUserInGrace = {
        ...mockUser,
        isDeleted: true,
        deletedAt: new Date(),
        scheduledPurgeAt: new Date(Date.now() + 86400000 * 20),
      };
      userRepo.findOne.mockResolvedValue(deletedUserInGrace);

      const res = await service.reactivateAccount(
        { identifier: 'reader@example.com', password: 'Password123!' },
        '10.0.0.1',
        'MobileApp/1.0',
      );

      expect(res.message).toBe('Khôi phục tài khoản thành công.');
      expect(deletedUserInGrace.isActive).toBe(true);
      expect(deletedUserInGrace.isDeleted).toBe(false);
      expect(deletedUserInGrace.deletedAt).toBeNull();
      expect(deletedUserInGrace.scheduledPurgeAt).toBeNull();
      expect(userRepo.save).toHaveBeenCalledWith(deletedUserInGrace);
      expect(res.accessToken).toBe('mock-signed-jwt-token');
    });

    it('Branch 4: should reject already-active account with 400 Bad Request (ACCOUNT_ALREADY_ACTIVE)', async () => {
      userRepo.findOne.mockResolvedValue({
        ...mockUser,
        isDeleted: false,
        isActive: true,
      });

      await expect(
        service.reactivateAccount({ identifier: 'reader@example.com', password: 'Password123!' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('5. Device Sessions Management', () => {
    it('getUserSessions: should return list of sessions and correctly flag isCurrentSession', async () => {
      mockRedisClient.smembers.mockResolvedValue(['fam-curr', 'fam-other']);

      redisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth_session:user-uuid-1:fam-curr') {
          return JSON.stringify({
            sessionId: 'fam-curr',
            createdAt: '2026-10-07T10:00:00Z',
            lastActiveAt: '2026-10-07T12:00:00Z',
            ip: '1.1.1.1',
            userAgent: 'Chrome',
            currentJti: 'jti-1',
          });
        }
        if (key === 'auth_session:user-uuid-1:fam-other') {
          return JSON.stringify({
            sessionId: 'fam-other',
            createdAt: '2026-10-07T08:00:00Z',
            lastActiveAt: '2026-10-07T11:00:00Z',
            ip: '2.2.2.2',
            userAgent: 'Firefox',
            currentJti: 'jti-2',
          });
        }
        return null;
      });

      const sessions = await service.getUserSessions('user-uuid-1', 'fam-curr');
      expect(sessions.length).toBe(2);
      expect(sessions[0].sessionId).toBe('fam-curr');
      expect(sessions[0].isCurrentSession).toBe(true);
      expect(sessions[1].sessionId).toBe('fam-other');
      expect(sessions[1].isCurrentSession).toBe(false);
    });

    it('revokeSession: should clean tokens, metadata, and remove from set', async () => {
      mockRedisClient.smembers.mockResolvedValue(['jti-active']);

      const res = await service.revokeSession('user-uuid-1', 'target-fam');
      expect(res.success).toBe(true);
      expect(redisService.del).toHaveBeenCalledWith('session:user-uuid-1:jti-active');
      expect(redisService.del).toHaveBeenCalledWith('auth_session:user-uuid-1:target-fam');
      expect(mockRedisClient.srem).toHaveBeenCalledWith('user_sessions:user-uuid-1', 'target-fam');
    });
  });

  describe('6. JwtStrategy Immediate Session Revocation Check (P1 Invariant)', () => {
    let jwtStrategy: JwtStrategy;

    beforeEach(() => {
      jwtStrategy = new JwtStrategy(
        { get: jest.fn().mockReturnValue('super_secret_jwt_key_omninovel_2026') } as any,
        userRepo,
        redisService,
      );
    });

    it('should validate successfully when session is active in Redis', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });
      redisService.get.mockResolvedValue(JSON.stringify({ sessionId: 'active-sid' }));

      const validated = await jwtStrategy.validate({
        sub: 'user-uuid-1',
        username: 'testreader',
        role: 'READER',
        sid: 'active-sid',
      });

      expect(validated.id).toBe('user-uuid-1');
      expect(validated.sessionId).toBe('active-sid');
    });

    it('should throw UnauthorizedException immediately when sid session is missing from Redis', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });
      redisService.get.mockResolvedValue(null); // Session was revoked or expired

      await expect(
        jwtStrategy.validate({
          sub: 'user-uuid-1',
          username: 'testreader',
          role: 'READER',
          sid: 'revoked-sid',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when sid is missing from payload (Fail-Closed Invariant)', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        jwtStrategy.validate({
          sub: 'user-uuid-1',
          username: 'testreader',
          role: 'READER',
        } as any),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
