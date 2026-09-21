import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GlossaryModal } from '../components/studio/glossary/glossary-modal';
import * as translationApi from '../lib/api/translation';
import { GlossaryDisplayTerm, TranslationGlossaryItemDto } from '@omninovel/shared';

vi.mock('../lib/api/translation', async (importOriginal) => {
  const actual = await importOriginal<typeof translationApi>();
  return {
    ...actual,
    fetchProjectGlossary: vi.fn(),
    createProjectGlossary: vi.fn(),
  };
});

describe('GlossaryModal Component (#151)', () => {
  let queryClient: QueryClient;
  const projectId = 'proj-999';

  const initialLiveTerms: TranslationGlossaryItemDto[] = [
    {
      id: 'term-live-1',
      projectId,
      sourceTerm: 'Hero',
      targetTerm: 'Anh hùng',
      category: 'CHARACTER_NAME',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const snapshotTerms: GlossaryDisplayTerm[] = [
    {
      sourceTerm: 'Demon Lord',
      targetTerm: 'Ma vương',
      category: 'CHARACTER_NAME',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(translationApi, 'fetchProjectGlossary').mockResolvedValue([...initialLiveTerms]);
  });

  function renderModal(props: Partial<React.ComponentProps<typeof GlossaryModal>> = {}) {
    return render(
      <QueryClientProvider client={queryClient}>
        <GlossaryModal
          isOpen={true}
          onClose={vi.fn()}
          projectId={projectId}
          snapshotTerms={snapshotTerms}
          {...props}
        />
      </QueryClientProvider>,
    );
  }

  it('renders modal and defaults to LIVE tab with fetched terms and creation form', async () => {
    renderModal();

    expect(screen.getByTestId('glossary-tab-live')).toBeInTheDocument();
    expect(screen.getByTestId('glossary-tab-snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('create-glossary-form')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Hero')).toBeInTheDocument();
      expect(screen.getByText('Anh hùng')).toBeInTheDocument();
    });
  });

  it('switches to SNAPSHOT tab, displays notice and snapshot items without mutation form', async () => {
    renderModal();

    fireEvent.click(screen.getByTestId('glossary-tab-snapshot'));

    expect(screen.getByTestId('glossary-snapshot-notice')).toBeInTheDocument();
    expect(screen.getByText('Demon Lord')).toBeInTheDocument();
    expect(screen.getByText('Ma vương')).toBeInTheDocument();

    // Invariant: Snapshot tab has no mutation form
    expect(screen.queryByTestId('create-glossary-form')).not.toBeInTheDocument();
  });

  it('switches automatically to LIVE tab and pre-fills input when initialSourceTerm is provided', async () => {
    const { rerender } = renderModal();

    // User is on SNAPSHOT tab
    fireEvent.click(screen.getByTestId('glossary-tab-snapshot'));
    expect(screen.getByTestId('glossary-snapshot-notice')).toBeInTheDocument();

    // Prop updates with selected text prefill
    rerender(
      <QueryClientProvider client={queryClient}>
        <GlossaryModal
          isOpen={true}
          onClose={vi.fn()}
          projectId={projectId}
          snapshotTerms={snapshotTerms}
          initialSourceTerm="Veldora"
        />
      </QueryClientProvider>,
    );

    // Should switch back to LIVE tab and prefill source input
    expect(screen.getByTestId('create-glossary-form')).toBeInTheDocument();
    const sourceInput = screen.getByTestId('glossary-source-input') as HTMLInputElement;
    expect(sourceInput.value).toBe('Veldora');
  });

  it('preserves snapshot term immutability when creating terms in Live tab', async () => {
    const originalSnapshot = [...snapshotTerms];

    const newLiveTerm: TranslationGlossaryItemDto = {
      id: 'term-new',
      projectId,
      sourceTerm: 'Tempest',
      targetTerm: 'Thành phố Tempest',
      category: 'LOCATION',
      createdAt: '2026-01-05T00:00:00.000Z',
    };
    vi.spyOn(translationApi, 'createProjectGlossary').mockResolvedValue(newLiveTerm);

    renderModal({ snapshotTerms: originalSnapshot });

    // Fill and submit form
    const sourceInput = screen.getByTestId('glossary-source-input');
    const targetInput = screen.getByTestId('glossary-target-input');
    fireEvent.change(sourceInput, { target: { value: 'Tempest' } });
    fireEvent.change(targetInput, { target: { value: 'Thành phố Tempest' } });

    fireEvent.click(screen.getByTestId('glossary-submit-btn'));

    await waitFor(() => {
      expect(translationApi.createProjectGlossary).toHaveBeenCalledWith({
        projectId,
        sourceTerm: 'Tempest',
        targetTerm: 'Thành phố Tempest',
        category: 'CHARACTER_NAME',
      });
    });

    // Verify snapshot immutability
    expect(originalSnapshot).toHaveLength(1);
    expect(originalSnapshot[0].sourceTerm).toBe('Demon Lord');
  });
});
