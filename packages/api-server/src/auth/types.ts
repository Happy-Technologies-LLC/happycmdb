// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication & Authorization Types
 */

export type UserRole = 'admin' | 'operator' | 'viewer' | 'agent';

export type Permission = 'read' | 'write' | 'discover' | 'admin';

export interface User {
  _id: string;
  _username: string;
  _email: string;
  _passwordHash: string;
  _role: UserRole;
  _enabled: boolean;
  _createdAt: Date;
  _updatedAt: Date;
  lastLoginAt?: Date;
}

export type ApiKeyTier = 'standard' | 'premium' | 'enterprise';

export interface ApiKey {
  _id: string;
  _key: string;
  _keyHash: string;
  _name: string;
  _userId: string;
  _role: UserRole;
  _tier: ApiKeyTier;
  _enabled: boolean;
  expiresAt?: Date;
  _createdAt: Date;
  lastUsedAt?: Date;
}

export interface TokenPayload {
  _userId: string;
  _username: string;
  _role: UserRole;
  _type: 'access' | 'refresh';
  _tier?: ApiKeyTier;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  _accessToken: string;
  _refreshToken: string;
  _expiresIn: number;
  _user: {
    _id: string;
    _username: string;
    _role: UserRole;
  };
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface ApiKeyRequest {
  name: string;
  expiresInDays?: number;
}

export interface ApiKeyResponse {
  _apiKey: string;
  _id: string;
  _name: string;
  expiresAt?: Date;
}

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: ['read', 'write', 'discover', 'admin'],
  operator: ['read', 'write', 'discover'],
  viewer: ['read'],
  agent: ['discover', 'write'], // Agents can discover and write CI data
};
