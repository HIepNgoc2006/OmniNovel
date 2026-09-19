import { describe, expect, it } from 'vitest';
import {
  ApplyTranslationMode,
  ChapterVersionType,
  TranslationJobStatus,
} from '@omninovel/shared';
import {
  ApplyJobResult,
  ApplyLifecycleState,
  canApplyJob,
  classifyApplyError,
  resolveApplyBlockReason,
  resolvePostApplyReaderUrl,
} from '../lib/studio/studio-apply-policy';

const baseParams = {
  jobStatus: TranslationJobStatus.READY_FOR_REVIEW,
  canApplyPermission: true,
  freshnessStatus: 'FRESH',
  hasUncommittedDrafts: false,
  applyInFlight: false,
  materializationInFlight: false,
};

function makeAxiosError(options: {
  status?: number;
  code?: string;
  apiCode?: string;
  message?: string;
}) {
  const message = options.message ?? 'Request failed';
  return {
    isAxiosError: true,
    message,
    code: options.code,
    ...(options.status !== undefined
      ? {
          response: {
            status: options.status,
            data: {
              error: {
                code: options.apiCode ?? 'HTTP_ERROR',
                message,
              },
            },
          },
        }
      : {}),
  };
}

describe('Studio Apply pure policy (#152)', () => {
  it('blocks apply unless job is READY_FOR_REVIEW', () => {
    expect(
      canApplyJob({
        ...baseParams,
        jobStatus: TranslationJobStatus.APPLIED,
      }),
    ).toBe(false);
  });

  it('blocks apply without apply permission', () => {
    expect(
      canApplyJob({
        ...baseParams,
        canApplyPermission: false,
      }),
    ).toBe(false);
  });

  it('blocks apply unless materialization freshness is FRESH', () => {
    expect(
      canApplyJob({
        ...baseParams,
        freshnessStatus: 'STALE',
      }),
    ).toBe(false);
  });

  it('blocks apply when any uncommitted draft exists', () => {
    expect(
      canApplyJob({
        ...baseParams,
        hasUncommittedDrafts: true,
      }),
    ).toBe(false);
  });

  it('blocks apply while apply or materialization is in flight', () => {
    expect(canApplyJob({ ...baseParams, applyInFlight: true })).toBe(false);
    expect(
      canApplyJob({ ...baseParams, materializationInFlight: true }),
    ).toBe(false);
  });

  it('allows apply only when all six gates pass', () => {
    expect(canApplyJob(baseParams)).toBe(true);
    expect(resolveApplyBlockReason(baseParams)).toBeNull();
  });

  it('returns a deterministic first blocking reason', () => {
    expect(
      resolveApplyBlockReason({
        ...baseParams,
        canApplyPermission: false,
        hasUncommittedDrafts: true,
      }),
    ).toBe('Bạn không có quyền xuất bản bản dịch này.');
  });

  it.each([
    ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION,
    ApplyTranslationMode.CREATE_ALTERNATE_VERSION,
  ])('builds an explicit reader version deep-link for %s', (_mode) => {
    const response = {
      chapterId: 'chapter-1',
      activeVersionId: 'version-active',
      targetVersionId: 'version-target',
      versionNumber: 2,
      versionType: ChapterVersionType.AI_TRANSLATED,
      isAlreadyApplied: false,
    };

    expect(resolvePostApplyReaderUrl('my-story', response)).toBe(
      '/stories/my-story/read/chapter-1?versionId=version-target',
    );
  });

  it.each([
    [400, 'BAD_REQUEST'],
    [403, 'FORBIDDEN'],
    [409, 'IDEMPOTENCY_CONFLICT'],
    [409, 'ARTIFACT_STALE'],
    [422, 'UNPROCESSABLE_ENTITY'],
  ])(
    'classifies authoritative HTTP %i / %s as non-ambiguous',
    (status, apiCode) => {
      const parsed = classifyApplyError(
        makeAxiosError({ status, apiCode, message: apiCode }),
      );

      expect(parsed).toMatchObject({
        status,
        code: apiCode,
        message: apiCode,
        isAmbiguous: false,
      });
    },
  );

  it.each([500, 502, 503, 504])(
    'classifies HTTP %i from POST apply as ambiguous',
    (status) => {
      const parsed = classifyApplyError(
        makeAxiosError({
          status,
          apiCode: 'INTERNAL_SERVER_ERROR',
          message: 'server failed after submission',
        }),
      );

      expect(parsed.status).toBe(status);
      expect(parsed.isAmbiguous).toBe(true);
    },
  );

  it('classifies Axios network failures without a response as ambiguous', () => {
    const parsed = classifyApplyError(
      makeAxiosError({
        code: 'ERR_NETWORK',
        message: 'Network Error',
      }),
    );

    expect(parsed.status).toBeUndefined();
    expect(parsed.isAmbiguous).toBe(true);
  });

  it('classifies timeout/abort transport failures as ambiguous', () => {
    expect(
      classifyApplyError(
        makeAxiosError({
          code: 'ECONNABORTED',
          message: 'timeout of 10000ms exceeded',
        }),
      ).isAmbiguous,
    ).toBe(true);

    expect(
      classifyApplyError(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        }),
      ).isAmbiguous,
    ).toBe(true);
  });

  it('does not mark unrelated local exceptions as ambiguous', () => {
    const parsed = classifyApplyError(new Error('local invariant failed'));

    expect(parsed.code).toBe('UNHANDLED_ERROR');
    expect(parsed.isAmbiguous).toBe(false);
  });

  it('exports the lifecycle and discriminated result contracts', () => {
    const lifecycle: ApplyLifecycleState = 'SUBMISSION_OUTCOME_UNKNOWN';
    const result: ApplyJobResult = {
      outcome: 'SUBMISSION_OUTCOME_UNKNOWN',
      error: {
        code: 'HTTP_ERROR',
        message: 'ambiguous transport',
        isAmbiguous: true,
      },
    };

    expect(lifecycle).toBe('SUBMISSION_OUTCOME_UNKNOWN');
    expect(result.outcome).toBe('SUBMISSION_OUTCOME_UNKNOWN');
  });
});
