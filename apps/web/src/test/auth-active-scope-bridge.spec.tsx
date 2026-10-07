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

    // Coordinator fails closed to anonymous/GUEST
    expect(result.current.status).toBe('anonymous');
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(activeScopeCoordinator.state).toBe('GUEST');
    expect(activeScopeCoordinator.activeScope).toMatch(/^guest:/);
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
    expect(onAuthStatusSpy).toHaveBeenCalledWith('authenticated', 'usr-new-login', {
      deferScopeResolution: true,
    });
    expect(activeScopeCoordinator.state).toBe('ACCOUNT');
    expect(activeScopeCoordinator.activeScope).toBe('account:usr-new-login');
  });

  it('resolves account scope and syncs user upon successful register() (Task 7B.3a Canonical Register)', async () => {
    vi.spyOn(authApi, 'registerApi').mockResolvedValue({
      message: 'Đăng ký thành công',
      accessToken: 'jwt-register-token',
      user: {
        id: 'usr-new-reg',
        username: 'new_registered',
        email: 'reg@omninovel.com',
        role: 'READER',
      },
    });

    const onAuthStatusSpy = vi.spyOn(activeScopeCoordinator, 'onAuthStatusChanged');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    // Trigger register
    await act(async () => {
      await result.current.register!({
        email: 'reg@omninovel.com',
        username: 'new_registered',
        password: 'Password123!',
      });
    });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.user).toEqual({
      id: 'usr-new-reg',
      username: 'new_registered',
      email: 'reg@omninovel.com',
      role: 'READER',
    });
    expect(onAuthStatusSpy).toHaveBeenCalledWith('authenticated', 'usr-new-reg', {
      deferScopeResolution: true,
    });
    expect(activeScopeCoordinator.state).toBe('ACCOUNT');
    expect(activeScopeCoordinator.activeScope).toBe('account:usr-new-reg');
  });

  it('fails-closed to anonymous/GUEST if hydrateSession returns profile with missing id', async () => {
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue('jwt-corrupted-token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      // Missing id!
      username: 'corrupted_user',
      email: 'corrupted@omninovel.com',
      role: 'READER',
    } as any);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    // INVARIANT: Never leave session authenticated with null scope!
    expect(result.current.status).toBe('anonymous');
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(activeScopeCoordinator.state).toBe('GUEST');
    expect(activeScopeCoordinator.activeScope).toMatch(/^guest:/);
  });

  it('fails-closed and throws error if login() returns user with missing id', async () => {
    vi.spyOn(clientApi, 'refreshAccessToken').mockResolvedValue(null);
    vi.spyOn(authApi, 'loginApi').mockResolvedValue({
      accessToken: 'jwt-bad-token',
      user: {
        // Missing id!
        username: 'bad_user',
        email: 'bad@omninovel.com',
        role: 'READER',
      } as any,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    await expect(
      act(async () => {
        await result.current.login({ identifier: 'bad@omninovel.com', password: 'Password123!' });
      })
    ).rejects.toThrow('Thông tin người dùng không hợp lệ');

    expect(result.current.status).toBe('anonymous');
    expect(result.current.isAuthenticated).toBe(false);
    expect(activeScopeCoordinator.state).toBe('GUEST');
  });

  it('getReadingStateRepository throws ScopeNotResolvedError on BOOTSTRAPPING or TRANSITIONING', async () => {
    const { getReadingStateRepository, ScopeNotResolvedError } = await import(
      '../lib/storage/reading-state-repository'
    );

    expect(() => getReadingStateRepository('BOOTSTRAPPING')).toThrow(ScopeNotResolvedError);
    expect(() => getReadingStateRepository('TRANSITIONING')).toThrow(ScopeNotResolvedError);
    expect(() => getReadingStateRepository('GUEST')).not.toThrow();
    expect(() => getReadingStateRepository('ACCOUNT')).not.toThrow();
  });
});
