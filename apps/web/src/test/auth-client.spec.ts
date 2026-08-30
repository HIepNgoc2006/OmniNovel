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

  it('Single-Flight Lock: 10 cuộc gọi refresh đồng thời chỉ kích hoạt đúng 1 lần POST /auth/refresh', async () => {
    let refreshCallCount = 0;
    const newAccessToken = 'fresh_rotated_access_token_777';

    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { data: { accessToken: newAccessToken } };
      }
      return { data: {} };
    });

    const refreshPromises = Array.from({ length: 10 }).map(() => refreshAccessToken());
    const results = await Promise.all(refreshPromises);

    results.forEach((token) => {
      expect(token).toBe(newAccessToken);
    });

    expect(refreshCallCount).toBe(1);
    expect(memoryAuthStore.getAccessToken()).toBe(newAccessToken);
    expect(memoryAuthStore.getStatus()).toBe('authenticated');
  });

  it('Axios Interceptor Concurrency: 10 requests đồng thời nhận 401 đều retry thành công và refresh đúng 1 lần', async () => {
    let refreshCallCount = 0;
    const newAccessToken = 'rotated_bearer_jwt_999';
    let requestCount = 0;

    // Giả lập backend endpoint /auth/refresh
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { data: { accessToken: newAccessToken } };
      }
      return { data: {} };
    });

    // Mock apiClient adapter để trả về 401 ở lần đầu, và 200 OK khi có token mới
    const customAdapter = async (config: any) => {
      requestCount++;
      const authHeader = config.headers?.Authorization;

      if (!authHeader || authHeader !== `Bearer ${newAccessToken}`) {
        const error: any = new Error('Request failed with status code 401');
        error.response = {
          status: 401,
          data: { message: 'Unauthorized' },
          statusText: 'Unauthorized',
          headers: {},
          config,
        };
        error.config = config;
        return Promise.reject(error);
      }

      return {
        data: { success: true, storyId: 'story-uuid-123' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };

    apiClient.defaults.adapter = customAdapter;

    // Bắn 10 request đồng thời qua apiClient
    const requests = Array.from({ length: 10 }).map((_, idx) =>
      apiClient.get(`/stories/item-${idx}`),
    );

    const responses = await Promise.all(requests);

    // Xác nhận cả 10 response đều trả về data thành công sau retry
    responses.forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    // Invariant: refreshAccessToken chỉ chạy đúng 1 lần duy nhất cho toàn bộ 10 requests
    expect(refreshCallCount).toBe(1);
    expect(memoryAuthStore.getAccessToken()).toBe(newAccessToken);
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
