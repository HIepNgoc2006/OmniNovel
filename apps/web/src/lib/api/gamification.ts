import { apiClient } from './client';
import { UserProgressionResponse } from '@omninovel/shared';

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
