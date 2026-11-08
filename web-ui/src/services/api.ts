// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { AuthToken, LoginCredentials, User } from '../types';
import { AUTH_HEADER, attachSession, endSession, refreshSession } from '../lib/session';
import { setToken } from '../utils/token';

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

// Bearer from memory; a 401 renews the session once from the refresh cookie (HAP-1211 H2)
attachSession(apiClient);

// API Service class
class ApiService {
  // Authentication
  /** X-CMDB-Auth makes the server set the refresh cookie (HAP-1211 F2); the access token is held in memory. */
  async login(credentials: LoginCredentials): Promise<AuthToken> {
    const response = await apiClient.post<{ success: boolean; data?: { _accessToken?: unknown; _expiresIn?: number } }>('/auth/login', {
      username: credentials.username,
      password: credentials.password,
    }, { headers: AUTH_HEADER });
    return {
      access_token: setToken(response.data.data?._accessToken),
      expires_in: response.data.data?._expiresIn ?? 0,
      token_type: 'Bearer',
    };
  }

  /** Restores or renews the in-memory access token from the refresh cookie; rejects when the server refuses it. */
  async refresh(): Promise<void> {
    await refreshSession();
  }

  /**
   * Expires the refresh cookie, after any renewal in flight is answered (HAP-1211 H2). The header is not required
   * (operator ruling Q1); it is sent for a future guard.
   */
  async logout(): Promise<void> {
    await endSession(() => apiClient.post('/auth/logout', undefined, { headers: AUTH_HEADER }));
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

  /** HAP-1285: the change ends every session; the server re-issues this one (new access token, new refresh cookie). */
  async changePassword(data: ChangePasswordData): Promise<void> {
    const response = await apiClient.put<{ success: boolean; data?: { _accessToken?: unknown } }>('/auth/password', data);
    setToken(response.data.data?._accessToken);
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
