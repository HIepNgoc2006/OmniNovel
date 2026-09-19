import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  ApplyTranslationMode,
  ApplyTranslationJobResponse,
  ChapterVersionType,
  ReviewSummaryDto,
} from '@omninovel/shared';
import { ApplyTranslationModal } from '../components/studio/apply-translation-modal';
import { ParsedApiError } from '../lib/studio/studio-apply-policy';

describe('ApplyTranslationModal Component (#152 Task 5)', () => {
  const mockReviewSummaryIncomplete: ReviewSummaryDto = {
    segmentCount: 10,
    verifiedCount: 7, // 3 unverified
    pageCount: 2,
    resultPageCount: 2,
    blockCount: null,
  };

  const mockReviewSummaryComplete: ReviewSummaryDto = {
    segmentCount: 10,
    verifiedCount: 10, // 100% verified
    pageCount: 2,
    resultPageCount: 2,
    blockCount: null,
  };

  const mockSuccessResponse: ApplyTranslationJobResponse = {
    chapterId: 'chap-123',
    activeVersionId: 'ver-target-1',
    targetVersionId: 'ver-target-1',
    versionNumber: 2,
    versionType: ChapterVersionType.AI_TRANSLATED,
    isAlreadyApplied: false,
  };

  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    storySlug: 'one-piece',
    reviewSummary: mockReviewSummaryIncomplete,
    applyLifecycle: 'IDLE' as const,
    applyResponse: null,
    applyError: null,
    onApply: vi.fn(),
    onRetry: vi.fn(),
    onReconcile: vi.fn(),
    onReset: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Renders verification warning when unverified segments exist (< 100%)', () => {
    render(<ApplyTranslationModal {...defaultProps} />);

    expect(screen.getByText(/Còn 3 phân đoạn chưa được đánh dấu đã duyệt thủ công/i)).toBeDefined();
    expect(screen.getByText(/Bạn vẫn muốn xuất bản\?/i)).toBeDefined();
  });

  it('2. Does NOT render warning when 100% segments are verified', () => {
    render(<ApplyTranslationModal {...defaultProps} reviewSummary={mockReviewSummaryComplete} />);

    expect(screen.queryByText(/Còn \d+ phân đoạn chưa được đánh dấu đã duyệt thủ công/i)).toBeNull();
    expect(screen.getByText(/100% phân đoạn đã được duyệt thủ công/i)).toBeDefined();
  });

  it('3. Mode cards display distinct labels, badges, and warnings', () => {
    render(<ApplyTranslationModal {...defaultProps} />);

    expect(screen.getByText(/Tạo phiên bản mới và đặt làm bản đọc chính/i)).toBeDefined();
    expect(screen.getByText(/Tạo bản dịch phụ \(Alternate Version\)/i)).toBeDefined();
  });

  it('4. Submit button is disabled until user explicitly selects a mode', () => {
    render(<ApplyTranslationModal {...defaultProps} />);

    const submitBtn = screen.getByRole('button', { name: /Xác Nhận Xuất Bản/i });
    expect(submitBtn).toBeDisabled();

    // Click mode 1 (OVERWRITE_ACTIVE_VERSION)
    const overwriteCard = screen.getByTestId('mode-card-OVERWRITE_ACTIVE_VERSION');
    fireEvent.click(overwriteCard);

    expect(submitBtn).not.toBeDisabled();
  });

  it('5. Clicking submit calls onApply with the selected mode', async () => {
    const onApplyMock = vi.fn().mockResolvedValue(undefined);
    render(<ApplyTranslationModal {...defaultProps} onApply={onApplyMock} />);

    // Select alternate version mode
    const altCard = screen.getByTestId('mode-card-CREATE_ALTERNATE_VERSION');
    fireEvent.click(altCard);

    const submitBtn = screen.getByRole('button', { name: /Xác Nhận Xuất Bản/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onApplyMock).toHaveBeenCalledWith(ApplyTranslationMode.CREATE_ALTERNATE_VERSION);
  });

  it('6. Submitting state (SUBMITTING / RECONCILING): disables controls and shows loading status', () => {
    render(
      <ApplyTranslationModal
        {...defaultProps}
        applyLifecycle="SUBMITTING"
      />,
    );

    expect(screen.getByText(/Đang ghi nhận xuất bản lên hệ thống\.\.\./i)).toBeDefined();
    const submitBtn = screen.getByRole('button', { name: /Đang Xử Lý\.\.\./i });
    expect(submitBtn).toBeDisabled();
  });

  it('7. Success state (SUCCEEDED): renders reader deep link, dashboard button, and close', () => {
    render(
      <ApplyTranslationModal
        {...defaultProps}
        applyLifecycle="SUCCEEDED"
        applyResponse={mockSuccessResponse}
      />,
    );

    expect(screen.getByText(/Xuất bản thành công!/i)).toBeDefined();
    expect(screen.getByText(/Phiên bản v2 đã sẵn sàng phục vụ độc giả\./i)).toBeDefined();

    // Reader link check: must contain ?versionId=ver-target-1
    const readLink = screen.getByRole('link', { name: /Đọc chương này ngay/i });
    expect(readLink.getAttribute('href')).toBe('/stories/one-piece/read/chap-123?versionId=ver-target-1');

    // Return to studio button calls onClose
    const stayBtn = screen.getByRole('button', { name: /Ở lại Studio/i });
    fireEvent.click(stayBtn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('8. Coherence failure (COMMITTED_RECONCILIATION_REQUIRED): displays recovery notice and reconcile button', async () => {
    const onReconcileMock = vi.fn().mockResolvedValue(undefined);
    const coherenceError: ParsedApiError = {
      code: 'COHERENCE_CHECK_FAILED',
      message: 'Workspace revision must strictly exceed previous revision',
      status: 409,
      isAmbiguous: false,
    };

    render(
      <ApplyTranslationModal
        {...defaultProps}
        applyLifecycle="COMMITTED_RECONCILIATION_REQUIRED"
        applyResponse={mockSuccessResponse}
        applyError={coherenceError}
        onReconcile={onReconcileMock}
      />,
    );

    expect(screen.getByText(/Yêu cầu xuất bản đã được ghi nhận trên máy chủ/i)).toBeDefined();
    const reconcileBtn = screen.getByRole('button', { name: /Đối Chiếu & Cập Nhật Lại/i });
    await act(async () => {
      fireEvent.click(reconcileBtn);
    });

    expect(onReconcileMock).toHaveBeenCalledTimes(1);
  });

  it('9. Ambiguity notice (SUBMISSION_OUTCOME_UNKNOWN): displays transport warning and retry button', async () => {
    const onRetryMock = vi.fn().mockResolvedValue(undefined);
    const ambiguousError: ParsedApiError = {
      code: 'GATEWAY_TIMEOUT',
      message: 'Gateway Timeout',
      status: 504,
      isAmbiguous: true,
    };

    render(
      <ApplyTranslationModal
        {...defaultProps}
        applyLifecycle="SUBMISSION_OUTCOME_UNKNOWN"
        applyError={ambiguousError}
        onRetry={onRetryMock}
      />,
    );

    expect(screen.getByText(/Không thể xác nhận trạng thái máy chủ/i)).toBeDefined();
    expect(screen.getByText(/Khóa Idempotency đã được giữ cố định/i)).toBeDefined();

    const retryBtn = screen.getByRole('button', { name: /Thử Lại Với Khóa Gốc/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(onRetryMock).toHaveBeenCalledTimes(1);
  });

  it('10. Deterministic failure (FAILED): displays error message and allows reset or retry', async () => {
    const onResetMock = vi.fn();
    const forbiddenError: ParsedApiError = {
      code: 'FORBIDDEN',
      message: 'Chỉ OWNER hoặc EDITOR mới được áp dụng.',
      status: 403,
      isAmbiguous: false,
    };

    render(
      <ApplyTranslationModal
        {...defaultProps}
        applyLifecycle="FAILED"
        applyError={forbiddenError}
        onReset={onResetMock}
      />,
    );

    expect(screen.getByText(/Xuất bản thất bại/i)).toBeDefined();
    expect(screen.getByText(/Chỉ OWNER hoặc EDITOR mới được áp dụng\./i)).toBeDefined();

    const resetBtn = screen.getByRole('button', { name: /Thử Chọn Lại/i });
    fireEvent.click(resetBtn);
    expect(onResetMock).toHaveBeenCalledTimes(1);
  });
});
