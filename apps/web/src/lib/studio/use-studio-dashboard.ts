'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ManagedStorySummaryDto,
  TranslationProjectSummaryDto,
  TranslationJobSummaryDto,
  JOB_STATUS_GROUPS,
  JobStatusGroup,
} from '@omninovel/shared';
import {
  fetchManagedStories,
  fetchTranslationProjects,
  fetchTranslationJobs,
  FetchTranslationJobsQuery,
} from '../api/translation';
import { useTranslationSocket, JobProgressEvent } from '../websocket/use-translation-socket';

export interface UseStudioDashboardOptions {
  initialLimit?: number;
}

export interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useStudioDashboard(options: UseStudioDashboardOptions = {}) {
  const { initialLimit = 20 } = options;

  // Filter states
  const [filterGroup, setFilterGroupState] = useState<JobStatusGroup>('ALL');
  const [searchKeyword, setSearchKeywordState] = useState<string>('');
  const [selectedStoryId, setSelectedStoryIdState] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(null);
  const [page, setPageState] = useState<number>(1);
  const [limit] = useState<number>(initialLimit);

  // Data states
  const [stories, setStories] = useState<ManagedStorySummaryDto[]>([]);
  const [projects, setProjects] = useState<TranslationProjectSummaryDto[]>([]);
  const [jobs, setJobs] = useState<TranslationJobSummaryDto[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: initialLimit,
    total: 0,
    totalPages: 1,
  });

  // Loading & error states
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [isJobsLoading, setIsJobsLoading] = useState<boolean>(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Ref to hold fetchJobs for realtime callbacks without stale closure
  const fetchJobsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Function to fetch jobs with current filters
  const fetchJobs = useCallback(
    async (overridePage?: number) => {
      const targetPage = overridePage ?? page;
      setIsJobsLoading(true);
      setError(null);
      try {
        const query: FetchTranslationJobsQuery = {
          page: targetPage,
          limit,
        };

        if (filterGroup !== 'ALL') {
          query.statuses = JOB_STATUS_GROUPS[filterGroup];
        }

        if (searchKeyword.trim().length > 0) {
          query.search = searchKeyword.trim();
        }

        if (selectedStoryId) {
          query.storyId = selectedStoryId;
        }

        if (selectedProjectId) {
          query.projectId = selectedProjectId;
        }

        const res = await fetchTranslationJobs(query);
        setJobs(res.data);
        setPagination({
          page: res.pagination.page,
          limit: res.pagination.limit,
          total: res.pagination.total,
          totalPages: res.pagination.totalPages,
        });
      } catch (err: any) {
        setError(err?.message || 'Không thể tải danh sách tiến trình dịch thuật');
      } finally {
        setIsJobsLoading(false);
      }
    },
    [page, limit, filterGroup, searchKeyword, selectedStoryId, selectedProjectId],
  );

  fetchJobsRef.current = fetchJobs;

  // Active job IDs to subscribe on WebSocket
  const activeJobIds = useMemo(() => {
    return jobs
      .filter((j) => (JOB_STATUS_GROUPS.ACTIVE as readonly string[]).includes(j.status))
      .map((j) => j.id);
  }, [jobs]);

  // Realtime acceleration with useTranslationSocket
  const handleProgress = useCallback((event: JobProgressEvent) => {
    setJobs((prevJobs) =>
      prevJobs.map((job) => {
        if (job.id === event.jobId) {
          return {
            ...job,
            progressPercentage: event.progress,
            status: event.status,
            heartbeatAt: event.timestamp || new Date().toISOString(),
          };
        }
        return job;
      }),
    );
  }, []);

  const handleTerminalOrReady = useCallback(() => {
    // Authoritative REST refetch
    void fetchJobsRef.current();
  }, []);

  const socket = useTranslationSocket({
    jobIds: activeJobIds,
    onProgress: handleProgress,
    onReady: handleTerminalOrReady,
    onFailed: handleTerminalOrReady,
    onCanceled: handleTerminalOrReady,
  });

  // Filter setters that reset page to 1
  const setFilterGroup = useCallback((group: JobStatusGroup) => {
    setFilterGroupState(group);
    setPageState(1);
  }, []);

  const setSearchKeyword = useCallback((keyword: string) => {
    setSearchKeywordState(keyword);
    setPageState(1);
  }, []);

  const setSelectedStoryId = useCallback((storyId: string | null) => {
    setSelectedStoryIdState(storyId);
    setSelectedProjectIdState(null);
    setPageState(1);
  }, []);

  const setSelectedProjectId = useCallback((projectId: string | null) => {
    setSelectedProjectIdState(projectId);
    setPageState(1);
  }, []);

  const setPage = useCallback((newPage: number) => {
    setPageState(newPage);
  }, []);

  // Fetch projects when selectedStoryId changes
  useEffect(() => {
    if (!selectedStoryId) {
      setProjects([]);
      return;
    }

    let isMounted = true;
    setIsLoadingProjects(true);
    fetchTranslationProjects({ storyId: selectedStoryId, limit: 100 })
      .then((res) => {
        if (isMounted) {
          setProjects(res.data);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch translation projects:', err);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingProjects(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedStoryId]);

  // Initial load: stories & first page of jobs concurrently
  useEffect(() => {
    let isMounted = true;
    setIsInitialLoading(true);

    const loadInitialData = async () => {
      try {
        const [storiesRes] = await Promise.all([
          fetchManagedStories({ limit: 100 }),
          fetchJobs(1),
        ]);
        if (isMounted) {
          setStories(storiesRes.data);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || 'Lỗi khi khởi tạo Studio Dashboard');
        }
      } finally {
        if (isMounted) {
          setIsInitialLoading(false);
        }
      }
    };

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []); // Run once on mount

  // When filters (filterGroup, searchKeyword, selectedStoryId, selectedProjectId, page) change after mount
  const isMountedRef = useRef(false);
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }
    void fetchJobs();
  }, [fetchJobs]);

  return {
    // State
    stories,
    projects,
    jobs,
    pagination,
    filterGroup,
    searchKeyword,
    selectedStoryId,
    selectedProjectId,
    page,
    limit,
    isInitialLoading,
    isJobsLoading,
    isLoadingProjects,
    error,
    socketStatus: {
      isConnected: socket.isConnected,
      subscriptionState: socket.subscriptionState,
    },

    // Setters
    setFilterGroup,
    setSearchKeyword,
    setSelectedStoryId,
    setSelectedProjectId,
    setPage,

    // Actions
    refetchJobs: fetchJobs,
  };
}
