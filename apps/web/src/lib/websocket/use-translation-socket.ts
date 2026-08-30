'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { memoryAuthStore } from '../auth/auth-store';
import { TranslationJobStatus } from '@omninovel/shared';

export interface JobProgressEvent {
  jobId: string;
  stage: TranslationJobStatus;
  progressPercentage: number;
  attemptNumber: number;
  sequence: number;
  timestamp: string;
}

export interface JobReadyEvent {
  jobId: string;
  resultManifest: Record<string, any>;
  timestamp: string;
}

export interface JobFailedEvent {
  jobId: string;
  errorMessage?: string;
  timestamp: string;
}

export interface UseTranslationSocketOptions {
  jobId?: string;
  onProgress?: (event: JobProgressEvent) => void;
  onReady?: (event: JobReadyEvent) => void;
  onFailed?: (event: JobFailedEvent) => void;
  onCanceled?: (data: { jobId: string; reason?: string }) => void;
}

const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';

export function useTranslationSocket({
  jobId,
  onProgress,
  onReady,
  onFailed,
  onCanceled,
}: UseTranslationSocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastProgress, setLastProgress] = useState<JobProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectSocket = useCallback(() => {
    const token = memoryAuthStore.getAccessToken();
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    // Nếu socket đã kết nối với đúng token, không cần tạo mới
    if (socketRef.current?.connected) {
      return;
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    // Kết nối tới namespace canonical /ws/ai
    const socket = io(`${WS_BASE_URL}/ws/ai`, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setError(null);
      if (jobId) {
        socket.emit('subscribe_job', { jobId });
      }
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      setError(err.message);
      setIsConnected(false);
    });

    socket.on('job_progress', (data: JobProgressEvent) => {
      if (!jobId || data.jobId === jobId) {
        setLastProgress(data);
        onProgress?.(data);
      }
    });

    socket.on('job_ready_for_review', (data: JobReadyEvent) => {
      if (!jobId || data.jobId === jobId) {
        onReady?.(data);
      }
    });

    socket.on('job_failed', (data: JobFailedEvent) => {
      if (!jobId || data.jobId === jobId) {
        onFailed?.(data);
      }
    });

    socket.on('job_canceled', (data: { jobId: string; reason?: string }) => {
      if (!jobId || data.jobId === jobId) {
        onCanceled?.(data);
      }
    });

    socketRef.current = socket;
  }, [jobId, onProgress, onReady, onFailed, onCanceled]);

  useEffect(() => {
    connectSocket();

    // Lắng nghe sự kiện token rotation để reconnect với token mới
    const unsubscribe = memoryAuthStore.subscribe(() => {
      const currentToken = memoryAuthStore.getAccessToken();
      if (currentToken && socketRef.current) {
        socketRef.current.auth = { token: currentToken };
        if (!socketRef.current.connected) {
          socketRef.current.connect();
        }
      } else if (!currentToken && socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
    });

    return () => {
      unsubscribe();
      if (socketRef.current) {
        if (jobId) {
          socketRef.current.emit('unsubscribe_job', { jobId });
        }
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [connectSocket, jobId]);

  return {
    isConnected,
    lastProgress,
    error,
    subscribeJob: (id: string) => {
      socketRef.current?.emit('subscribe_job', { jobId: id });
    },
    unsubscribeJob: (id: string) => {
      socketRef.current?.emit('unsubscribe_job', { jobId: id });
    },
  };
}
