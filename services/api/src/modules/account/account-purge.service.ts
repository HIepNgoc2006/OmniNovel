import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger(AccountPurgeService.name);

  constructor(
    private dataSource: DataSource,
    private authService: AuthService,
  ) {}

  /**
   * Pha 2 — Day 30 Final Purge (Scheduled Background Job):
   * Quét và xử lý các tài khoản đã quá hạn scheduled_purge_at.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleScheduledPurge(): Promise<void> {
    this.logger.log('Executing scheduled account purge background worker...');
    const result = await this.purgeDueAccounts();
    this.logger.log(`Scheduled account purge finished. Purged ${result.purgedCount} accounts.`);
  }

  /**
   * Thực thi quy trình Hard Purge dứt khoát theo Quy chuẩn Hai Pha Xóa Tài Khoản:
   * 1. Node.js SHA-256 Hash userId
   * 2. Anonymize sổ cái bền vững: guest_claims & reward_transactions
   * 3. Hard-delete dòng users (Kích hoạt CASCADE & SET NULL của CSDL)
   * 4. Thu hồi sạch sẽ phiên Redis
   */
  async purgeDueAccounts(): Promise<{ purgedCount: number; purgedUserIds: string[] }> {
    const dueUsers: { id: string }[] = await this.dataSource.query(
      `SELECT id FROM users WHERE is_deleted = true AND scheduled_purge_at <= NOW()`,
    );

    if (!dueUsers || dueUsers.length === 0) {
      return { purgedCount: 0, purgedUserIds: [] };
    }

    const purgedUserIds: string[] = [];

    for (const user of dueUsers) {
      const userId = user.id;

      try {
        await this.dataSource.transaction(async (manager) => {
          // 1. Tính toán Node.js SHA-256 an toàn
          const anonymizedHash = crypto
            .createHash('sha256')
            .update(userId)
            .digest('hex');

          // 2. Anonymize Guest Claims Ledger
          await manager.query(
            `UPDATE guest_claims 
             SET anonymized_subject_hash = $1, user_id = NULL 
             WHERE user_id = $2`,
            [anonymizedHash, userId],
          );

          // 3. Anonymize Economic Reward Transactions Ledger
          await manager.query(
            `UPDATE reward_transactions 
             SET anonymized_subject_hash = $1, user_id = NULL 
             WHERE user_id = $2`,
            [anonymizedHash, userId],
          );

          // 4. Hard-delete dòng users
          await manager.query(`DELETE FROM users WHERE id = $1`, [userId]);
        });

        // 5. Dọn dẹp phiên trên Redis
        await this.authService.revokeAllUserSessions(userId);

        purgedUserIds.push(userId);
        this.logger.log(`Account ${userId} successfully purged and anonymized.`);
      } catch (err: any) {
        this.logger.error(`Failed to purge account ${userId}: ${err.message}`, err.stack);
      }
    }

    return {
      purgedCount: purgedUserIds.length,
      purgedUserIds,
    };
  }
}
