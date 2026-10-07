import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GuestClaimCoordinator,
  PENDING_CLAIM_ID_KEY,
  PENDING_CLAIM_USER_ID_KEY,
} from '../lib/claim/guest-claim-coordinator';
import {
  GuestClaimStatus,
  ConflictResolution,
  ReadingMode,
  GuestClaimPreviewResult,
  GuestClaimCommitResult,
  GuestClaimStatusResult,
} from '@omninovel/shared';
import * as claimsApi from '../lib/api/claims';

describe('Task 7B.3: GuestClaimCoordinator (Web Client Integration)', () => {
  let mockDbClient: any;
  let mockGuestProfileProvider: any;
  let mockActiveScopeCoordinator: any;
  let coordinator: GuestClaimCoordinator;

  const sampleUserId = 'usr-test-123';
  const sampleGuestProfileId = 'guest-uuid-456';
  const sampleClaimId = 'claim-session-789';

  const mockPreviewResult: GuestClaimPreviewResult = {
    claimId: sampleClaimId,
    status: GuestClaimStatus.PREPARED,
    stateFingerprint: 'sha256-fingerprint-abc',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    bookmarksToImport: 2,
    historyToImport: 3,
    progressToImport: 1,
    conflictsCount: 1,
    readStatesIgnoredAntiResurrectionCount: 0,
    conflicts: [
      {
        storyId: 'story-conflict-1',
        cloudProgress: {
          chapterId: 'chap-c1',
          readingMode: ReadingMode.PAGED,
          pageIndex: 12,
          scrollPosition: 0,
          progressPercentage: 60,
          updatedAt: new Date().toISOString(),
        },
        guestProgress: {
          chapterId: 'chap-g1',
          readingMode: ReadingMode.PAGED,
          pageIndex: 5,
          scrollPosition: 0,
          progressPercentage: 25,
        },
      },
    ],
  };

  const mockCommitResult: GuestClaimCommitResult = {
    claimId: sampleClaimId,
    status: GuestClaimStatus.COMMITTED,
    committedAt: new Date().toISOString(),
    summary: {
      bookmarksImported: 2,
      historyMerged: 3,
      progressUpdated: 1,
      conflictsResolved: 1,
    },
  };

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();

    mockDbClient = {
      hasGuestData: vi.fn(),
      getBookmarks: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue([]),
      getAllProgress: vi.fn().mockResolvedValue([]),
      rebindScope: vi.fn().mockResolvedValue(undefined),
      purgeScope: vi.fn().mockResolvedValue(undefined),
    };

    mockGuestProfileProvider = {
      getOrCreateGuestProfileId: vi.fn().mockResolvedValue(sampleGuestProfileId),
      quarantineGuestScope: vi.fn().mockResolvedValue(undefined),
    };

    mockActiveScopeCoordinator = {
      state: 'BOOTSTRAPPING',
      activeScope: null,
      canMutateUserState: false,
      setTransitioning: vi.fn(function () {
        mockActiveScopeCoordinator.state = 'TRANSITIONING';
        mockActiveScopeCoordinator.activeScope = null;
        mockActiveScopeCoordinator.canMutateUserState = false;
      }),
      resolveToAccount: vi.fn(function (id: string) {
        mockActiveScopeCoordinator.state = 'ACCOUNT';
        mockActiveScopeCoordinator.activeScope = `account:${id}`;
        mockActiveScopeCoordinator.canMutateUserState = true;
      }),
    };

    coordinator = new GuestClaimCoordinator(
      mockDbClient,
      mockGuestProfileProvider,
      mockActiveScopeCoordinator,
    );
  });

  describe('Invariant 1: Direct Account Transition when No Guest Data Exists', () => {
    it('resolves directly to ACCOUNT and keeps dialog closed if hasGuestData is false', async () => {
      mockDbClient.hasGuestData.mockResolvedValue(false);

      const prepared = await coordinator.checkAndPrepareClaim(sampleUserId);

      expect(prepared).toBe(false);
      expect(mockActiveScopeCoordinator.resolveToAccount).toHaveBeenCalledWith(sampleUserId);
      expect(mockActiveScopeCoordinator.setTransitioning).not.toHaveBeenCalled();
      expect(coordinator.state.isOpen).toBe(false);
      expect(coordinator.state.previewData).toBeNull();
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBeNull();
    });
  });

  describe('Invariant 2 & 3: TRANSITIONING Lock & Canonical Prepare Payload', () => {
    it('locks in TRANSITIONING and prepares claim session when guest data exists', async () => {
      mockDbClient.hasGuestData.mockResolvedValue(true);
      mockDbClient.getBookmarks.mockResolvedValue([
        { storyId: 's1', ownerScope: `guest:${sampleGuestProfileId}`, createdAt: '2026-01-01' },
      ]);
      mockDbClient.getHistory.mockResolvedValue([
        {
          storyId: 's1',
          chapterId: 'c1',
          progressPercentage: 45,
          ownerScope: `guest:${sampleGuestProfileId}`,
        },
      ]);
      mockDbClient.getAllProgress.mockResolvedValue([
        {
          storyId: 's1',
          chapterId: 'c1',
          readingMode: ReadingMode.PAGED,
          pageIndex: 0, // Should be normalized to >= 1
          scrollPosition: 0,
          progressPercentage: 45,
          ownerScope: `guest:${sampleGuestProfileId}`,
        },
      ]);

      const prepareSpy = vi
        .spyOn(claimsApi, 'prepareGuestClaimApi')
        .mockResolvedValue(mockPreviewResult);

      const prepared = await coordinator.checkAndPrepareClaim(sampleUserId);

      expect(prepared).toBe(true);
      // P0 Invariant: Must be in TRANSITIONING state during claim pending
      expect(mockActiveScopeCoordinator.setTransitioning).toHaveBeenCalled();
      expect(mockActiveScopeCoordinator.canMutateUserState).toBe(false);

      // Verify canonical prepare payload
      expect(prepareSpy).toHaveBeenCalledWith({
        guestProfileId: sampleGuestProfileId,
        bookmarks: [{ storyId: 's1', createdAt: '2026-01-01' }],
        history: [{ storyId: 's1', chapterId: 'c1', progressPercentage: 45, completedAt: null, lastReadAt: undefined }],
        progress: [
          {
            storyId: 's1',
            chapterId: 'c1',
            chapterVersionId: null,
            readingMode: ReadingMode.PAGED,
            pageIndex: 1, // Normalized 1-based pageIndex >= 1
            scrollPosition: 0,
            progressPercentage: 45,
            anchorBlockId: null,
            textOffset: null,
            updatedAt: undefined,
          },
        ],
      });

      // Verify UI state & crash recovery persistence
      expect(coordinator.state.isOpen).toBe(true);
      expect(coordinator.state.previewData).toEqual(mockPreviewResult);
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBe(sampleClaimId);
      expect(localStorage.getItem(PENDING_CLAIM_USER_ID_KEY)).toBe(sampleUserId);
    });
  });

  describe('Invariant 4: Marker Quarantine on Skip (Zero Partition Mutation)', () => {
    it('quarantines guest scope without renaming/deleting partition, clears pending token, and transitions to ACCOUNT', async () => {
      // Simulate open state
      mockDbClient.hasGuestData.mockResolvedValue(true);
      vi.spyOn(claimsApi, 'prepareGuestClaimApi').mockResolvedValue(mockPreviewResult);
      await coordinator.checkAndPrepareClaim(sampleUserId);

      // User clicks Skip
      await coordinator.skipClaim(sampleUserId);

      // 1. Quarantines scope via marker list
      expect(mockGuestProfileProvider.quarantineGuestScope).toHaveBeenCalledWith(
        sampleGuestProfileId,
      );

      // 2. Physical partition NOT purged or modified on skip
      expect(mockDbClient.purgeScope).not.toHaveBeenCalled();
      expect(mockDbClient.rebindScope).not.toHaveBeenCalled();

      // 3. Pending tokens cleared from localStorage
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBeNull();
      expect(localStorage.getItem(PENDING_CLAIM_USER_ID_KEY)).toBeNull();

      // 4. Modal closed and coordinator transitioned to ACCOUNT
      expect(coordinator.state.isOpen).toBe(false);
      expect(coordinator.state.previewData).toBeNull();
      expect(mockActiveScopeCoordinator.resolveToAccount).toHaveBeenCalledWith(sampleUserId);
      expect(mockActiveScopeCoordinator.canMutateUserState).toBe(true);
    });
  });

  describe('Invariant 5: Commit Success with Transactional Local Rebind', () => {
    it('commits claim to API, calls local rebindScope, clears pending tokens, and transitions to ACCOUNT', async () => {
      mockDbClient.hasGuestData.mockResolvedValue(true);
      vi.spyOn(claimsApi, 'prepareGuestClaimApi').mockResolvedValue(mockPreviewResult);
      const commitSpy = vi
        .spyOn(claimsApi, 'commitGuestClaimApi')
        .mockResolvedValue(mockCommitResult);

      await coordinator.checkAndPrepareClaim(sampleUserId);

      const decisions = {
        'story-conflict-1': ConflictResolution.USE_GUEST,
      };

      const result = await coordinator.confirmClaim(sampleUserId, decisions);

      expect(commitSpy).toHaveBeenCalledWith(sampleClaimId, {
        expectedStateFingerprint: mockPreviewResult.stateFingerprint,
        conflictDecisions: decisions,
      });

      // Local rebind executed with conflict decisions
      expect(mockDbClient.rebindScope).toHaveBeenCalledWith(
        `guest:${sampleGuestProfileId}`,
        `account:${sampleUserId}`,
        decisions,
      );

      // Pending token cleared
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBeNull();

      // Dialog closed & resolved to account
      expect(coordinator.state.isOpen).toBe(false);
      expect(mockActiveScopeCoordinator.resolveToAccount).toHaveBeenCalledWith(sampleUserId);
    });
  });

  describe('Invariant 6: 409 Conflict Handling (Auto Re-Prepare)', () => {
    it('triggers auto re-prepare when commit returns 409 Conflict', async () => {
      mockDbClient.hasGuestData.mockResolvedValue(true);
      vi.spyOn(claimsApi, 'prepareGuestClaimApi').mockResolvedValue(mockPreviewResult);

      const conflictError: any = new Error('CLAIM_STALE_REPREPARE');
      conflictError.response = { status: 409, data: { error: { code: 'CLAIM_STALE_REPREPARE' } } };

      vi.spyOn(claimsApi, 'commitGuestClaimApi').mockRejectedValue(conflictError);

      await coordinator.checkAndPrepareClaim(sampleUserId);

      const prepareSpy = vi.spyOn(coordinator, 'checkAndPrepareClaim');

      await expect(coordinator.confirmClaim(sampleUserId)).rejects.toThrow(
        /Dữ liệu trên máy chủ đã thay đổi/i,
      );

      expect(prepareSpy).toHaveBeenCalledWith(sampleUserId);
    });
  });

  describe('Invariant 7: Crash Recovery Protocol', () => {
    it('recovers COMMITTED claim: executes local rebind and resolves to ACCOUNT', async () => {
      localStorage.setItem(PENDING_CLAIM_ID_KEY, sampleClaimId);
      localStorage.setItem(PENDING_CLAIM_USER_ID_KEY, sampleUserId);

      const statusRes: GuestClaimStatusResult = {
        claimId: sampleClaimId,
        status: GuestClaimStatus.COMMITTED,
        expiresAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        previewData: mockPreviewResult,
        resultSummary: mockCommitResult.summary,
      };

      vi.spyOn(claimsApi, 'getGuestClaimStatusApi').mockResolvedValue(statusRes);

      const recoveryStatus = await coordinator.checkCrashRecovery(sampleUserId);

      expect(recoveryStatus).toBe('RESOLVED');
      expect(mockDbClient.rebindScope).toHaveBeenCalledWith(
        `guest:${sampleGuestProfileId}`,
        `account:${sampleUserId}`,
        undefined,
      );
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBeNull();
      expect(mockActiveScopeCoordinator.resolveToAccount).toHaveBeenCalledWith(sampleUserId);
    });

    it('reopens dialog if pending claim is still PREPARED', async () => {
      localStorage.setItem(PENDING_CLAIM_ID_KEY, sampleClaimId);

      const statusRes: GuestClaimStatusResult = {
        claimId: sampleClaimId,
        status: GuestClaimStatus.PREPARED,
        expiresAt: new Date().toISOString(),
        previewData: mockPreviewResult,
      };

      vi.spyOn(claimsApi, 'getGuestClaimStatusApi').mockResolvedValue(statusRes);

      const recoveryStatus = await coordinator.checkCrashRecovery(sampleUserId);

      expect(recoveryStatus).toBe('RESOLVED');
      expect(mockActiveScopeCoordinator.setTransitioning).toHaveBeenCalled();
      expect(coordinator.state.isOpen).toBe(true);
      expect(coordinator.state.previewData).toEqual(mockPreviewResult);
    });

    it('clears pending token if claim was EXPIRED or ABORTED', async () => {
      localStorage.setItem(PENDING_CLAIM_ID_KEY, sampleClaimId);

      const statusRes: GuestClaimStatusResult = {
        claimId: sampleClaimId,
        status: GuestClaimStatus.EXPIRED,
        expiresAt: new Date().toISOString(),
        previewData: mockPreviewResult,
      };

      vi.spyOn(claimsApi, 'getGuestClaimStatusApi').mockResolvedValue(statusRes);

      const recoveryStatus = await coordinator.checkCrashRecovery(sampleUserId);

      expect(recoveryStatus).toBe('NONE');
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBeNull();
    });

    it('fails closed and keeps TRANSITIONING if status check throws network error', async () => {
      localStorage.setItem(PENDING_CLAIM_ID_KEY, sampleClaimId);

      vi.spyOn(claimsApi, 'getGuestClaimStatusApi').mockRejectedValue(new Error('Network timeout'));

      const recoveryStatus = await coordinator.checkCrashRecovery(sampleUserId);

      expect(recoveryStatus).toBe('PENDING_UNAVAILABLE');
      expect(mockActiveScopeCoordinator.setTransitioning).toHaveBeenCalled();
      // Tokens preserved for future recovery attempt
      expect(localStorage.getItem(PENDING_CLAIM_ID_KEY)).toBe(sampleClaimId);
      // Coordinator does NOT resolve to account
      expect(mockActiveScopeCoordinator.resolveToAccount).not.toHaveBeenCalled();
    });
  });
});
