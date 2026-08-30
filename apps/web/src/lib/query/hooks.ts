'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getProgressionApi, checkinApi } from '../api/gamification';
import { getStoriesApi } from '../api/stories';
import { useAuth } from '../auth/auth-context';
import { MediaFormat, StoryStatus } from '@omninovel/shared';

export function useProgression() {
  const { isAuthenticated } = useAuth();

  return useQuery({
    queryKey: ['gamification', 'progression'],
    queryFn: getProgressionApi,
    enabled: isAuthenticated,
  });
}

export function useCheckinMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: checkinApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gamification', 'progression'] });
    },
  });
}

export function useStories(params?: {
  page?: number;
  limit?: number;
  mediaFormat?: MediaFormat;
  status?: StoryStatus;
  search?: string;
}) {
  return useQuery({
    queryKey: ['stories', params],
    queryFn: () => getStoriesApi(params),
  });
}
