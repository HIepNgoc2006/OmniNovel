import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../lib/auth/auth-context';
import { activeScopeCoordinator } from '../lib/identity/active-scope-coordinator';
import * as authApi from '../lib/api/auth';
import * as clientApi from '../lib/api/client';

describe('7A.4a: Auth ↔ ActiveScope Runtime Bridge', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('orchestrates BOOTSTRAPPING when hydration starts, then resolves GUEST for anonymous users', async () => {
    // Refresh token returns null -> Anonymous session
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue(null);

    const onAuthStatusSpy = vi.spyOn(activeScopeCoordinator, 'onAuthStatusChanged');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    // Initially initializing / bootstrapping
    expect(result.current.isLoading).toBe(true);
    expect(onAuthStatusSpy).toHaveBeenCalledWith('initializing');
    expect(activeScopeCoordinator.state).toBe('BOOTSTRAPPING');

    // Wait for hydration to finish
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe('anonymous');
    expect(result.current.isAuthenticated).toBe(false);
    expect(activeScopeCoordinator.state).toBe('GUEST');
    expect(activeScopeCoordinator.activeScope).toMatch(/^guest:/);
    expect(activeScopeCoordinator.canMutateUserState).toBe(true);
  });

  it('orchestrates ACCOUNT when user is authenticated with a valid profile id', async () => {
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue('fake-access-token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      id: 'usr-vip-999',
      username: 'vip_reader',
      email: 'vip@omninovel.com',
      role: 'READER',
    } as any);

    const onAuthStatusSpy = vi.spyOn(activeScopeCoordinator, 'onAuthStatusChanged');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.user?.id).toBe('usr-vip-999');
    expect(onAuthStatusSpy).toHaveBeenCalledWith('authenticated', 'usr-vip-999');
    expect(activeScopeCoordinator.state).toBe('ACCOUNT');
    expect(activeScopeCoordinator.activeScope).toBe('account:usr-vip-999');
    expect(activeScopeCoordinator.canMutateUserState).toBe(true);
  });

  it('fails closed to BOOTSTRAPPING if authenticated status has missing or empty user id', async () => {
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue('fake-access-token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      id: '', // Empty user id!
      username: 'corrupt_user',
    } as any);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    // Coordinator fails closed
    expect(activeScopeCoordinator.state).toBe('BOOTSTRAPPING');
    expect(activeScopeCoordinator.activeScope).toBeNull();
    expect(activeScopeCoordinator.canMutateUserState).toBe(false);
  });

  it('calls activeScopeCoordinator.onLogout() and rotates guestProfileId on logout', async () => {
    // Start authenticated
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue('token-1');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      id: 'usr-logout-test',
      username: 'user_before_logout',
    } as any);
    vi.spyOn(authApi, 'logoutApi').mockResolvedValue({} as any);

    const onLogoutSpy = vi.spyOn(activeScopeCoordinator, 'onLogout');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(activeScopeCoordinator.activeScope).toBe('account:usr-logout-test');

    // Perform logout
    await act(async () => {
      await result.current.logout();
    });

    // Invariant: onLogout was called, detaching account and rotating guestProfileId
    expect(onLogoutSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('anonymous');
    expect(activeScopeCoordinator.state).toBe('GUEST');
    expect(activeScopeCoordinator.activeScope).toMatch(/^guest:/);
    expect(activeScopeCoordinator.activeScope).not.toBe('account:usr-logout-test');
  });

  it('resolves account scope upon successful login()', async () => {
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue(null);
    vi.spyOn(authApi, 'loginApi').mockResolvedValue({
      accessToken: 'jwt-login-token',
      user: {
        id: 'usr-new-login',
        username: 'new_login_user',
        email: 'new@omninovel.com',
        role: 'READER',
      } as any,
    });

    const onAuthStatusSpy = vi.spyOn(activeScopeCoordinator, 'onAuthStatusChanged');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(activeScopeCoordinator.state).toBe('GUEST');

    // Trigger login
    await act(async () => {
      await result.current.login({ identifier: 'new@omninovel.com', password: 'Password123!' });
    });

    expect(result.current.status).toBe('authenticated');
    expect(onAuthStatusSpy).toHaveBeenCalledWith('authenticated', 'usr-new-login');
    expect(activeScopeCoordinator.state).toBe('ACCOUNT');
    expect(activeScopeCoordinator.activeScope).toBe('account:usr-new-login');
  });
});
