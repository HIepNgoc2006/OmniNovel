'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { memoryAuthStore } from '../auth/auth-store';
import {
  TranslationJobStatus,
  JobProgressWsEvent,
  JobReadyWsEvent,
  JobFailedWsEvent,
  JobCanceledWsEvent,
} from '@omninovel/shared';

export type JobProgressEvent = JobProgressWsEvent;
export type JobReadyEvent = JobReadyWsEvent;
export type JobFailedEvent = JobFailedWsEvent;
export type JobCanceledEvent = JobCanceledWsEvent;

export type TranslationSocketSubscriptionState =
  | 'idle'
  | 'subscribing'
  | 'subscribed'
  | 'error';

export interface UseTranslationSocketOptions {
  jobId?: string;
  onProgress?: (event: JobProgressEvent) => void;
  onReady?: (event: JobReadyEvent) => void;
  onFailed?: (event: JobFailedEvent) => void;
  onCanceled?: (event: JobCanceledEvent) => void;
}

export interface UseTranslationSocketReturn {
  isConnected: boolean;
  subscriptionState: TranslationSocketSubscriptionState;
  lastProgress: JobProgressEvent | null;
  error: string | null;
  subscribeJob: (id: string) => void;
  unsubscribeJob: (id: string) => void;
}

const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:8000';

export function useTranslationSocket({
  jobId,
  onProgress,
  onReady,
  onFailed,
  onCanceled,
}: UseTranslationSocketOptions = {}): UseTranslationSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [subscriptionState, setSubscriptionState] =
    useState<TranslationSocketSubscriptionState>('idle');
  const [lastProgress, setLastProgress] = useState<JobProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Callback Freshness Ref: Never recreate socket transport on inline callback recreation
  const callbacksRef = useRef({ onProgress, onReady, onFailed, onCanceled });
  useEffect(() => {
    callbacksRef.current = { onProgress, onReady, onFailed, onCanceled };
  });

  // 2. Active Job ID Ref: Always read dynamic target without closing/reopening transport
  const jobIdRef = useRef(jobId);
  const activeSubscribedJobRef = useRef<string | null>(null);
  useEffect(() => {
    jobIdRef.current = jobId;
  }, [jobId]);

  // 3. Socket Transport Connection Lifecycle
  const connectSocket = useCallback(() => {
    const token = memoryAuthStore.getAccessToken();
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setSubscriptionState('idle');
      }
      return;
    }

    const authObj = socketRef.current?.auth as Record<string, any> | undefined;
    if (socketRef.current?.connected && authObj?.token === token) {
      return;
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = io(`${WS_BASE_URL}/ws/ai`, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setError(null);
      const targetJob = jobIdRef.current;
      if (targetJob) {
        setSubscriptionState('subscribing');
        activeSubscribedJobRef.current = targetJob;
        socket.emit('subscribe_job', { jobId: targetJob });
      } else {
        setSubscriptionState('idle');
        activeSubscribedJobRef.current = null;
      }
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setSubscriptionState('idle');
    });

    socket.on('connect_error', (err) => {
      setError(err.message);
      setIsConnected(false);
      setSubscriptionState('error');
    });

    socket.on('subscribed', (data: { jobId?: string }) => {
      if (data?.jobId && data.jobId === jobIdRef.current) {
        setSubscriptionState('subscribed');
      }
    });

    socket.on('unsubscribed', (data: { jobId?: string }) => {
      if (data?.jobId && data.jobId === jobIdRef.current) {
        setSubscriptionState('idle');
      }
    });

    socket.on('error', (err: any) => {
      setSubscriptionState('error');
      setError(err?.message || 'Lỗi WebSocket');
    });

    socket.on('job_progress', (data: JobProgressEvent) => {
      const targetJob = jobIdRef.current;
      if (!targetJob || data.jobId === targetJob) {
        setLastProgress(data);
        callbacksRef.current.onProgress?.(data);
      }
    });

    socket.on('job_ready_for_review', (data: JobReadyEvent) => {
      const targetJob = jobIdRef.current;
      if (!targetJob || data.jobId === targetJob) {
        callbacksRef.current.onReady?.(data);
      }
    });

    socket.on('job_failed', (data: JobFailedEvent) => {
      const targetJob = jobIdRef.current;
      if (!targetJob || data.jobId === targetJob) {
        callbacksRef.current.onFailed?.(data);
      }
    });

    socket.on('job_canceled', (data: JobCanceledEvent) => {
      const targetJob = jobIdRef.current;
      if (!targetJob || data.jobId === targetJob) {
        callbacksRef.current.onCanceled?.(data);
      }
    });

    socketRef.current = socket;
  }, []);

  useEffect(() => {
    connectSocket();

    const unsubscribe = memoryAuthStore.subscribe(() => {
      const currentToken = memoryAuthStore.getAccessToken();
      if (currentToken && socketRef.current) {
        const authRecord = socketRef.current.auth as Record<string, any> | undefined;
        if (authRecord?.token !== currentToken) {
          socketRef.current.auth = { token: currentToken };
          if (socketRef.current.connected) {
            socketRef.current.disconnect().connect();
          } else {
            socketRef.current.connect();
          }
        }
      } else if (!currentToken && socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setSubscriptionState('idle');
      } else if (currentToken && !socketRef.current) {
        connectSocket();
      }
    });

    return () => {
      unsubscribe();
      if (socketRef.current) {
        const currentJob = jobIdRef.current;
        if (currentJob) {
          socketRef.current.emit('unsubscribe_job', { jobId: currentJob });
        }
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setSubscriptionState('idle');
      }
    };
  }, [connectSocket]);

  // 4. Job Subscription Transition Lifecycle: Switch jobs without tearing down socket transport
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      if (!jobId) {
        setSubscriptionState('idle');
      }
      return;
    }

    const prevSubscribed = activeSubscribedJobRef.current;
    if (prevSubscribed && prevSubscribed !== jobId) {
      socket.emit('unsubscribe_job', { jobId: prevSubscribed });
      activeSubscribedJobRef.current = null;
    }

    if (jobId) {
      setSubscriptionState('subscribing');
      activeSubscribedJobRef.current = jobId;
      socket.emit('subscribe_job', { jobId });
    } else {
      setSubscriptionState('idle');
      activeSubscribedJobRef.current = null;
    }
  }, [jobId]);

  return {
    isConnected,
    subscriptionState,
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
