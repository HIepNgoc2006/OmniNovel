import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { memoryAuthStore } from '../lib/auth/auth-store';
import { apiClient, refreshAccessToken } from '../lib/api/client';

describe('Auth Memory Store & Single-Flight Refresh Invariant', () => {
  beforeEach(() => {
    memoryAuthStore.clear();
    vi.restoreAllMocks();
  });

  it('phải lưu trữ token hoàn toàn trong RAM (Memory Store) và chuyển đổi AuthStatus', () => {
    expect(memoryAuthStore.getStatus()).toBe('anonymous');
    expect(memoryAuthStore.getAccessToken()).toBeNull();

    memoryAuthStore.setAccessToken('mock_access_token_123');
    expect(memoryAuthStore.getStatus()).toBe('authenticated');
    expect(memoryAuthStore.getAccessToken()).toBe('mock_access_token_123');

    memoryAuthStore.clear();
    expect(memoryAuthStore.getStatus()).toBe('anonymous');
    expect(memoryAuthStore.getAccessToken()).toBeNull();
  });

  it('Single-Flight Invariant: 10 request đồng thời nhận 401 chỉ kích hoạt đúng 1 lần POST /auth/refresh', async () => {
    let refreshCallCount = 0;
    const newAccessToken = 'fresh_rotated_access_token_777';

    // Mock axios.post cho /auth/refresh
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCallCount++;
        // Giả lập network delay nhẹ
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { data: { accessToken: newAccessToken } };
      }
      return { data: {} };
    });

    // Chạy 10 cuộc gọi refreshAccessToken đồng thời
    const refreshPromises = Array.from({ length: 10 }).map(() => refreshAccessToken());
    const results = await Promise.all(refreshPromises);

    // Xác nhận: tất cả 10 promise đều nhận được token mới
    results.forEach((token) => {
      expect(token).toBe(newAccessToken);
    });

    // Xác nhận bất biến cốt lõi: CHỈ GỌI REFRESH ĐÚNG 1 LẦN DUY NHẤT
    expect(refreshCallCount).toBe(1);
    expect(memoryAuthStore.getAccessToken()).toBe(newAccessToken);
    expect(memoryAuthStore.getStatus()).toBe('authenticated');
  });

  it('Refresh Failure Invariant: Khi refresh thất bại, xóa sạch session và chuyển về anonymous không retry loop', async () => {
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        throw new Error('Refresh token expired or invalid (HTTP 401)');
      }
      return { data: {} };
    });

    memoryAuthStore.setAccessToken('stale_token');
    expect(memoryAuthStore.getStatus()).toBe('authenticated');

    const result = await refreshAccessToken();

    expect(result).toBeNull();
    expect(memoryAuthStore.getAccessToken()).toBeNull();
    expect(memoryAuthStore.getStatus()).toBe('anonymous');
  });
});
