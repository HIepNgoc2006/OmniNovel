import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AccountService } from '../account.service';
import { AccountPurgeService } from '../account-purge.service';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../users/entities/user.entity';
import { UserProgression } from '../../users/entities/user-progression.entity';
import { UnauthorizedException } from '@nestjs/common';

describe('AccountService & AccountPurgeService - Two-Phase Deletion & Lifecycle (Task 7B.2)', () => {
  let accountService: AccountService;
  let purgeService: AccountPurgeService;
  let userRepo: any;
  let progressionRepo: any;
  let authService: any;
  let dataSource: any;

  const mockUser: Partial<User> = {
    id: 'user-purge-test-1',
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
    mockUser.passwordHash = await argon2.hash('CorrectPassword123!', {
      type: argon2.argon2id,
    });
  });

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve({ ...u })),
    };

    progressionRepo = {
      findOne: jest.fn().mockResolvedValue({ userId: 'user-purge-test-1', level: 5, totalExp: '1000' }),
    };

    authService = {
      revokeAllUserSessions: jest.fn().mockResolvedValue({ success: true }),
    };

    dataSource = {
      query: jest.fn(),
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        AccountPurgeService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserProgression), useValue: progressionRepo },
        { provide: AuthService, useValue: authService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    accountService = module.get<AccountService>(AccountService);
    purgeService = module.get<AccountPurgeService>(AccountPurgeService);
  });

  describe('1. Day 0 Soft Delete (DELETE /api/v1/account)', () => {
    it('should reject incorrect password with UnauthorizedException', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        accountService.deleteAccount('user-purge-test-1', { currentPassword: 'WrongPassword!' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(userRepo.save).not.toHaveBeenCalled();
      expect(authService.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('should soft-delete user, set 30-day scheduledPurgeAt, and revoke all sessions', async () => {
      const activeUser = { ...mockUser };
      userRepo.findOne.mockResolvedValue(activeUser);

      const res = await accountService.deleteAccount('user-purge-test-1', {
        currentPassword: 'CorrectPassword123!',
      });

      expect(res.success).toBe(true);
      expect(res.scheduledPurgeAt).toBeDefined();

      // Verify user flags
      expect(activeUser.isActive).toBe(false);
      expect(activeUser.isDeleted).toBe(true);
      expect(activeUser.deletedAt).toBeInstanceOf(Date);
      expect(activeUser.scheduledPurgeAt).toBeInstanceOf(Date);

      // Verify scheduledPurgeAt is ~30 days in the future
      const diffDays =
        (activeUser.scheduledPurgeAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(Math.round(diffDays)).toBe(30);

      expect(userRepo.save).toHaveBeenCalledWith(activeUser);
      expect(authService.revokeAllUserSessions).toHaveBeenCalledWith('user-purge-test-1');
    });
  });

  describe('2. Export User Data (GDPR Compliant Portability)', () => {
    it('should gather all user profile, progress, bookmarks, claims, and transactions', async () => {
      userRepo.findOne.mockResolvedValue({ ...mockUser });
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('bookmarks')) return [{ story_id: 'story-1', created_at: new Date() }];
        if (sql.includes('reading_progress')) return [{ story_id: 'story-1', page_index: 5 }];
        if (sql.includes('chapter_read_states')) return [{ chapter_id: 'chap-1', max_progress_percentage: 100 }];
        if (sql.includes('guest_claims')) return [{ claim_id: 'claim-1', status: 'COMMITTED' }];
        if (sql.includes('reward_transactions')) return [{ id: 'tx-1', amount: 50 }];
        if (sql.includes('stories')) return [{ id: 'story-1', title: 'My Story' }];
        if (sql.includes('translation_projects')) return [{ id: 'proj-1', target_language: 'vi' }];
        if (sql.includes('translation_jobs')) return [{ id: 'job-1', status: 'READY_FOR_REVIEW' }];
        if (sql.includes('chapter_versions')) return [{ id: 'ver-1', version_number: 1 }];
        if (sql.includes('story_members')) return [{ id: 'mem-1', role: 'TRANSLATOR' }];
        return [];
      });

      const exportData = await accountService.exportUserData('user-purge-test-1');

      expect(exportData.user.id).toBe('user-purge-test-1');
      expect(exportData.bookmarks.length).toBe(1);
      expect(exportData.readingProgress.length).toBe(1);
      expect(exportData.claims.length).toBe(1);
      expect(exportData.rewardTransactions.length).toBe(1);
      expect(exportData.translations.projects.length).toBe(1);
      expect(exportData.translations.jobs.length).toBe(1);
      expect(exportData.translations.versions.length).toBe(1);
      expect(exportData.translations.memberships.length).toBe(1);
    });
  });

  describe('3. Day 30 Final Purge Background Job (Node SHA-256 & Durable Ledgers Anonymization)', () => {
    it('should do nothing if no accounts are due for purge', async () => {
      dataSource.query.mockResolvedValueOnce([]); // no due users

      const result = await purgeService.purgeDueAccounts();
      expect(result.purgedCount).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should anonymize guest_claims, reward_transactions and hard-delete users row for due accounts', async () => {
      const dueUserId = 'user-due-for-purge-123';
      dataSource.query.mockResolvedValueOnce([{ id: dueUserId }]);

      const mockQueries: string[] = [];
      const mockParams: any[] = [];

      dataSource.transaction.mockImplementation(async (cb: any) => {
        const mockManager = {
          query: jest.fn().mockImplementation(async (sql: string, params: any[]) => {
            mockQueries.push(sql);
            mockParams.push(params);
            return [];
          }),
        };
        return cb(mockManager);
      });

      const result = await purgeService.purgeDueAccounts();

      expect(result.purgedCount).toBe(1);
      expect(result.purgedUserIds).toEqual([dueUserId]);

      // Calculate expected Node.js SHA-256 hash
      const expectedHash = crypto.createHash('sha256').update(dueUserId).digest('hex');

      // Verify guest_claims update query
      expect(mockQueries[0]).toContain('UPDATE guest_claims');
      expect(mockParams[0]).toEqual([expectedHash, dueUserId]);

      // Verify reward_transactions update query
      expect(mockQueries[1]).toContain('UPDATE reward_transactions');
      expect(mockParams[1]).toEqual([expectedHash, dueUserId]);

      // Verify hard-delete from users
      expect(mockQueries[2]).toContain('DELETE FROM users WHERE id = $1');
      expect(mockParams[2]).toEqual([dueUserId]);

      // Verify sessions revoked
      expect(authService.revokeAllUserSessions).toHaveBeenCalledWith(dueUserId);
    });
  });
});
