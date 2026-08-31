'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ChapterDetailResponse } from '@omninovel/shared';
import { useReaderSettings } from '../../../lib/reader/use-reader-settings';
import { useReadingProgress } from '../../../lib/reader/use-reading-progress';
import { ChapterItem } from '../../../lib/api/stories';
import { MangaHud } from './manga-hud';
import { WebtoonView } from './webtoon-view';
import { PagedView } from './paged-view';
import { ChapterDrawer } from '../shared/chapter-drawer';
import { VersionSelectorModal } from '../shared/version-selector-modal';
import { ReadingRewardToast } from '../shared/reading-reward-toast';

interface MangaReaderProps {
  initialData: ChapterDetailResponse;
  allChapters?: ChapterItem[];
}

export function MangaReader({ initialData, allChapters = [] }: MangaReaderProps) {
  const router = useRouter();
  const { settings, updateMangaSettings } = useReaderSettings();
  const [data, setData] = useState<ChapterDetailResponse>(initialData);
  const [currentPage, setCurrentPage] = useState(1);
  const [isHudVisible, setIsHudVisible] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isVersionModalOpen, setIsVersionModalOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const lastScrollYRef = useRef(0);
  const hasRestoredScrollRef = useRef(false);
  const totalPages = data.mediaAssets.length;

  const {
    scrollProgress,
    readChapterIds,
    serverResume,
    rewardStatus,
    showRewardToast,
    dismissRewardToast,
    updateProgress,
  } = useReadingProgress({
    storyId: data.story.id,
    chapterId: data.chapter.id,
    chapterVersionId: data.activeVersion?.id,
    readingMode: settings.manga.mode.toUpperCase(),
  });

  // Reset scroll restore flag on chapter change
  useEffect(() => {
    hasRestoredScrollRef.current = false;
  }, [data.chapter.id]);

  // Phục hồi vị trí đọc từ Server Resume
  useEffect(() => {
    if (serverResume && !hasRestoredScrollRef.current) {
      if (serverResume.chapterId === data.chapter.id && serverResume.scrollPosition > 0) {
        hasRestoredScrollRef.current = true;
        if (settings.manga.mode === 'webtoon') {
          const timer = setTimeout(() => {
            window.scrollTo({ top: serverResume.scrollPosition, behavior: 'instant' });
          }, 50);
          return () => clearTimeout(timer);
        } else if (settings.manga.mode === 'paged') {
          const targetPage = Math.max(1, Math.min(totalPages, Math.round(serverResume.scrollPosition)));
          setCurrentPage(targetPage);
        }
      }
    }
  }, [serverResume, data.chapter.id, settings.manga.mode, totalPages]);

  // 1. Theo dõi sự kiện cuộn trang để ẩn/hiện HUD tự động trong chế độ Webtoon
  useEffect(() => {
    if (settings.manga.mode !== 'webtoon') return;

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? (currentScrollY / docHeight) * 100 : 0;

      updateProgress(progress, currentScrollY);

      if (currentScrollY > lastScrollYRef.current + 20) {
        // Cuộn xuống -> Ẩn HUD
        setIsHudVisible(false);
      } else if (currentScrollY < lastScrollYRef.current - 20) {
        // Cuộn lên -> Hiện HUD
        setIsHudVisible(true);
      }
      lastScrollYRef.current = currentScrollY;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [settings.manga.mode, updateProgress]);

  // 2. Cập nhật tiến độ đọc khi lật trang trong chế độ Paged
  const handlePageChange = useCallback(
    (page: number) => {
      const targetPage = Math.max(1, Math.min(totalPages, page));
      setCurrentPage(targetPage);
      const percentage = totalPages > 0 ? (targetPage / totalPages) * 100 : 0;
      updateProgress(percentage, targetPage);
    },
    [totalPages, updateProgress],
  );

  // 3. Phím tắt điều hướng bàn phím thông minh
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Bỏ qua nếu đang focus vào ô nhập liệu hoặc có modifier key
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName) ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey
      ) {
        return;
      }

      if (e.key === 'ArrowRight') {
        if (settings.manga.mode === 'paged') {
          if (settings.manga.direction === 'rtl') {
            handlePageChange(currentPage - 1);
          } else {
            handlePageChange(currentPage + 1);
          }
        }
      } else if (e.key === 'ArrowLeft') {
        if (settings.manga.mode === 'paged') {
          if (settings.manga.direction === 'rtl') {
            handlePageChange(currentPage + 1);
          } else {
            handlePageChange(currentPage - 1);
          }
        }
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        setIsHudVisible((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, handlePageChange, settings.manga.direction, settings.manga.mode]);

  // 4. Chuyển đổi Fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const toggleMode = () => {
    const nextMode = settings.manga.mode === 'webtoon' ? 'paged' : 'webtoon';
    updateMangaSettings({ mode: nextMode });
  };

  const toggleDirection = () => {
    const nextDir = settings.manga.direction === 'rtl' ? 'ltr' : 'rtl';
    updateMangaSettings({ direction: nextDir });
  };

  const handleSelectVersion = (versionId: string) => {
    router.push(`/stories/${data.story.slug}/read/${data.chapter.id}?versionId=${versionId}`);
  };

  return (
    <div className="relative min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center">
      {/* Smart HUD */}
      <MangaHud
        isVisible={isHudVisible}
        storySlug={data.story.slug}
        storyTitle={data.story.title}
        chapterNumber={data.chapter.chapterNumber}
        chapterTitle={data.chapter.title}
        currentPage={currentPage}
        totalPages={totalPages}
        readingMode={settings.manga.mode}
        direction={settings.manga.direction}
        isFullscreen={isFullscreen}
        previousChapterId={data.navigation.previous?.id || null}
        nextChapterId={data.navigation.next?.id || null}
        onPageChange={handlePageChange}
        onToggleMode={toggleMode}
        onToggleDirection={toggleDirection}
        onToggleFullscreen={toggleFullscreen}
        onOpenDrawer={() => setIsDrawerOpen(true)}
        onOpenVersionModal={() => setIsVersionModalOpen(true)}
      />

      {/* Main Reading Canvas */}
      <main className="w-full flex-1 pt-14 pb-16">
        {settings.manga.mode === 'webtoon' ? (
          <WebtoonView
            assets={data.mediaAssets}
            onPageVisible={(page) => setCurrentPage(page)}
            onCenterClick={() => setIsHudVisible((prev) => !prev)}
          />
        ) : (
          <PagedView
            assets={data.mediaAssets}
            currentPage={currentPage}
            direction={settings.manga.direction}
            layout={settings.manga.layout}
            onPageChange={handlePageChange}
            onCenterClick={() => setIsHudVisible((prev) => !prev)}
          />
        )}
      </main>

      {/* Chapter Drawer */}
      <ChapterDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        storySlug={data.story.slug}
        storyTitle={data.story.title}
        currentChapterId={data.chapter.id}
        chapters={allChapters}
        readChapterIds={readChapterIds}
      />

      {/* Version Selector Modal */}
      <VersionSelectorModal
        isOpen={isVersionModalOpen}
        onClose={() => setIsVersionModalOpen(false)}
        versions={data.availableVersions}
        currentVersionId={data.activeVersion?.id || null}
        onSelectVersion={handleSelectVersion}
      />

      {/* EXP Reward Toast */}
      <ReadingRewardToast
        isVisible={showRewardToast}
        onDismiss={dismissRewardToast}
        earnedExp={rewardStatus?.earnedExp || 5}
      />
    </div>
  );
}
