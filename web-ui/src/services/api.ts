// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { AuthToken, LoginCredentials, User } from '../types';

export interface UpdateProfileData {
  name?: string;
  avatar?: string;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
}

interface RawUserPayload {
  userId?: string;
  _userId?: string;
  username?: string;
  _username?: string;
  email?: string;
  name?: string;
  avatar?: string;
  _avatar?: string;
  role?: string;
  _role?: string;
  createdAt?: string;
  _createdAt?: string;
  lastLoginAt?: string;
  _lastLoginAt?: string;
}

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - add auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - handle errors
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const isLoginRequest = error.config?.url?.includes('/auth/login');
    if (error.response?.status === 401 && !isLoginRequest) {
      // Token expired or invalid
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// API Service class
class ApiService {
  // Authentication
  async login(credentials: LoginCredentials): Promise<AuthToken> {
    const response = await apiClient.post<{success: boolean; data: any}>('/auth/login', {
      username: credentials.username,
      password: credentials.password,
    });
    return {
      access_token: response.data.data._accessToken,
      refresh_token: response.data.data._refreshToken,
      expires_in: response.data.data._expiresIn,
      token_type: 'Bearer',
    };
  }

  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  }

  private mapUser(userData: RawUserPayload): User {
    return {
      user_id: userData.userId || userData._userId || '',
      username: userData.username || userData._username || '',
      email: userData.email || userData.username || userData._username || '',
      full_name: userData.name || userData.username || userData._username || '',
      avatar: userData.avatar || userData._avatar,
      role: (userData.role || userData._role || 'viewer') as User['role'],
      created_at: userData.createdAt || userData._createdAt || new Date().toISOString(),
      last_login: userData.lastLoginAt || userData._lastLoginAt,
    };
  }

  async getCurrentUser(): Promise<User> {
    const response = await apiClient.get<{ success: boolean; data: RawUserPayload }>('/auth/me');
    return this.mapUser(response.data.data);
  }

  async updateProfile(data: UpdateProfileData): Promise<User> {
    const response = await apiClient.put<{ success: boolean; data: RawUserPayload }>('/auth/profile', data);
    return this.mapUser(response.data.data);
  }

  async changePassword(data: ChangePasswordData): Promise<void> {
    await apiClient.put('/auth/password', data);
  }

  async deleteAccount(): Promise<void> {
    await apiClient.delete('/auth/account');
  }
}

// Export singleton instance
export const api = new ApiService();

// Export axios instance for custom requests
export { apiClient };

// Export types
export type { AxiosError, AxiosRequestConfig, AxiosResponse };
