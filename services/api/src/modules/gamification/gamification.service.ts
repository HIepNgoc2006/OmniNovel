import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UserProgression } from '../users/entities/user-progression.entity';
import { RankTheme } from '../users/entities/rank-theme.entity';
import { RankLevel } from '../users/entities/rank-level.entity';
import { Chapter } from '../chapters/entities/chapter.entity';
import {
  RewardTransaction,
  RewardType,
  RewardSourceType,
} from './entities/reward-transaction.entity';
import { DailyCheckin } from './entities/daily-checkin.entity';
import { LevelReward } from './entities/level-reward.entity';
import { UserClaimedLevelReward } from './entities/user-claimed-level-reward.entity';
import { RedisService } from '../../redis/redis.service';
import { ReadChapterRewardDto } from './dto/read-chapter-reward.dto';

// 1. TÍNH BẢNG NGƯỠNG CẤP ĐỘ CANONICAL (SSoT): TotalEXP_required(L) = Σ(i=1..L-1) floor(100 * i^1.5)
const LEVEL_THRESHOLDS: number[] = new Array(101).fill(0);
LEVEL_THRESHOLDS[1] = 0;
for (let l = 2; l <= 100; l++) {
  let sum = 0;
  for (let i = 1; i <= l - 1; i++) {
    sum += Math.floor(100 * Math.pow(i, 1.5));
  }
  LEVEL_THRESHOLDS[l] = sum;
}

@Injectable()
export class GamificationService {
  constructor(
    @InjectRepository(UserProgression)
    private progressionRepository: Repository<UserProgression>,
    @InjectRepository(RewardTransaction)
    private transactionRepository: Repository<RewardTransaction>,
    @InjectRepository(DailyCheckin)
    private checkinRepository: Repository<DailyCheckin>,
    @InjectRepository(RankTheme)
    private themeRepository: Repository<RankTheme>,
    @InjectRepository(RankLevel)
    private levelRepository: Repository<RankLevel>,
    @InjectRepository(LevelReward)
    private levelRewardRepository: Repository<LevelReward>,
    @InjectRepository(Chapter)
    private chapterRepository: Repository<Chapter>,
    private redisService: RedisService,
    private dataSource: DataSource,
  ) {}

  // 1. CÔNG THỨC LEVEL CANONICAL SSoT
  calculateLevel(totalExp: number | string): number {
    const exp = Math.max(0, Number(totalExp) || 0);
    for (let l = 100; l >= 1; l--) {
      if (exp >= LEVEL_THRESHOLDS[l]) {
        return l;
      }
    }
    return 1;
  }

  getExpProgress(totalExp: number | string) {
    const exp = Math.max(0, Number(totalExp) || 0);
    const level = this.calculateLevel(exp);
    const currentLevelBaseExp = LEVEL_THRESHOLDS[level];
    const nextLevelBaseExp = level < 100 ? LEVEL_THRESHOLDS[level + 1] : currentLevelBaseExp;
    const currentLevelExp = exp - currentLevelBaseExp;
    const nextLevelExp = nextLevelBaseExp - currentLevelBaseExp;
    const progressPercent =
      level >= 100
        ? 100
        : Math.min(100, Math.round((currentLevelExp / Math.max(1, nextLevelExp)) * 100));

    return {
      level,
      totalExp: exp.toString(),
      currentLevelExp,
      nextLevelExp,
      currentLevelBaseExp,
      nextLevelBaseExp,
      progressPercent,
    };
  }

  // 2. ĐIỂM DANH HÀNG NGÀY THEO MÚI GIỜ ASIA/HO_CHI_MINH (UTC+7)
  async checkIn(userId: string, idempotencyKeyHeader?: string) {
    const todayVN = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayVN = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(yesterdayDate);

    // Redis SETNX để chống concurrent requests từ client
    const redisLockKey = `idempotency:checkin:${userId}:${idempotencyKeyHeader || todayVN}`;
    const acquired = await this.redisService.setnx(redisLockKey, '1', 60);
    if (!acquired && idempotencyKeyHeader) {
      throw new BadRequestException('Yêu cầu điểm danh trùng lặp đang được xử lý.');
    }

    return this.dataSource.transaction(async (manager) => {
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình độc giả.');
      }

      // Kiểm tra đã điểm danh hôm nay chưa
      const existingCheckin = await manager.findOne(DailyCheckin, {
        where: { userId, checkinDate: todayVN },
      });

      if (existingCheckin) {
        return {
          alreadyCheckedIn: true,
          message: 'Bạn đã điểm danh ngày hôm nay rồi.',
          coinsEarned: 0,
          expEarned: 0,
          newStreak: progression.currentStreak,
          totalExp: progression.totalExp,
          omnicoinBalance: progression.omnicoinBalance,
          level: progression.level,
        };
      }

      // Tính Chuỗi Streak
      let streak = 1;
      if (progression.lastCheckinDate === yesterdayVN) {
        streak = progression.currentStreak + 1;
      }
      const maxStreak = Math.max(progression.maxStreak, streak);

      // Tính Thưởng Chuỗi theo SSoT:
      // Base: +10 EXP, +5 Coin
      // 7 ngày: +50 EXP, +20 Coin
      // 14 ngày: +100 EXP, +50 Coin
      // 30 ngày: +300 EXP, +150 Coin
      let rewardExp = 10;
      let rewardCoins = 5;

      if (streak === 30 || (streak > 30 && streak % 30 === 0)) {
        rewardExp += 300;
        rewardCoins += 150;
      } else if (streak === 14 || (streak > 14 && streak % 14 === 0)) {
        rewardExp += 100;
        rewardCoins += 50;
      } else if (streak === 7 || (streak > 7 && streak % 7 === 0)) {
        rewardExp += 50;
        rewardCoins += 20;
      }

      // 1. Lưu bản ghi điểm danh
      const checkinRecord = manager.create(DailyCheckin, {
        userId,
        checkinDate: todayVN,
        streakCount: streak,
        rewardCoins,
        rewardExp,
      });
      await manager.save(checkinRecord);

      // 2. Ghi Sổ Cái Bất Biến - EXP
      const newTotalExp = (BigInt(progression.totalExp) + BigInt(rewardExp)).toString();
      const expTx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.EXP,
        amount: rewardExp,
        balanceAfter: newTotalExp,
        sourceType: RewardSourceType.CHECKIN,
        sourceId: todayVN,
        idempotencyKey: `CHECKIN:${userId}:${todayVN}:EXP`,
      });
      await manager.save(expTx);

      // 3. Ghi Sổ Cái Bất Biến - OMNICOIN
      const newBalance = (BigInt(progression.omnicoinBalance) + BigInt(rewardCoins)).toString();
      const coinTx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.OMNICOIN,
        amount: rewardCoins,
        balanceAfter: newBalance,
        sourceType: RewardSourceType.CHECKIN,
        sourceId: todayVN,
        idempotencyKey: `CHECKIN:${userId}:${todayVN}:OMNICOIN`,
      });
      await manager.save(coinTx);

      // 4. Cập nhật UserProgression
      progression.totalExp = newTotalExp;
      progression.omnicoinBalance = newBalance;
      progression.currentStreak = streak;
      progression.maxStreak = maxStreak;
      progression.lastCheckinDate = todayVN;
      progression.level = this.calculateLevel(newTotalExp);
      await manager.save(progression);

      return {
        alreadyCheckedIn: false,
        message: `Điểm danh thành công! Chuỗi ${streak} ngày.`,
        coinsEarned: rewardCoins,
        expEarned: rewardExp,
        newStreak: streak,
        maxStreak,
        totalExp: newTotalExp,
        omnicoinBalance: newBalance,
        level: progression.level,
      };
    });
  }

  // 3. THƯỞNG ĐỌC CHƯƠNG TRUYỆN: +5 EXP, KIỂM TRA CHAPTER THỰC TẾ, ĐIỀU KIỆN >=45s & >=80%, TRẦN 100 EXP/NGÀY
  async rewardReadChapter(userId: string, dto: ReadChapterRewardDto) {
    // 1. Xác thực Chương Truyện có thực sự tồn tại trong DB (Chống Fake Chapter Farming)
    const chapter = await this.chapterRepository.findOne({
      where: { id: dto.chapterId },
    });

    if (!chapter) {
      throw new NotFoundException('Chương truyện không tồn tại.');
    }

    // 2. Xác thực điều kiện đọc hợp lệ (Thời gian đọc >= 45s và cuộn >= 80%)
    if (dto.readingDurationSeconds < 45 || dto.progressPercentage < 80) {
      return {
        success: false,
        earnedExp: 0,
        reason: 'CRITERIA_NOT_MET',
        message:
          'Chưa đạt điều kiện nhận thưởng (cần thời gian đọc tối thiểu 45 giây và cuộn qua ít nhất 80% nội dung).',
      };
    }

    return this.dataSource.transaction(async (manager) => {
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình độc giả.');
      }

      // 3. Kiểm tra Idempotency SSoT qua Sổ Cái (1 reward / user / chapter)
      const idempotencyKey = `READ:${userId}:${dto.chapterId}:EXP`;
      const existingTx = await manager.findOne(RewardTransaction, {
        where: { idempotencyKey },
      });

      if (existingTx) {
        return {
          success: true,
          earnedExp: 0,
          reason: 'ALREADY_REWARDED',
          message: 'Bạn đã nhận thưởng EXP cho chương này rồi.',
          totalExp: progression.totalExp,
          level: progression.level,
        };
      }

      // 4. Kiểm tra Trần Tối Đa 100 EXP/ngày từ việc đọc truyện
      const startOfDayVN = new Date();
      startOfDayVN.setUTCHours(0, 0, 0, 0);

      const sumRes = await manager.query(
        `SELECT COALESCE(SUM(amount), 0) AS total 
         FROM reward_transactions 
         WHERE user_id = $1 
           AND source_type = 'READ_CHAPTER' 
           AND created_at >= $2`,
        [userId, startOfDayVN.toISOString()],
      );

      const todayEarnedExp = Number(sumRes[0].total);
      if (todayEarnedExp >= 100) {
        return {
          success: true,
          earnedExp: 0,
          reason: 'DAILY_CAP_REACHED',
          message: 'Bạn đã đạt giới hạn tối đa 100 EXP đọc truyện trong ngày hôm nay.',
          totalExp: progression.totalExp,
          level: progression.level,
        };
      }

      // Thưởng +5 EXP theo đúng SSoT
      const expToAward = Math.min(5, 100 - todayEarnedExp);
      const newTotalExp = (BigInt(progression.totalExp) + BigInt(expToAward)).toString();

      // 5. Ghi Sổ Cái Bất Biến
      const tx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.EXP,
        amount: expToAward,
        balanceAfter: newTotalExp,
        sourceType: RewardSourceType.READ_CHAPTER,
        sourceId: dto.chapterId,
        idempotencyKey,
      });
      await manager.save(tx);

      // 6. Cập nhật UserProgression
      progression.totalExp = newTotalExp;
      progression.level = this.calculateLevel(newTotalExp);
      await manager.save(progression);

      return {
        success: true,
        earnedExp: expToAward,
        todayTotalReadExp: todayEarnedExp + expToAward,
        dailyCap: 100,
        totalExp: newTotalExp,
        level: progression.level,
      };
    });
  }

  // 4. LẤY CHI TIẾT TIẾN TRÌNH & DANH HIỆU
  async getProgression(userId: string) {
    const progression = await this.progressionRepository.findOne({
      where: { userId },
      relations: { rankTheme: true },
    });

    if (!progression) {
      throw new NotFoundException('Không tìm thấy hồ sơ tiến trình.');
    }

    const themeId = progression.rankThemeId || 'DEFAULT';
    const matchingRank = await this.dataSource.query(
      `SELECT rank_title, badge_icon 
       FROM rank_levels 
       WHERE theme_id = $1 AND min_level <= $2 AND max_level >= $2 
       LIMIT 1`,
      [themeId, progression.level],
    );

    const rankTitle = matchingRank[0]?.rank_title || 'Độc Giả';
    const badgeIcon = matchingRank[0]?.badge_icon || null;

    const progress = this.getExpProgress(progression.totalExp);
    const todayVN = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    return {
      userId: progression.userId,
      level: progression.level,
      totalExp: progression.totalExp,
      currentLevelExp: progress.currentLevelExp,
      nextLevelExp: progress.nextLevelExp,
      omnicoinBalance: progression.omnicoinBalance,
      currentStreak: progression.currentStreak,
      streak: progression.currentStreak,
      maxStreak: progression.maxStreak,
      lastCheckinDate: progression.lastCheckinDate,
      hasCheckedInToday: progression.lastCheckinDate === todayVN,
      rankTitle,
      activeTheme: {
        id: progression.rankTheme?.id || 'DEFAULT',
        name: progression.rankTheme?.name || 'Mặc Định',
        rankTitle,
        badgeIcon,
      },
      progress,
    };
  }

  // 5. THAY ĐỔI CHỦ ĐỀ CẤP BẬC (PATCH /gamification/rank-theme)
  async changeRankTheme(userId: string, themeId: string) {
    const theme = await this.themeRepository.findOne({
      where: { id: themeId, isActive: true },
    });

    if (!theme) {
      throw new NotFoundException('Chủ đề cấp bậc không tồn tại hoặc chưa kích hoạt.');
    }

    const progression = await this.progressionRepository.findOne({
      where: { userId },
    });

    if (!progression) {
      throw new NotFoundException('Không tìm thấy hồ sơ tiến trình.');
    }

    progression.rankThemeId = themeId;
    await this.progressionRepository.save(progression);

    const matchingRank = await this.dataSource.query(
      `SELECT rank_title, badge_icon 
       FROM rank_levels 
       WHERE theme_id = $1 AND min_level <= $2 AND max_level >= $2 
       LIMIT 1`,
      [themeId, progression.level],
    );

    const rankTitle = matchingRank[0]?.rank_title || 'Độc Giả';
    const badgeIcon = matchingRank[0]?.badge_icon || null;

    return {
      activeTheme: {
        id: theme.id,
        name: theme.name,
        rankTitle,
        badgeIcon,
      },
      rankTitle,
    };
  }

  // 6. NHẬN THƯỞNG MỐC LEVEL ĐÃ CẤU HÌNH (POST /gamification/rewards/claim)
  async claimLevelReward(userId: string, milestoneLevel: number, idempotencyKeyHeader?: string) {
    const redisLockKey = `idempotency:claim:${userId}:${idempotencyKeyHeader || milestoneLevel}`;
    const acquired = await this.redisService.setnx(redisLockKey, '1', 60);
    if (!acquired && idempotencyKeyHeader) {
      throw new BadRequestException('Yêu cầu nhận thưởng trùng lặp đang được xử lý.');
    }

    return this.dataSource.transaction(async (manager) => {
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình.');
      }

      // CHỈ CLAIM PHẦN THƯỞNG ĐÃ CẤU HÌNH TRONG level_rewards (Không tự động phát sinh)
      const reward = await manager.findOne(LevelReward, {
        where: { milestoneLevel },
      });

      if (!reward) {
        throw new NotFoundException('Không có phần thưởng nào được cấu hình cho mốc cấp độ này.');
      }

      if (progression.level < milestoneLevel) {
        throw new BadRequestException(
          `Bạn cần đạt cấp độ ${milestoneLevel} để nhận phần thưởng này (Cấp hiện tại: ${progression.level}).`,
        );
      }

      const alreadyClaimed = await manager.findOne(UserClaimedLevelReward, {
        where: { userId, rewardId: reward.id },
      });

      if (alreadyClaimed) {
        throw new BadRequestException('Bạn đã nhận phần thưởng mốc cấp độ này rồi.');
      }

      // 1. Ghi nhận claim
      const claim = manager.create(UserClaimedLevelReward, {
        userId,
        rewardId: reward.id,
      });
      await manager.save(claim);

      // 2. Ghi Sổ Cái Bất Biến
      const newBalance = (BigInt(progression.omnicoinBalance) + BigInt(reward.rewardCoins)).toString();
      const tx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.OMNICOIN,
        amount: reward.rewardCoins,
        balanceAfter: newBalance,
        sourceType: RewardSourceType.LEVEL_REWARD,
        sourceId: milestoneLevel.toString(),
        idempotencyKey: `LEVEL_REWARD:${userId}:${milestoneLevel}:OMNICOIN`,
      });
      await manager.save(tx);

      // 3. Cập nhật UserProgression
      progression.omnicoinBalance = newBalance;
      await manager.save(progression);

      return {
        rewardCoins: reward.rewardCoins,
        claimedAt: claim.claimedAt,
      };
    });
  }

  // 7. TRUY VẤN LỊCH SỬ SỔ CÁI (GET /gamification/transactions)
  async getTransactions(
    userId: string,
    page = 1,
    limit = 20,
    rewardType?: RewardType,
  ) {
    const take = Math.min(50, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const whereClause: any = { userId };
    if (rewardType) {
      whereClause.rewardType = rewardType;
    }

    const [transactions, total] = await this.transactionRepository.findAndCount({
      where: whereClause,
      order: { createdAt: 'DESC' },
      take,
      skip,
    });

    return {
      transactions,
      pagination: {
        total,
        page,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  // 8. BẢNG XẾP HẠNG LEVEL TOP ĐỘC GIẢ
  async getLeaderboard(limit = 20) {
    const take = Math.min(100, Math.max(1, limit));
    const topUsers = await this.dataSource.query(
      `SELECT 
         p.user_id AS "userId",
         u.username,
         u.avatar_url AS "avatarUrl",
         p.level,
         p.total_exp AS "totalExp",
         p.current_streak AS "currentStreak",
         p.rank_theme_id AS "rankThemeId",
         COALESCE(rl.rank_title, 'Độc Giả') AS "rankTitle"
       FROM user_progression p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN rank_levels rl ON rl.theme_id = p.rank_theme_id 
         AND rl.min_level <= p.level 
         AND rl.max_level >= p.level
       WHERE u.is_active = TRUE AND u.is_deleted = FALSE
       ORDER BY p.total_exp DESC, p.level DESC
       LIMIT $1`,
      [take],
    );

    return {
      leaderboard: topUsers.map((u: any, index: number) => ({
        rank: index + 1,
        ...u,
      })),
    };
  }
}
