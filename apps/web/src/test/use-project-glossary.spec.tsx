import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProjectGlossary } from '../lib/studio/use-project-glossary';
import * as translationApi from '../lib/api/translation';
import { TranslationGlossaryItemDto } from '@omninovel/shared';

vi.mock('../lib/api/translation', async (importOriginal) => {
  const actual = await importOriginal<typeof translationApi>();
  return {
    ...actual,
    fetchProjectGlossary: vi.fn(),
    createProjectGlossary: vi.fn(),
  };
});

describe('useProjectGlossary Hook (#151)', () => {
  let queryClient: QueryClient;
  const projectId = 'proj-123';

  let termsStore: TranslationGlossaryItemDto[];

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    termsStore = [
      {
        id: 'term-1',
        projectId,
        sourceTerm: 'Hero',
        targetTerm: 'Anh hùng',
        category: 'CHARACTER_NAME',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'term-2',
        projectId,
        sourceTerm: 'Camelot',
        targetTerm: 'Ca-mê-lốt',
        category: 'LOCATION',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ];

    vi.spyOn(translationApi, 'fetchProjectGlossary').mockImplementation(async () => [
      ...termsStore,
    ]);

    vi.spyOn(translationApi, 'createProjectGlossary').mockImplementation(async (payload) => {
      const idx = termsStore.findIndex((t) => t.sourceTerm === payload.sourceTerm);
      const saved: TranslationGlossaryItemDto = {
        id: idx >= 0 ? termsStore[idx].id : `term-${termsStore.length + 1}`,
        projectId: payload.projectId,
        sourceTerm: payload.sourceTerm,
        targetTerm: payload.targetTerm,
        category: payload.category || 'OTHER',
        createdAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        termsStore[idx] = saved;
      } else {
        termsStore.unshift(saved);
      }
      return saved;
    });
  });

  function createWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    };
  }

  it('does NOT fetch glossary when isEnabled is false (lazy loading)', async () => {
    const { result } = renderHook(
      () => useProjectGlossary({ projectId, isEnabled: false }),
      { wrapper: createWrapper() },
    );

    expect(translationApi.fetchProjectGlossary).not.toHaveBeenCalled();
    expect(result.current.terms).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches glossary terms when isEnabled is true', async () => {
    const { result } = renderHook(
      () => useProjectGlossary({ projectId, isEnabled: true }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(translationApi.fetchProjectGlossary).toHaveBeenCalledWith(projectId);
    expect(result.current.terms).toHaveLength(2);
  });

  it('creates new term and updates query cache via exact upsert', async () => {
    const { result } = renderHook(
      () => useProjectGlossary({ projectId, isEnabled: true }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.terms).toHaveLength(2));

    await act(async () => {
      await result.current.createTerm({
        sourceTerm: 'Excalibur',
        targetTerm: 'Thánh kiếm Excalibur',
        category: 'ITEM',
      });
    });

    expect(translationApi.createProjectGlossary).toHaveBeenCalledWith({
      projectId,
      sourceTerm: 'Excalibur',
      targetTerm: 'Thánh kiếm Excalibur',
      category: 'ITEM',
    });

    await waitFor(() => {
      expect(result.current.terms.some((t) => t.sourceTerm === 'Excalibur')).toBe(true);
    });
  });

  it('updates existing term in cache when created term has exact same sourceTerm', async () => {
    const { result } = renderHook(
      () => useProjectGlossary({ projectId, isEnabled: true }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.terms).toHaveLength(2));

    await act(async () => {
      await result.current.createTerm({
        sourceTerm: 'Hero',
        targetTerm: 'Dũng sĩ tối thượng',
        category: 'CHARACTER_NAME',
      });
    });

    await waitFor(() => {
      expect(result.current.terms).toHaveLength(2);
      const heroTerm = result.current.terms.find((t) => t.sourceTerm === 'Hero');
      expect(heroTerm?.targetTerm).toBe('Dũng sĩ tối thượng');
    });
  });
});
