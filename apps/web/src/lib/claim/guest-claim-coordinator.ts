import {
  PrepareGuestClaimPayload,
  GuestClaimPreviewResult,
  GuestClaimCommitResult,
  GuestClaimStatus,
  ConflictResolution,
  ReadingMode,
} from '@omninovel/shared';
import {
  prepareGuestClaimApi,
  commitGuestClaimApi,
  getGuestClaimStatusApi,
} from '../api/claims';
import {
  IndexedDbClient,
  indexedDbClient,
} from '../storage/indexed-db-client';
import {
  GuestProfileIdentityProvider,
  guestProfileIdentityProvider,
} from '../identity/guest-profile-identity-provider';
import {
  ActiveScopeCoordinator,
  activeScopeCoordinator,
} from '../identity/active-scope-coordinator';

export const PENDING_CLAIM_ID_KEY = 'omninovel_pending_claim_id';
export const PENDING_CLAIM_USER_ID_KEY = 'omninovel_pending_claim_user_id';

export interface GuestClaimCoordinatorState {
  isOpen: boolean;
  isPreparing: boolean;
  isCommitting: boolean;
  previewData: GuestClaimPreviewResult | null;
  error: string | null;
  currentUserId: string | null;
}

export class GuestClaimCoordinator {
  private _state: GuestClaimCoordinatorState = {
    isOpen: false,
    isPreparing: false,
    isCommitting: false,
    previewData: null,
    error: null,
    currentUserId: null,
  };

  private _listeners: Set<(state: GuestClaimCoordinatorState) => void> = new Set();

  constructor(
    private readonly dbClient: IndexedDbClient = indexedDbClient,
    private readonly guestProfileProvider: GuestProfileIdentityProvider = guestProfileIdentityProvider,
    private readonly coordinator: ActiveScopeCoordinator = activeScopeCoordinator,
  ) {}

  get state(): GuestClaimCoordinatorState {
    return this._state;
  }

  subscribe(listener: (state: GuestClaimCoordinatorState) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _updateState(partial: Partial<GuestClaimCoordinatorState>): void {
    this._state = { ...this._state, ...partial };
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  /**
   * P0 Invariant: Checks for local guest data after login or register.
   * If local guest data exists, switches coordinator to TRANSITIONING and prepares a claim session.
   * If no local guest data exists, directly resolves activeScope to account:<userId>.
   */
  async checkAndPrepareClaim(userId: string): Promise<boolean> {
    const trimmedUserId = userId?.trim();
    if (!trimmedUserId) {
      return false;
    }

    try {
      const guestProfileId = await this.guestProfileProvider.getOrCreateGuestProfileId();
      const guestScope = `guest:${guestProfileId}`;

      const hasData = await this.dbClient.hasGuestData(guestScope);
      if (!hasData) {
        // No local guest data -> Direct resolve to account
        this.coordinator.resolveToAccount(trimmedUserId);
        this._updateState({ isOpen: false, previewData: null, currentUserId: trimmedUserId });
        return false;
      }

      // Enter TRANSITIONING state: locks user-state mutations
      this.coordinator.setTransitioning();
      this._updateState({
        isPreparing: true,
        error: null,
        currentUserId: trimmedUserId,
      });

      // Gather guest datasets from IndexedDB
      const bookmarks = await this.dbClient.getBookmarks(guestScope);
      const history = await this.dbClient.getHistory(guestScope);
      const progress = await this.dbClient.getAllProgress(guestScope);

      // Normalize into canonical payload
      const payload: PrepareGuestClaimPayload = {
        guestProfileId,
        bookmarks: bookmarks.map((b) => ({
          storyId: b.storyId,
          createdAt: b.createdAt,
        })),
        history: history.map((h) => ({
          storyId: h.storyId,
          chapterId: h.chapterId,
          progressPercentage: typeof h.progressPercentage === 'number' ? h.progressPercentage : 0,
          completedAt: (h as any).completedAt || (h.progressPercentage >= 100 ? h.lastReadAt : null),
          lastReadAt: h.lastReadAt,
        })),
        progress: progress.map((p) => ({
          storyId: p.storyId,
          chapterId: p.chapterId,
          chapterVersionId: p.chapterVersionId || null,
          readingMode: (p.readingMode as ReadingMode) || ReadingMode.PAGED,
          pageIndex: Math.max(1, typeof p.pageIndex === 'number' ? p.pageIndex : 1),
          scrollPosition: typeof p.scrollPosition === 'number' ? p.scrollPosition : 0,
          progressPercentage: typeof p.progressPercentage === 'number' ? p.progressPercentage : 0,
          anchorBlockId: p.anchorBlockId || null,
          textOffset: typeof p.textOffset === 'number' ? p.textOffset : null,
          updatedAt: p.updatedAt,
        })),
      };

      const preview = await prepareGuestClaimApi(payload);

      // Store pending claim id for crash recovery
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(PENDING_CLAIM_ID_KEY, preview.claimId);
        window.localStorage.setItem(PENDING_CLAIM_USER_ID_KEY, trimmedUserId);
      }

      this._updateState({
        isPreparing: false,
        isOpen: true,
        previewData: preview,
        error: null,
      });

      return true;
    } catch (err: any) {
      // In case of preparation error, allow user to fall back into account scope safely
      this.coordinator.resolveToAccount(trimmedUserId);
      this._updateState({
        isPreparing: false,
        isOpen: false,
        error: err?.message || 'Không thể chuẩn bị dữ liệu gộp từ khách.',
      });
      return false;
    }
  }

  /**
   * P0 Invariant: User chooses to skip claiming guest data.
   * Quarantines guestProfileId into marker list (WITHOUT renaming or deleting the physical partition).
   * Transitions activeScope to account:<userId>.
   */
  async skipClaim(userId?: string): Promise<void> {
    const targetUserId = (userId || this._state.currentUserId)?.trim();
    const guestProfileId = await this.guestProfileProvider.getOrCreateGuestProfileId();

    // 1. Marker quarantine guest scope
    await this.guestProfileProvider.quarantineGuestScope(guestProfileId);

    // 2. Clear crash recovery token
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(PENDING_CLAIM_ID_KEY);
      window.localStorage.removeItem(PENDING_CLAIM_USER_ID_KEY);
    }

    // 3. Close modal & transition to account
    this._updateState({
      isOpen: false,
      previewData: null,
      error: null,
    });

    if (targetUserId) {
      this.coordinator.resolveToAccount(targetUserId);
    }
  }

  /**
   * P0 Invariant: User confirms claiming guest data.
   * Commits the claim session to Core API.
   * On 200 OK (COMMITTED), merges local IndexedDB records and purges source guest partition.
   * On 409 Conflict (CLAIM_STALE_REPREPARE), automatically re-prepares.
   */
  async confirmClaim(
    userId?: string,
    conflictDecisions?: Record<string, ConflictResolution>,
  ): Promise<GuestClaimCommitResult> {
    const targetUserId = (userId || this._state.currentUserId)?.trim();
    if (!targetUserId) {
      throw new Error('Thiếu định danh người dùng để thực hiện gộp dữ liệu.');
    }

    const claimId =
      this._state.previewData?.claimId ||
      (typeof window !== 'undefined' ? window.localStorage.getItem(PENDING_CLAIM_ID_KEY) : null);

    if (!claimId) {
      throw new Error('Không tìm thấy phiên claim hợp lệ.');
    }

    this._updateState({ isCommitting: true, error: null });

    try {
      const commitRes = await commitGuestClaimApi(claimId, { conflictDecisions });

      if (commitRes.status === GuestClaimStatus.COMMITTED) {
        const guestProfileId = await this.guestProfileProvider.getOrCreateGuestProfileId();
        const guestScope = `guest:${guestProfileId}`;
        const accountScope = `account:${targetUserId}`;

        // Local Transactional Merge & Purge source guest partition
        await this.dbClient.rebindScope(guestScope, accountScope);

        // Clear crash recovery token
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(PENDING_CLAIM_ID_KEY);
          window.localStorage.removeItem(PENDING_CLAIM_USER_ID_KEY);
        }

        this._updateState({
          isCommitting: false,
          isOpen: false,
          previewData: null,
          error: null,
        });

        // Finally transition activeScope to account:<userId>
        this.coordinator.resolveToAccount(targetUserId);
        return commitRes;
      }

      throw new Error(`Phiên gộp kết thúc với trạng thái không mong muốn: ${commitRes.status}`);
    } catch (err: any) {
      this._updateState({ isCommitting: false });

      // Handle 409 Conflict: Server state updated, auto re-prepare
      if (err?.response?.status === 409 || err?.message?.includes('409') || err?.response?.data?.error?.code === 'CLAIM_STALE_REPREPARE') {
        await this.checkAndPrepareClaim(targetUserId);
        throw new Error('Dữ liệu trên máy chủ đã thay đổi. Đã làm mới thông tin xem trước, vui lòng xác nhận lại.');
      }

      const errorMessage =
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        'Gộp dữ liệu thất bại.';
      this._updateState({ error: errorMessage });
      throw err;
    }
  }

  /**
   * P0 Invariant: Crash Recovery.
   * Inspects pendingClaimId in localStorage upon app boot or session rehydration.
   */
  async checkCrashRecovery(userId: string): Promise<boolean> {
    const trimmedUserId = userId?.trim();
    if (!trimmedUserId || typeof window === 'undefined' || !window.localStorage) {
      return false;
    }

    const pendingClaimId = window.localStorage.getItem(PENDING_CLAIM_ID_KEY);
    if (!pendingClaimId) {
      return false;
    }

    try {
      const statusRes = await getGuestClaimStatusApi(pendingClaimId);

      if (statusRes.status === GuestClaimStatus.COMMITTED) {
        // Commit already succeeded on server before crash: finalize local rebind
        const guestProfileId = await this.guestProfileProvider.getOrCreateGuestProfileId();
        await this.dbClient.rebindScope(`guest:${guestProfileId}`, `account:${trimmedUserId}`);

        window.localStorage.removeItem(PENDING_CLAIM_ID_KEY);
        window.localStorage.removeItem(PENDING_CLAIM_USER_ID_KEY);
        this.coordinator.resolveToAccount(trimmedUserId);
        return true;
      }

      if (
        statusRes.status === GuestClaimStatus.ABORTED ||
        statusRes.status === GuestClaimStatus.EXPIRED
      ) {
        // Obsolete claim -> clear token
        window.localStorage.removeItem(PENDING_CLAIM_ID_KEY);
        window.localStorage.removeItem(PENDING_CLAIM_USER_ID_KEY);
        return false;
      }

      if (statusRes.status === GuestClaimStatus.PREPARED) {
        // Pending decision -> Re-open dialog
        this.coordinator.setTransitioning();
        this._updateState({
          isOpen: true,
          previewData: statusRes.previewData,
          currentUserId: trimmedUserId,
        });
        return true;
      }

      return false;
    } catch {
      // In case of network error during crash recovery check, keep pendingClaimId for next attempt
      return false;
    }
  }
}

export const guestClaimCoordinator = new GuestClaimCoordinator();
