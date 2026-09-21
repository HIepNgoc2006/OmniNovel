'use client';

import React, { use, useState, useCallback } from 'react';
import Link from 'next/link';
import { MediaFormat } from '@omninovel/shared';
import { useReviewJobDispatcher } from '@/lib/studio/use-review-job-dispatcher';
import { MangaReviewStudio } from '@/components/studio/manga-review-studio';
import { NovelReviewStudio } from '@/components/studio/novel-review-studio';
import { GlossaryModal } from '@/components/studio/glossary/glossary-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  RefreshCw,
  AlertTriangle,
  BookOpen,
  ShieldAlert,
  ChevronLeft,
} from 'lucide-react';

interface PageProps {
  params: Promise<{ jobId: string }>;
}

export default function TranslationReviewJobPage({ params }: PageProps) {
  const { jobId } = use(params);
  const dispatcher = useReviewJobDispatcher(jobId);

  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);
  const [glossaryPrefill, setGlossaryPrefill] = useState<string | undefined>();

  const handleOpenGlossary = useCallback((prefill?: string) => {
    setGlossaryPrefill(prefill);
    setIsGlossaryOpen(true);
  }, []);

  // 1. Initializing & Loading state
  if (dispatcher.status === 'initializing' || dispatcher.status === 'loading') {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4">
        <RefreshCw className="w-8 h-8 text-red-500 animate-spin mx-auto" />
        <p className="text-sm text-slate-400">
          Đang tải thông tin không gian duyệt bản dịch...
        </p>
      </div>
    );
  }

  // 2. Auth Required fallback
  if (dispatcher.status === 'auth_required') {
    return (
      <div className="max-w-md mx-auto my-20 p-6 bg-slate-900 border border-slate-800 rounded-3xl text-center space-y-4">
        <ShieldAlert className="w-12 h-12 text-amber-400 mx-auto" />
        <h2 className="text-lg font-bold text-white">Yêu Cầu Xác Thực</h2>
        <p className="text-xs text-slate-400 leading-relaxed">
          Khu vực AI Translation Studio chỉ dành cho Biên dịch viên và Quản trị
          viên đã đăng nhập.
        </p>
        <Link href="/studio">
          <Button variant="secondary" size="sm">
            Quay lại Studio
          </Button>
        </Link>
      </div>
    );
  }

  // 3. Error state (401 / 403 / 404 / network / server errors)
  if (dispatcher.status === 'error' || dispatcher.error) {
    const err = dispatcher.error;
    const isAccess =
      err?.status === 401 ||
      err?.status === 403 ||
      err?.status === 404 ||
      err?.code === 'FORBIDDEN' ||
      err?.code === 'NOT_FOUND' ||
      err?.code === 'UNAUTHORIZED';

    return (
      <div className="max-w-lg mx-auto my-20 p-8 bg-slate-900 border border-red-500/30 rounded-3xl text-center space-y-5">
        <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto" />
        <div className="space-y-1">
          <Badge variant="primary" className="mb-2">
            {err?.code || 'ERROR'}
          </Badge>
          <h2 className="text-lg font-bold text-white">
            {isAccess
              ? 'Không Thể Truy Cập Job Dịch'
              : 'Lỗi Tải Dữ Liệu Workspace'}
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {err?.message ||
              (isAccess
                ? 'Bạn không có quyền truy cập hoặc job dịch không tồn tại.'
                : 'Đã có lỗi xảy ra khi tải dữ liệu không gian duyệt.')}
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void dispatcher.refetchDetail()}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Thử Lại
          </Button>
          <Link href="/studio">
            <Button variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Về Danh Sách Job
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // 4. Fail-closed on unsupported or unknown format
  if (!dispatcher.isSupportedFormat || !dispatcher.mediaFormat) {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-amber-500/30 rounded-3xl text-center space-y-5">
        <BookOpen className="w-12 h-12 text-amber-400 mx-auto" />
        <div className="space-y-2">
          <Badge variant="warning">Định Dạng Không Hợp Lệ</Badge>
          <h2 className="text-xl font-black text-white">
            Định Dạng Tác Phẩm Không Hỗ Trợ
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            Hệ thống không hỗ trợ giao diện duyệt cho định dạng tác phẩm này.
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Link href="/studio">
            <Button variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Studio Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // 5. Authoritative Media Format Dispatcher
  return (
    <>
      {dispatcher.mediaFormat === MediaFormat.COMIC ? (
        <MangaReviewStudio
          jobId={jobId}
          initialJobDetail={dispatcher.jobDetail}
          onJobDetailChange={dispatcher.updateJobDetail}
          onOpenGlossary={() => handleOpenGlossary()}
        />
      ) : (
        <NovelReviewStudio
          jobId={jobId}
          initialJobDetail={dispatcher.jobDetail}
          onJobDetailChange={dispatcher.updateJobDetail}
          onOpenGlossary={handleOpenGlossary}
        />
      )}

      <GlossaryModal
        isOpen={isGlossaryOpen}
        onClose={() => {
          setIsGlossaryOpen(false);
          setGlossaryPrefill(undefined);
        }}
        projectId={dispatcher.jobDetail?.context?.project?.id}
        snapshotTerms={dispatcher.jobDetail?.glossarySnapshot ?? []}
        initialSourceTerm={glossaryPrefill}
      />
    </>
  );
}

