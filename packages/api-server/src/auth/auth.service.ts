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
import { containsNul, defaultCredentialsRefused, isDefaultEquivalent, newPasswordAllowed } from './default-credentials';
import { isPlatformAdmin } from './platform-admin';
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

export interface UserProfileUpdate {
  name?: string;
  avatar?: string;
}

/** Compare-and-set target of a self-service write (HP1-S6, SEC16-01). */
export interface GuardedUserWrite {
  userId: string;
  /** Neo4j elementId of the node that was read; the write addresses only that node. */
  elementId?: string;
  /** Generation of the credential that authorized the request; the write lands only while it is current. */
  credentialEpoch: number;
}

export interface GuardedPasswordWrite extends GuardedUserWrite {
  /** Hash the current password was verified against; the write lands only while it is still stored. */
  readHash: string;
  newHash: string;
}

export interface CredentialEventInput {
  userId: string;
  event: 'default_marker_set_login';
  actor: string;
}

export interface AuthRepository {
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  updateUserLastLogin(userId: string): Promise<void>;
  /** Applies a partial profile update (name/avatar) and returns the updated user. */
  updateUser(id: string, updates: UserProfileUpdate): Promise<User>;
  /**
   * Sets the password hash only while the node still has the authorizing
   * generation, is unmarked and stores `readHash`. False when nothing was written.
   */
  updatePasswordHashGuarded(write: GuardedPasswordWrite): Promise<boolean>;
  /** Disables the account only while the authorizing generation is current and it is unmarked. */
  disableUserGuarded(write: GuardedUserWrite): Promise<boolean>;
  /**
   * Permanently deletes the user's account and every record owned solely
   * by that account (API keys, application settings, discovery provider
   * settings). Does not touch data the user merely authored elsewhere.
   */
  deleteUserAccount(id: string, elementId?: string): Promise<void>;
  /** Sets the default-password marker; true only on the false → true transition. */
  markDefaultSuspect(user: User): Promise<boolean>;
  /** Appends an auth_credential_events row. */
  recordCredentialEvent(event: CredentialEventInput): Promise<void>;
  findApiKeyByKey(keyHash: string): Promise<ApiKey | null>;
  createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey>;
  updateApiKeyLastUsed(keyId: string): Promise<void>;
  deleteApiKey(userId: string, keyId: string): Promise<number>;
  listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]>;
}

/** A new password that is default-equivalent, contains U+0000 or exceeds 72 UTF-8 bytes (→ 400). */
export class PasswordNotAllowedError extends Error {
  constructor() {
    super('Password not allowed');
    this.name = 'PasswordNotAllowedError';
  }
}

/** The authorizing credential's generation is no longer current (→ 401). */
export class CredentialsChangedError extends Error {
  constructor() {
    super('Credentials changed');
    this.name = 'CredentialsChangedError';
  }
}

const INVALID_CREDENTIALS = 'Invalid credentials';

/** The user's credential generation (absent = 0; NaN when malformed). */
function credentialEpochOf(user: Pick<User, '_credentialEpoch'>): number {
  return user._credentialEpoch ?? 0;
}

/** Equality of generations; a malformed (non-integer) generation never matches. */
function sameGeneration(presented: unknown, current: number): boolean {
  return Number.isSafeInteger(current) && presented === current;
}

export class ApiKeyNotFoundError extends Error {
  constructor() {
    super('API key not found');
    this.name = 'ApiKeyNotFoundError';
  }
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
   * Login with username and password.
   *
   * Outside development (HP1-S6, v16 §1.1): a default-equivalent password is
   * refused before anything else, and if it matches the stored hash the
   * account is marked; a password containing U+0000 is refused; a marked
   * account never gets tokens; login never clears the marker. Tokens carry
   * the credential generation of the user read whose hash was compared, and
   * a re-read after bcrypt refuses when the generation, hash, marker or
   * enabled flag moved meanwhile (a concurrent operator rotation).
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const { username, password } = request;

    // Find user
    const user = await this.repository.findUserByUsername(username);
    if (!user) {
      throw new Error(INVALID_CREDENTIALS);
    }

    // Check if user is enabled
    if (!user._enabled) {
      throw new Error('User account is disabled');
    }

    const refuseDefaults = defaultCredentialsRefused();
    if (refuseDefaults) {
      if (isDefaultEquivalent(password)) {
        await this.markIfDefaultHash(user, password);
        throw new Error(INVALID_CREDENTIALS);
      }
      if (containsNul(password)) {
        throw new Error(INVALID_CREDENTIALS);
      }
    }

    if (!(await this.verifyPassword(password, user._passwordHash))) {
      throw new Error(INVALID_CREDENTIALS);
    }
    if (refuseDefaults && user._defaultPasswordSuspect === true) {
      throw new Error(INVALID_CREDENTIALS);
    }

    const credentialEpoch = credentialEpochOf(user);
    const current = await this.repository.findUserById(user._id);
    if (
      !current || !current._enabled || current._passwordHash !== user._passwordHash
      || !sameGeneration(credentialEpochOf(current), credentialEpoch)
      || (refuseDefaults && current._defaultPasswordSuspect === true)
    ) {
      throw new Error(INVALID_CREDENTIALS);
    }

    // Update last login
    await this.repository.updateUserLastLogin(user._id);

    // Generate tokens (tenant claim comes from the user record, never the request)
    const accessToken = this.jwtService.generateAccessToken(
      user._id, user._username, user._role, user._organizationId, credentialEpoch
    );
    const refreshToken = this.jwtService.generateRefreshToken(user._id, user._username, user._role, credentialEpoch);

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
   * Refresh access token using refresh token. The refresh token must be of
   * the user's current credential generation, and the user unmarked.
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

    const credentialEpoch = credentialEpochOf(user);
    if (
      (defaultCredentialsRefused() && user._defaultPasswordSuspect === true)
      || !sameGeneration(payload._cep ?? 0, credentialEpoch)
    ) {
      throw new Error('Invalid or expired refresh token');
    }

    // Generate new tokens from the current user record (org re-read, not copied from the old token)
    const accessToken = this.jwtService.generateAccessToken(
      user._id, user._username, user._role, user._organizationId, credentialEpoch
    );
    const newRefreshToken = this.jwtService.generateRefreshToken(user._id, user._username, user._role, credentialEpoch);

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
   * Verify a bearer (access) JWT and return its payload with the tenant
   * claim taken from the freshly loaded user record, never from the token:
   * moving or removing a user's organization takes effect on the next
   * request. Refresh tokens are rejected here; they are only accepted by
   * refreshToken(). The token must be of the user's current credential
   * generation and the user unmarked; `_platformAdmin` is the user's
   * effective platform-admin status, never a token claim.
   */
  async verifyToken(token: string): Promise<TokenPayload> {
    try {
      const payload = this.jwtService.verifyToken(token);

      if (payload._type !== 'access') {
        throw new Error('Invalid token type');
      }

      const user = await this.findEnabledUser(payload._userId);
      if (!user) {
        throw new Error('User not found or disabled');
      }
      if (defaultCredentialsRefused() && user._defaultPasswordSuspect === true) {
        throw new Error('Credentials refused');
      }
      const credentialEpoch = credentialEpochOf(user);
      if (!sameGeneration(payload._cep ?? 0, credentialEpoch)) {
        throw new Error('Credentials rotated');
      }

      return {
        ...payload,
        _organizationId: user._organizationId,
        _cep: credentialEpoch,
        _platformAdmin: isPlatformAdmin(user),
      };
    } catch (error) {
      throw new Error(`Token verification failed: ${error}`);
    }
  }

  /**
   * The user record if it exists and is enabled, re-read from the store; the
   * check verifyToken applies on every request. Long-lived connections
   * (WebSocketService) call it to re-check identities verified earlier.
   */
  async findEnabledUser(userId: string): Promise<User | null> {
    const user = await this.repository.findUserById(userId);
    return user && user._enabled ? user : null;
  }

  /**
   * Generate an API key for a user. The key records the credential
   * generation of the credential that authorized this request
   * (`authorizingEpoch`, req.user._cep), never a fresh read: a key created
   * in flight by a pre-rotation credential is born dead.
   */
  async generateApiKey(userId: string, request: ApiKeyRequest, authorizingEpoch: number): Promise<ApiKeyResponse> {
    const { name: _name, expiresInDays } = request;
    if (!Number.isSafeInteger(authorizingEpoch)) {
      throw new CredentialsChangedError();
    }

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
      _credentialEpoch: authorizingEpoch,
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
    if (defaultCredentialsRefused() && user._defaultPasswordSuspect === true) {
      throw new Error('Associated user not found or disabled');
    }
    const credentialEpoch = credentialEpochOf(user);
    if (!sameGeneration(apiKeyRecord._credentialEpoch ?? 0, credentialEpoch)) {
      throw new Error('API key revoked');
    }

    // Update last used timestamp
    await this.repository.updateApiKeyLastUsed(apiKeyRecord._id);

    // Return token payload format; the tenant claim is the owning user's org.
    // API keys never carry platform administration (P-6).
    return {
      _userId: user._id,
      _username: user._username,
      _role: apiKeyRecord._role,
      _type: 'access', // API keys act like access tokens
      _organizationId: user._organizationId,
      _cep: credentialEpoch,
      _platformAdmin: false,
    };
  }

  /**
   * Revoke API key
   */
  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    const affectedRows = await this.repository.deleteApiKey(userId, keyId);
    if (affectedRows === 0) {
      throw new ApiKeyNotFoundError();
    }
  }

  /**
   * List all API keys for a user
   */
  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    return await this.repository.listApiKeys(userId);
  }

  /**
   * Get the authenticated user's sanitized profile (no password hash)
   */
  async getUserProfile(userId: string): Promise<Omit<User, '_passwordHash'> | null> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      return null;
    }
    const { _passwordHash, ...profile } = user;
    return profile;
  }

  /**
   * Update the authenticated user's profile (name/avatar only)
   */
  async updateProfile(
    userId: string,
    updates: { name?: string; avatar?: string }
  ): Promise<Omit<User, '_passwordHash'>> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const updated = await this.repository.updateUser(userId, updates);
    const { _passwordHash, ...profile } = updated;
    return profile;
  }

  /**
   * Change the authenticated user's password, verifying the current
   * password against the stored hash before replacing it. The new password
   * must not be default-equivalent, contain U+0000 or exceed 72 bytes (every
   * environment). The write is a compare-and-set against the authorizing
   * credential generation, the hash just verified and an unmarked account,
   * so a request authorized before an operator rotation cannot overwrite it.
   * Never touches the marker or the generation.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    authorizingEpoch: number
  ): Promise<void> {
    if (!newPasswordAllowed(newPassword)) {
      throw new PasswordNotAllowedError();
    }

    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    const credentialEpoch = credentialEpochOf(user);
    if (!sameGeneration(authorizingEpoch, credentialEpoch)) {
      throw new CredentialsChangedError();
    }

    if (!(await this.verifyPassword(currentPassword, user._passwordHash))) {
      throw new Error('Current password is incorrect');
    }

    const newHash = await this.passwordService.hash(newPassword);
    const written = await this.repository.updatePasswordHashGuarded({
      userId, elementId: user._elementId, credentialEpoch, readHash: user._passwordHash, newHash,
    });
    if (!written) {
      throw new CredentialsChangedError();
    }
  }

  /**
   * Permanently delete the authenticated user's account and everything
   * owned solely by it (API keys, application settings). The account is
   * first disabled by a compare-and-set against the authorizing credential
   * generation, so a request authorized before an operator rotation cannot
   * delete the rotated account.
   */
  async deleteAccount(userId: string, authorizingEpoch: number): Promise<void> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    const credentialEpoch = credentialEpochOf(user);
    if (!sameGeneration(authorizingEpoch, credentialEpoch)) {
      throw new CredentialsChangedError();
    }
    if (!(await this.repository.disableUserGuarded({ userId, elementId: user._elementId, credentialEpoch }))) {
      throw new CredentialsChangedError();
    }

    await this.repository.deleteUserAccount(userId, user._elementId);
  }

  /** bcrypt compare that treats a missing or non-bcrypt hash, or any library error, as a mismatch. */
  private async verifyPassword(password: string, hash: unknown): Promise<boolean> {
    if (typeof hash !== 'string' || hash === '') {
      return false;
    }
    try {
      return await this.passwordService.verify(password, hash);
    } catch {
      return false;
    }
  }

  /**
   * A refused default-equivalent login whose password matches the stored
   * hash marks the account (transition only) and audits that transition.
   * Failures here never turn the refusal into a different response.
   */
  private async markIfDefaultHash(user: User, password: string): Promise<void> {
    if (!(await this.verifyPassword(password, user._passwordHash))) {
      return;
    }
    try {
      if (await this.repository.markDefaultSuspect(user)) {
        await this.repository.recordCredentialEvent({ userId: user._id, event: 'default_marker_set_login', actor: user._id });
      }
    } catch {
      // Fail closed: the login is refused regardless; a missing event row
      // after a marker write leaves the account more locked, never less.
    }
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
