import { apiClient } from './client';
import {
  UserProgressionResponse,
  ReadChapterRewardRequest,
  ReadChapterRewardResponse,
} from '@omninovel/shared';

export type { ReadChapterRewardRequest, ReadChapterRewardResponse };

export interface CheckinResponse {
  success: boolean;
  message: string;
  expGained: number;
  omnicoinGained: number;
  streak: number;
}

export async function getProgressionApi(): Promise<UserProgressionResponse> {
  const response = await apiClient.get<UserProgressionResponse>('/gamification/progression');
  return response.data;
}

export async function checkinApi(): Promise<CheckinResponse> {
  const response = await apiClient.post<CheckinResponse>('/gamification/checkin');
  return response.data;
}

export async function rewardReadChapterApi(
  dto: ReadChapterRewardRequest,
): Promise<ReadChapterRewardResponse> {
  const response = await apiClient.post<ReadChapterRewardResponse>(
    '/gamification/read-chapter',
    dto,
  );
  return response.data;
}

