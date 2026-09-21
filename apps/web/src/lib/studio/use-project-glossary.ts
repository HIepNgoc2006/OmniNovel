'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  TranslationGlossaryItemDto,
  CreateGlossaryTermRequest,
} from '@omninovel/shared';
import {
  fetchProjectGlossary,
  createProjectGlossary,
  parseApiError,
  ParsedApiError,
} from '../api/translation';

export interface UseProjectGlossaryOptions {
  projectId?: string;
  isEnabled?: boolean;
}

export function useProjectGlossary(options: UseProjectGlossaryOptions = {}) {
  const { projectId, isEnabled = false } = options;
  const queryClient = useQueryClient();

  const queryKey = ['translation-glossary', projectId];

  const glossaryQuery = useQuery<TranslationGlossaryItemDto[], Error>({
    queryKey,
    queryFn: () => {
      if (!projectId) return Promise.resolve([]);
      return fetchProjectGlossary(projectId);
    },
    enabled: Boolean(projectId) && isEnabled,
    staleTime: 1000 * 60, // 1 minute
  });

  const createMutation = useMutation<
    TranslationGlossaryItemDto,
    ParsedApiError,
    Omit<CreateGlossaryTermRequest, 'projectId'>
  >({
    mutationFn: async (payload) => {
      if (!projectId) {
        throw {
          code: 'MISSING_PROJECT_ID',
          message: 'Không tìm thấy ID dự án.',
        } as ParsedApiError;
      }
      try {
        return await createProjectGlossary({
          projectId,
          ...payload,
        });
      } catch (err) {
        throw parseApiError(err);
      }
    },
    onSuccess: (createdTerm) => {
      if (!projectId) return;
      queryClient.setQueryData<TranslationGlossaryItemDto[]>(queryKey, (old) => {
        const list = Array.isArray(old) ? [...old] : [];
        const index = list.findIndex((item) => item.sourceTerm === createdTerm.sourceTerm);
        if (index >= 0) {
          list[index] = createdTerm;
        } else {
          list.unshift(createdTerm);
        }
        return list;
      });
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    terms: glossaryQuery.data ?? [],
    isLoading: glossaryQuery.isLoading,
    isFetching: glossaryQuery.isFetching,
    isError: glossaryQuery.isError,
    error: glossaryQuery.error,
    refetch: glossaryQuery.refetch,
    createTerm: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createError: createMutation.error,
    resetCreateError: createMutation.reset,
  };
}
