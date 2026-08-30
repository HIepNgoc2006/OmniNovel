import { apiClient } from './client';
import { GlobalRole } from '@omninovel/shared';

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  role: GlobalRole | string;
  avatarUrl?: string | null;
  createdAt?: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  user: UserProfile;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface RegisterResponse {
  message: string;
  user: {
    id: string;
    email: string;
    username: string;
    role?: string;
    avatarUrl?: string | null;
    createdAt?: string;
  };
}

export interface GetMeResponse {
  user: UserProfile;
  permissions: string[];
}

export async function loginApi(data: LoginRequest): Promise<LoginResponse> {
  const response = await apiClient.post<LoginResponse>('/auth/login', data);
  return response.data;
}

export async function registerApi(data: RegisterRequest): Promise<RegisterResponse> {
  const response = await apiClient.post<RegisterResponse>('/auth/register', data);
  return response.data;
}

export async function logoutApi(): Promise<{ message: string }> {
  const response = await apiClient.post<{ message: string }>('/auth/logout');
  return response.data;
}

export async function getMeApi(): Promise<UserProfile> {
  const response = await apiClient.get<GetMeResponse>('/auth/me');
  return response.data.user;
}
