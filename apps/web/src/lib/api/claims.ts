import { apiClient } from './client';
import {
  PrepareGuestClaimPayload,
  GuestClaimPreviewResult,
  CommitGuestClaimPayload,
  GuestClaimCommitResult,
  GuestClaimStatusResult,
} from '@omninovel/shared';

/**
 * Prepares a two-step guest data claim session.
 * Computes stateFingerprint and identifies any reading progress conflicts.
 */
export async function prepareGuestClaimApi(
  payload: PrepareGuestClaimPayload,
): Promise<GuestClaimPreviewResult> {
  const response = await apiClient.post<GuestClaimPreviewResult>(
    '/account/guest-claims/prepare',
    payload,
  );
  return response.data;
}

/**
 * Commits a prepared guest claim session.
 * Merges bookmarks, chapter read-states, and resolved reading progress into the authenticated user account.
 */
export async function commitGuestClaimApi(
  claimId: string,
  payload: CommitGuestClaimPayload,
): Promise<GuestClaimCommitResult> {
  const response = await apiClient.post<GuestClaimCommitResult>(
    `/account/guest-claims/${encodeURIComponent(claimId)}/commit`,
    payload,
  );
  return response.data;
}

/**
 * Retrieves the current status and summary of a guest claim.
 * Used for crash recovery and polling committed state.
 */
export async function getGuestClaimStatusApi(
  claimId: string,
): Promise<GuestClaimStatusResult> {
  const response = await apiClient.get<GuestClaimStatusResult>(
    `/account/guest-claims/${encodeURIComponent(claimId)}/status`,
  );
  return response.data;
}
