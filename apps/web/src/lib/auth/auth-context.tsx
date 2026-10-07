'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { memoryAuthStore, AuthStatus } from './auth-store';
import {
  loginApi,
  logoutApi,
  getMeApi,
  registerApi,
  UserProfile,
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
} from '../api/auth';
import { refreshAccessToken } from '../api/client';
import { activeScopeCoordinator, ActiveScopeState } from '../identity/active-scope-coordinator';
import { purgeOfflineCache } from '../reader/offline-cache';
import { guestClaimCoordinator } from '../claim/guest-claim-coordinator';

interface AuthContextType {
  status: AuthStatus;
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  activeScope?: string | null;
  activeScopeState?: ActiveScopeState;
  login: (data: LoginRequest) => Promise<void>;
  register?: (data: RegisterRequest) => Promise<RegisterResponse>;
  logout: () => Promise<void>;
  refetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [activeScope, setActiveScope] = useState<string | null>(activeScopeCoordinator.activeScope);
  const [activeScopeState, setActiveScopeState] = useState<ActiveScopeState>(activeScopeCoordinator.state);

  // Sync state with coordinator
  useEffect(() => {
    return activeScopeCoordinator.subscribe((scope, state) => {
      setActiveScope(scope);
      setActiveScopeState(state);
    });
  }, []);

  // Sync state with memory store
  useEffect(() => {
    return memoryAuthStore.subscribe(() => {
      setStatus(memoryAuthStore.getStatus());
    });
  }, []);

  const hydrateSession = useCallback(async () => {
    activeScopeCoordinator.onAuthStatusChanged('initializing');
    try {
      // 1. Gửi request POST /auth/refresh để lấy lại accessToken nếu có HttpOnly refresh cookie
      const token = await refreshAccessToken();
      if (token) {
        // 2. Hydrate thông tin user profile
        const profile = await getMeApi();
        if (profile && profile.id) {
          const recoveryStatus = await guestClaimCoordinator.checkCrashRecovery(profile.id);
          if (recoveryStatus === 'NONE') {
            await activeScopeCoordinator.onAuthStatusChanged('authenticated', profile.id);
          } else if (recoveryStatus === 'PENDING_UNAVAILABLE') {
            // P0 Invariant: Fail-closed on crash recovery check error -> keep TRANSITIONING
            await activeScopeCoordinator.onAuthStatusChanged('authenticated', profile.id, {
              deferScopeResolution: true,
            });
          }
          // If 'RESOLVED': coordinator has handled resolution or dialog reopening
          memoryAuthStore.setAccessToken(token);
          setUser(profile);
          setStatus('authenticated');
        } else {
          // Thiếu profile.id -> Fail-closed về anonymous sạch sẽ
          memoryAuthStore.clear();
          setUser(null);
          setStatus('anonymous');
          await activeScopeCoordinator.onAuthStatusChanged('anonymous');
        }
      } else {
        // 3. Không có refresh cookie hợp lệ -> ANONYMOUS sạch sẽ, không báo lỗi
        memoryAuthStore.clear();
        setUser(null);
        setStatus('anonymous');
        await activeScopeCoordinator.onAuthStatusChanged('anonymous');
      }
    } catch {
      memoryAuthStore.clear();
      setUser(null);
      setStatus('anonymous');
      await activeScopeCoordinator.onAuthStatusChanged('anonymous');
    }
  }, []);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  const login = async (data: LoginRequest) => {
    const res = await loginApi(data);
    if (!res.user || !res.user.id) {
      memoryAuthStore.clear();
      setUser(null);
      setStatus('anonymous');
      await activeScopeCoordinator.onAuthStatusChanged('anonymous');
      throw new Error('Đăng nhập thất bại: Thông tin người dùng không hợp lệ.');
    }
    // P0 Invariant: Enter TRANSITIONING immediately with deferred scope resolution so mutations stay disabled
    await activeScopeCoordinator.onAuthStatusChanged('authenticated', res.user.id, {
      deferScopeResolution: true,
    });
    memoryAuthStore.setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');

    // Trigger Guest Claim flow: locks in TRANSITIONING if guest data exists, else resolves to ACCOUNT
    await guestClaimCoordinator.checkAndPrepareClaim(res.user.id);
  };

  const register = async (data: RegisterRequest): Promise<RegisterResponse> => {
    const res = await registerApi(data);
    if (res.accessToken && res.user?.id) {
      // P0 Invariant: Enter TRANSITIONING immediately with deferred scope resolution
      await activeScopeCoordinator.onAuthStatusChanged('authenticated', res.user.id, {
        deferScopeResolution: true,
      });
      memoryAuthStore.setAccessToken(res.accessToken);
      setUser(res.user);
      setStatus('authenticated');

      // Trigger Guest Claim flow: locks in TRANSITIONING if guest data exists, else resolves to ACCOUNT
      await guestClaimCoordinator.checkAndPrepareClaim(res.user.id);
    }
    return res;
  };

  const logout = async () => {
    try {
      await logoutApi();
    } catch {
      // Ignore network errors during logout
    } finally {
      memoryAuthStore.clear();
      setUser(null);
      setStatus('anonymous');
      await activeScopeCoordinator.onLogout();
      purgeOfflineCache().catch(() => {});
    }
  };

  const refetchUser = async () => {
    if (memoryAuthStore.getAccessToken()) {
      try {
        const profile = await getMeApi();
        if (profile && profile.id) {
          await activeScopeCoordinator.onAuthStatusChanged('authenticated', profile.id);
          setUser(profile);
        } else {
          memoryAuthStore.clear();
          setUser(null);
          setStatus('anonymous');
          await activeScopeCoordinator.onAuthStatusChanged('anonymous');
        }
      } catch {
        // ignore
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        isAuthenticated: status === 'authenticated',
        isLoading: status === 'initializing',
        activeScope,
        activeScopeState,
        login,
        register,
        logout,
        refetchUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
