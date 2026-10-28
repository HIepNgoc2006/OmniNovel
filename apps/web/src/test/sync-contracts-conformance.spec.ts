import { describe, it, expect } from 'vitest';
import {
  SyncDomain,
  SyncOperation,
  ReadingMode,
  ClientMutation,
  MutationResultItem,
  PushMutationsBatchResponse,
  SyncChangesResponse,
  SyncSnapshotResponse,
  BookmarkMutationPayload,
  ProgressMutationPayload,
  HistoryMutationPayload,
  PreferenceMutationPayload,
} from '@omninovel/shared';

describe('Task 7C.3 — Shared Canonical Sync Contracts Conformance', () => {
  it('should export all 5 canonical SyncDomain values', () => {
    expect(SyncDomain.BOOKMARK).toBe('BOOKMARK');
    expect(SyncDomain.PROGRESS).toBe('PROGRESS');
    expect(SyncDomain.HISTORY).toBe('HISTORY');
    expect(SyncDomain.PREFERENCE).toBe('PREFERENCE');
    expect(SyncDomain.FOLLOW).toBe('FOLLOW');
  });

  it('should export canonical SyncOperation values', () => {
    expect(SyncOperation.UPSERT).toBe('UPSERT');
    expect(SyncOperation.DELETE).toBe('DELETE');
  });

  it('should reuse ReadingMode without duplicate enum collision', () => {
    expect(ReadingMode.WEBTOON).toBe('WEBTOON');
    expect(ReadingMode.PAGED).toBe('PAGED');
    expect(ReadingMode.NOVEL).toBe('NOVEL');
  });

  it('should conform to ClientMutation structure with decimal string baseServerRevision', () => {
    const mutation: ClientMutation = {
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      mutationId: '550e8400-e29b-41d4-a716-446655440001',
      domain: SyncDomain.PROGRESS,
      entityId: '550e8400-e29b-41d4-a716-446655440002',
      operation: SyncOperation.UPSERT,
      baseServerRevision: '9223372036854775807', // 64-bit BigInt Decimal String
      payload: {
        storyId: '550e8400-e29b-41d4-a716-446655440002',
        chapterId: '550e8400-e29b-41d4-a716-446655440003',
        readingMode: ReadingMode.WEBTOON,
        pageIndex: 1,
        scrollPosition: 120.5,
        progressPercentage: 45,
        observedHistoryEpoch: 1,
      } satisfies ProgressMutationPayload,
      clientCreatedAt: '2026-10-28T22:00:00.000Z',
    };

    expect(mutation.domain).toBe(SyncDomain.PROGRESS);
    expect(BigInt(mutation.baseServerRevision)).toBe(9223372036854775807n);
  });

  it('should support MutationResultItem with assignedRevision string | null and DOMAIN_NOT_SUPPORTED', () => {
    const appliedResult: MutationResultItem = {
      mutationId: '550e8400-e29b-41d4-a716-446655440001',
      status: 'APPLIED',
      assignedRevision: '105',
    };

    const notSupportedResult: MutationResultItem = {
      mutationId: '550e8400-e29b-41d4-a716-446655440002',
      status: 'DOMAIN_NOT_SUPPORTED',
      assignedRevision: null,
      reason: 'FOLLOW domain is not yet supported in Phase 7C',
    };

    const batchResponse: PushMutationsBatchResponse = {
      processedCount: 2,
      newServerRevision: '105',
      results: [appliedResult, notSupportedResult],
    };

    expect(batchResponse.results[0].status).toBe('APPLIED');
    expect(batchResponse.results[1].status).toBe('DOMAIN_NOT_SUPPORTED');
    expect(batchResponse.results[1].assignedRevision).toBeNull();
  });

  it('should accurately handle SyncChangesResponse with nextRevision and minActiveRevision', () => {
    const changesResponse: SyncChangesResponse = {
      currentServerRevision: '200',
      minActiveRevision: '50',
      nextRevision: '100',
      hasMore: true,
      changes: [
        {
          revision: '51',
          domain: SyncDomain.BOOKMARK,
          entityId: '550e8400-e29b-41d4-a716-446655440010',
          operation: SyncOperation.UPSERT,
          payload: { storyId: '550e8400-e29b-41d4-a716-446655440010' } satisfies BookmarkMutationPayload,
          createdAt: '2026-10-28T22:00:00.000Z',
        },
      ],
    };

    expect(changesResponse.hasMore).toBe(true);
    expect(changesResponse.nextRevision).toBe('100');
    // Paginated checkpoint invariant: when hasMore === true, Web Client MUST checkpoint to nextRevision
    const targetCheckpoint = changesResponse.hasMore && changesResponse.nextRevision
      ? changesResponse.nextRevision
      : changesResponse.currentServerRevision;
    expect(targetCheckpoint).toBe('100');
  });

  it('should support SnapshotData with chapterReadStates mapping and preferences', () => {
    const snapshot: SyncSnapshotResponse = {
      snapshotRevision: '500',
      minActiveRevision: '500',
      hasMore: false,
      nextCursor: null,
      data: {
        bookmarks: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            createdAt: '2026-10-28T21:00:00.000Z',
          },
        ],
        readingProgress: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            chapterId: '550e8400-e29b-41d4-a716-446655440011',
            readingMode: ReadingMode.WEBTOON,
            pageIndex: 12,
            scrollPosition: 540,
            progressPercentage: 60,
          },
        ],
        chapterReadStates: [
          {
            storyId: '550e8400-e29b-41d4-a716-446655440010',
            chapterId: '550e8400-e29b-41d4-a716-446655440011',
            chapterVersionId: null,
            maxProgressPercentage: 60,
            completedAt: null,
            lastReadAt: '2026-10-28T21:30:00.000Z',
            storyHistoryEpoch: 0,
          },
        ],
        preferences: [
          {
            key: 'theme',
            value: 'dark',
            updatedAt: '2026-10-28T21:00:00.000Z',
          },
        ],
      },
    };

    expect(snapshot.data.chapterReadStates[0].maxProgressPercentage).toBe(60);
    expect(snapshot.data.preferences[0].value).toBe('dark');
  });

  it('should safely compare large 64-bit decimal string revisions using BigInt', () => {
    const revA = '10000000000000000001';
    const revB = '10000000000000000002';
    // JavaScript Number loses precision: Number(revA) === Number(revB) is TRUE!
    expect(Number(revA) === Number(revB)).toBe(true); // Precision lost in float64
    // BigInt retains exact precision:
    expect(BigInt(revA) < BigInt(revB)).toBe(true);
    expect(BigInt(revA) === BigInt(revB)).toBe(false);
  });
});
