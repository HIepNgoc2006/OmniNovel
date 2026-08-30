'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getProgressionApi, checkinApi } from '../api/gamification';
import {
  getStoriesApi,
  getFeaturedStoriesApi,
  getStoryRankingsApi,
  getStoryBySlugApi,
  GetStoriesParams,
} from '../api/stories';
import { useAuth } from '../auth/auth-context';

export function useProgression() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['gamification', 'progression', user?.id],
    queryFn: getProgressionApi,
    enabled: Boolean(user),
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

export function useStories(params?: GetStoriesParams) {
  return useQuery({
    queryKey: ['stories', params],
    queryFn: () => getStoriesApi(params),
  });
}

export function useFeaturedStories() {
  return useQuery({
    queryKey: ['stories', 'featured'],
    queryFn: getFeaturedStoriesApi,
  });
}

export function useStoryRankings() {
  return useQuery({
    queryKey: ['stories', 'rankings'],
    queryFn: getStoryRankingsApi,
  });
}

export function useStoryBySlug(slug: string) {
  return useQuery({
    queryKey: ['stories', 'detail', slug],
    queryFn: () => getStoryBySlugApi(slug),
    enabled: Boolean(slug),
  });
}
