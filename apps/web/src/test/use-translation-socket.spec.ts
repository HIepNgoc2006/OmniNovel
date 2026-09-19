import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTranslationSocket } from '../lib/websocket/use-translation-socket';
import { memoryAuthStore } from '../lib/auth/auth-store';
import { io } from 'socket.io-client';
import { TranslationJobStatus } from '@omninovel/shared';

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(),
  };
});

describe('useTranslationSocket Hardening (#149 RED 6)', () => {
  let mockSocket: any;
  let eventHandlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    memoryAuthStore.setAccessToken('initial-jwt-token');

    eventHandlers = {};
    mockSocket = {
      connected: false,
      auth: { token: 'initial-jwt-token' },
      on: vi.fn((event: string, handler: Function) => {
        eventHandlers[event] = handler;
        return mockSocket;
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => {
        mockSocket.connected = false;
        eventHandlers['disconnect']?.();
        return mockSocket;
      }),
      connect: vi.fn(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
        return mockSocket;
      }),
    };

    (io as any).mockReturnValue(mockSocket);
  });

  afterEach(() => {
    memoryAuthStore.clear();
  });

  it('1. Re-render with new inline callbacks does NOT disconnect or recreate socket transport', () => {
    let callCount = 0;
    const { rerender } = renderHook(
      ({ onProgress }) =>
        useTranslationSocket({
          jobId: 'job-1',
          onProgress,
        }),
      {
        initialProps: {
          onProgress: () => {
            callCount++;
          },
        },
      },
    );

    expect(io).toHaveBeenCalledTimes(1);

    // Simulate socket connected
    act(() => {
      mockSocket.connected = true;
      eventHandlers['connect']?.();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-1' });

    // Rerender with brand new inline callback instance
    act(() => {
      rerender({
        onProgress: () => {
          callCount += 10;
        },
      });
    });

    // Transport must not be recreated or disconnected!
    expect(io).toHaveBeenCalledTimes(1);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();

    // Trigger job_progress event and verify the updated callback is invoked
    act(() => {
      eventHandlers['job_progress']?.({
        jobId: 'job-1',
        status: TranslationJobStatus.TRANSLATING,
        progress: 50,
        timestamp: new Date().toISOString(),
      });
    });

    expect(callCount).toBe(10);
  });

  it('2. Job switch emits unsubscribe_job for old job and subscribe_job for new job without socket disconnect', () => {
    const { rerender } = renderHook(
      ({ jobId }) =>
        useTranslationSocket({
          jobId,
        }),
      {
        initialProps: { jobId: 'job-1' },
      },
    );

    act(() => {
      mockSocket.connected = true;
      eventHandlers['connect']?.();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-1' });
    mockSocket.emit.mockClear();

    // Switch to job-2
    act(() => {
      rerender({ jobId: 'job-2' });
    });

    expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-1' });
    expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-2' });
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
  });

  it('3. Ignores incoming events for stale/mismatched jobId', () => {
    const onProgress = vi.fn();
    renderHook(() =>
      useTranslationSocket({
        jobId: 'job-active',
        onProgress,
      }),
    );

    act(() => {
      mockSocket.connected = true;
      eventHandlers['connect']?.();
    });

    // Event with different jobId must be dropped
    act(() => {
      eventHandlers['job_progress']?.({
        jobId: 'job-other',
        status: TranslationJobStatus.TRANSLATING,
        progress: 40,
        timestamp: new Date().toISOString(),
      });
    });

    expect(onProgress).not.toHaveBeenCalled();

    // Event with matching jobId must be processed
    act(() => {
      eventHandlers['job_progress']?.({
        jobId: 'job-active',
        status: TranslationJobStatus.TRANSLATING,
        progress: 80,
        timestamp: new Date().toISOString(),
      });
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('4. Truthful subscriptionState transitions: idle -> subscribing -> subscribed / error', () => {
    const { result } = renderHook(() =>
      useTranslationSocket({
        jobId: 'job-1',
      }),
    );

    expect(result.current.isConnected).toBe(false);
    expect(result.current.subscriptionState).toBe('idle');

    // Transport connects
    act(() => {
      mockSocket.connected = true;
      eventHandlers['connect']?.();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.subscriptionState).toBe('subscribing');

    // Server acknowledges subscription
    act(() => {
      eventHandlers['subscribed']?.({ jobId: 'job-1' });
    });

    expect(result.current.subscriptionState).toBe('subscribed');

    // Server emits error (e.g. FORBIDDEN or NOT_FOUND)
    act(() => {
      eventHandlers['error']?.({ message: 'FORBIDDEN: Không có quyền truy cập' });
    });

    expect(result.current.subscriptionState).toBe('error');
    expect(result.current.error).toBe('FORBIDDEN: Không có quyền truy cập');
  });

  it('5. Clean unmount unsubscribes active job and disconnects socket', () => {
    const { unmount } = renderHook(() =>
      useTranslationSocket({
        jobId: 'job-1',
      }),
    );

    act(() => {
      mockSocket.connected = true;
      eventHandlers['connect']?.();
    });

    mockSocket.emit.mockClear();
    mockSocket.disconnect.mockClear();

    unmount();

    expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-1' });
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  describe('Multi-Job Subscription Persistence (#145 Task 2)', () => {
    it('6. Initializes with jobIds array and emits subscribe_job for all on connect', () => {
      renderHook(() =>
        useTranslationSocket({
          jobIds: ['job-a', 'job-b'],
        }),
      );

      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-a' });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-b' });
    });

    it('7. subscribeJobs and unsubscribeJobs dynamically manages multiple subscriptions', () => {
      const { result } = renderHook(() => useTranslationSocket());

      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      mockSocket.emit.mockClear();

      // Subscribe batch of jobs
      act(() => {
        result.current.subscribeJobs?.(['job-1', 'job-2']);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-2' });

      mockSocket.emit.mockClear();

      // Unsubscribe one job
      act(() => {
        result.current.unsubscribeJobs?.(['job-1']);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-1' });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-2' });
    });

    it('8. Automatically resubscribes all active job IDs in Set on socket reconnect', () => {
      const { result } = renderHook(() =>
        useTranslationSocket({
          jobIds: ['job-alpha', 'job-beta'],
        }),
      );

      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-alpha' });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-beta' });

      // Add a third job dynamically
      act(() => {
        result.current.subscribeJobs?.(['job-gamma']);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-gamma' });

      mockSocket.emit.mockClear();

      // Simulate connection drop (disconnect)
      act(() => {
        mockSocket.connected = false;
        eventHandlers['disconnect']?.();
      });

      // Simulate reconnect (connect)
      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      // All 3 jobs must be automatically resubscribed!
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-alpha' });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-beta' });
      expect(mockSocket.emit).toHaveBeenCalledWith('subscribe_job', { jobId: 'job-gamma' });
    });

    it('9. Incoming events for any subscribed job in jobIds are processed, mismatched are dropped', () => {
      const onProgress = vi.fn();
      renderHook(() =>
        useTranslationSocket({
          jobIds: ['job-x', 'job-y'],
          onProgress,
        }),
      );

      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      // Event for job-x (subscribed)
      act(() => {
        eventHandlers['job_progress']?.({
          jobId: 'job-x',
          status: TranslationJobStatus.TRANSLATING,
          progress: 30,
          timestamp: new Date().toISOString(),
        });
      });
      expect(onProgress).toHaveBeenCalledTimes(1);

      // Event for job-y (subscribed)
      act(() => {
        eventHandlers['job_progress']?.({
          jobId: 'job-y',
          status: TranslationJobStatus.INPAINTING,
          progress: 60,
          timestamp: new Date().toISOString(),
        });
      });
      expect(onProgress).toHaveBeenCalledTimes(2);

      // Event for job-z (not subscribed)
      act(() => {
        eventHandlers['job_progress']?.({
          jobId: 'job-z',
          status: TranslationJobStatus.OCR,
          progress: 90,
          timestamp: new Date().toISOString(),
        });
      });
      expect(onProgress).toHaveBeenCalledTimes(2); // Still 2, dropped!
    });

    it('10. Clean unmount unsubscribes all subscribed jobs in Set', () => {
      const { unmount } = renderHook(() =>
        useTranslationSocket({
          jobIds: ['job-m1', 'job-m2'],
        }),
      );

      act(() => {
        mockSocket.connected = true;
        eventHandlers['connect']?.();
      });

      mockSocket.emit.mockClear();

      unmount();

      expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-m1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('unsubscribe_job', { jobId: 'job-m2' });
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });
});
