import {
  InstallationIdentityProvider,
  installationIdentityProvider,
} from './installation-identity-provider';
import {
  GuestProfileIdentityProvider,
  guestProfileIdentityProvider,
} from './guest-profile-identity-provider';
import { AuthStatus } from '../auth/auth-store';

export type ActiveScopeState = 'BOOTSTRAPPING' | 'GUEST' | 'ACCOUNT' | 'TRANSITIONING';

export class ActiveScopeCoordinator {
  private _state: ActiveScopeState = 'BOOTSTRAPPING';
  private _activeScope: string | null = null;
  private _waiters: Array<(scope: string) => void> = [];
  private _listeners: Set<(scope: string | null, state: ActiveScopeState) => void> = new Set();

  constructor(
    private readonly installProvider: InstallationIdentityProvider = installationIdentityProvider,
    private readonly guestProfileProvider: GuestProfileIdentityProvider = guestProfileIdentityProvider,
  ) {}

  get state(): ActiveScopeState {
    return this._state;
  }

  get activeScope(): string | null {
    return this._activeScope;
  }

  /**
   * P0 Invariant: Zero persistent user-state write during BOOTSTRAPPING or TRANSITIONING.
   * Only true when the active scope has deterministically resolved to GUEST or ACCOUNT.
   */
  get canMutateUserState(): boolean {
    return (this._state === 'GUEST' || this._state === 'ACCOUNT') && this._activeScope !== null;
  }

  /**
   * Returns a promise that resolves as soon as the scope transitions to a steady state (GUEST or ACCOUNT).
   * Multiple concurrent callers converge and resolve together without dropping any waiters.
   */
  async waitForResolvedScope(): Promise<string> {
    if (this.canMutateUserState && this._activeScope) {
      return this._activeScope;
    }

    return new Promise<string>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  /**
   * Consumes canonical AuthStatus from memoryAuthStore / AuthContext.
   * Enforces zero-race transition from BOOTSTRAPPING to GUEST or ACCOUNT.
   * 
   * P0 Invariant: Fail-closed on authenticated without valid userId.
   * If status is 'authenticated' but userId is missing or empty, scope remains null
   * and state stays BOOTSTRAPPING. NEVER create spoofed account:unknown.
   */
  /**
   * P0 Invariant: Explicitly sets coordinator into TRANSITIONING state.
   * While TRANSITIONING, canMutateUserState is false, blocking user-state mutations.
   */
  setTransitioning(): void {
    this._state = 'TRANSITIONING';
    this._activeScope = null;
    this._notifyListeners();
  }

  /**
   * Deterministically resolves identity to an authenticated account scope.
   */
  resolveToAccount(userId: string): void {
    const trimmed = userId?.trim();
    if (!trimmed) {
      this._state = 'BOOTSTRAPPING';
      this._activeScope = null;
      this._notifyListeners();
      return;
    }
    this._activeScope = `account:${trimmed}`;
    this._state = 'ACCOUNT';
    this._flushWaiters(this._activeScope);
    this._notifyListeners();
  }

  /**
   * Consumes canonical AuthStatus from memoryAuthStore / AuthContext.
   * Enforces zero-race transition from BOOTSTRAPPING to GUEST or ACCOUNT.
   * 
   * P0 Invariant: Fail-closed on authenticated without valid userId.
   * If status is 'authenticated' but userId is missing or empty, scope remains null
   * and state stays BOOTSTRAPPING. NEVER create spoofed account:unknown.
   */
  async onAuthStatusChanged(
    status: AuthStatus,
    userId?: string,
    options?: { deferScopeResolution?: boolean },
  ): Promise<void> {
    if (status === 'initializing') {
      this._state = 'BOOTSTRAPPING';
      this._activeScope = null;
      this._notifyListeners();
      return;
    }

    if (status === 'anonymous') {
      const profileId = await this.guestProfileProvider.getOrCreateGuestProfileId();
      this._activeScope = `guest:${profileId}`;
      this._state = 'GUEST';
      this._flushWaiters(this._activeScope);
      this._notifyListeners();
      return;
    }

    if (status === 'authenticated') {
      const trimmedUserId = userId?.trim();
      if (!trimmedUserId) {
        // Fail-closed: Missing/invalid userId while authenticated must NOT create account:unknown!
        this._state = 'BOOTSTRAPPING';
        this._activeScope = null;
        this._notifyListeners();
        return;
      }

      if (options?.deferScopeResolution) {
        this.setTransitioning();
        return;
      }

      this.resolveToAccount(trimmedUserId);
    }
  }

  /**
   * Handles user logout:
   * 1. Detaches current account scope
   * 2. Preserves stable installationId
   * 3. Rotates to a fresh guest profile
   * 4. Activates fresh guest scope with empty local library state
   */
  async onLogout(): Promise<void> {
    this._state = 'TRANSITIONING';
    this._activeScope = null;
    this._notifyListeners();

    const freshProfileId = await this.guestProfileProvider.rotateGuestProfileId();
    this._activeScope = `guest:${freshProfileId}`;
    this._state = 'GUEST';

    this._flushWaiters(this._activeScope);
    this._notifyListeners();
  }

  /**
   * Helper to retrieve stable device scope (device:<installationId>).
   */
  async getDeviceScope(): Promise<string> {
    const installId = await this.installProvider.getOrCreateInstallationId();
    return `device:${installId}`;
  }

  subscribe(listener: (scope: string | null, state: ActiveScopeState) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _flushWaiters(scope: string): void {
    const waiters = [...this._waiters];
    this._waiters = [];
    for (const resolve of waiters) {
      resolve(scope);
    }
  }

  private _notifyListeners(): void {
    for (const listener of this._listeners) {
      listener(this._activeScope, this._state);
    }
  }
}

export const activeScopeCoordinator = new ActiveScopeCoordinator();
