'use client';

import { use, useEffect, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import { MediaFormat, ChapterDetailResponse } from '@omninovel/shared';
import { getChapterDetailApi } from '../../../../../../lib/api/chapters';
import { getStoryBySlugApi, ChapterItem } from '../../../../../../lib/api/stories';
import { MangaReader } from '../../../../../../components/reader/manga/manga-reader';
import { NovelReader } from '../../../../../../components/reader/novel/novel-reader';

interface ReaderPageProps {
  params: Promise<{
    slug: string;
    chapterId: string;
  }>;
  searchParams: Promise<{
    versionId?: string;
  }>;
}

export default function ReaderPage({ params, searchParams }: ReaderPageProps) {
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);
  const router = useRouter();

  const [chapterData, setChapterData] = useState<ChapterDetailResponse | null>(null);
  const [allChapters, setAllChapters] = useState<ChapterItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    setError(null);

    Promise.all([
      getChapterDetailApi(resolvedParams.chapterId, resolvedSearchParams.versionId),
      getStoryBySlugApi(resolvedParams.slug).catch(() => null),
    ])
      .then(([detail, story]) => {
        if (!isMounted) return;

        // Invariant: Kiểm tra story slug có khớp hay không (Anti-Slug Tampering)
        if (detail.story.slug !== resolvedParams.slug) {
          router.replace(`/stories/${detail.story.slug}/read/${detail.chapter.id}`);
          return;
        }

        setChapterData(detail);

        // Lấy danh sách chapters của edition hiện tại cho Chapter Drawer
        if (story && story.editions) {
          const currentEdition =
            story.editions.find((e) => e.id === detail.chapter.storyEditionId) ||
            story.editions.find((e) => e.isDefault) ||
            story.editions[0];

          if (currentEdition && currentEdition.chapters) {
            setAllChapters(currentEdition.chapters);
          }
        }

        setIsLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        if (err.response?.status === 404) {
          setError('Không tìm thấy chương truyện này.');
        } else if (err.response?.status === 403) {
          setError('Bạn không có quyền truy cập chương truyện này. Vui lòng đăng nhập.');
        } else {
          setError('Đã xảy ra lỗi khi tải dữ liệu chương truyện.');
        }
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [resolvedParams.chapterId, resolvedParams.slug, resolvedSearchParams.versionId, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full bg-slate-950 flex flex-col items-center justify-center text-slate-400">
        <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-medium">Đang chuẩn bị không gian đọc...</p>
      </div>
    );
  }

  if (error || !chapterData) {
    return (
      <div className="min-h-screen w-full bg-slate-950 flex flex-col items-center justify-center p-4 text-center">
        <div className="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
          <h2 className="text-lg font-bold text-slate-100 mb-2">Không thể tải chương truyện</h2>
          <p className="text-sm text-slate-400 mb-6">{error || 'Chương truyện không tồn tại.'}</p>
          <a
            href={`/stories/${resolvedParams.slug}`}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-semibold transition-colors inline-block"
          >
            Quay lại trang truyện
          </a>
        </div>
      </div>
    );
  }

  // Phân luồng tự động Manga vs Novel
  if (chapterData.story.mediaFormat === MediaFormat.COMIC) {
    return <MangaReader initialData={chapterData} allChapters={allChapters} />;
  }

  return <NovelReader initialData={chapterData} allChapters={allChapters} />;
}
