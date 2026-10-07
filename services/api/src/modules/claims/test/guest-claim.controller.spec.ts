import { Test, TestingModule } from '@nestjs/testing';
import { GuestClaimController } from '../guest-claim.controller';
import { GuestClaimService } from '../guest-claim.service';
import {
  CanonicalReadingMode,
  PrepareGuestClaimDto,
} from '../dto/prepare-guest-claim.dto';
import {
  CommitGuestClaimDto,
  ConflictResolution,
} from '../dto/commit-guest-claim.dto';

describe('GuestClaimController (Task 7B.1 Routing & Guards)', () => {
  let controller: GuestClaimController;
  let serviceMock: any;

  const userId = '11111111-1111-4111-8111-111111111111';
  const claimId = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    serviceMock = {
      prepareClaim: jest.fn(),
      commitClaim: jest.fn(),
      getClaimStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GuestClaimController],
      providers: [
        {
          provide: GuestClaimService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<GuestClaimController>(GuestClaimController);
  });

  it('prepareClaim should delegate to service.prepareClaim', async () => {
    const dto: PrepareGuestClaimDto = {
      guestProfileId: '33333333-3333-4333-8333-333333333333',
      bookmarks: [],
      history: [],
      progress: [],
    };

    const expectedRes = {
      claimId,
      status: 'PREPARED',
      stateFingerprint: 'mock_fingerprint',
      expiresAt: '2026-10-07T13:00:00.000Z',
      bookmarksToImport: 0,
      historyToImport: 0,
      progressToImport: 0,
      conflictsCount: 0,
      readStatesIgnoredAntiResurrectionCount: 0,
      conflicts: [],
    };

    serviceMock.prepareClaim.mockResolvedValueOnce(expectedRes);

    const result = await controller.prepareClaim(userId, dto);
    expect(serviceMock.prepareClaim).toHaveBeenCalledWith(userId, dto);
    expect(result).toEqual(expectedRes);
  });

  it('commitClaim should delegate to service.commitClaim', async () => {
    const dto: CommitGuestClaimDto = {
      expectedStateFingerprint: 'mock_fingerprint',
      conflictDecisions: {
        'story-1': ConflictResolution.USE_GUEST,
      },
    };

    const expectedRes = {
      claimId,
      status: 'COMMITTED',
      committedAt: '2026-10-07T13:00:00.000Z',
      summary: {
        bookmarksImported: 1,
        historyMerged: 2,
        progressUpdated: 1,
        conflictsResolved: 1,
      },
    };

    serviceMock.commitClaim.mockResolvedValueOnce(expectedRes);

    const result = await controller.commitClaim(userId, claimId, dto);
    expect(serviceMock.commitClaim).toHaveBeenCalledWith(userId, claimId, dto);
    expect(result).toEqual(expectedRes);
  });

  it('getClaimStatus should delegate to service.getClaimStatus', async () => {
    const expectedRes = {
      claimId,
      status: 'COMMITTED',
      stateFingerprint: 'mock_fingerprint',
      createdAt: '2026-10-07T12:00:00.000Z',
      expiresAt: '2026-10-07T12:15:00.000Z',
      committedAt: '2026-10-07T12:05:00.000Z',
      previewData: {
        claimId,
        status: 'PREPARED',
        stateFingerprint: 'mock_fingerprint',
        expiresAt: '2026-10-07T12:15:00.000Z',
        bookmarksToImport: 0,
        historyToImport: 0,
        progressToImport: 0,
        conflictsCount: 0,
        readStatesIgnoredAntiResurrectionCount: 0,
        conflicts: [],
      },
      resultSummary: {
        bookmarksImported: 1,
        historyMerged: 2,
        progressUpdated: 1,
        conflictsResolved: 1,
      },
    };

    serviceMock.getClaimStatus.mockResolvedValueOnce(expectedRes);

    const result = await controller.getClaimStatus(userId, claimId);
    expect(serviceMock.getClaimStatus).toHaveBeenCalledWith(userId, claimId);
    expect(result).toEqual(expectedRes);
  });
});
