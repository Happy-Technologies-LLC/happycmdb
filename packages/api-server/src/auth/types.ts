// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication & Authorization Types
 */

import type { Request } from 'express';

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
  /** Display name shown in the profile UI; falls back to username when unset. */
  _name?: string;
  /** Data-URL or hosted URL for the profile avatar image. */
  _avatar?: string;
  /**
   * Organization (tenant) the user belongs to. It is the tenant of every
   * request the user makes (re-read per request by AuthService.verifyToken /
   * verifyApiKey). Unset => org-scoped routes (business services, TBM) return 403.
   */
  _organizationId?: string;
  /** Neo4j elementId of the user node; guarded writes address the node by it. */
  _elementId?: string;
  /**
   * Dedicated platform-administrator flag (P-6): stored `platformAdmin`.
   * Independent of role and organization; never effective on a seeded
   * account (see platform-admin.ts isPlatformAdmin).
   */
  _platformAdmin?: boolean;
  /** Immutable seed provenance stamped by the seed writers / §12 inventory. */
  _seedProvenance?: string;
  /**
   * Stored `defaultPasswordSuspect`: the stored hash verified against a
   * default plaintext. Outside development the account can neither log in
   * nor use any credential until an operator rotation clears it.
   */
  _defaultPasswordSuspect?: boolean;
  /**
   * Credential generation (stored `credentialEpoch`, absent = 0). Every token
   * and API key is valid only for the generation it was minted in; an
   * operator rotation increments it. NaN when the stored value is malformed.
   */
  _credentialEpoch?: number;
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
  /** Credential generation of the credential that authorized this key's creation. */
  _credentialEpoch?: number;
}

export interface TokenPayload {
  _userId: string;
  _username: string;
  _role: UserRole;
  _type: 'access' | 'refresh';
  _tier?: ApiKeyTier;
  /**
   * Tenant; org-scoped routes require it (AuthMiddleware.requireOrganization).
   * On authenticated requests it is the user's current organization, not the
   * value minted into the token.
   */
  _organizationId?: string;
  /** Credential generation the token was minted in (absent on pre-HP1 tokens = 0). */
  _cep?: number;
  /**
   * Effective platform-administrator status, set by AuthService.verifyToken
   * from the freshly loaded user on every request; never minted into a JWT.
   */
  _platformAdmin?: boolean;
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
