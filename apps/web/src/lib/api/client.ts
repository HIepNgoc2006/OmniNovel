import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { memoryAuthStore } from '../auth/auth-store';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // Gửi kèm HttpOnly cookies (refreshToken) cho domain backend
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request Interceptor: Đính kèm access token từ RAM memory store
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = memoryAuthStore.getAccessToken();
    if (token && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Single-Flight Refresh Promise lock
let refreshPromise: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      // POST /auth/refresh sử dụng instance axios thuần (hoặc withCredentials) để tránh trigger loop
      const response = await axios.post<{ accessToken: string }>(
        `${API_BASE_URL}/auth/refresh`,
        {},
        { withCredentials: true },
      );

      const newToken = response.data.accessToken;
      if (newToken) {
        memoryAuthStore.setAccessToken(newToken);
        return newToken;
      }
      memoryAuthStore.clear();
      return null;
    } catch {
      memoryAuthStore.clear();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Response Interceptor: Bắt 401 và xử lý Single-Flight Refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Không intercept lỗi 401 của chính endpoint refresh hoặc login để tránh loop
    if (
      !originalRequest ||
      originalRequest.url?.includes('/auth/refresh') ||
      originalRequest.url?.includes('/auth/login') ||
      originalRequest.url?.includes('/auth/register')
    ) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const newToken = await refreshAccessToken();
      if (newToken) {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      }
    }

    return Promise.reject(error);
  },
);
