import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GuestClaimDialog } from '../components/claim/guest-claim-dialog';
import * as coordinatorHook from '../lib/claim/use-guest-claim-coordinator';
import {
  GuestClaimStatus,
  ConflictResolution,
  ReadingMode,
  GuestClaimPreviewResult,
} from '@omninovel/shared';

describe('GuestClaimDialog (Web Presentation & Invariants)', () => {
  const mockSkipClaim = vi.fn();
  const mockConfirmClaim = vi.fn();

  const samplePreview: GuestClaimPreviewResult = {
    claimId: 'claim-modal-1',
    status: GuestClaimStatus.PREPARED,
    stateFingerprint: 'hash-preview-999',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    bookmarksToImport: 5,
    historyToImport: 12,
    progressToImport: 3,
    conflictsCount: 1,
    readStatesIgnoredAntiResurrectionCount: 0,
    conflicts: [
      {
        storyId: 'story-alpha',
        cloudProgress: {
          chapterId: 'chap-cloud-10',
          readingMode: ReadingMode.PAGED,
          pageIndex: 20,
          scrollPosition: 0,
          progressPercentage: 80,
          updatedAt: new Date().toISOString(),
        },
        guestProgress: {
          chapterId: 'chap-guest-5',
          readingMode: ReadingMode.PAGED,
          pageIndex: 10,
          scrollPosition: 0,
          progressPercentage: 40,
        },
      },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSkipClaim.mockReset();
    mockConfirmClaim.mockReset();
  });

  it('renders nothing when isOpen is false or previewData is null', () => {
    vi.spyOn(coordinatorHook, 'useGuestClaimCoordinator').mockReturnValue({
      isOpen: false,
      isPreparing: false,
      isCommitting: false,
      previewData: null,
      error: null,
      currentUserId: null,
      checkAndPrepareClaim: vi.fn(),
      skipClaim: mockSkipClaim,
      confirmClaim: mockConfirmClaim,
      checkCrashRecovery: vi.fn(),
    });

    const { container } = render(<GuestClaimDialog />);
    expect(container.firstChild).toBeNull();
  });

  it('renders stats overview correctly when open', () => {
    vi.spyOn(coordinatorHook, 'useGuestClaimCoordinator').mockReturnValue({
      isOpen: true,
      isPreparing: false,
      isCommitting: false,
      previewData: samplePreview,
      error: null,
      currentUserId: 'usr-1',
      checkAndPrepareClaim: vi.fn(),
      skipClaim: mockSkipClaim,
      confirmClaim: mockConfirmClaim,
      checkCrashRecovery: vi.fn(),
    });

    render(<GuestClaimDialog />);

    expect(screen.getByText('Gộp Dữ Liệu Đọc Khách Vào Tài Khoản')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // Bookmarks count
    expect(screen.getByText('12')).toBeInTheDocument(); // History count
    expect(screen.getByText('3')).toBeInTheDocument(); // Progress count
  });

  it('renders conflicts list and allows selecting between cloud and guest progress', () => {
    vi.spyOn(coordinatorHook, 'useGuestClaimCoordinator').mockReturnValue({
      isOpen: true,
      isPreparing: false,
      isCommitting: false,
      previewData: samplePreview,
      error: null,
      currentUserId: 'usr-1',
      checkAndPrepareClaim: vi.fn(),
      skipClaim: mockSkipClaim,
      confirmClaim: mockConfirmClaim,
      checkCrashRecovery: vi.fn(),
    });

    render(<GuestClaimDialog />);

    expect(screen.getByText(/Phát hiện 1 truyện có xung đột tiến độ/i)).toBeInTheDocument();
    expect(screen.getByText('story-alpha')).toBeInTheDocument();

    // Find radio options
    const cloudRadio = screen.getByRole('radio', { name: /bản đám mây/i });
    const guestRadio = screen.getByRole('radio', { name: /máy hiện tại/i });

    expect(cloudRadio).toBeChecked();
    expect(guestRadio).not.toBeChecked();

    // Select guest radio
    fireEvent.click(guestRadio);
    expect(guestRadio).toBeChecked();

    // Click confirm -> passes decisions
    const confirmBtn = screen.getByRole('button', { name: /Gộp Vào Tài Khoản/i });
    fireEvent.click(confirmBtn);

    expect(mockConfirmClaim).toHaveBeenCalledWith(undefined, {
      'story-alpha': ConflictResolution.USE_GUEST,
    });
  });

  it('calls skipClaim when clicking "Bỏ qua & Không gộp"', () => {
    vi.spyOn(coordinatorHook, 'useGuestClaimCoordinator').mockReturnValue({
      isOpen: true,
      isPreparing: false,
      isCommitting: false,
      previewData: samplePreview,
      error: null,
      currentUserId: 'usr-1',
      checkAndPrepareClaim: vi.fn(),
      skipClaim: mockSkipClaim,
      confirmClaim: mockConfirmClaim,
      checkCrashRecovery: vi.fn(),
    });

    render(<GuestClaimDialog />);

    const skipBtn = screen.getByRole('button', { name: /Bỏ qua & Không gộp/i });
    fireEvent.click(skipBtn);

    expect(mockSkipClaim).toHaveBeenCalledTimes(1);
  });

  it('disables buttons and displays loading indicator while isCommitting is true', () => {
    vi.spyOn(coordinatorHook, 'useGuestClaimCoordinator').mockReturnValue({
      isOpen: true,
      isPreparing: false,
      isCommitting: true,
      previewData: samplePreview,
      error: null,
      currentUserId: 'usr-1',
      checkAndPrepareClaim: vi.fn(),
      skipClaim: mockSkipClaim,
      confirmClaim: mockConfirmClaim,
      checkCrashRecovery: vi.fn(),
    });

    render(<GuestClaimDialog />);

    const skipBtn = screen.getByRole('button', { name: /Bỏ qua & Không gộp/i });
    const confirmBtn = screen.getByRole('button', { name: /Đang gộp dữ liệu.../i });

    expect(skipBtn).toBeDisabled();
    expect(confirmBtn).toBeDisabled();
  });
});
