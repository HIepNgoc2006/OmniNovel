import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { GuestClaimService } from '../guest-claim.service';
import { GuestClaim, GuestClaimStatusEnum } from '../entities/guest-claim.entity';
import { RedisService } from '../../../redis/redis.service';
import {
  CanonicalReadingMode,
  PrepareGuestClaimDto,
} from '../dto/prepare-guest-claim.dto';
import {
  CommitGuestClaimDto,
  ConflictResolution,
} from '../dto/commit-guest-claim.dto';

describe('GuestClaimService (Task 7B.1 Backend Claim Engine)', () => {
  let service: GuestClaimService;
  let guestClaimRepoMock: any;
  let dataSourceMock: any;
  let queryRunnerMock: any;
  let redisServiceMock: any;

  const userId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const storyId1 = '33333333-3333-4333-8333-333333333333';
  const storyId2 = '44444444-4444-4444-8444-444444444444';
  const chapterId1 = '55555555-5555-4555-8555-555555555555';
  const chapterId2 = '66666666-6666-4666-8666-666666666666';

  beforeEach(async () => {
    queryRunnerMock = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: false,
      query: jest.fn(),
    };

    dataSourceMock = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunnerMock),
    };

    guestClaimRepoMock = {
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      findOne: jest.fn(),
    };

    redisServiceMock = {
      checkRateLimit: jest.fn().mockResolvedValue({
        allowed: true,
        currentRequests: 1,
        remainingRequests: 9,
        resetTime: Math.floor(Date.now() / 1000) + 60,
      }),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      setnx: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestClaimService,
        {
          provide: getRepositoryToken(GuestClaim),
          useValue: guestClaimRepoMock,
        },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: RedisService, useValue: redisServiceMock },
      ],
    }).compile();

    service = module.get<GuestClaimService>(GuestClaimService);
  });

  describe('prepareClaim', () => {
    const validDto: PrepareGuestClaimDto = {
      guestProfileId: '77777777-7777-4777-8777-777777777777',
      bookmarks: [{ storyId: storyId1 }],
      history: [
        {
          storyId: storyId1,
          chapterId: chapterId1,
          progressPercentage: 100,
        },
      ],
      progress: [
        {
          storyId: storyId1,
          chapterId: chapterId1,
          readingMode: CanonicalReadingMode.PAGED,
          pageIndex: 12,
          scrollPosition: 0,
          progressPercentage: 50,
        },
      ],
    };

    it('should throw 429 when rate limit exceeded', async () => {
      redisServiceMock.checkRateLimit.mockResolvedValueOnce({
        allowed: false,
        currentRequests: 11,
        remainingRequests: 0,
        resetTime: 123456,
      });

      await expect(service.prepareClaim(userId, validDto)).rejects.toThrow(
        new HttpException(
          'Too many claim requests. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    });

    it('should throw BadRequestException if referenced story does not exist', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return []; // Story not found
        }
        return [];
      });

      await expect(service.prepareClaim(userId, validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if referenced story is PRIVATE', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PRIVATE', status: 'ONGOING' }];
        }
        return [];
      });

      await expect(service.prepareClaim(userId, validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if chapter does not belong to story', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId2, has_published_version: true }]; // Mismatched storyId
        }
        return [];
      });

      await expect(service.prepareClaim(userId, validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if chapter is not published', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId1, has_published_version: false }]; // Not published
        }
        return [];
      });

      await expect(service.prepareClaim(userId, validDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if chapterVersionId is unpublished', async () => {
      const dtoWithVersion: PrepareGuestClaimDto = {
        ...validDto,
        progress: [
          {
            ...validDto.progress[0],
            chapterVersionId: 'version-unpublished',
          },
        ],
      };

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId1, has_published_version: true }];
        }
        if (sql.includes('FROM chapter_versions')) {
          return [
            {
              id: 'version-unpublished',
              chapter_id: chapterId1,
              story_id: storyId1,
              is_published: false, // Unpublished version!
            },
          ];
        }
        return [];
      });

      await expect(service.prepareClaim(userId, dtoWithVersion)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should compute diff, identify tombstones and detect PAGED progress conflict correctly', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId1, has_published_version: true }];
        }
        if (sql.includes('SELECT story_id FROM bookmarks')) {
          return [{ story_id: storyId1 }]; // Already bookmarked on cloud
        }
        if (sql.includes('SELECT story_id, epoch FROM reading_history_tombstones')) {
          return []; // No tombstones
        }
        if (sql.includes('SELECT chapter_id, max_progress_percentage FROM chapter_read_states')) {
          return [{ chapter_id: chapterId1, max_progress_percentage: 80 }];
        }
        if (sql.includes('SELECT story_id, chapter_id, reading_mode')) {
          return [
            {
              story_id: storyId1,
              chapter_id: chapterId1,
              reading_mode: 'PAGED',
              page_index: 5, // Cloud is page 5, Guest is page 12 -> CONFLICT
              scroll_position: 0,
              progress_percentage: 20,
              anchor_block_id: null,
              text_offset: 0,
              updated_at: new Date('2026-10-01T00:00:00Z'),
            },
          ];
        }
        return [];
      });

      const preview = await service.prepareClaim(userId, validDto);

      expect(preview.status).toBe('PREPARED');
      expect(preview.bookmarksToImport).toBe(0); // Already bookmarked
      expect(preview.historyToImport).toBe(1); // 100% > 80%
      expect(preview.conflictsCount).toBe(1);
      expect(preview.conflicts[0].storyId).toBe(storyId1);
      expect(preview.conflicts[0].cloudProgress.pageIndex).toBe(5);
      expect(preview.conflicts[0].guestProgress.pageIndex).toBe(12);
      expect(guestClaimRepoMock.save).toHaveBeenCalled();
    });

    it('should ignore guest history and progress when story has tombstone (Anti-Resurrection)', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId1, has_published_version: true }];
        }
        if (sql.includes('SELECT story_id FROM bookmarks')) {
          return [];
        }
        if (sql.includes('SELECT story_id, epoch FROM reading_history_tombstones')) {
          return [{ story_id: storyId1, epoch: 1 }]; // Tombstone exists!
        }
        if (sql.includes('SELECT chapter_id, max_progress_percentage FROM chapter_read_states')) {
          return [];
        }
        if (sql.includes('SELECT story_id, chapter_id, reading_mode')) {
          return [];
        }
        return [];
      });

      const preview = await service.prepareClaim(userId, validDto);

      expect(preview.readStatesIgnoredAntiResurrectionCount).toBe(2); // 1 history + 1 progress ignored
      expect(preview.historyToImport).toBe(0);
      expect(preview.progressToImport).toBe(0);
      expect(preview.conflictsCount).toBe(0);
    });

    it('should ignore guest history and progress when global sentinel tombstone exists (00000000-0000-0000-0000-000000000000) while still importing bookmarks', async () => {
      const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000';
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM stories')) {
          return [{ id: storyId1, visibility: 'PUBLIC', status: 'ONGOING' }];
        }
        if (sql.includes('FROM chapters')) {
          return [{ id: chapterId1, story_id: storyId1, has_published_version: true }];
        }
        if (sql.includes('SELECT story_id FROM bookmarks')) {
          return []; // Not bookmarked yet
        }
        if (sql.includes('SELECT story_id, epoch FROM reading_history_tombstones')) {
          // Global sentinel tombstone!
          return [{ story_id: GLOBAL_SENTINEL, epoch: 5 }];
        }
        if (sql.includes('SELECT chapter_id, max_progress_percentage FROM chapter_read_states')) {
          return [];
        }
        if (sql.includes('SELECT story_id, chapter_id, reading_mode')) {
          return [];
        }
        return [];
      });

      const preview = await service.prepareClaim(userId, validDto);

      // Bookmarks must NOT be ignored (bookmarks are additive)
      expect(preview.bookmarksToImport).toBe(1);
      // History and Progress must be ignored by global anti-resurrection sentinel
      expect(preview.readStatesIgnoredAntiResurrectionCount).toBe(2);
      expect(preview.historyToImport).toBe(0);
      expect(preview.progressToImport).toBe(0);
      expect(preview.conflictsCount).toBe(0);
    });
  });

  describe('commitClaim', () => {
    const claimId = '88888888-8888-4888-8888-888888888888';
    const mockFingerprint = 'mock_fingerprint_0123456789012345678901234567890123456789012345678901234567890123';

    it('should throw NotFoundException if claim does not exist', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [];
        }
        return [];
      });

      const commitDto: CommitGuestClaimDto = {
        expectedStateFingerprint: mockFingerprint,
      };

      await expect(
        service.commitClaim(userId, claimId, commitDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if claim belongs to another user', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId: otherUserId, // Different user
              status: GuestClaimStatusEnum.PREPARED,
            },
          ];
        }
        return [];
      });

      const commitDto: CommitGuestClaimDto = {
        expectedStateFingerprint: mockFingerprint,
      };

      await expect(
        service.commitClaim(userId, claimId, commitDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return saved result immediately if claim is already COMMITTED (Idempotency First)', async () => {
      const summary = {
        bookmarksImported: 2,
        historyMerged: 3,
        progressUpdated: 1,
        conflictsResolved: 0,
      };

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.COMMITTED,
              resultSummary: summary,
              committedAt: new Date('2026-10-07T12:00:00Z'),
            },
          ];
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: mockFingerprint,
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.summary).toEqual(summary);
      expect(queryRunnerMock.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw 410 GONE if claim has expired', async () => {
      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.PREPARED,
              expiresAt: new Date(Date.now() - 100000), // Expired
            },
          ];
        }
        return [];
      });

      await expect(
        service.commitClaim(userId, claimId, {
          expectedStateFingerprint: mockFingerprint,
        }),
      ).rejects.toThrow(
        new HttpException('Claim has expired', HttpStatus.GONE),
      );
    });

    it('should throw ConflictException (409) if cloud state fingerprint changed (TOCTOU)', async () => {
      const storedPayload: PrepareGuestClaimDto = {
        guestProfileId: '77777777-7777-4777-8777-777777777777',
        bookmarks: [{ storyId: storyId1 }],
        history: [],
        progress: [],
      };

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.PREPARED,
              expiresAt: new Date(Date.now() + 100000),
              stateFingerprint: 'original_fingerprint',
              previewData: {
                payload: storedPayload,
                conflicts: [],
              },
            },
          ];
        }
        if (sql.includes('SELECT story_id FROM bookmarks')) {
          // Cloud now has this bookmark added concurrently
          return [{ story_id: storyId1 }];
        }
        return [];
      });

      await expect(
        service.commitClaim(userId, claimId, {
          expectedStateFingerprint: 'original_fingerprint',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully merge bookmarks, history, and progress with conflict resolution', async () => {
      const storedPayload: PrepareGuestClaimDto = {
        guestProfileId: '77777777-7777-4777-8777-777777777777',
        bookmarks: [{ storyId: storyId1 }],
        history: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            progressPercentage: 100,
          },
        ],
        progress: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            readingMode: CanonicalReadingMode.PAGED,
            pageIndex: 10,
            scrollPosition: 0,
            progressPercentage: 50,
          },
        ],
      };

      // Mock calculate fingerprint deterministic match
      // For empty cloud state: bookmarks=[], tombstones=[], readStates=[], progress=[]
      const emptyStateFingerprint = (service as any).computeCloudFingerprint({
        bookmarks: [],
        tombstones: [],
        readStates: [],
        progress: [],
      });

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.PREPARED,
              expiresAt: new Date(Date.now() + 100000),
              stateFingerprint: emptyStateFingerprint,
              previewData: {
                payload: storedPayload,
                conflicts: [
                  {
                    storyId: storyId1,
                  },
                ],
              },
            },
          ];
        }
        if (sql.includes('INSERT INTO bookmarks')) {
          return [[], 1]; // 1 row inserted
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: emptyStateFingerprint,
        conflictDecisions: {
          [storyId1]: ConflictResolution.USE_GUEST,
        },
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.summary.bookmarksImported).toBe(1);
      expect(res.summary.historyMerged).toBe(1);
      expect(res.summary.progressUpdated).toBe(1);
      expect(res.summary.conflictsResolved).toBe(1);
      expect(queryRunnerMock.commitTransaction).toHaveBeenCalled();
    });

    it('should succeed when claim row is returned as raw PostgreSQL row with snake_case columns (P0-1 remediation)', async () => {
      const storedPayload: PrepareGuestClaimDto = {
        guestProfileId: '77777777-7777-4777-8777-777777777777',
        bookmarks: [{ storyId: storyId1 }],
        history: [],
        progress: [],
      };

      const emptyFingerprint = (service as any).computeCloudFingerprint({
        bookmarks: [],
        tombstones: [],
        readStates: [],
        progress: [],
      });

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          // Raw PostgreSQL row returns snake_case columns (claim.userId is undefined)!
          return [
            {
              claim_id: claimId,
              user_id: userId,
              status: GuestClaimStatusEnum.PREPARED,
              state_fingerprint: emptyFingerprint,
              preview_data: {
                payload: storedPayload,
                conflicts: [],
              },
              expires_at: new Date(Date.now() + 100000),
              created_at: new Date(),
            },
          ];
        }
        if (sql.includes('INSERT INTO bookmarks')) {
          return [[], 1];
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: emptyFingerprint,
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.claimId).toBe(claimId);
      expect(res.summary.bookmarksImported).toBe(1);
      expect(queryRunnerMock.commitTransaction).toHaveBeenCalled();
    });

    it('should ignore guest history and progress during commit when global sentinel tombstone exists while still importing bookmarks', async () => {
      const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000';
      const storedPayload: PrepareGuestClaimDto = {
        guestProfileId: '77777777-7777-4777-8777-777777777777',
        bookmarks: [{ storyId: storyId1 }],
        history: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            progressPercentage: 100,
          },
        ],
        progress: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            readingMode: CanonicalReadingMode.PAGED,
            pageIndex: 10,
            scrollPosition: 0,
            progressPercentage: 50,
          },
        ],
      };

      const emptyFingerprintWithGlobalTombstone = (service as any).computeCloudFingerprint({
        bookmarks: [],
        tombstones: [{ storyId: GLOBAL_SENTINEL, epoch: 5 }],
        readStates: [],
        progress: [],
      });

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.PREPARED,
              expiresAt: new Date(Date.now() + 100000),
              stateFingerprint: emptyFingerprintWithGlobalTombstone,
              previewData: {
                payload: storedPayload,
                conflicts: [],
              },
            },
          ];
        }
        if (sql.includes('SELECT story_id, epoch FROM reading_history_tombstones')) {
          return [{ story_id: GLOBAL_SENTINEL, epoch: 5 }];
        }
        if (sql.includes('INSERT INTO bookmarks')) {
          return [[], 1]; // Bookmark is inserted
        }
        if (sql.includes('SELECT story_id, chapter_id, chapter_version_id, reading_mode')) {
          return []; // post-merge reading_progress
        }
        if (sql.includes('FROM chapter_read_states crs')) {
          return []; // post-merge chapter_read_states
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: emptyFingerprintWithGlobalTombstone,
      });

      expect(res.status).toBe('COMMITTED');
      // Bookmarks imported = 1, but historyMerged = 0 and progressUpdated = 0 due to global sentinel
      expect(res.summary.bookmarksImported).toBe(1);
      expect(res.summary.historyMerged).toBe(0);
      expect(res.summary.progressUpdated).toBe(0);
      expect(res.finalization).toBeDefined();
      expect(res.finalization!.tombstonedStoryIds).toContain(storyId1);
    });

    it('should compute post-merge authoritative finalization snapshot with storyId, progress, chapter read states, and persist in finalization_data', async () => {
      const storedPayload: PrepareGuestClaimDto = {
        guestProfileId: '77777777-7777-4777-8777-777777777777',
        bookmarks: [{ storyId: storyId1 }],
        history: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            progressPercentage: 100,
          },
        ],
        progress: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            readingMode: CanonicalReadingMode.PAGED,
            pageIndex: 10,
            scrollPosition: 0,
            progressPercentage: 50,
          },
        ],
      };

      const emptyFingerprint = (service as any).computeCloudFingerprint({
        bookmarks: [],
        tombstones: [],
        readStates: [],
        progress: [],
      });

      let persistedFinalizationData: any = null;

      queryRunnerMock.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.PREPARED,
              expiresAt: new Date(Date.now() + 100000),
              stateFingerprint: emptyFingerprint,
              previewData: {
                payload: storedPayload,
                conflicts: [],
              },
            },
          ];
        }
        if (sql.includes('INSERT INTO bookmarks')) {
          return [[], 1];
        }
        if (sql.includes('UPDATE guest_claims')) {
          // SQL params should include finalization_data
          persistedFinalizationData = JSON.parse(params[2]);
          return [];
        }
        if (sql.includes('SELECT story_id, chapter_id, chapter_version_id, reading_mode')) {
          return [
            {
              story_id: storyId1,
              chapter_id: chapterId1,
              chapter_version_id: null,
              reading_mode: 'PAGED',
              page_index: 10,
              scroll_position: 0,
              progress_percentage: 50,
              anchor_block_id: null,
              text_offset: 0,
              updated_at: new Date('2026-10-14T10:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM chapter_read_states crs')) {
          return [
            {
              chapter_id: chapterId1,
              last_version_id: null,
              max_progress_percentage: 100,
              completed_at: new Date('2026-10-14T10:00:00Z'),
              last_read_at: new Date('2026-10-14T10:00:00Z'),
              story_id: storyId1,
            },
          ];
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: emptyFingerprint,
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.finalization).toBeDefined();
      expect(res.finalization!.finalizedProgress).toHaveLength(1);
      expect(res.finalization!.finalizedProgress[0].storyId).toBe(storyId1);
      expect(res.finalization!.finalizedProgress[0].pageIndex).toBe(10);
      expect(res.finalization!.finalizedChapterReadStates).toHaveLength(1);
      expect(res.finalization!.finalizedChapterReadStates[0].storyId).toBe(storyId1);
      expect(res.finalization!.finalizedChapterReadStates[0].chapterId).toBe(chapterId1);
      expect(res.finalization!.finalizedChapterReadStates[0].progressPercentage).toBe(100);

      expect(persistedFinalizationData).toBeDefined();
      expect(persistedFinalizationData.finalizedProgress[0].storyId).toBe(storyId1);
      expect(persistedFinalizationData.finalizedChapterReadStates[0].storyId).toBe(storyId1);
    });

    it('should return persisted finalization snapshot on commit retry (idempotent 200)', async () => {
      const summary = {
        bookmarksImported: 1,
        historyMerged: 1,
        progressUpdated: 1,
        conflictsResolved: 0,
      };
      const finalizationSnapshot = {
        tombstonedStoryIds: [],
        finalizedProgress: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            readingMode: 'PAGED',
            pageIndex: 10,
            scrollPosition: 0,
            progressPercentage: 50,
            updatedAt: '2026-10-14T10:00:00.000Z',
          },
        ],
        finalizedChapterReadStates: [
          {
            storyId: storyId1,
            chapterId: chapterId1,
            progressPercentage: 100,
            lastReadAt: '2026-10-14T10:00:00.000Z',
          },
        ],
      };

      queryRunnerMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM guest_claims WHERE claim_id')) {
          return [
            {
              claimId,
              userId,
              status: GuestClaimStatusEnum.COMMITTED,
              resultSummary: summary,
              finalizationData: finalizationSnapshot,
              committedAt: new Date('2026-10-07T12:00:00Z'),
            },
          ];
        }
        return [];
      });

      const res = await service.commitClaim(userId, claimId, {
        expectedStateFingerprint: mockFingerprint,
      });

      expect(res.status).toBe('COMMITTED');
      expect(res.summary).toEqual(summary);
      expect(res.finalization).toEqual(finalizationSnapshot);
      expect(queryRunnerMock.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('getClaimStatus', () => {
    const claimId = '99999999-9999-4999-8999-999999999999';

    it('should throw NotFoundException if claim not found', async () => {
      guestClaimRepoMock.findOne.mockResolvedValueOnce(null);
      await expect(service.getClaimStatus(userId, claimId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if userId does not match', async () => {
      guestClaimRepoMock.findOne.mockResolvedValueOnce({
        claimId,
        userId: otherUserId,
      });
      await expect(service.getClaimStatus(userId, claimId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should return sanitized status response without raw payload', async () => {
      guestClaimRepoMock.findOne.mockResolvedValueOnce({
        claimId,
        userId,
        status: GuestClaimStatusEnum.COMMITTED,
        stateFingerprint: 'mock_fingerprint',
        createdAt: new Date('2026-10-07T10:00:00Z'),
        expiresAt: new Date('2026-10-07T10:15:00Z'),
        committedAt: new Date('2026-10-07T10:05:00Z'),
        previewData: {
          bookmarksToImport: 1,
          payload: { secret: 'raw_data' },
        },
        resultSummary: { bookmarksImported: 1 },
      });

      const res = await service.getClaimStatus(userId, claimId);
      expect(res.status).toBe(GuestClaimStatusEnum.COMMITTED);
      expect(res.previewData.bookmarksToImport).toBe(1);
      expect((res.previewData as any).payload).toBeUndefined();
    });

    it('should return finalization snapshot for COMMITTED claim', async () => {
      const finalizationSnapshot = {
        tombstonedStoryIds: [storyId1],
        finalizedProgress: [],
        finalizedChapterReadStates: [],
      };

      guestClaimRepoMock.findOne.mockResolvedValueOnce({
        claimId,
        userId,
        status: GuestClaimStatusEnum.COMMITTED,
        stateFingerprint: 'mock_fingerprint',
        createdAt: new Date('2026-10-07T10:00:00Z'),
        expiresAt: new Date('2026-10-07T10:15:00Z'),
        committedAt: new Date('2026-10-07T10:05:00Z'),
        previewData: {
          bookmarksToImport: 1,
        },
        resultSummary: { bookmarksImported: 1 },
        finalizationData: finalizationSnapshot,
      });

      const res = await service.getClaimStatus(userId, claimId);
      expect(res.status).toBe(GuestClaimStatusEnum.COMMITTED);
      expect(res.finalization).toEqual(finalizationSnapshot);
    });

    it('should return finalization: null safely for legacy claim without finalization_data', async () => {
      guestClaimRepoMock.findOne.mockResolvedValueOnce({
        claimId,
        userId,
        status: GuestClaimStatusEnum.COMMITTED,
        stateFingerprint: 'mock_fingerprint',
        createdAt: new Date('2026-10-07T10:00:00Z'),
        expiresAt: new Date('2026-10-07T10:15:00Z'),
        committedAt: new Date('2026-10-07T10:05:00Z'),
        previewData: {
          bookmarksToImport: 1,
        },
        resultSummary: { bookmarksImported: 1 },
        finalizationData: null,
      });

      const res = await service.getClaimStatus(userId, claimId);
      expect(res.status).toBe(GuestClaimStatusEnum.COMMITTED);
      expect(res.finalization).toBeNull();
    });
  });
});
