import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_PROVIDERS,
  LOCAL_PROVIDERS,
  isExternalProvider,
  requiresExternalConsent,
  validateJobCreationForm,
  shouldReuseIdempotencyKey,
  classifyJobCreationError,
  FrozenJobSubmission,
  JobCreationFormData,
} from '../lib/studio/studio-job-creation-policy';
import { CreateTranslationJobRequest } from '@omninovel/shared';

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

describe('Studio Job Creation Pure Policy (#146 Task 2)', () => {
  describe('Provider Categories and Consent Requirements', () => {
    it('correctly identifies external providers requiring explicit consent', () => {
      for (const provider of EXTERNAL_PROVIDERS) {
        expect(isExternalProvider(provider)).toBe(true);
        expect(requiresExternalConsent(provider)).toBe(true);
      }
    });

    it('correctly identifies local/mock providers not forcing consent', () => {
      for (const provider of LOCAL_PROVIDERS) {
        expect(isExternalProvider(provider)).toBe(false);
        expect(requiresExternalConsent(provider)).toBe(false);
      }
    });

    it('handles undefined or unknown provider as non-external by default or falls back gracefully', () => {
      expect(isExternalProvider(undefined)).toBe(false);
      expect(requiresExternalConsent(undefined)).toBe(false);
      expect(isExternalProvider('MOCK')).toBe(false);
    });
  });

  describe('validateJobCreationForm', () => {
    const validBaseForm: JobCreationFormData = {
      chapterVersionId: '11111111-1111-4111-8111-111111111111',
      sourceLang: 'ja',
      targetLang: 'vi',
      provider: 'MOCK',
      externalConsent: false,
    };

    it('passes for a valid form with local provider without consent', () => {
      const result = validateJobCreationForm(validBaseForm);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it('rejects when chapterVersionId is missing', () => {
      const result = validateJobCreationForm({
        ...validBaseForm,
        chapterVersionId: '',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.chapterVersionId).toBeDefined();
    });

    it('rejects when sourceLang is missing', () => {
      const result = validateJobCreationForm({
        ...validBaseForm,
        sourceLang: '',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.sourceLang).toBeDefined();
    });

    it('rejects when targetLang is missing', () => {
      const result = validateJobCreationForm({
        ...validBaseForm,
        targetLang: '',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.targetLang).toBeDefined();
    });

    it('rejects when sourceLang and targetLang are identical', () => {
      const result = validateJobCreationForm({
        ...validBaseForm,
        sourceLang: 'vi',
        targetLang: 'vi',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.targetLang).toMatch(/không được trùng/i);
    });

    it('rejects external provider when externalConsent is false or omitted', () => {
      const withoutConsent = validateJobCreationForm({
        ...validBaseForm,
        provider: 'OPENAI',
        externalConsent: false,
      });
      expect(withoutConsent.isValid).toBe(false);
      expect(withoutConsent.errors.externalConsent).toMatch(/đồng ý/i);

      const omittedConsent = validateJobCreationForm({
        ...validBaseForm,
        provider: 'OPENAI',
        externalConsent: undefined,
      });
      expect(omittedConsent.isValid).toBe(false);
      expect(omittedConsent.errors.externalConsent).toMatch(/đồng ý/i);
    });

    it('passes external provider when externalConsent is true', () => {
      const result = validateJobCreationForm({
        ...validBaseForm,
        provider: 'OPENAI',
        externalConsent: true,
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual({});
    });
  });

  describe('shouldReuseIdempotencyKey (Frozen Submission Identity)', () => {
    const basePayload: CreateTranslationJobRequest = {
      chapterVersionId: '11111111-1111-4111-8111-111111111111',
      sourceLang: 'ja',
      targetLang: 'vi',
      provider: 'OPENAI',
      externalConsent: true,
    };

    const previousSubmission: FrozenJobSubmission = {
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      payload: basePayload,
    };

    it('returns false when there is no previous submission', () => {
      expect(shouldReuseIdempotencyKey(null, basePayload, false)).toBe(false);
      expect(shouldReuseIdempotencyKey(null, basePayload, true)).toBe(false);
    });

    it('returns true on ambiguous retry with identical payload', () => {
      expect(
        shouldReuseIdempotencyKey(previousSubmission, basePayload, true),
      ).toBe(true);
    });

    it('returns false when payload has changed even if ambiguous', () => {
      const modifiedPayload = {
        ...basePayload,
        targetLang: 'en',
      };
      expect(
        shouldReuseIdempotencyKey(previousSubmission, modifiedPayload, true),
      ).toBe(false);
    });

    it('returns false when provider changed', () => {
      const modifiedPayload = {
        ...basePayload,
        provider: 'GEMINI',
      };
      expect(
        shouldReuseIdempotencyKey(previousSubmission, modifiedPayload, true),
      ).toBe(false);
    });

    it('returns false when error was not ambiguous and not an identical retry attempt', () => {
      expect(
        shouldReuseIdempotencyKey(previousSubmission, basePayload, false),
      ).toBe(false);
    });
  });

  describe('classifyJobCreationError (Ambiguity & Actionable Mapping)', () => {
    it.each([500, 502, 503, 504])(
      'classifies HTTP %i from POST /ai/jobs as ambiguous',
      (status) => {
        const parsed = classifyJobCreationError(
          makeAxiosError({
            status,
            apiCode: 'INTERNAL_SERVER_ERROR',
            message: 'Internal error',
          }),
        );
        expect(parsed.status).toBe(status);
        expect(parsed.isAmbiguous).toBe(true);
      },
    );

    it('classifies network connection failures as ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          code: 'ERR_NETWORK',
          message: 'Network Error',
        }),
      );
      expect(parsed.isAmbiguous).toBe(true);
    });

    it('classifies timeouts and aborts as ambiguous', () => {
      expect(
        classifyJobCreationError(
          makeAxiosError({
            code: 'ECONNABORTED',
            message: 'timeout exceeded',
          }),
        ).isAmbiguous,
      ).toBe(true);

      expect(
        classifyJobCreationError(
          Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          }),
        ).isAmbiguous,
      ).toBe(true);
    });

    it('classifies 400 consent required error as actionable and non-ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          status: 400,
          apiCode: 'EXTERNAL_PROVIDER_CONSENT_REQUIRED',
          message: 'Consent required',
        }),
      );
      expect(parsed.isAmbiguous).toBe(false);
      expect(parsed.message).toMatch(/đồng ý/i);
    });

    it('classifies 400 language mismatch as actionable and non-ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          status: 400,
          apiCode: 'SOURCE_LANGUAGE_MISMATCH',
          message: 'Language mismatch',
        }),
      );
      expect(parsed.isAmbiguous).toBe(false);
      expect(parsed.message).toMatch(/ngôn ngữ nguồn/i);
    });

    it('classifies 403 forbidden as actionable and non-ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          status: 403,
          apiCode: 'FORBIDDEN',
          message: 'Forbidden',
        }),
      );
      expect(parsed.isAmbiguous).toBe(false);
      expect(parsed.message).toMatch(/quyền/i);
    });

    it('classifies 404 not found as actionable and non-ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          status: 404,
          apiCode: 'NOT_FOUND',
          message: 'Not found',
        }),
      );
      expect(parsed.isAmbiguous).toBe(false);
      expect(parsed.message).toMatch(/không tìm thấy/i);
    });

    it('classifies 409 conflict as actionable and non-ambiguous', () => {
      const parsed = classifyJobCreationError(
        makeAxiosError({
          status: 409,
          apiCode: 'CONFLICT',
          message: 'Conflict',
        }),
      );
      expect(parsed.isAmbiguous).toBe(false);
      expect(parsed.message).toMatch(/xung đột/i);
    });
  });
});
