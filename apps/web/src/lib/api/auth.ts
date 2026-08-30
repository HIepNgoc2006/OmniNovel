import { apiClient } from './client';
import { GlobalRole } from '@omninovel/shared';

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  fullName?: string;
  avatarUrl?: string;
  globalRole: GlobalRole;
  isActive: boolean;
  createdAt: string;
}

export interface LoginRequest {
  email?: string;
  username?: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  user: UserProfile;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  fullName?: string;
}

export interface RegisterResponse {
  message: string;
  user: {
    id: string;
    email: string;
    username: string;
  };
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
  const response = await apiClient.get<UserProfile>('/auth/me');
  return response.data;
}
