'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ServerResumeState } from '@omninovel/shared';
import { activeScopeCoordinator } from '../identity/active-scope-coordinator';
import {
  UpdateReadingProgressInput,
  PersistenceStatus,
  getReadingStateRepository,
} from '../storage/reading-state-repository';
import { ReadingHistoryMetadata } from '../storage/guest-reading-state-repository';
import { accountReadingStateRepository } from '../storage/account-reading-state-repository';
import { ReadChapterRewardResponse } from '../api/gamification';

export interface ReadingResumeState extends ServerResumeState {
  pageIndex?: number;
  anchorBlockId?: string | null;
  textOffset?: number | null;
}

export interface UseReadingProgressOptions {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode?: string;
  initialScrollPosition?: number;
  storyTitle?: string;
  storySlug?: string;
  storyCoverUrl?: string;
  chapterNumber?: string | number;
  chapterTitle?: string;
}

export function useReadingProgress({
  storyId,
  chapterId,
  chapterVersionId,
  readingMode = 'WEBTOON',
  initialScrollPosition = 0,
  storyTitle = 'Untitled Story',
  storySlug,
  storyCoverUrl,
  chapterNumber = '1',
  chapterTitle,
}: UseReadingProgressOptions) {
  const [readingDuration, setReadingDuration] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [readChapterIds, setReadChapterIds] = useState<string[]>([]);
  const [serverResume, setServerResume] = useState<ReadingResumeState | null>(null);
  const [rewardStatus, setRewardStatus] = useState<ReadChapterRewardResponse | null>(null);
  const [showRewardToast, setShowRewardToast] = useState(false);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('ready');

  const durationRef = useRef(0);
  const progressRef = useRef(0);
  const scrollPosRef = useRef(initialScrollPosition);
  const pageIndexRef = useRef(1);
  const anchorBlockIdRef = useRef<string | null>(null);
  const textOffsetRef = useRef<number | null>(null);
  const isRewardClaimedRef = useRef(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Bootstrap reading progress from appropriate repository (IndexedDB for Guest, Core API for Account)
  useEffect(() => {
    let isMounted = true;
    if (!storyId) return;

    activeScopeCoordinator.waitForResolvedScope().then(async () => {
      if (!isMounted) return;
      const repo = getReadingStateRepository(activeScopeCoordinator.state);

      try {
        const [progress, readIds] = await Promise.all([
          repo.getProgress(storyId),
          repo.getReadChapterIds(storyId),
        ]);

        if (!isMounted) return;

        if (readIds && Array.isArray(readIds)) {
          setReadChapterIds(readIds);
        }

        if (progress && progress.chapterId) {
          setServerResume({
            chapterId: progress.chapterId,
            chapterVersionId: progress.chapterVersionId || null,
            readingMode: progress.readingMode,
            scrollPosition: progress.scrollPosition || 0,
            progressPercentage: progress.progressPercentage || 0,
            pageIndex: progress.pageIndex ?? 1,
            anchorBlockId: progress.anchorBlockId || null,
            textOffset: progress.textOffset || null,
          });
        }
      } catch {
        // Safe fail-closed
      }
    });

    return () => {
      isMounted = false;
    };
  }, [storyId]);

  // 2. Timer đo thời gian đọc thực tế (chỉ đếm khi document visible)
  useEffect(() => {
    durationRef.current = 0;
    progressRef.current = 0;
    isRewardClaimedRef.current = false;
    setReadingDuration(0);
    setScrollProgress(0);
    setRewardStatus(null);
    setShowRewardToast(false);

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden) {
        durationRef.current += 1;
        setReadingDuration(durationRef.current);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [chapterId]);

  // 3. Thực thi lưu tiến độ qua Repository
  const persistSession = useCallback(
    async (
      percentage: number,
      scrollPos: number,
      pageIdx: number,
      anchorId: string | null,
      offset: number | null,
      customMeta?: Partial<ReadingHistoryMetadata>
    ) => {
      if (!storyId || !chapterId) return;

      setPersistenceStatus('saving');
      try {
        await activeScopeCoordinator.waitForResolvedScope();
        const repo = getReadingStateRepository(activeScopeCoordinator.state);

        const historyMeta: ReadingHistoryMetadata = {
          storyTitle: customMeta?.storyTitle || storyTitle,
          storySlug: customMeta?.storySlug || storySlug,
          storyCoverUrl: customMeta?.storyCoverUrl || storyCoverUrl,
          chapterNumber: customMeta?.chapterNumber || chapterNumber,
          chapterTitle: customMeta?.chapterTitle || chapterTitle,
        };

        await repo.saveProgress(
          {
            storyId,
            chapterId,
            chapterVersionId: chapterVersionId || null,
            readingMode,
            progressPercentage: Math.round(percentage * 100) / 100,
            scrollPosition: Math.round(scrollPos),
            pageIndex: pageIdx,
            anchorBlockId: anchorId,
            textOffset: offset,
            updatedAt: new Date().toISOString(),
            deviceTimestamp: Date.now(),
          },
          historyMeta
        );

        setPersistenceStatus('ready');
      } catch (err: any) {
        if (
          err?.name === 'QuotaExceededStorageError' ||
          err?.name === 'IndexedDbUnavailableError'
        ) {
          setPersistenceStatus('unavailable');
        } else {
          setPersistenceStatus('error');
        }
        // ZERO localStorage fallback!
      }
    },
    [
      chapterId,
      chapterNumber,
      chapterTitle,
      chapterVersionId,
      readingMode,
      storyCoverUrl,
      storyId,
      storySlug,
      storyTitle,
    ]
  );

  // 4. Debounced sync cho Account (hoặc save trực tiếp cho Guest)
  const triggerSync = useCallback(
    (
      percentage: number,
      scrollPos: number,
      pageIdx: number,
      anchorId: string | null,
      offset: number | null,
      customMeta?: Partial<ReadingHistoryMetadata>
    ) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }

      if (activeScopeCoordinator.state === 'ACCOUNT') {
        syncTimeoutRef.current = setTimeout(() => {
          persistSession(percentage, scrollPos, pageIdx, anchorId, offset, customMeta);
        }, 2000);
      } else {
        // Guest mode: save directly to local IndexedDB
        persistSession(percentage, scrollPos, pageIdx, anchorId, offset, customMeta);
      }
    },
    [persistSession]
  );

  // 5. Cập nhật tiến độ: Hỗ trợ cả Object contract (7A.4c) lẫn backward-compatible (percentage, scrollPos)
  const updateProgress = useCallback(
    (input: UpdateReadingProgressInput | number, legacyScrollPos = 0) => {
      let percentage: number;
      let scrollPos = 0;
      let pageIdx = 1;
      let anchorId: string | null = null;
      let offset: number | null = null;
      let customMeta: Partial<ReadingHistoryMetadata> | undefined;

      if (typeof input === 'number') {
        percentage = input;
        scrollPos = legacyScrollPos;
      } else {
        percentage = input.progressPercentage;
        scrollPos = input.scrollPosition ?? 0;
        pageIdx = input.pageIndex ?? 1;
        anchorId = input.anchorBlockId ?? null;
        offset = input.textOffset ?? null;
        customMeta = {
          storyTitle: input.storyTitle,
          storySlug: input.storySlug,
          storyCoverUrl: input.storyCoverUrl,
          chapterNumber: input.chapterNumber,
          chapterTitle: input.chapterTitle,
        };
      }

      const clamped = Math.min(100, Math.max(0, percentage));
      progressRef.current = clamped;
      scrollPosRef.current = scrollPos;
      pageIndexRef.current = pageIdx;
      anchorBlockIdRef.current = anchorId;
      textOffsetRef.current = offset;
      setScrollProgress(clamped);

      if (clamped >= 80) {
        setReadChapterIds((prev) =>
          prev.includes(chapterId) ? prev : [...prev, chapterId]
        );
      }

      triggerSync(clamped, scrollPos, pageIdx, anchorId, offset, customMeta);

      // 6. Kiểm tra điều kiện Gamification: chỉ cho Account, >= 45s && >= 80%
      if (
        activeScopeCoordinator.state === 'ACCOUNT' &&
        !isRewardClaimedRef.current &&
        durationRef.current >= 45 &&
        clamped >= 80
      ) {
        isRewardClaimedRef.current = true;
        accountReadingStateRepository
          .claimChapterReward({
            chapterId,
            readingDurationSeconds: durationRef.current,
            progressPercentage: clamped,
          })
          .then((res) => {
            if (res) {
              setRewardStatus(res);
              if (res.success && res.earnedExp > 0) {
                setShowRewardToast(true);
              }
            }
          })
          .catch(() => {});
      }
    },
    [chapterId, triggerSync]
  );

  // Sync khi unmount hoặc rời trang
  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      if (storyId && chapterId && progressRef.current > 0) {
        persistSession(
          progressRef.current,
          scrollPosRef.current,
          pageIndexRef.current,
          anchorBlockIdRef.current,
          textOffsetRef.current
        ).catch(() => {});
      }
    };
  }, [chapterId, persistSession, storyId]);

  return {
    readingDuration,
    scrollProgress,
    readChapterIds,
    serverResume,
    rewardStatus,
    showRewardToast,
    persistenceStatus,
    dismissRewardToast: () => setShowRewardToast(false),
    updateProgress,
  };
}
