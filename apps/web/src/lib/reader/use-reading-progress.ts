'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../auth/auth-context';
import { saveReadingProgressApi, getReadingProgressApi } from '../api/stories';
import { rewardReadChapterApi, ReadChapterRewardResponse } from '../api/gamification';

interface UseReadingProgressOptions {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  readingMode?: string;
  initialScrollPosition?: number;
}

export function useReadingProgress({
  storyId,
  chapterId,
  chapterVersionId,
  readingMode = 'WEBTOON',
  initialScrollPosition = 0,
}: UseReadingProgressOptions) {
  const { isAuthenticated } = useAuth();
  const [readingDuration, setReadingDuration] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [readChapterIds, setReadChapterIds] = useState<string[]>([]);
  const [serverResume, setServerResume] = useState<{
    chapterId: string | null;
    scrollPosition: number;
    progressPercentage: number;
  } | null>(null);
  const [rewardStatus, setRewardStatus] = useState<ReadChapterRewardResponse | null>(null);
  const [showRewardToast, setShowRewardToast] = useState(false);

  const durationRef = useRef(0);
  const progressRef = useRef(0);
  const scrollPosRef = useRef(initialScrollPosition);
  const isRewardClaimedRef = useRef(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Bootstrap Server Reading Progress & Read Chapters
  useEffect(() => {
    let isMounted = true;
    if (isAuthenticated && storyId) {
      getReadingProgressApi(storyId)
        .then((res) => {
          if (!isMounted) return;
          if (res.readChapterIds && Array.isArray(res.readChapterIds)) {
            setReadChapterIds(res.readChapterIds);
          }
          if (res.chapterId) {
            setServerResume({
              chapterId: res.chapterId,
              scrollPosition: res.scrollPosition || 0,
              progressPercentage: res.progressPercentage || 0,
            });
          }
        })
        .catch(() => {
          // Fallback to local resume
          try {
            const raw = localStorage.getItem(`omninovel_reading_resume_${storyId}`);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed.chapterId) {
                setServerResume(parsed);
              }
            }
          } catch {}
        });
    } else if (storyId) {
      try {
        const raw = localStorage.getItem(`omninovel_reading_resume_${storyId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.chapterId) {
            setServerResume(parsed);
          }
        }
      } catch {}
    }
    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, storyId]);

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

  // 3. Debounced sync lên server
  const triggerSync = useCallback(() => {
    if (!isAuthenticated || !storyId || !chapterId) return;

    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }

    syncTimeoutRef.current = setTimeout(async () => {
      try {
        await saveReadingProgressApi({
          storyId,
          chapterId,
          chapterVersionId: chapterVersionId || undefined,
          readingMode,
          progressPercentage: Math.round(progressRef.current * 100) / 100,
          scrollPosition: Math.round(scrollPosRef.current),
        });
      } catch {
        // Silent catch for background sync
      }
    }, 2000);
  }, [isAuthenticated, storyId, chapterId, chapterVersionId, readingMode]);

  // 4. Cập nhật tiến độ cuộn trang / trang
  const updateProgress = useCallback(
    (percentage: number, scrollPos = 0) => {
      const clamped = Math.min(100, Math.max(0, percentage));
      progressRef.current = clamped;
      scrollPosRef.current = scrollPos;
      setScrollProgress(clamped);

      if (clamped >= 80) {
        setReadChapterIds((prev) =>
          prev.includes(chapterId) ? prev : [...prev, chapterId],
        );
      }

      // Lưu optimistic vào localStorage
      try {
        localStorage.setItem(
          `omninovel_reading_resume_${storyId}`,
          JSON.stringify({
            chapterId,
            chapterVersionId,
            progressPercentage: clamped,
            scrollPosition: scrollPos,
            updatedAt: Date.now(),
          }),
        );
      } catch {}

      // Đồng bộ server
      triggerSync();

      // 5. Kiểm tra điều kiện Gamification: >= 45s && >= 80%
      if (
        isAuthenticated &&
        !isRewardClaimedRef.current &&
        durationRef.current >= 45 &&
        clamped >= 80
      ) {
        isRewardClaimedRef.current = true;
        rewardReadChapterApi({
          chapterId,
          readingDurationSeconds: durationRef.current,
          progressPercentage: clamped,
        })
          .then((res) => {
            setRewardStatus(res);
            if (res.success && res.earnedExp > 0) {
              setShowRewardToast(true);
            }
          })
          .catch(() => {});
      }
    },
    [chapterId, chapterVersionId, isAuthenticated, storyId, triggerSync],
  );

  // Sync khi unmount hoặc rời trang
  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      if (isAuthenticated && storyId && chapterId && progressRef.current > 0) {
        saveReadingProgressApi({
          storyId,
          chapterId,
          chapterVersionId: chapterVersionId || undefined,
          readingMode,
          progressPercentage: Math.round(progressRef.current * 100) / 100,
          scrollPosition: Math.round(scrollPosRef.current),
        }).catch(() => {});
      }
    };
  }, [chapterId, chapterVersionId, isAuthenticated, readingMode, storyId]);

  return {
    readingDuration,
    scrollProgress,
    readChapterIds,
    serverResume,
    rewardStatus,
    showRewardToast,
    dismissRewardToast: () => setShowRewardToast(false),
    updateProgress,
  };
}
