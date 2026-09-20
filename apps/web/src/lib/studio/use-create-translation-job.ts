'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreateTranslationJobRequest,
  FrozenJobSubmission as SharedFrozenJobSubmission,
  ManagedStorySummaryDto,
  StudioChapterVersionSummaryDto,
} from '@omninovel/shared';
import {
  createTranslationJobApi,
  fetchManagedStories,
  fetchStudioChapterVersions,
} from '../api/translation';
import {
  Story,
  getStoryBySlugApi,
} from '../api/stories';
import {
  FrozenJobSubmission,
  JobCreationFormErrors,
  JobCreationLifecycleState,
  ParsedJobCreationError,
  classifyJobCreationError,
  isExternalProvider,
  shouldReuseIdempotencyKey,
  validateJobCreationForm,
} from './studio-job-creation-policy';

export interface UseCreateTranslationJobOptions {
  initialStorySlug?: string;
  initialChapterId?: string;
  defaultTargetLang?: string;
  defaultProvider?: string;
}

function createIdempotencyKey(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }

  throw new Error('Crypto.randomUUID() is required to create TranslationJob submissions.');
}

export function useCreateTranslationJob(
  options: UseCreateTranslationJobOptions = {},
) {
  const {
    initialStorySlug,
    initialChapterId,
    defaultTargetLang = 'vi',
    defaultProvider = 'MOCK',
  } = options;
  const router = useRouter();

  const [stories, setStories] = useState<ManagedStorySummaryDto[]>([]);
  const [storyDetail, setStoryDetail] = useState<Story | null>(null);
  const [chapterVersions, setChapterVersions] = useState<
    StudioChapterVersionSummaryDto[]
  >([]);

  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [selectedEditionId, setSelectedEditionId] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const [sourceLang, setSourceLangState] = useState('');
  const [targetLang, setTargetLangState] = useState(defaultTargetLang);
  const [provider, setProviderState] = useState(defaultProvider);
  const [externalConsent, setExternalConsentState] = useState(false);

  const [lifecycle, setLifecycle] =
    useState<JobCreationLifecycleState>('IDLE');
  const [submissionError, setSubmissionError] =
    useState<ParsedJobCreationError | null>(null);
  const [formErrors, setFormErrors] = useState<JobCreationFormErrors>({});
  const [frozenSubmission, setFrozenSubmission] =
    useState<FrozenJobSubmission | null>(null);

  const [isLoadingStories, setIsLoadingStories] = useState(true);
  const [isLoadingStoryDetail, setIsLoadingStoryDetail] = useState(false);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);

  const frozenSubmissionRef = useRef<FrozenJobSubmission | null>(null);
  const submissionInFlightRef = useRef(false);
  const storyRequestIdRef = useRef(0);
  const versionRequestIdRef = useRef(0);

  const invalidateSubmissionIdentity = useCallback(() => {
    frozenSubmissionRef.current = null;
    setFrozenSubmission(null);
    setSubmissionError(null);
    setFormErrors({});
    setLifecycle((current) =>
      current === 'SUBMITTING' ? current : 'IDLE',
    );
  }, []);

  const clearDownstreamFromStory = useCallback(() => {
    setSelectedEditionId(null);
    setSelectedChapterId(null);
    setSelectedVersionId(null);
    setChapterVersions([]);
    setSourceLangState('');
  }, []);

  const clearDownstreamFromEdition = useCallback(() => {
    setSelectedChapterId(null);
    setSelectedVersionId(null);
    setChapterVersions([]);
    setSourceLangState('');
  }, []);

  const clearDownstreamFromChapter = useCallback(() => {
    setSelectedVersionId(null);
    setChapterVersions([]);
    setSourceLangState('');
  }, []);

  const loadChapterVersions = useCallback(async (chapterId: string) => {
    const requestId = ++versionRequestIdRef.current;
    setIsLoadingVersions(true);
    setHierarchyError(null);

    try {
      const versions = await fetchStudioChapterVersions(chapterId);
      if (requestId !== versionRequestIdRef.current) {
        return [];
      }
      setChapterVersions(versions);
      return versions;
    } catch (error) {
      if (requestId === versionRequestIdRef.current) {
        setChapterVersions([]);
        setHierarchyError(
          error instanceof Error
            ? error.message
            : 'Không thể tải danh sách phiên bản nguồn.',
        );
      }
      return [];
    } finally {
      if (requestId === versionRequestIdRef.current) {
        setIsLoadingVersions(false);
      }
    }
  }, []);

  const loadStoryBySlug = useCallback(async (slug: string) => {
    const requestId = ++storyRequestIdRef.current;
    setIsLoadingStoryDetail(true);
    setHierarchyError(null);

    try {
      const detail = await getStoryBySlugApi(slug);
      if (requestId !== storyRequestIdRef.current) {
        return null;
      }
      setStoryDetail(detail);
      setSelectedStoryId(detail.id);
      return detail;
    } catch (error) {
      if (requestId === storyRequestIdRef.current) {
        setStoryDetail(null);
        setSelectedStoryId(null);
        setHierarchyError(
          error instanceof Error
            ? error.message
            : 'Không thể tải chi tiết bộ truyện.',
        );
      }
      return null;
    } finally {
      if (requestId === storyRequestIdRef.current) {
        setIsLoadingStoryDetail(false);
      }
    }
  }, []);

  const selectStory = useCallback(
    async (storyId: string | null) => {
      invalidateSubmissionIdentity();
      clearDownstreamFromStory();
      setStoryDetail(null);
      setSelectedStoryId(storyId);
      setHierarchyError(null);

      if (!storyId) {
        return;
      }

      const summary = stories.find((story) => story.id === storyId);
      if (!summary) {
        setSelectedStoryId(null);
        setHierarchyError('Không tìm thấy bộ truyện trong danh sách được quản lý.');
        return;
      }

      await loadStoryBySlug(summary.slug);
    },
    [
      clearDownstreamFromStory,
      invalidateSubmissionIdentity,
      loadStoryBySlug,
      stories,
    ],
  );

  const selectEdition = useCallback(
    (editionId: string | null) => {
      invalidateSubmissionIdentity();
      clearDownstreamFromEdition();
      setSelectedEditionId(editionId);
      setHierarchyError(null);
    },
    [clearDownstreamFromEdition, invalidateSubmissionIdentity],
  );

  const selectChapter = useCallback(
    async (chapterId: string | null) => {
      invalidateSubmissionIdentity();
      clearDownstreamFromChapter();
      setSelectedChapterId(chapterId);
      setHierarchyError(null);

      if (!chapterId) {
        return;
      }

      await loadChapterVersions(chapterId);
    },
    [
      clearDownstreamFromChapter,
      invalidateSubmissionIdentity,
      loadChapterVersions,
    ],
  );

  const selectVersion = useCallback(
    (versionId: string | null) => {
      invalidateSubmissionIdentity();
      setSelectedVersionId(versionId);

      if (!versionId) {
        setSourceLangState('');
        return;
      }

      const version = chapterVersions.find((item) => item.id === versionId);
      if (!version) {
        setSelectedVersionId(null);
        setSourceLangState('');
        setHierarchyError('Không tìm thấy phiên bản nguồn đã chọn.');
        return;
      }

      setHierarchyError(null);
      setSourceLangState(version.language);
    },
    [chapterVersions, invalidateSubmissionIdentity],
  );

  const setSourceLang = useCallback(
    (value: string) => {
      invalidateSubmissionIdentity();
      setSourceLangState(value);
    },
    [invalidateSubmissionIdentity],
  );

  const setTargetLang = useCallback(
    (value: string) => {
      invalidateSubmissionIdentity();
      setTargetLangState(value);
    },
    [invalidateSubmissionIdentity],
  );

  const setProvider = useCallback(
    (value: string) => {
      invalidateSubmissionIdentity();
      setProviderState(value);
      setExternalConsentState(false);
    },
    [invalidateSubmissionIdentity],
  );

  const setExternalConsent = useCallback(
    (value: boolean) => {
      invalidateSubmissionIdentity();
      setExternalConsentState(value);
    },
    [invalidateSubmissionIdentity],
  );

  const currentPayload = useMemo<CreateTranslationJobRequest | null>(() => {
    if (!selectedVersionId) {
      return null;
    }

    return {
      chapterVersionId: selectedVersionId,
      sourceLang: sourceLang.trim(),
      targetLang: targetLang.trim(),
      provider: provider.trim() || 'MOCK',
      ...(isExternalProvider(provider)
        ? { externalConsent: externalConsent === true }
        : {}),
    };
  }, [
    selectedVersionId,
    sourceLang,
    targetLang,
    provider,
    externalConsent,
  ]);

  const validation = useMemo(
    () =>
      validateJobCreationForm({
        chapterVersionId: selectedVersionId ?? undefined,
        sourceLang,
        targetLang,
        provider,
        externalConsent,
      }),
    [selectedVersionId, sourceLang, targetLang, provider, externalConsent],
  );

  const performSubmit = useCallback(
    async (
      payload: CreateTranslationJobRequest,
      forcedIdempotencyKey?: string,
    ) => {
      if (submissionInFlightRef.current) {
        return null;
      }

      submissionInFlightRef.current = true;
      setLifecycle('SUBMITTING');
      setSubmissionError(null);
      setFormErrors({});

      const previous = frozenSubmissionRef.current;
      const shouldReuse =
        forcedIdempotencyKey !== undefined ||
        shouldReuseIdempotencyKey(
          previous,
          payload,
          lifecycle === 'SUBMISSION_OUTCOME_UNKNOWN',
        );
      const idempotencyKey =
        forcedIdempotencyKey ??
        (shouldReuse && previous
          ? previous.idempotencyKey
          : createIdempotencyKey());

      const frozen: FrozenJobSubmission = {
        idempotencyKey,
        payload,
      };
      frozenSubmissionRef.current = frozen;
      setFrozenSubmission(frozen);

      try {
        const response = await createTranslationJobApi(payload, idempotencyKey);
        setLifecycle('SUCCEEDED');
        setSubmissionError(null);
        router.push(`/studio/ai/jobs/${response.jobId}`);
        return response;
      } catch (error) {
        const parsed = classifyJobCreationError(error);
        setSubmissionError(parsed);

        if (parsed.isAmbiguous) {
          setLifecycle('SUBMISSION_OUTCOME_UNKNOWN');
        } else {
          frozenSubmissionRef.current = null;
          setFrozenSubmission(null);
          setLifecycle('FAILED');
        }

        return null;
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [lifecycle, router],
  );

  const submit = useCallback(async () => {
    if (submissionInFlightRef.current) {
      return null;
    }

    const nextValidation = validateJobCreationForm({
      chapterVersionId: selectedVersionId ?? undefined,
      sourceLang,
      targetLang,
      provider,
      externalConsent,
    });
    setFormErrors(nextValidation.errors);

    if (!nextValidation.isValid || !currentPayload) {
      return null;
    }

    return performSubmit(currentPayload);
  }, [
    selectedVersionId,
    sourceLang,
    targetLang,
    provider,
    externalConsent,
    currentPayload,
    performSubmit,
  ]);

  const retry = useCallback(async () => {
    if (
      submissionInFlightRef.current ||
      lifecycle !== 'SUBMISSION_OUTCOME_UNKNOWN'
    ) {
      return null;
    }

    const previous = frozenSubmissionRef.current;
    if (!previous || !currentPayload) {
      return null;
    }

    if (!shouldReuseIdempotencyKey(previous, currentPayload, true)) {
      invalidateSubmissionIdentity();
      return null;
    }

    return performSubmit(currentPayload, previous.idempotencyKey);
  }, [
    currentPayload,
    invalidateSubmissionIdentity,
    lifecycle,
    performSubmit,
  ]);

  const reset = useCallback(() => {
    storyRequestIdRef.current += 1;
    versionRequestIdRef.current += 1;
    submissionInFlightRef.current = false;
    frozenSubmissionRef.current = null;

    setStoryDetail(null);
    setChapterVersions([]);
    setSelectedStoryId(null);
    setSelectedEditionId(null);
    setSelectedChapterId(null);
    setSelectedVersionId(null);
    setSourceLangState('');
    setTargetLangState(defaultTargetLang);
    setProviderState(defaultProvider);
    setExternalConsentState(false);
    setLifecycle('IDLE');
    setSubmissionError(null);
    setFormErrors({});
    setFrozenSubmission(null);
    setHierarchyError(null);
    setIsLoadingStoryDetail(false);
    setIsLoadingVersions(false);
  }, [defaultProvider, defaultTargetLang]);

  useEffect(() => {
    let active = true;
    setIsLoadingStories(true);

    const loadInitial = async () => {
      try {
        const storiesResponse = await fetchManagedStories({ limit: 100 });
        if (!active) return;
        setStories(storiesResponse.data);

        if (!initialStorySlug) {
          return;
        }

        const detail = await loadStoryBySlug(initialStorySlug);
        if (!active || !detail || !initialChapterId) {
          return;
        }

        const edition = detail.editions?.find((candidate) =>
          candidate.chapters?.some((chapter) => chapter.id === initialChapterId),
        );

        if (!edition) {
          setHierarchyError(
            'Chapter deep-link không thuộc Story/Edition đã chọn.',
          );
          return;
        }

        setSelectedEditionId(edition.id);
        setSelectedChapterId(initialChapterId);
        await loadChapterVersions(initialChapterId);
      } catch (error) {
        if (active) {
          setHierarchyError(
            error instanceof Error
              ? error.message
              : 'Không thể khởi tạo workflow tạo bản dịch.',
          );
        }
      } finally {
        if (active) {
          setIsLoadingStories(false);
        }
      }
    };

    void loadInitial();

    return () => {
      active = false;
      storyRequestIdRef.current += 1;
      versionRequestIdRef.current += 1;
    };
  }, [initialStorySlug, initialChapterId, loadChapterVersions, loadStoryBySlug]);

  return {
    stories,
    storyDetail,
    chapterVersions,
    selectedStoryId,
    selectedEditionId,
    selectedChapterId,
    selectedVersionId,
    sourceLang,
    targetLang,
    provider,
    externalConsent,
    lifecycle,
    isSubmitting: lifecycle === 'SUBMITTING',
    submissionError,
    formErrors,
    frozenSubmission,
    hierarchyError,
    isLoadingStories,
    isLoadingStoryDetail,
    isLoadingVersions,
    canSubmit: validation.isValid && lifecycle !== 'SUBMITTING',

    selectStory,
    selectEdition,
    selectChapter,
    selectVersion,
    setSourceLang,
    setTargetLang,
    setProvider,
    setExternalConsent,
    submit,
    retry,
    reset,
  };
}
