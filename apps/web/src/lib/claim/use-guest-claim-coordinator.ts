'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  GuestClaimCoordinator,
  guestClaimCoordinator,
  GuestClaimCoordinatorState,
} from './guest-claim-coordinator';
import { ConflictResolution } from '@omninovel/shared';

export function useGuestClaimCoordinator(
  coordinator: GuestClaimCoordinator = guestClaimCoordinator,
) {
  const [state, setState] = useState<GuestClaimCoordinatorState>(coordinator.state);

  useEffect(() => {
    return coordinator.subscribe((nextState) => {
      setState(nextState);
    });
  }, [coordinator]);

  const checkAndPrepareClaim = useCallback(
    (userId: string) => coordinator.checkAndPrepareClaim(userId),
    [coordinator],
  );

  const skipClaim = useCallback(
    (userId?: string) => coordinator.skipClaim(userId),
    [coordinator],
  );

  const confirmClaim = useCallback(
    (userId?: string, conflictDecisions?: Record<string, ConflictResolution>) =>
      coordinator.confirmClaim(userId, conflictDecisions),
    [coordinator],
  );

  const checkCrashRecovery = useCallback(
    (userId: string) => coordinator.checkCrashRecovery(userId),
    [coordinator],
  );

  return {
    ...state,
    checkAndPrepareClaim,
    skipClaim,
    confirmClaim,
    checkCrashRecovery,
  };
}
