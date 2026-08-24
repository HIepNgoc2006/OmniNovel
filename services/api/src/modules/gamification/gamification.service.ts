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
import {
  RewardTransaction,
  RewardType,
  RewardSourceType,
} from './entities/reward-transaction.entity';
import { DailyCheckin } from './entities/daily-checkin.entity';
import { LevelReward } from './entities/level-reward.entity';
import { UserClaimedLevelReward } from './entities/user-claimed-level-reward.entity';
import { RedisService } from '../../redis/redis.service';

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
    private redisService: RedisService,
    private dataSource: DataSource,
  ) {}

  // 1. CÔNG THỨC LEVEL SSoT: Level L yêu cầu 100 * (L - 1)^2 Total EXP
  calculateLevel(totalExp: number | string): number {
    const exp = Math.max(0, Number(totalExp) || 0);
    const lvl = Math.floor(Math.sqrt(exp / 100)) + 1;
    return Math.min(100, Math.max(1, lvl));
  }

  getExpForLevel(level: number): number {
    const lvl = Math.min(100, Math.max(1, level));
    return 100 * Math.pow(lvl - 1, 2);
  }

  getExpProgress(totalExp: number | string) {
    const exp = Math.max(0, Number(totalExp) || 0);
    const level = this.calculateLevel(exp);
    const currentLevelBaseExp = this.getExpForLevel(level);
    const nextLevelBaseExp = level < 100 ? this.getExpForLevel(level + 1) : currentLevelBaseExp;
    const expInCurrentLevel = exp - currentLevelBaseExp;
    const expNeededForNextLevel = nextLevelBaseExp - currentLevelBaseExp;
    const progressPercent =
      level >= 100
        ? 100
        : Math.min(100, Math.round((expInCurrentLevel / Math.max(1, expNeededForNextLevel)) * 100));

    return {
      level,
      totalExp: exp.toString(),
      currentLevelBaseExp,
      nextLevelBaseExp,
      expInCurrentLevel,
      expNeededForNextLevel,
      progressPercent,
    };
  }

  // 2. ĐIỂM DANH HÀNG NGÀY (DAILY CHECK-IN)
  async checkIn(userId: string) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD (UTC)

    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

    return this.dataSource.transaction(async (manager) => {
      // Khóa bi quan (pessimistic_write) UserProgression để chống race condition
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình độc giả.');
      }

      // Kiểm tra đã điểm danh hôm nay chưa
      const existingCheckin = await manager.findOne(DailyCheckin, {
        where: { userId, checkinDate: todayStr },
      });

      if (existingCheckin) {
        return {
          alreadyCheckedIn: true,
          message: 'Bạn đã điểm danh ngày hôm nay rồi.',
          checkinDate: todayStr,
          currentStreak: progression.currentStreak,
          maxStreak: progression.maxStreak,
          totalExp: progression.totalExp,
          omnicoinBalance: progression.omnicoinBalance,
          level: progression.level,
        };
      }

      // Tính Streak
      let streak = 1;
      if (progression.lastCheckinDate === yesterdayStr) {
        streak = progression.currentStreak + 1;
      }
      const maxStreak = Math.max(progression.maxStreak, streak);

      // Tính Phần Thưởng
      let rewardExp = 10;
      let rewardCoins = 5;

      // Bonus mốc chuỗi điểm danh
      if (streak % 30 === 0) {
        rewardExp += 100;
        rewardCoins += 50;
      } else if (streak % 7 === 0) {
        rewardExp += 30;
        rewardCoins += 15;
      }

      // 1. Ghi nhận lịch điểm danh
      const checkinRecord = manager.create(DailyCheckin, {
        userId,
        checkinDate: todayStr,
        streakCount: streak,
        rewardCoins,
        rewardExp,
      });
      await manager.save(checkinRecord);

      // 2. Ghi nhận Sổ Cái Bất Biến (Reward Transactions) - EXP
      const newTotalExp = (BigInt(progression.totalExp) + BigInt(rewardExp)).toString();
      const expTx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.EXP,
        amount: rewardExp,
        balanceAfter: newTotalExp,
        sourceType: RewardSourceType.CHECKIN,
        sourceId: todayStr,
        idempotencyKey: `CHECKIN:${userId}:${todayStr}:EXP`,
      });
      await manager.save(expTx);

      // 3. Ghi nhận Sổ Cái Bất Biến (Reward Transactions) - OMNICOIN
      const newBalance = (BigInt(progression.omnicoinBalance) + BigInt(rewardCoins)).toString();
      const coinTx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.OMNICOIN,
        amount: rewardCoins,
        balanceAfter: newBalance,
        sourceType: RewardSourceType.CHECKIN,
        sourceId: todayStr,
        idempotencyKey: `CHECKIN:${userId}:${todayStr}:OMNICOIN`,
      });
      await manager.save(coinTx);

      // 4. Cập nhật UserProgression
      progression.totalExp = newTotalExp;
      progression.omnicoinBalance = newBalance;
      progression.currentStreak = streak;
      progression.maxStreak = maxStreak;
      progression.lastCheckinDate = todayStr;
      progression.level = this.calculateLevel(newTotalExp);
      await manager.save(progression);

      return {
        alreadyCheckedIn: false,
        message: `Điểm danh thành công! Chuỗi ${streak} ngày.`,
        checkinDate: todayStr,
        streakCount: streak,
        maxStreak,
        rewardExp,
        rewardCoins,
        totalExp: newTotalExp,
        omnicoinBalance: newBalance,
        level: progression.level,
      };
    });
  }

  // 3. THƯỞNG ĐỌC CHƯƠNG (READ CHAPTER EXP) - 1 LẦN/CHƯƠNG & CAP 100 EXP/NGÀY
  async rewardReadChapter(userId: string, chapterId: string) {
    return this.dataSource.transaction(async (manager) => {
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình độc giả.');
      }

      // 1. Kiểm tra Idempotency SSoT qua Sổ Cái (1 reward / user / chapter)
      const idempotencyKey = `READ:${userId}:${chapterId}:EXP`;
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

      // 2. Kiểm tra Daily Cap 100 EXP/ngày từ việc đọc truyện
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const sumRes = await manager.query(
        `SELECT COALESCE(SUM(amount), 0) AS total 
         FROM reward_transactions 
         WHERE user_id = $1 
           AND source_type = 'READ_CHAPTER' 
           AND created_at >= $2`,
        [userId, startOfDay.toISOString()],
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

      const expToAward = Math.min(10, 100 - todayEarnedExp);
      const newTotalExp = (BigInt(progression.totalExp) + BigInt(expToAward)).toString();

      // 3. Ghi Sổ Cái Bất Biến
      const tx = manager.create(RewardTransaction, {
        userId,
        rewardType: RewardType.EXP,
        amount: expToAward,
        balanceAfter: newTotalExp,
        sourceType: RewardSourceType.READ_CHAPTER,
        sourceId: chapterId,
        idempotencyKey,
      });
      await manager.save(tx);

      // 4. Cập nhật UserProgression
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
    const rankLevel = await this.levelRepository.findOne({
      where: {
        themeId,
      },
      order: { minLevel: 'ASC' },
    });

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
    const todayStr = new Date().toISOString().split('T')[0];

    return {
      userId: progression.userId,
      level: progression.level,
      totalExp: progression.totalExp,
      omnicoinBalance: progression.omnicoinBalance,
      currentStreak: progression.currentStreak,
      maxStreak: progression.maxStreak,
      lastCheckinDate: progression.lastCheckinDate,
      hasCheckedInToday: progression.lastCheckinDate === todayStr,
      activeTheme: {
        id: progression.rankTheme?.id || 'DEFAULT',
        name: progression.rankTheme?.name || 'Mặc Định',
        rankTitle,
        badgeIcon,
      },
      progress,
    };
  }

  // 5. TRANG BỊ CHỦ ĐỀ CẤP BẬC (EQUIP THEME)
  async equipTheme(userId: string, themeId: string) {
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

    return this.getProgression(userId);
  }

  // 6. NHẬN PHẦN THƯỞNG MỐC LEVEL (LEVEL MILESTONE REWARD)
  async claimLevelReward(userId: string, milestoneLevel: number) {
    return this.dataSource.transaction(async (manager) => {
      const progression = await manager.findOne(UserProgression, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!progression) {
        throw new NotFoundException('Không tìm thấy hồ sơ tiến trình.');
      }

      if (progression.level < milestoneLevel) {
        throw new BadRequestException(
          `Bạn cần đạt cấp độ ${milestoneLevel} để nhận phần thưởng này (Cấp hiện tại: ${progression.level}).`,
        );
      }

      let reward = await manager.findOne(LevelReward, {
        where: { milestoneLevel },
      });

      // Nếu chưa có trong bảng, tạo mốc mặc định (vd: level 10: 100 coin, level 20: 200 coin)
      if (!reward) {
        reward = manager.create(LevelReward, {
          milestoneLevel,
          rewardCoins: milestoneLevel * 10,
        });
        reward = await manager.save(reward);
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
        success: true,
        milestoneLevel,
        rewardCoins: reward.rewardCoins,
        newBalance,
      };
    });
  }

  // 7. BẢNG XẾP HẠNG LEVEL TOP ĐỘC GIẢ
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

  // 8. LỊCH SỬ BIẾN ĐỘNG SỔ CÁI
  async getHistory(userId: string, page = 1, limit = 20) {
    const take = Math.min(50, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const [items, total] = await this.transactionRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      take,
      skip,
    });

    return {
      items,
      total,
      page,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }
}
