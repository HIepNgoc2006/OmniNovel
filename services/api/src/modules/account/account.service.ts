import {
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { User } from '../users/entities/user.entity';
import { UserProgression } from '../users/entities/user-progression.entity';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserProgression)
    private progressionRepository: Repository<UserProgression>,
    private authService: AuthService,
    private dataSource: DataSource,
  ) {}

  /**
   * Pha 1 — Day 0 Soft Delete (DELETE /api/v1/account):
   * - Xác thực mật khẩu hiện tại bằng Argon2id.
   * - Đánh dấu is_active = false, is_deleted = true, deleted_at = NOW(), scheduled_purge_at = NOW() + 30 days.
   * - Thu hồi TOÀN BỘ phiên đăng nhập trên Redis (revokeAllUserSessions).
   * - BẢO TỒN NGUYÊN VẸN ATTRIBUTIONS & TIẾN ĐỘ (Zero Irreversible Mutations tại Day 0).
   */
  async deleteAccount(userId: string, dto: DeleteAccountDto) {
    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true, isDeleted: false },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị khóa.');
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Mật khẩu không chính xác.');
    }

    const scheduledPurgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 ngày

    user.isActive = false;
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.scheduledPurgeAt = scheduledPurgeAt;
    await this.userRepository.save(user);

    // Thu hồi toàn bộ session token trên Redis
    await this.authService.revokeAllUserSessions(userId);

    this.logger.log(
      `Account ${userId} scheduled for purge at ${scheduledPurgeAt.toISOString()} (Day 0 Soft Delete completed).`,
    );

    return {
      success: true,
      message:
        'Tài khoản của bạn đã được đưa vào trạng thái chờ xóa. Bạn có 30 ngày để khôi phục trước khi bị xóa vĩnh viễn.',
      scheduledPurgeAt,
    };
  }

  /**
   * Xuất toàn bộ dữ liệu người dùng (GDPR / Data Portability compliant)
   */
  async exportUserData(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản không tồn tại.');
    }

    const progression = await this.progressionRepository.findOne({
      where: { userId },
    });

    const [
      bookmarks,
      readingProgress,
      chapterReadStates,
      claims,
      rewardTransactions,
      stories,
    ] = await Promise.all([
      this.dataSource.query(
        'SELECT story_id, created_at FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      ),
      this.dataSource.query(
        'SELECT story_id, chapter_id, reading_mode, page_index, scroll_position, progress_percentage, updated_at FROM reading_progress WHERE user_id = $1',
        [userId],
      ),
      this.dataSource.query(
        'SELECT chapter_id, max_progress_percentage, completed_at, last_read_at FROM chapter_read_states WHERE user_id = $1',
        [userId],
      ),
      this.dataSource.query(
        'SELECT claim_id, guest_profile_id, status, created_at, committed_at, result_summary FROM guest_claims WHERE user_id = $1',
        [userId],
      ),
      this.dataSource.query(
        'SELECT id, reward_type, amount, balance_after, source_type, created_at FROM reward_transactions WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      ),
      this.dataSource.query(
        'SELECT id, title, slug, status, created_at FROM stories WHERE created_by = $1',
        [userId],
      ),
    ]);

    return {
      exportDate: new Date().toISOString(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
      progression,
      bookmarks,
      readingProgress,
      chapterReadStates,
      claims,
      rewardTransactions,
      stories,
    };
  }
}
