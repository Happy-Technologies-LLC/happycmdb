// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication Service
 * Core authentication logic for login, token refresh, and API key management
 */

import { randomBytes, createHash } from 'crypto';
import type { ConfigSchema } from '@cmdb/common';
import { JWTService } from './jwt.service';
import { PasswordService } from './password.service';
import {
  User,
  ApiKey,
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  ApiKeyRequest,
  ApiKeyResponse,
  TokenPayload,
} from './types';

export interface AuthRepository {
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  updateUserLastLogin(userId: string): Promise<void>;
  findApiKeyByKey(keyHash: string): Promise<ApiKey | null>;
  createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey>;
  updateApiKeyLastUsed(keyId: string): Promise<void>;
  deleteApiKey(keyId: string): Promise<void>;
  listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]>;
}

export class AuthService {
  private jwtService: JWTService;
  private passwordService: PasswordService;
  private repository: AuthRepository;

  constructor(
    _config: ConfigSchema['auth'],
    _repository: AuthRepository
  ) {
    this.jwtService = new JWTService(_config.jwt);
    this.passwordService = new PasswordService(_config.bcrypt);
    this.repository = _repository;
  }

  /**
   * Login with username and password
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const { username, password } = request;

    // Find user
    const user = await this.repository.findUserByUsername(username);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Check if user is enabled
    if (!user._enabled) {
      throw new Error('User account is disabled');
    }

    // Verify password
    const isValid = await this.passwordService.verify(password, user._passwordHash);
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    // Update last login
    await this.repository.updateUserLastLogin(user._id);

    // Generate tokens
    const accessToken = this.jwtService.generateAccessToken(user._id, user._username, user._role);
    const refreshToken = this.jwtService.generateRefreshToken(user._id, user._username, user._role);

    return {
      _accessToken: accessToken,
      _refreshToken: refreshToken,
      _expiresIn: this.jwtService.getTokenExpiresIn('access'),
      _user: {
        _id: user._id,
        _username: user._username,
        _role: user._role,
      },
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(request: RefreshTokenRequest): Promise<LoginResponse> {
    const { refreshToken } = request;

    // Verify refresh token
    let payload: TokenPayload;
    try {
      payload = this.jwtService.verifyToken(refreshToken);
    } catch (error) {
      throw new Error('Invalid or expired refresh token');
    }

    // Ensure it's a refresh token
    if (payload._type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    // Find user
    const user = await this.repository.findUserById(payload._userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Check if user is enabled
    if (!user._enabled) {
      throw new Error('User account is disabled');
    }

    // Generate new tokens
    const accessToken = this.jwtService.generateAccessToken(user._id, user._username, user._role);
    const newRefreshToken = this.jwtService.generateRefreshToken(user._id, user._username, user._role);

    return {
      _accessToken: accessToken,
      _refreshToken: newRefreshToken,
      _expiresIn: this.jwtService.getTokenExpiresIn('access'),
      _user: {
        _id: user._id,
        _username: user._username,
        _role: user._role,
      },
    };
  }

  /**
   * Verify JWT token and return payload
   */
  async verifyToken(token: string): Promise<TokenPayload> {
    try {
      const payload = this.jwtService.verifyToken(token);

      // Verify user still exists and is enabled
      const user = await this.repository.findUserById(payload._userId);
      if (!user || !user._enabled) {
        throw new Error('User not found or disabled');
      }

      return payload;
    } catch (error) {
      throw new Error(`Token verification failed: ${error}`);
    }
  }

  /**
   * Generate API key for a user
   */
  async generateApiKey(userId: string, request: ApiKeyRequest): Promise<ApiKeyResponse> {
    const { _name, expiresInDays } = request;

    // Find user
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Generate random API key (64 characters hex)
    const apiKey = this.generateRandomKey(64);
    const keyHash = this.hashKey(apiKey);

    // Calculate expiration
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;

    // Create API key record
    const created = await this.repository.createApiKey({
      _key: apiKey, // Store plain key temporarily (will be removed after response)
      _keyHash: keyHash,
      _name,
      _userId: user._id,
      _role: user._role,
      _enabled: true,
      expiresAt,
      lastUsedAt: undefined,
    } as any);

    return {
      _apiKey: apiKey, // Return plain key once (user must save it)
      _id: created._id,
      _name: created._name,
      expiresAt: created.expiresAt,
    };
  }

  /**
   * Verify API key and return associated user info
   */
  async verifyApiKey(apiKey: string): Promise<TokenPayload> {
    const keyHash = this.hashKey(apiKey);

    // Find API key
    const apiKeyRecord = await this.repository.findApiKeyByKey(keyHash);
    if (!apiKeyRecord) {
      throw new Error('Invalid API key');
    }

    // Check if enabled
    if (!apiKeyRecord._enabled) {
      throw new Error('API key is disabled');
    }

    // Check if expired
    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      throw new Error('API key expired');
    }

    // Find user
    const user = await this.repository.findUserById(apiKeyRecord._userId);
    if (!user || !user._enabled) {
      throw new Error('Associated user not found or disabled');
    }

    // Update last used timestamp
    await this.repository.updateApiKeyLastUsed(apiKeyRecord._id);

    // Return token payload format
    return {
      _userId: user._id,
      _username: user._username,
      _role: apiKeyRecord._role,
      _type: 'access', // API keys act like access tokens
    };
  }

  /**
   * Revoke API key
   */
  async revokeApiKey(_userId: string, keyId: string): Promise<void> {
    await this.repository.deleteApiKey(keyId);
  }

  /**
   * List all API keys for a user
   */
  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    return await this.repository.listApiKeys(userId);
  }

  /**
   * Generate random key
   */
  private generateRandomKey(length: number): string {
    return randomBytes(length / 2).toString('hex');
  }

  /**
   * Hash API key for storage
   */
  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
