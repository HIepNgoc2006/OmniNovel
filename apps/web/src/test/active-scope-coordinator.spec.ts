import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InstallationIdentityProvider,
  INSTALLATION_ID_KEY,
} from '../lib/identity/installation-identity-provider';
import {
  GuestProfileIdentityProvider,
  GUEST_PROFILE_ID_KEY,
  QUARANTINED_PROFILES_KEY,
} from '../lib/identity/guest-profile-identity-provider';
import {
  ActiveScopeCoordinator,
  ActiveScopeState,
} from '../lib/identity/active-scope-coordinator';

describe('Task 7A.1: Web Identity & ActiveScopeCoordinator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('InstallationIdentityProvider (Stable Device Identity)', () => {
    it('creates a stable UUIDv4 installationId and persists to localStorage', async () => {
      const provider = new InstallationIdentityProvider();
      const id1 = await provider.getOrCreateInstallationId();

      expect(id1).toBeDefined();
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(10);
      expect(localStorage.getItem(INSTALLATION_ID_KEY)).toBe(id1);

      const id2 = await provider.getOrCreateInstallationId();
      expect(id2).toBe(id1);
    });

    it('resolves concurrent getOrCreateInstallationId() calls to the identical canonical ID (Multi-tab race guard)', async () => {
      const provider = new InstallationIdentityProvider();
      const results = await Promise.all([
        provider.getOrCreateInstallationId(),
        provider.getOrCreateInstallationId(),
        provider.getOrCreateInstallationId(),
      ]);

      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
      expect(localStorage.getItem(INSTALLATION_ID_KEY)).toBe(results[0]);
    });
  });

  describe('GuestProfileIdentityProvider (Rotatable Guest Identity)', () => {
    it('creates, retrieves, and rotates guestProfileId', async () => {
      const provider = new GuestProfileIdentityProvider();
      const initialProfileId = await provider.getOrCreateGuestProfileId();

      expect(initialProfileId).toBeDefined();
      expect(localStorage.getItem(GUEST_PROFILE_ID_KEY)).toBe(initialProfileId);

      // Rotate to fresh guest profile
      const newProfileId = await provider.rotateGuestProfileId();
      expect(newProfileId).toBeDefined();
      expect(newProfileId).not.toBe(initialProfileId);
      expect(localStorage.getItem(GUEST_PROFILE_ID_KEY)).toBe(newProfileId);
    });

    it('quarantines old guest profile without silent destruction', async () => {
      const provider = new GuestProfileIdentityProvider();
      const profileToQuarantine = await provider.getOrCreateGuestProfileId();

      await provider.quarantineGuestScope(profileToQuarantine);
      const quarantined = await provider.listQuarantinedGuestScopes();

      expect(quarantined).toContain(profileToQuarantine);
      const raw = localStorage.getItem(QUARANTINED_PROFILES_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)).toContain(profileToQuarantine);
    });
  });

  describe('ActiveScopeCoordinator (State Machine & Zero-Race Invariant)', () => {
    it('starts in BOOTSTRAPPING state with null activeScope and disallows user-state mutations', () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      expect(coordinator.state).toBe<ActiveScopeState>('BOOTSTRAPPING');
      expect(coordinator.activeScope).toBeNull();
      expect(coordinator.canMutateUserState).toBe(false);
    });

    it('transitions BOOTSTRAPPING -> GUEST when auth hydrates as anonymous', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      await coordinator.onAuthStatusChanged('anonymous');

      expect(coordinator.state).toBe<ActiveScopeState>('GUEST');
      expect(coordinator.canMutateUserState).toBe(true);
      expect(coordinator.activeScope).toMatch(/^guest:[a-zA-Z0-9_-]+$/);
    });

    it('transitions BOOTSTRAPPING -> ACCOUNT when auth hydrates as authenticated', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      await coordinator.onAuthStatusChanged('authenticated', 'user-alpha-456');

      expect(coordinator.state).toBe<ActiveScopeState>('ACCOUNT');
      expect(coordinator.canMutateUserState).toBe(true);
      expect(coordinator.activeScope).toBe('account:user-alpha-456');
    });

    it('resolves multiple concurrent waitForResolvedScope() without hanging or mismatch', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      const promise1 = coordinator.waitForResolvedScope();
      const promise2 = coordinator.waitForResolvedScope();

      // Resolve while promises are waiting
      await coordinator.onAuthStatusChanged('authenticated', 'user-beta-789');

      const [scope1, scope2] = await Promise.all([promise1, promise2]);
      expect(scope1).toBe('account:user-beta-789');
      expect(scope2).toBe('account:user-beta-789');
      expect(coordinator.activeScope).toBe('account:user-beta-789');
    });

    it('handles logout: transitions ACCOUNT -> TRANSITIONING -> GUEST with unchanged installationId and rotated guestProfileId', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      const initialInstallId = await installProvider.getOrCreateInstallationId();
      await coordinator.onAuthStatusChanged('authenticated', 'user-logout-test');

      expect(coordinator.state).toBe('ACCOUNT');
      expect(coordinator.activeScope).toBe('account:user-logout-test');

      // Perform logout
      await coordinator.onLogout();

      expect(coordinator.state).toBe('GUEST');
      expect(coordinator.canMutateUserState).toBe(true);
      expect(coordinator.activeScope).toMatch(/^guest:[a-zA-Z0-9_-]+$/);
      expect(coordinator.activeScope).not.toBe('account:user-logout-test');

      // Installation ID MUST REMAIN STABLE
      const postLogoutInstallId = await installProvider.getOrCreateInstallationId();
      expect(postLogoutInstallId).toBe(initialInstallId);
    });

    it('handles login transition: preserves installationId and switches scope to account:<userId>', async () => {
      const installProvider = new InstallationIdentityProvider();
      const guestProvider = new GuestProfileIdentityProvider();
      const coordinator = new ActiveScopeCoordinator(installProvider, guestProvider);

      const initialInstallId = await installProvider.getOrCreateInstallationId();
      await coordinator.onAuthStatusChanged('anonymous');
      const guestScope = coordinator.activeScope;
      expect(guestScope).toMatch(/^guest:/);

      // User logs in
      await coordinator.onAuthStatusChanged('authenticated', 'user-login-777');

      expect(coordinator.state).toBe('ACCOUNT');
      expect(coordinator.activeScope).toBe('account:user-login-777');
      expect(await installProvider.getOrCreateInstallationId()).toBe(initialInstallId);
    });
  });
});
