'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { memoryAuthStore, AuthStatus } from './auth-store';
import { loginApi, logoutApi, getMeApi, UserProfile, LoginRequest } from '../api/auth';
import { refreshAccessToken } from '../api/client';

interface AuthContextType {
  status: AuthStatus;
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  refetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [user, setUser] = useState<UserProfile | null>(null);

  // Sync state with memory store
  useEffect(() => {
    return memoryAuthStore.subscribe(() => {
      setStatus(memoryAuthStore.getStatus());
    });
  }, []);

  const hydrateSession = useCallback(async () => {
    try {
      // 1. Gửi request POST /auth/refresh để lấy lại accessToken nếu có HttpOnly refresh cookie
      const token = await refreshAccessToken();
      if (token) {
        // 2. Hydrate thông tin user profile
        const profile = await getMeApi();
        setUser(profile);
        memoryAuthStore.setAccessToken(token);
        setStatus('authenticated');
      } else {
        // 3. Không có refresh cookie hợp lệ -> ANONYMOUS sạch sẽ, không báo lỗi
        memoryAuthStore.clear();
        setUser(null);
        setStatus('anonymous');
      }
    } catch {
      memoryAuthStore.clear();
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  const login = async (data: LoginRequest) => {
    const res = await loginApi(data);
    memoryAuthStore.setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');
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
    }
  };

  const refetchUser = async () => {
    if (memoryAuthStore.getAccessToken()) {
      try {
        const profile = await getMeApi();
        setUser(profile);
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
        login,
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
