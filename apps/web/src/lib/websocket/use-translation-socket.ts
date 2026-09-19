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
  jobIds?: string[];
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
  subscribeJobs: (ids: string[]) => void;
  unsubscribeJobs: (ids: string[]) => void;
}

const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:8000';

export function useTranslationSocket({
  jobId,
  jobIds,
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

  // 2. Multi-Job Subscriptions Set SSoT: Retains all active subscribed jobs across reconnects
  const subscribedJobIdsRef = useRef<Set<string>>(
    new Set([
      ...(jobId ? [jobId] : []),
      ...(jobIds || []).filter(Boolean),
    ]),
  );

  const jobIdRef = useRef(jobId);
  useEffect(() => {
    jobIdRef.current = jobId;
  }, [jobId]);

  const isTargetJob = useCallback((eventJobId: string): boolean => {
    // If neither jobId nor jobIds were passed and Set is empty, allow all (tester mode in legacy studio page)
    if (subscribedJobIdsRef.current.size === 0 && !jobIdRef.current) {
      return true;
    }
    // If Set has entries, only accept if in Set
    if (subscribedJobIdsRef.current.size > 0) {
      return subscribedJobIdsRef.current.has(eventJobId);
    }
    return eventJobId === jobIdRef.current;
  }, []);

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

      // Resubscribe all active job IDs in subscribedJobIdsRef on initial connect & reconnect!
      if (subscribedJobIdsRef.current.size > 0) {
        setSubscriptionState('subscribing');
        for (const targetJob of subscribedJobIdsRef.current) {
          socket.emit('subscribe_job', { jobId: targetJob });
        }
      } else {
        setSubscriptionState('idle');
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
      if (data?.jobId && subscribedJobIdsRef.current.has(data.jobId)) {
        setSubscriptionState('subscribed');
      }
    });

    socket.on('unsubscribed', (data: { jobId?: string }) => {
      if (data?.jobId && subscribedJobIdsRef.current.has(data.jobId)) {
        subscribedJobIdsRef.current.delete(data.jobId);
        if (subscribedJobIdsRef.current.size === 0) {
          setSubscriptionState('idle');
        }
      }
    });

    socket.on('error', (err: any) => {
      setSubscriptionState('error');
      setError(err?.message || 'Lỗi WebSocket');
    });

    socket.on('job_progress', (data: JobProgressEvent) => {
      if (isTargetJob(data.jobId)) {
        setLastProgress(data);
        callbacksRef.current.onProgress?.(data);
      }
    });

    socket.on('job_ready_for_review', (data: JobReadyEvent) => {
      if (isTargetJob(data.jobId)) {
        callbacksRef.current.onReady?.(data);
      }
    });

    socket.on('job_failed', (data: JobFailedEvent) => {
      if (isTargetJob(data.jobId)) {
        callbacksRef.current.onFailed?.(data);
      }
    });

    socket.on('job_canceled', (data: JobCanceledEvent) => {
      if (isTargetJob(data.jobId)) {
        callbacksRef.current.onCanceled?.(data);
      }
    });

    socketRef.current = socket;
  }, [isTargetJob]);

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
        for (const targetJob of subscribedJobIdsRef.current) {
          socketRef.current.emit('unsubscribe_job', { jobId: targetJob });
        }
        subscribedJobIdsRef.current.clear();
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setSubscriptionState('idle');
      }
    };
  }, [connectSocket]);

  // 4. Single Job Subscription Prop Transition Lifecycle
  const prevJobIdRef = useRef<string | undefined>(jobId);
  useEffect(() => {
    const prev = prevJobIdRef.current;
    prevJobIdRef.current = jobId;

    const socket = socketRef.current;
    if (prev && prev !== jobId) {
      subscribedJobIdsRef.current.delete(prev);
      if (socket?.connected) {
        socket.emit('unsubscribe_job', { jobId: prev });
      }
    }

    if (jobId) {
      if (!subscribedJobIdsRef.current.has(jobId)) {
        subscribedJobIdsRef.current.add(jobId);
        if (socket?.connected) {
          setSubscriptionState('subscribing');
          socket.emit('subscribe_job', { jobId });
        }
      }
    } else if (subscribedJobIdsRef.current.size === 0) {
      setSubscriptionState('idle');
    }
  }, [jobId]);

  // 5. Multi-Job Subscription Prop Transition Lifecycle
  const prevJobIdsRef = useRef<string[]>(jobIds || []);
  useEffect(() => {
    const currentList = jobIds || [];
    const prevList = prevJobIdsRef.current;
    prevJobIdsRef.current = currentList;

    const socket = socketRef.current;
    const currentSet = new Set(currentList.filter(Boolean));
    const prevSet = new Set(prevList.filter(Boolean));

    // Jobs to unsubscribe
    for (const id of prevSet) {
      if (!currentSet.has(id) && id !== jobIdRef.current) {
        subscribedJobIdsRef.current.delete(id);
        if (socket?.connected) {
          socket.emit('unsubscribe_job', { jobId: id });
        }
      }
    }

    // Jobs to subscribe
    let newlyAdded = false;
    for (const id of currentSet) {
      if (id && !subscribedJobIdsRef.current.has(id)) {
        subscribedJobIdsRef.current.add(id);
        newlyAdded = true;
        if (socket?.connected) {
          socket.emit('subscribe_job', { jobId: id });
        }
      }
    }

    if (newlyAdded && socket?.connected) {
      setSubscriptionState('subscribing');
    } else if (subscribedJobIdsRef.current.size === 0) {
      setSubscriptionState('idle');
    }
  }, [jobIds]);

  const subscribeJob = useCallback((id: string) => {
    if (!id) return;
    if (!subscribedJobIdsRef.current.has(id)) {
      subscribedJobIdsRef.current.add(id);
      if (socketRef.current?.connected) {
        setSubscriptionState('subscribing');
        socketRef.current.emit('subscribe_job', { jobId: id });
      }
    }
  }, []);

  const unsubscribeJob = useCallback((id: string) => {
    if (!id) return;
    if (subscribedJobIdsRef.current.has(id)) {
      subscribedJobIdsRef.current.delete(id);
      if (socketRef.current?.connected) {
        socketRef.current.emit('unsubscribe_job', { jobId: id });
      }
      if (subscribedJobIdsRef.current.size === 0) {
        setSubscriptionState('idle');
      }
    }
  }, []);

  const subscribeJobs = useCallback((ids: string[]) => {
    if (!ids || ids.length === 0) return;
    let added = false;
    for (const id of ids) {
      if (id && !subscribedJobIdsRef.current.has(id)) {
        subscribedJobIdsRef.current.add(id);
        added = true;
        if (socketRef.current?.connected) {
          socketRef.current.emit('subscribe_job', { jobId: id });
        }
      }
    }
    if (added && socketRef.current?.connected) {
      setSubscriptionState('subscribing');
    }
  }, []);

  const unsubscribeJobs = useCallback((ids: string[]) => {
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      if (id && subscribedJobIdsRef.current.has(id)) {
        subscribedJobIdsRef.current.delete(id);
        if (socketRef.current?.connected) {
          socketRef.current.emit('unsubscribe_job', { jobId: id });
        }
      }
    }
    if (subscribedJobIdsRef.current.size === 0) {
      setSubscriptionState('idle');
    }
  }, []);

  return {
    isConnected,
    subscriptionState,
    lastProgress,
    error,
    subscribeJob,
    unsubscribeJob,
    subscribeJobs,
    unsubscribeJobs,
  };
}
