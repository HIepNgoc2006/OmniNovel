'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ChapterDetailResponse, MediaAssetType } from '@omninovel/shared';
import { useReaderSettings } from '../../../lib/reader/use-reader-settings';
import { useReadingProgress } from '../../../lib/reader/use-reading-progress';
import { ChapterItem } from '../../../lib/api/stories';
import { getMediaPresignedUrlApi } from '../../../lib/api/chapters';
import { getCachedAsset, setCachedAsset } from '../../../lib/reader/offline-cache';
import { NovelHud } from './novel-hud';
import { NovelContentRenderer } from './novel-content-renderer';
import { NovelSettingsModal } from './novel-settings-modal';
import { ChapterDrawer } from '../shared/chapter-drawer';
import { VersionSelectorModal } from '../shared/version-selector-modal';
import { ReadingRewardToast } from '../shared/reading-reward-toast';

interface NovelReaderProps {
  initialData: ChapterDetailResponse;
  allChapters?: ChapterItem[];
}

export function NovelReader({ initialData, allChapters = [] }: NovelReaderProps) {
  const router = useRouter();
  const { settings, updateNovelSettings } = useReaderSettings();
  const [data, setData] = useState<ChapterDetailResponse>(initialData);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [isLoadingContent, setIsLoadingContent] = useState<boolean>(true);
  const [isHudVisible, setIsHudVisible] = useState<boolean>(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isVersionModalOpen, setIsVersionModalOpen] = useState<boolean>(false);

  const lastScrollYRef = useRef(0);

  const {
    scrollProgress,
    readChapterIds,
    rewardStatus,
    showRewardToast,
    dismissRewardToast,
    updateProgress,
  } = useReadingProgress({
    storyId: data.story.id,
    chapterId: data.chapter.id,
    chapterVersionId: data.activeVersion?.id,
    readingMode: 'NOVEL',
  });

  // 1. Tải nội dung HTML từ NOVEL_HTML asset
  useEffect(() => {
    let isMounted = true;
    const htmlAsset = data.mediaAssets.find((a) => a.assetType === MediaAssetType.NOVEL_HTML);

    if (!htmlAsset) {
      // Fallback nếu không có file HTML riêng (ví dụ chapter placeholder)
      setHtmlContent(
        `<p class="text-center text-slate-400 italic">Chương này chưa có nội dung văn bản nào.</p>`,
      );
      setIsLoadingContent(false);
      return;
    }

    const versionId = data.activeVersion?.id || 'default';
    const isRestricted = !data.activeVersion?.isPublished;

    // Thử lấy từ Offline Cache trước
    getCachedAsset(htmlAsset.id, versionId).then((cached) => {
      if (cached && typeof cached.content === 'string' && isMounted) {
        setHtmlContent(cached.content);
        setIsLoadingContent(false);
      }
    });

    // Lấy Presigned URL để fetch nội dung mới nhất
    getMediaPresignedUrlApi(htmlAsset.id)
      .then((res) => {
        if (!res.downloadUrl) throw new Error('No download URL');
        return fetch(res.downloadUrl);
      })
      .then((res) => res.text())
      .then((text) => {
        if (isMounted) {
          setHtmlContent(text);
          setIsLoadingContent(false);
          setCachedAsset(htmlAsset.id, versionId, text, 'text/html', isRestricted);
        }
      })
      .catch(() => {
        if (isMounted && !htmlContent) {
          setHtmlContent(
            `<p class="text-center text-rose-400">Không thể tải nội dung chương truyện. Vui lòng kiểm tra kết nối mạng.</p>`,
          );
          setIsLoadingContent(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [data.activeVersion?.id, data.mediaAssets]);

  // 2. Theo dõi sự kiện cuộn trang
  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? (currentScrollY / docHeight) * 100 : 0;

      updateProgress(progress, currentScrollY);

      if (currentScrollY > lastScrollYRef.current + 25) {
        setIsHudVisible(false);
      } else if (currentScrollY < lastScrollYRef.current - 25) {
        setIsHudVisible(true);
      }
      lastScrollYRef.current = currentScrollY;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [updateProgress]);

  // 3. Phím tắt bàn phím
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName) ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey
      ) {
        return;
      }

      if (e.key === 'm' || e.key === 'M') {
        setIsHudVisible((prev) => !prev);
      } else if (e.key === 's' || e.key === 'S') {
        setIsSettingsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelectVersion = (versionId: string) => {
    router.push(`/stories/${data.story.slug}/read/${data.chapter.id}?versionId=${versionId}`);
  };

  const themeWrapperClass =
    settings.novel.theme === 'sepia'
      ? 'bg-[#f7efe1] text-[#2d2319]'
      : settings.novel.theme === 'light'
      ? 'bg-white text-slate-900'
      : 'bg-[#0f172a] text-[#f8fafc]';

  return (
    <div
      data-reader-theme={settings.novel.theme}
      className={`relative min-h-screen ${themeWrapperClass} transition-colors duration-200`}
    >
      {/* Smart HUD */}
      <NovelHud
        isVisible={isHudVisible}
        storySlug={data.story.slug}
        storyTitle={data.story.title}
        chapterNumber={data.chapter.chapterNumber}
        chapterTitle={data.chapter.title}
        progressPercentage={scrollProgress}
        theme={settings.novel.theme}
        previousChapterId={data.navigation.previous?.id || null}
        nextChapterId={data.navigation.next?.id || null}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenDrawer={() => setIsDrawerOpen(true)}
        onOpenVersionModal={() => setIsVersionModalOpen(true)}
      />

      {/* Novel Article Reading Canvas */}
      <main className="pt-16 pb-20 min-h-screen">
        {isLoadingContent ? (
          <div className="max-w-3xl mx-auto px-4 py-24 space-y-4 animate-pulse">
            <div className="h-6 bg-black/10 dark:bg-white/10 rounded w-3/4 mb-8" />
            <div className="h-4 bg-black/10 dark:bg-white/10 rounded w-full" />
            <div className="h-4 bg-black/10 dark:bg-white/10 rounded w-5/6" />
            <div className="h-4 bg-black/10 dark:bg-white/10 rounded w-full" />
            <div className="h-4 bg-black/10 dark:bg-white/10 rounded w-4/5" />
          </div>
        ) : (
          <NovelContentRenderer
            rawHtml={htmlContent}
            settings={settings.novel}
            onCenterClick={() => setIsHudVisible((prev) => !prev)}
          />
        )}
      </main>

      {/* Novel Settings Modal */}
      <NovelSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings.novel}
        onUpdateSettings={updateNovelSettings}
      />

      {/* Chapter Jump Drawer */}
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

      {/* EXP Reward Celebration Toast */}
      <ReadingRewardToast
        isVisible={showRewardToast}
        onDismiss={dismissRewardToast}
        earnedExp={rewardStatus?.earnedExp || 5}
      />
    </div>
  );
}
