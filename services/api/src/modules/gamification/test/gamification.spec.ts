import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GamificationService, getVietnamDayBoundaries } from '../gamification.service';
import { UserProgression } from '../../users/entities/user-progression.entity';
import { RewardTransaction, RewardType, RewardSourceType } from '../entities/reward-transaction.entity';
import { DailyCheckin } from '../entities/daily-checkin.entity';
import { RankTheme } from '../../users/entities/rank-theme.entity';
import { RankLevel } from '../../users/entities/rank-level.entity';
import { LevelReward } from '../entities/level-reward.entity';
import { UserClaimedLevelReward } from '../entities/user-claimed-level-reward.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { RedisService } from '../../../redis/redis.service';

describe('GamificationService — Phase 5C.5 Gates 1, 1B, 2', () => {
  let service: GamificationService;
  let redisService: jest.Mocked<RedisService>;
  let dataSource: any;

  const mockProgressionRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockTransactionRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockCheckinRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const mockThemeRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockLevelRepo = {
    find: jest.fn(),
  };

  const mockLevelRewardRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockChapterRepo = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockRedis = {
      setnx: jest.fn(),
      releaseLock: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const mockManager = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((entityClass, data) => ({ ...data })),
      query: jest.fn(),
      getRepository: jest.fn(),
    };

    const mockDS = {
      transaction: jest.fn(async (cb) => cb(mockManager)),
      query: jest.fn(),
      getRepository: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GamificationService,
        { provide: getRepositoryToken(UserProgression), useValue: mockProgressionRepo },
        { provide: getRepositoryToken(RewardTransaction), useValue: mockTransactionRepo },
        { provide: getRepositoryToken(DailyCheckin), useValue: mockCheckinRepo },
        { provide: getRepositoryToken(RankTheme), useValue: mockThemeRepo },
        { provide: getRepositoryToken(RankLevel), useValue: mockLevelRepo },
        { provide: getRepositoryToken(LevelReward), useValue: mockLevelRewardRepo },
        { provide: getRepositoryToken(Chapter), useValue: mockChapterRepo },
        { provide: RedisService, useValue: mockRedis },
        { provide: DataSource, useValue: mockDS },
      ],
    }).compile();

    service = module.get<GamificationService>(GamificationService);
    redisService = module.get(RedisService);
    dataSource = module.get(DataSource);
  });

  describe('Gate 1: Canonical Redis Lock & Multi-UUID Defense', () => {
    it('khi request thứ 2 gửi đến lúc request 1 đang giữ lock, phải ném 400 CHECKIN_REQUEST_IN_FLIGHT', async () => {
      const userId = 'user-uuid-1';
      redisService.setnx.mockResolvedValueOnce(false); // Lock acquisition failed

      try {
        await service.checkIn(userId);
        fail('Should throw BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: 'CHECKIN_REQUEST_IN_FLIGHT',
            message: expect.stringContaining('CHECKIN_REQUEST_IN_FLIGHT'),
          }),
        );
      }
    });
  });

  describe('Gate 1B: Ownership-Safe Release & Best-Effort Failure Resilience', () => {
    it('request hoàn thành giải phóng lock đúng key và lockToken', async () => {
      const userId = 'user-uuid-1';
      const { todayVN } = getVietnamDayBoundaries();
      redisService.setnx.mockResolvedValueOnce(true);
      redisService.releaseLock.mockResolvedValueOnce(true);

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const mgr = {
          findOne: jest.fn().mockImplementation((entity: any) => {
            if (entity === UserProgression) {
              return {
                userId,
                totalExp: '100',
                omnicoinBalance: '50',
                currentStreak: 1,
                maxStreak: 1,
                lastCheckinDate: '2026-09-22',
                level: 1,
              };
            }
            if (entity === DailyCheckin) return null;
            return null;
          }),
          save: jest.fn().mockImplementation((e) => e),
          create: jest.fn((_, d) => d),
        };
        return cb(mgr);
      });

      const res = await service.checkIn(userId);
      expect(res.newStreak).toBe(1);
      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
      const [calledKey, calledToken] = redisService.releaseLock.mock.calls[0];
      expect(calledKey).toBe(`gamification:lock:checkin:${userId}:${todayVN}`);
      expect(typeof calledToken).toBe('string');
      expect(calledToken.length).toBeGreaterThan(10);
    });

    it('khi releaseLock ném exception, DB transaction thành công không bị crash 500 và service log warn an toàn', async () => {
      const userId = 'user-uuid-2';
      redisService.setnx.mockResolvedValueOnce(true);
      redisService.releaseLock.mockRejectedValueOnce(new Error('Redis connection dropped'));

      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const mgr = {
          findOne: jest.fn().mockImplementation((entity: any) => {
            if (entity === UserProgression) {
              return {
                userId,
                totalExp: '100',
                omnicoinBalance: '50',
                currentStreak: 1,
                maxStreak: 1,
                lastCheckinDate: '2026-09-22',
                level: 1,
              };
            }
            if (entity === DailyCheckin) return null;
            return null;
          }),
          save: jest.fn().mockImplementation((e) => e),
          create: jest.fn((_, d) => d),
        };
        return cb(mgr);
      });

      // Không ném lỗi ra ngoài
      const res = await service.checkIn(userId);
      expect(res.alreadyCheckedIn).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Không thể giải phóng Redis lock'),
      );
    });

    it('claimLevelReward: giải phóng lock và ném LEVEL_REWARD_REQUEST_IN_FLIGHT nếu lock đang bận', async () => {
      const userId = 'user-uuid-claim';
      redisService.setnx.mockResolvedValueOnce(false);

      try {
        await service.claimLevelReward(userId, 5);
        fail('Should throw BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: 'LEVEL_REWARD_REQUEST_IN_FLIGHT',
            message: expect.stringContaining('LEVEL_REWARD_REQUEST_IN_FLIGHT'),
          }),
        );
      }
    });
  });

  describe('Gate 2: Canonical serverDateVN Trong Mọi HTTP 200 Outcome của rewardReadChapter', () => {
    const { todayVN } = getVietnamDayBoundaries();

    it('outcome 1: CRITERIA_NOT_MET trả serverDateVN canonical và success: false', async () => {
      mockChapterRepo.findOne.mockResolvedValueOnce({
        id: 'chap-1',
        storyEdition: { story: { visibility: 'PUBLIC' } },
      });

      const res = await service.rewardReadChapter('user-1', {
        chapterId: 'chap-1',
        readingDurationSeconds: 30, // < 45s
        progressPercentage: 90,
      });

      expect(res.success).toBe(false);
      expect(res.reason).toBe('CRITERIA_NOT_MET');
      expect(res.serverDateVN).toBe(todayVN);
    });

    it('outcome 2: ALREADY_REWARDED trả serverDateVN canonical và success: true', async () => {
      mockChapterRepo.findOne.mockResolvedValueOnce({
        id: 'chap-2',
        storyEdition: { story: { visibility: 'PUBLIC' } },
      });

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const mgr = {
          findOne: jest.fn().mockImplementation((entity: any) => {
            if (entity === UserProgression) return { userId: 'user-1', totalExp: '100', level: 1 };
            if (entity === RewardTransaction) return { id: 'tx-1' }; // Đã có transaction
            return null;
          }),
          query: jest.fn(),
        };
        return cb(mgr);
      });

      const res = await service.rewardReadChapter('user-1', {
        chapterId: 'chap-2',
        readingDurationSeconds: 60,
        progressPercentage: 85,
      });

      expect(res.success).toBe(true);
      expect(res.earnedExp).toBe(0);
      expect(res.reason).toBe('ALREADY_REWARDED');
      expect(res.serverDateVN).toBe(todayVN);
    });

    it('outcome 3: DAILY_CAP_REACHED trả serverDateVN canonical và success: true', async () => {
      mockChapterRepo.findOne.mockResolvedValueOnce({
        id: 'chap-3',
        storyEdition: { story: { visibility: 'PUBLIC' } },
      });

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const mgr = {
          findOne: jest.fn().mockImplementation((entity: any) => {
            if (entity === UserProgression) return { userId: 'user-1', totalExp: '500', level: 3 };
            if (entity === RewardTransaction) return null;
            return null;
          }),
          query: jest.fn().mockResolvedValueOnce([{ total: '100' }]), // Đã nhận 100 EXP hôm nay
        };
        return cb(mgr);
      });

      const res = await service.rewardReadChapter('user-1', {
        chapterId: 'chap-3',
        readingDurationSeconds: 60,
        progressPercentage: 90,
      });

      expect(res.success).toBe(true);
      expect(res.earnedExp).toBe(0);
      expect(res.reason).toBe('DAILY_CAP_REACHED');
      expect(res.serverDateVN).toBe(todayVN);
    });

    it('outcome 4: Thưởng thành công (+5 EXP) trả serverDateVN canonical và success: true', async () => {
      mockChapterRepo.findOne.mockResolvedValueOnce({
        id: 'chap-4',
        storyEdition: { story: { visibility: 'PUBLIC' } },
      });

      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const progression = { userId: 'user-1', totalExp: '100', level: 1 };
        const mgr = {
          findOne: jest.fn().mockImplementation((entity: any) => {
            if (entity === UserProgression) return progression;
            if (entity === RewardTransaction) return null;
            return null;
          }),
          query: jest.fn().mockResolvedValueOnce([{ total: '20' }]),
          create: jest.fn((_, d) => d),
          save: jest.fn().mockImplementation((e) => e),
        };
        return cb(mgr);
      });

      const res = await service.rewardReadChapter('user-1', {
        chapterId: 'chap-4',
        readingDurationSeconds: 50,
        progressPercentage: 85,
      });

      expect(res.success).toBe(true);
      expect(res.earnedExp).toBe(5);
      expect(res.serverDateVN).toBe(todayVN);
    });
  });

  describe('Contract Themes & Level Rewards', () => {
    it('getThemes trả danh sách active theme kèm currentRankTitle', async () => {
      mockProgressionRepo.findOne.mockResolvedValueOnce({ level: 5 });
      mockThemeRepo.find.mockResolvedValueOnce([
        { id: 'DEFAULT', name: 'Mặc Định', isActive: true },
        { id: 'TU_TIEN', name: 'Tu Tiên', isActive: true },
      ]);
      mockLevelRepo.find.mockResolvedValueOnce([
        { themeId: 'DEFAULT', minLevel: 1, maxLevel: 10, rankTitle: 'Luyện Khí' },
        { themeId: 'TU_TIEN', minLevel: 1, maxLevel: 10, rankTitle: 'Trúc Cơ' },
      ]);

      const res = await service.getThemes('user-1');
      expect(res.themes).toHaveLength(2);
      expect(res.themes[0].currentRankTitle).toBe('Luyện Khí');
      expect(res.themes[1].currentRankTitle).toBe('Trúc Cơ');
    });

    it('getLevelRewards trả danh sách mốc kèm isClaimed và canClaim', async () => {
      mockProgressionRepo.findOne.mockResolvedValueOnce({ level: 10 });
      mockLevelRewardRepo.find.mockResolvedValueOnce([
        { id: 'r-5', milestoneLevel: 5, rewardCoins: 50 },
        { id: 'r-10', milestoneLevel: 10, rewardCoins: 100 },
        { id: 'r-20', milestoneLevel: 20, rewardCoins: 200 },
      ]);

      const mockClaimRepo = {
        find: jest.fn().mockResolvedValueOnce([{ rewardId: 'r-5' }]),
      };
      dataSource.getRepository.mockReturnValueOnce(mockClaimRepo);

      const res = await service.getLevelRewards('user-1');
      expect(res.rewards).toHaveLength(3);
      // Mốc 5: đã claim
      expect(res.rewards[0].isClaimed).toBe(true);
      expect(res.rewards[0].canClaim).toBe(false);
      // Mốc 10: chưa claim, level 10 >= 10 -> canClaim = true
      expect(res.rewards[1].isClaimed).toBe(false);
      expect(res.rewards[1].canClaim).toBe(true);
      // Mốc 20: chưa claim, level 10 < 20 -> canClaim = false
      expect(res.rewards[2].isClaimed).toBe(false);
      expect(res.rewards[2].canClaim).toBe(false);
    });
  });

  describe('SSoT Date & Time Calculations trong getProgression', () => {
    it('trả serverDateVN, serverNow, nextCheckinAt, secondsUntilNextCheckin hợp lệ', async () => {
      mockProgressionRepo.findOne.mockResolvedValueOnce({
        userId: 'user-time',
        level: 2,
        totalExp: '300',
        omnicoinBalance: '100',
        currentStreak: 2,
        maxStreak: 5,
        lastCheckinDate: '2026-09-23',
        rankThemeId: 'DEFAULT',
      });
      dataSource.query.mockResolvedValueOnce([{ rank_title: 'Độc Giả', badge_icon: null }]);

      const res = await service.getProgression('user-time');
      expect(res.serverDateVN).toBeDefined();
      expect(res.serverNow).toBeDefined();
      expect(res.nextCheckinAt).toBeDefined();
      expect(res.secondsUntilNextCheckin).toBeGreaterThanOrEqual(0);
      expect(typeof res.secondsUntilNextCheckin).toBe('number');
    });
  });
});
