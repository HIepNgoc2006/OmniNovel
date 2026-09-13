'use client';

import React, { use } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useMangaReviewStudio } from '@/lib/studio/use-manga-review-studio';
import {
  parsePageQueryParam,
  canNavigatePrev,
  canNavigateNext,
  clampPageNumber,
  isEditableElement,
} from '@/lib/studio/manga-page-navigator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  Sparkles,
  BookOpen,
  ShieldAlert,
} from 'lucide-react';

interface PageProps {
  params: Promise<{ jobId: string }>;
}

export default function MangaStudioJobPage({ params }: PageProps) {
  const { jobId } = use(params);
  const studio = useMangaReviewStudio(jobId);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Navigation handler: URL is SSoT, UI only pushes router!
  const navigateToPage = React.useCallback(
    (targetPage: number) => {
      const maxPages = studio.pageCountInfo.pageCount;
      const clamped = clampPageNumber(targetPage, maxPages);
      if (clamped !== studio.currentPage) {
        router.push(`${pathname}?page=${clamped}`);
      }
    },
    [pathname, router, studio.currentPage, studio.pageCountInfo.pageCount]
  );

  // URL SSoT Synchronization
  React.useEffect(() => {
    if (studio.status !== 'ready' || studio.workspaceMode?.mode !== 'REVIEWABLE') {
      return;
    }
    const maxPages = studio.pageCountInfo.pageCount;
    if (!maxPages) return;

    const rawParam = searchParams.get('page');
    const { page, isCanonical } = parsePageQueryParam(rawParam, maxPages);

    if (!isCanonical) {
      router.replace(`${pathname}?page=${page}`);
    }

    if (studio.currentPage !== page) {
      studio.goToPage(page);
    }
  }, [searchParams, pathname, router, studio]);

  // Keyboard navigation
  React.useEffect(() => {
    if (studio.status !== 'ready' || studio.workspaceMode?.mode !== 'REVIEWABLE') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) return;

      const maxPages = studio.pageCountInfo.pageCount;
      if (event.key === 'ArrowRight' && canNavigateNext(studio.currentPage, maxPages)) {
        event.preventDefault();
        navigateToPage(studio.currentPage + 1);
      } else if (event.key === 'ArrowLeft' && canNavigatePrev(studio.currentPage)) {
        event.preventDefault();
        navigateToPage(studio.currentPage - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [studio.status, studio.workspaceMode?.mode, studio.currentPage, studio.pageCountInfo.pageCount, navigateToPage]);


  // 1. Loading & Initializing state
  if (studio.status === 'initializing' || studio.status === 'loading') {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4">
        <RefreshCw className="w-8 h-8 text-red-500 animate-spin mx-auto" />
        <p className="text-sm text-slate-400">
          Đang tải dữ liệu không gian duyệt Manga Studio...
        </p>
      </div>
    );
  }

  // 2. Auth Required fallback
  if (studio.status === 'auth_required') {
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

  // 3. Fatal Error state (e.g. 401 / 403 / 404 vs 500 / network)
  const fatalErr = studio.fatalError || studio.error;
  if (studio.status === 'error' || fatalErr) {
    const isAccess =
      fatalErr?.status === 401 ||
      fatalErr?.status === 403 ||
      fatalErr?.status === 404 ||
      fatalErr?.code === 'FORBIDDEN' ||
      fatalErr?.code === 'NOT_FOUND' ||
      fatalErr?.code === 'UNAUTHORIZED';

    return (
      <div className="max-w-lg mx-auto my-20 p-8 bg-slate-900 border border-red-500/30 rounded-3xl text-center space-y-5">
        <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto" />
        <div className="space-y-1">
          <Badge variant="primary" className="mb-2">
            {fatalErr?.code || 'ERROR'}
          </Badge>
          <h2 className="text-lg font-bold text-white">
            {isAccess ? 'Không Thể Truy Cập Job Dịch' : 'Lỗi Tải Dữ Liệu Workspace'}
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {fatalErr?.message ||
              (isAccess
                ? 'Bạn không có quyền truy cập hoặc job dịch không tồn tại.'
                : 'Đã có lỗi xảy ra khi tải dữ liệu không gian duyệt.')}
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => studio.retry()}
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

  // 3.5. Early Identity Guard: If jobDetail is present but does not match route jobId, fail-closed
  if (studio.jobDetail && studio.jobDetail.job.id !== jobId) {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-slate-800 rounded-3xl text-center space-y-4">
        <Clock className="w-8 h-8 text-slate-500 mx-auto animate-spin" />
        <p className="text-xs text-slate-400">
          Đang chuẩn bị không gian làm việc...
        </p>
      </div>
    );
  }

  // 4. Unsupported format handoff (NOVEL)
  if (studio.workspaceMode?.mode === 'UNSUPPORTED_FORMAT') {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-amber-500/30 rounded-3xl text-center space-y-5">
        <BookOpen className="w-12 h-12 text-amber-400 mx-auto" />
        <div className="space-y-2">
          <Badge variant="warning">Định Dạng Không Khớp</Badge>
          <h2 className="text-xl font-black text-white">
            Tác Phẩm Tiểu Thuyết (Light Novel)
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {studio.workspaceMode.message}
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

  // 5. Count Unavailable state (READY_FOR_REVIEW without valid page sequence)
  if (studio.workspaceMode?.mode === 'COUNT_UNAVAILABLE') {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-amber-500/30 rounded-3xl text-center space-y-5">
        <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto" />
        <div className="space-y-2">
          <Badge variant="warning">Số Trang Chưa Sẵn Sàng</Badge>
          <h2 className="text-xl font-black text-white">
            Dữ Liệu Kết Xuất Chưa Hoàn Tất
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {studio.workspaceMode.message}
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => studio.refetchDetail()}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Tải Lại Dữ Liệu
          </Button>
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

  // 5.5. Reconciliation Required state (Desynchronized / Coherence breaker triggered)
  if (studio.workspaceMode?.mode === 'RECONCILIATION_REQUIRED') {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-amber-500/30 rounded-3xl text-center space-y-5">
        <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto" />
        <div className="space-y-2">
          <Badge variant="warning">Yêu Cầu Đồng Bộ Lại</Badge>
          <h2 className="text-xl font-black text-white">
            Trạng Thái Dữ Liệu Chưa Nhất Quán
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {studio.workspaceMode.message ||
              'Dữ liệu phân đoạn hoặc bản xem trước chưa khớp phiên bản với chi tiết job. Vui lòng bấm Đồng Bộ Lại để thử tải lại dữ liệu mới nhất.'}
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => studio.reconcileAuthoritativeWorkspace()}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Đồng Bộ Lại (Reconcile)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => studio.retry()}
          >
            Tải Lại Toàn Bộ
          </Button>
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

  // 6. Terminal ended state (FAILED / CANCELED / EXPIRED)
  if (studio.workspaceMode?.mode === 'TERMINAL_STATE') {
    const job = studio.jobDetail?.job;
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-rose-500/30 rounded-3xl text-center space-y-5">
        <ShieldAlert className="w-12 h-12 text-rose-500 mx-auto" />
        <div className="space-y-2">
          <Badge variant="primary">{job?.status}</Badge>
          <h2 className="text-xl font-black text-white">
            Job Dịch Đã Kết Thúc
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {studio.workspaceMode.message}
          </p>
        </div>
        <div className="pt-2 flex justify-center gap-3">
          <Link href="/studio">
            <Button variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Về Studio Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // 7. Non-ready pipeline monitor state (QUEUED, PREPROCESSING, etc.)
  if (studio.workspaceMode?.mode === 'PIPELINE_MONITOR') {
    const job = studio.jobDetail?.job;
    const progress = job?.progressPercentage ?? 0;
    return (
      <div className="max-w-2xl mx-auto my-16 p-8 bg-slate-900 border border-slate-800 rounded-3xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-400 animate-spin" />
            <h2 className="text-lg font-bold text-white">
              Tiến Trình Dịch Tự Động Đang Xử Lý
            </h2>
          </div>
          <Badge variant="warning">{job?.status}</Badge>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-xs text-slate-400 font-medium">
            <span>Tiến độ tổng thể</span>
            <span className="text-white font-bold">{progress}%</span>
          </div>
          <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-red-600 to-amber-500 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          {studio.workspaceMode.message}
        </p>

        <div className="flex justify-between items-center pt-2">
          <Link href="/studio">
            <Button variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Bảng Điều Khiển
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => studio.refetchDetail()}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Làm Mới Trạng Thái
          </Button>
        </div>
      </div>
    );
  }

  // 8. APPLIED read-only state
  if (studio.workspaceMode?.mode === 'APPLIED') {
    const story = studio.jobDetail?.context.story;
    const chapter = studio.jobDetail?.context.chapter;
    return (
      <div className="max-w-3xl mx-auto my-12 p-8 bg-slate-900 border border-emerald-500/30 rounded-3xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="success">APPLIED</Badge>
              <span className="text-xs text-slate-400">Chỉ Đọc (Read-only)</span>
            </div>
            <h1 className="text-xl font-black text-white">
              {story?.title} — Chương {chapter?.chapterNumber}
            </h1>
          </div>
          <div className="text-right">
            <span className="text-xs text-slate-400">Số trang tác phẩm: </span>
            <span className="text-xs font-bold text-emerald-400">
              {studio.pageCountInfo.isAvailable
                ? `${studio.pageCountInfo.pageCount} trang`
                : 'Không xác định'}
            </span>
          </div>
        </div>

        <div className="p-4 bg-emerald-950/30 border border-emerald-800/40 rounded-2xl flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-300 leading-relaxed">
            {studio.workspaceMode.message}
          </p>
        </div>

        <div className="flex justify-between items-center pt-2">
          <Link href="/studio">
            <Button variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Về Studio Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // 9. Fail-Closed Guard: Do NOT render reviewable workspace shell unless mode is REVIEWABLE and detail matches jobId
  if (
    !studio.jobDetail ||
    studio.jobDetail.job.id !== jobId ||
    studio.workspaceMode?.mode !== 'REVIEWABLE'
  ) {
    return (
      <div className="max-w-xl mx-auto my-20 p-8 bg-slate-900 border border-slate-800 rounded-3xl text-center space-y-4">
        <Clock className="w-8 h-8 text-slate-500 mx-auto animate-spin" />
        <p className="text-xs text-slate-400">
          Đang chuẩn bị không gian làm việc...
        </p>
      </div>
    );
  }

  // 10. Full READY_FOR_REVIEW Reviewable Workspace (RED 0 Foundation Shell)
  const job = studio.jobDetail.job;
  const story = studio.jobDetail.context.story;
  const chapter = studio.jobDetail.context.chapter;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Studio Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link
              href="/studio"
              className="text-slate-400 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </Link>
            <Badge variant="primary">Manga Review Studio</Badge>
            <Badge variant="success">READY_FOR_REVIEW</Badge>
            {studio.freshness.status === 'FRESH' && (
              <Badge variant="success">Đã Đồng Bộ Kết Xuất</Badge>
            )}
            {studio.freshness.status === 'STALE' && (
              <Badge variant="warning">Cần Kết Xuất Lại</Badge>
            )}
            {studio.freshness.status === 'UNKNOWN' && (
              <Badge variant="outline">Chưa Xác Định Phiên Bản</Badge>
            )}
            {studio.freshness.status === 'INVARIANT_VIOLATION' && (
              <Badge
                variant="outline"
                className="text-rose-400 border-rose-500/40 bg-rose-950/30"
              >
                Dữ Liệu Phiên Bản Không Nhất Quán
              </Badge>
            )}
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white">
            {story?.title} — Chương {chapter?.chapterNumber}
            {chapter?.title ? `: ${chapter.title}` : ''}
          </h1>
        </div>

        {/* Operation Error Banner if any */}
        {studio.operationError && (
          <div className="w-full p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between text-xs text-amber-300">
            <span>{studio.operationError.message || 'Lỗi thao tác cục bộ.'}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => studio.clearOperationError()}
              className="h-6 px-2 text-xs text-amber-300 hover:text-white hover:bg-amber-500/20"
            >
              Đóng
            </Button>
          </div>
        )}

        {/* Action controls & Authoritative PageCount */}
        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-xs font-semibold">
            <span className="text-slate-400">Trang: </span>
            <span className="text-white">
              {studio.pageCountInfo.isAvailable
                ? `1..${studio.pageCountInfo.pageCount}`
                : 'Không xác định'}
            </span>
          </div>

          {studio.freshness.status === 'STALE' && (
            <Button
              variant="primary"
              size="sm"
              disabled={!studio.workspaceMode?.canMaterialize || studio.isMaterializing}
              onClick={() => studio.triggerMaterialization()}
            >
              <Sparkles className={`w-3.5 h-3.5 mr-1 ${studio.isMaterializing ? 'animate-spin' : ''}`} />
              {studio.isMaterializing ? 'Đang Kết Xuất...' : 'Tạo Kết Xuất (Re-render)'}
            </Button>
          )}
          {studio.freshness.status === 'FRESH' && (
            <Button variant="outline" size="sm" disabled>
              <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-400" />
              Đã Đồng Bộ Kết Xuất
            </Button>
          )}
          {studio.freshness.status === 'UNKNOWN' && (
            <Button variant="outline" size="sm" disabled>
              Chưa Xác Định Phiên Bản
            </Button>
          )}
          {studio.freshness.status === 'INVARIANT_VIOLATION' && (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="text-rose-400 border-rose-800"
            >
              <AlertTriangle className="w-3.5 h-3.5 mr-1 text-rose-400" />
              Phiên Bản Không Hợp Lệ
            </Button>
          )}
        </div>
      </div>

      {/* Invariant Violation Alert Banner */}
      {studio.freshness.status === 'INVARIANT_VIOLATION' && (
        <div className="p-4 bg-rose-950/40 border border-rose-500/50 rounded-2xl flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
          <div className="text-xs text-rose-200">
            <span className="font-bold">Cảnh Báo Bất Biến Phiên Bản: </span>
            {studio.freshness.message || 'materializedRevision không thể lớn hơn reviewRevision.'}
          </div>
        </div>
      )}

      {/* OCC Conflict Alert Banner */}
      {studio.conflictState && (
        <div className="p-4 bg-amber-950/40 border border-amber-500/50 rounded-2xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <div className="text-xs text-amber-200">
              {studio.conflictState.kind === 'SEGMENT_REMOVED' ? (
                <span>
                  <span className="font-bold">Phân đoạn đã bị xóa: </span>
                  Phân đoạn này không còn tồn tại trên máy chủ. Bản nháp của bạn đã được giữ lại và thao tác lưu bị khóa.
                </span>
              ) : studio.conflictState.kind === 'COMMIT_UNKNOWN_CONFLICT' ? (
                <span>
                  <span className="font-bold">Xung đột sau khi lưu: </span>
                  Phân đoạn này đã bị chỉnh sửa bởi phiên bản khác trên máy chủ sau khi thử lưu. Bản nháp của bạn đã được bảo lưu.
                </span>
              ) : studio.conflictState.kind === 'UNCOMMITTED_DRAFT' ? (
                <span>
                  <span className="font-bold">Bản nháp chưa lưu: </span>
                  Yêu cầu lưu trước đó bị gián đoạn mạng và chưa được ghi nhận trên máy chủ. Bản nháp của bạn đã được bảo lưu để thử lại.
                </span>
              ) : (
                <span>
                  <span className="font-bold">Xung Đột Phiên Bản (409 VERSION_CONFLICT): </span>
                  {studio.conflictState.currentVersion !== undefined &&
                  studio.conflictState.expectedVersion !== undefined
                    ? `Bản ghi segment đã được sửa bởi người khác (Server v${studio.conflictState.currentVersion} vs Bạn v${studio.conflictState.expectedVersion}). Bản nháp của bạn đã được giữ nguyên.`
                    : 'Phiên bản trên máy chủ đã thay đổi. Bản nháp của bạn đã được giữ nguyên.'}
                </span>
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => studio.clearConflict(studio.conflictState?.segmentId)}
          >
            Đóng
          </Button>
        </div>
      )}

      {/* Workspace Main Grid (Foundation layout placeholder for RED 1-6 expansion) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[600px]">
        {/* Left / Center: Canvas / Image Preview (Col 8) */}
        <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col justify-between">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-red-500" />
              <span>Canvas So Sánh & Vùng Thoại OCR</span>
            </h3>
            <span className="text-xs text-slate-400">
              Trang hiện tại: {studio.currentPage} /{' '}
              {studio.pageCountInfo.pageCount ?? '—'}
            </span>
          </div>

          {/* Placeholder for canvas / image preview component */}
          <div className="flex-1 my-6 flex items-center justify-center border border-dashed border-slate-800 rounded-2xl bg-slate-950/40 p-8 text-center">
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                Không gian hiển thị ảnh gốc vs ảnh đã dịch và OCR bounding boxes (RED 2).
              </p>
              <p className="text-[11px] text-slate-600">
                Segment Count: {studio.segments.length} | Authoritative Page Count:{' '}
                {studio.pageCountInfo.pageCount ?? 'N/A'}
              </p>
            </div>
          </div>

          {/* Page Navigator Navigation Bar */}
          <div className="pt-3 border-t border-slate-800 space-y-3">
            {/* Local Window Preview Error Banner (Amendment #1) */}
            {studio.previewWindowError && (
              <div
                data-testid="window-error-banner"
                className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-2xl flex items-center justify-between gap-3 text-xs text-rose-300"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>Không thể tải hình ảnh xem trước cho trang hiện tại.</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => studio.retryPreviewWindow()}
                  className="h-7 px-2.5 text-xs text-rose-200 hover:text-white hover:bg-rose-500/20"
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Thử lại tải ảnh
                </Button>
              </div>
            )}

            {/* Bounded Thumbnail Strip (<= 5 thumbnails) */}
            {studio.previewWindow && (
              <div
                data-testid="thumbnail-strip"
                className="py-1 px-2 flex items-center justify-center gap-2 overflow-x-auto"
              >
                {Array.from(
                  { length: studio.previewWindow.toPage - studio.previewWindow.fromPage + 1 },
                  (_, idx) => studio.previewWindow!.fromPage + idx
                ).map((p) => {
                  const isActive = p === studio.currentPage;
                  const resultThumb = studio.previewWindow?.resultAssets.find((a) => a.pageNumber === p);
                  const sourceThumb = studio.previewWindow?.sourceAssets.find((a) => a.pageNumber === p);
                  const thumbUrl = resultThumb?.url || sourceThumb?.url;

                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`thumbnail-item-${p}`}
                      onClick={() => navigateToPage(p)}
                      className={`relative group flex flex-col items-center justify-center w-14 h-20 rounded-xl border text-xs transition-all cursor-pointer overflow-hidden ${
                        isActive
                          ? 'border-red-500 ring-2 ring-red-500/40 bg-red-950/30 text-white'
                          : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={`Trang ${p}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="font-semibold text-xs">P.{p}</span>
                      )}
                      <div
                        className={`absolute bottom-0 inset-x-0 text-[10px] font-mono py-0.5 text-center ${
                          isActive ? 'bg-red-600 text-white font-bold' : 'bg-slate-900/80 text-slate-400'
                        }`}
                      >
                        {p}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Main Navigation Controls */}
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!canNavigatePrev(studio.currentPage)}
                onClick={() => navigateToPage(studio.currentPage - 1)}
              >
                Trang Trước
              </Button>
              <span className="text-xs font-semibold text-slate-300 px-3">
                Trang {studio.currentPage} / {studio.pageCountInfo.pageCount ?? '—'}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNavigateNext(studio.currentPage, studio.pageCountInfo.pageCount)}
                onClick={() => navigateToPage(studio.currentPage + 1)}
              >
                Trang Tiếp
              </Button>
            </div>
          </div>
        </div>

        {/* Right Panel: Segments List & Translation Editor (Col 4) */}
        <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 flex flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-white">
              Danh Sách Ô Thoại (Segments)
            </h3>
            {studio.pageSegmentsLoading && (
              <RefreshCw className="w-3.5 h-3.5 text-slate-400 animate-spin" />
            )}
          </div>

          {/* Page Segments Error Banner */}
          {studio.pageSegmentsError && (
            <div
              data-testid="page-segments-error-banner"
              className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-2xl flex items-center justify-between gap-2 text-xs text-rose-300"
            >
              <span>Lỗi tải danh sách ô thoại trang {studio.currentPage}.</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => studio.retryPageSegments()}
                className="h-7 px-2 text-xs text-rose-200 hover:text-white hover:bg-rose-500/20"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Thử lại
              </Button>
            </div>
          )}

          {/* Page Segments Loading State */}
          {studio.pageSegmentsLoading && (
            <div className="py-8 text-center text-xs text-slate-500 space-y-2">
              <RefreshCw className="w-5 h-5 text-slate-500 animate-spin mx-auto" />
              <p>Đang tải ô thoại trang {studio.currentPage}...</p>
            </div>
          )}

          {/* Empty Page State (P1-3 Invariant: NEVER fallback to all canonical segments!) */}
          {!studio.pageSegmentsLoading && !studio.pageSegmentsError && studio.pageSegments.length === 0 && (
            <div
              data-testid="empty-page-segments"
              className="py-12 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-2xl space-y-1"
            >
              <p className="font-semibold text-slate-400">Không có ô thoại nào</p>
              <p className="text-[11px] text-slate-600">Trang {studio.currentPage} chưa phát hiện hoặc không có ô thoại OCR.</p>
            </div>
          )}

          {/* Segments List for Current Page */}
          {!studio.pageSegmentsLoading && studio.pageSegments.length > 0 && (
            <div className="flex-1 overflow-y-auto space-y-3 max-h-[500px] pr-1">
              {studio.pageSegments.map((seg) => {
                const hasPending = Boolean(studio.pendingUnknownMutations[seg.id]);
                const segConflict = studio.conflictStates[seg.id];
                return (
                  <div
                    key={seg.id}
                    onClick={() => studio.setSelectedSegmentId(seg.id)}
                    className={`p-3 rounded-2xl border transition-all cursor-pointer ${
                      studio.selectedSegmentId === seg.id
                        ? 'bg-red-500/10 border-red-500/40'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex justify-between items-center text-[11px] text-slate-400 mb-1">
                      <span>
                        {typeof seg.pageNumber === 'number'
                          ? `Trang ${seg.pageNumber}`
                          : 'Chưa gán trang'}{' '}
                        • Thứ tự #{seg.sortOrder}
                      </span>
                      <div className="flex items-center gap-1">
                        {hasPending && (
                          <Badge variant="warning" className="animate-pulse">
                            Chờ xác nhận
                          </Badge>
                        )}
                        {segConflict?.retryBlocked && (
                          <Badge variant="outline" className="text-rose-400 border-rose-500/40">
                            Bị khóa
                          </Badge>
                        )}
                        {studio.segmentsSyncStatus !== 'SYNCED' ? (
                          <Badge variant="outline" className="text-amber-400 border-amber-500/40">
                            Chưa xác minh
                          </Badge>
                        ) : seg.isHumanVerified ? (
                          <Badge variant="success">Đã Duyệt</Badge>
                        ) : (
                          <Badge variant="outline">Chưa Duyệt</Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs font-mono text-slate-400 line-clamp-1 mb-1">
                      {seg.rawText}
                    </p>
                    <p className="text-xs text-white line-clamp-2">
                      {seg.translatedText || (
                        <span className="text-slate-600 italic">Chưa có bản dịch</span>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {/* P2-2: Segment Pagination Controls (when totalPages > 1 on current manga page) */}
          {studio.pageSegmentsPagination && studio.pageSegmentsPagination.totalPages > 1 && (
            <div
              data-testid="segment-pagination-bar"
              className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={studio.pageSegmentsPagination.page <= 1 || studio.pageSegmentsLoading}
                onClick={() => studio.goToPageSegmentsPage(studio.pageSegmentsPagination!.page - 1)}
                className="h-7 px-2 text-xs"
              >
                Trước
              </Button>
              <span>
                Phân đoạn {studio.pageSegmentsPagination.page} / {studio.pageSegmentsPagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  studio.pageSegmentsPagination.page >= studio.pageSegmentsPagination.totalPages ||
                  studio.pageSegmentsLoading
                }
                onClick={() => studio.goToPageSegmentsPage(studio.pageSegmentsPagination!.page + 1)}
                className="h-7 px-2 text-xs"
              >
                Sau
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
