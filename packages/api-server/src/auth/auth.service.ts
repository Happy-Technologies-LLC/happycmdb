// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication Service
 * Core authentication logic for login, token refresh, and API key management
 */

import { randomBytes, createHash } from 'crypto';
import { isIP } from 'net';
import { errorClassFields, logger, type AuditLogEntry, type ConfigSchema } from '@cmdb/common';
import { JWTService, TokenVerificationError } from './jwt.service';
import { BCRYPT_HASH, PasswordService } from './password.service';
import { containsNul, defaultCredentialsRefused, isDefaultEquivalent, newPasswordAllowed } from './default-credentials';
import {
  User,
  ApiKey,
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  ApiKeyRequest,
  ApiKeyResponse,
  TokenPayload,
  ROLE_PERMISSIONS,
  AmbiguousUserIdentityError,
  UserNotFoundError,
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

/** Cost-convergence write of a successful login: the same password at the configured cost, same generation (HAP-1090). */
export interface GuardedPasswordRehash extends GuardedUserWrite {
  /** Hash the password was verified against; the write lands only while it is still stored. */
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
  /**
   * Replaces the hash with the same password at a new cost only while the node still has the verified
   * generation, is unmarked and stores `readHash`. Never changes the generation. False when nothing was written.
   */
  rehashPasswordGuarded(write: GuardedPasswordRehash): Promise<boolean>;
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
  /** HAP-1368: whether the hash-chained audit_log can be written (AUDIT_CHAIN_KEY set). */
  auditChainReady(): boolean;
  /** HAP-1368: appends one hash-chained audit_log row bound to the organization. */
  recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>, organizationId: string): Promise<void>;
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

/** The current password of a self-service change did not match (→ 400; HAP-1368 audits it as wrong_password). */
export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'CurrentPasswordIncorrectError';
  }
}

/** Audited outcomes of a self-service password change attempt (HAP-1368); the list is what tests enumerate. */
export const PASSWORD_CHANGE_OUTCOMES = ['success', 'wrong_password'] as const;
export type PasswordChangeOutcome = (typeof PASSWORD_CHANGE_OUTCOMES)[number];

/**
 * HAP-1711: the client address for an audit row, only when it is a bare IPv4/IPv6 literal that Postgres `inet` stores
 * as a host address; anything else is undefined (a null ip_address). req.ip can be a zone-id IPv6 (net.isIP accepts
 * `fe80::1%eth0`, inet rejects it), a non-IP leftmost X-Forwarded-For under an over-broad TRUST_PROXY, or text with a
 * /prefix (inet would store a network mask); one such value would otherwise fail the audit insert and lose the row.
 */
export function auditClientAddress(ip: string | undefined): string | undefined {
  return ip !== undefined && isIP(ip) !== 0 && !ip.includes('%') ? ip : undefined;
}

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

/**
 * Logged reason of an authentication failure; never part of a response.
 * `default_credential_refused` (v16 §15 N-21) is a default-equivalent login
 * password refused outside development; `ambiguous_identity` is an
 * identifier matching more than one :User node. Callers send both the same
 * response as any other failure.
 */
export type AuthFailureReason =
  | 'invalid' | 'expired' | 'wrong_type' | 'disabled' | 'revoked' | 'store_error' | 'default_credential_refused'
  | 'ambiguous_identity';

export class AuthFailureError extends Error {
  override readonly cause: unknown;

  constructor(readonly reason: AuthFailureReason, cause?: unknown) {
    super('Authentication failed');
    this.cause = cause;
  }
}

function tokenFailure(error: unknown): AuthFailureError {
  return new AuthFailureError(error instanceof TokenVerificationError ? error.reason : 'store_error', error);
}

/** Any failure inside a credential check as an AuthFailureError (fail closed). */
function asAuthFailure(error: unknown): AuthFailureError {
  if (error instanceof AuthFailureError) return error;
  if (error instanceof AmbiguousUserIdentityError) return new AuthFailureError('ambiguous_identity', error);
  return new AuthFailureError('store_error', error);
}

/** Absolute session cap (HAP-1285, founder decision): refresh is refused once now − `_authTime` exceeds it. Not configurable. */
export const SESSION_ABSOLUTE_CAP_SECONDS = 7 * 24 * 60 * 60;

/**
 * Clock-skew allowance (HAP-1669): a refresh token's `_authTime` may exceed its own `iat` by at most this many seconds.
 * Both claims are minted by this service in one call (`_authTime` is `iat` at login, earlier on a renewal), so any real
 * excess is a forged or corrupted claim; without the bound a future `_authTime` never reaches the 7-day cap.
 */
export const AUTH_TIME_TOLERANCE_SECONDS = 60;

export class AuthService {
  private jwtService: JWTService;
  private passwordService: PasswordService;
  private repository: AuthRepository;
  private dummyHash: Promise<string> | undefined;

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
   * Every attempt makes exactly one bcrypt compare before any outcome is
   * decided (HAP-552): against a usable stored hash, else the dummy hash.
   *
   * Outside development (HP1-S6, v16 §1.1): a default-equivalent password is
   * always refused, and if it matches the stored hash the
   * account is marked; a password containing U+0000 is refused; a marked
   * account never gets tokens; login never clears the marker. Tokens carry
   * the credential generation of the user read whose hash was compared, and
   * a re-read after bcrypt refuses when the generation, hash, marker or
   * enabled flag moved meanwhile (a concurrent operator rotation).
   *
   * Cost convergence (HAP-1090): once every check above has passed, a stored hash at a cost other than the configured
   * one is replaced by the same password at the configured cost (guarded, same generation, best-effort). Never on a
   * refused attempt, an unknown or disabled user, or a hash already at the configured cost.
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const { username, password } = request;
    try {
      const dummyHash = await this.loginDummyHash();
      let lookupFailure: { error: unknown } | undefined;
      const user = await this.repository.findUserByUsername(username).catch((error: unknown) => {
        lookupFailure = { error };
        return null;
      });
      // Exactly one compare, whatever the lookup found; a dummy compare never matches.
      const stored = user?._passwordHash;
      const usable = typeof stored === 'string' && BCRYPT_HASH.test(stored);
      const matched = (await this.verifyPassword(password, usable ? stored : dummyHash)) && usable;
      if (lookupFailure !== undefined) throw lookupFailure.error;
      if (!user) throw new AuthFailureError('invalid');
      if (!user._enabled) throw new AuthFailureError('disabled');

      const refuseDefaults = defaultCredentialsRefused();
      if (refuseDefaults) {
        if (isDefaultEquivalent(password)) {
          if (matched) await this.markIfDefaultHash(user);
          throw new AuthFailureError('default_credential_refused');
        }
        if (containsNul(password)) throw new AuthFailureError('invalid');
      }

      if (!matched) throw new AuthFailureError('invalid');
      if (refuseDefaults && user._defaultPasswordSuspect === true) {
        throw new AuthFailureError('invalid');
      }

      const credentialEpoch = credentialEpochOf(user);
      const current = await this.repository.findUserById(user._id);
      if (
        !current || !current._enabled || current._passwordHash !== user._passwordHash
        || !sameGeneration(credentialEpochOf(current), credentialEpoch)
        || (refuseDefaults && current._defaultPasswordSuspect === true)
      ) {
        throw new AuthFailureError('invalid');
      }

      await this.repository.updateUserLastLogin(user._id);
      await this.rehashStoredPassword(user, password, credentialEpoch);
      // Tenant claim comes from the user record, never the request.
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
    } catch (error) {
      throw asAuthFailure(error);
    }
  }

  /**
   * Refresh access token using refresh token. The refresh token must be of
   * the user's current credential generation, the user unmarked, and the
   * login it descends from at most SESSION_ABSOLUTE_CAP_SECONDS old.
   */
  async refreshToken(request: RefreshTokenRequest): Promise<LoginResponse> {
    const { refreshToken } = request;
    let payload: TokenPayload;
    try {
      payload = this.jwtService.verifyToken(refreshToken);
    } catch (error) {
      throw tokenFailure(error);
    }
    if (payload._type !== 'refresh') throw new AuthFailureError('wrong_type');
    // HAP-1285: a hard cap from the login, checked before any store read. A token without the claim predates it.
    const { _authTime: authTime, iat } = payload;
    if (!Number.isSafeInteger(authTime) || !Number.isSafeInteger(iat)) throw new AuthFailureError('invalid');
    // HAP-1669: the login time cannot lie after this token's own issue time (beyond skew), or the cap would never end it.
    if (authTime! > iat! + AUTH_TIME_TOLERANCE_SECONDS) throw new AuthFailureError('invalid');
    if (Math.floor(Date.now() / 1000) - authTime! > SESSION_ABSOLUTE_CAP_SECONDS) throw new AuthFailureError('expired');

    try {
      const user = await this.repository.findUserById(payload._userId);
      if (!user) throw new AuthFailureError('revoked');
      if (!user._enabled) throw new AuthFailureError('disabled');
      const credentialEpoch = credentialEpochOf(user);
      if (
        (defaultCredentialsRefused() && user._defaultPasswordSuspect === true)
        || !sameGeneration(payload._cep ?? 0, credentialEpoch)
      ) {
        throw new AuthFailureError('revoked');
      }

      // New tokens from the current user record (org re-read, not copied from the old token); the login time is kept.
      const accessToken = this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, credentialEpoch
      );
      const newRefreshToken = this.jwtService.generateRefreshToken(
        user._id, user._username, user._role, credentialEpoch, authTime
      );
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
    } catch (error) {
      throw asAuthFailure(error);
    }
  }

  /**
   * Verify a bearer (access) JWT and return its payload with authorization
   * role and tenant from the freshly loaded enabled user, never from the token.
   * Refresh tokens are rejected here; they are only accepted by refreshToken().
   * The token must be of the user's current credential generation and the
   * user unmarked. No platform-admin marker is returned: platform authority
   * is decided per request from the store (AuthMiddleware.requirePlatformAdmin).
   */
  async verifyToken(token: string): Promise<TokenPayload> {
    let payload: TokenPayload;
    try {
      payload = this.jwtService.verifyToken(token);
    } catch (error) {
      throw tokenFailure(error);
    }
    if (payload._type !== 'access') throw new AuthFailureError('wrong_type');
    try {
      const user = await this.repository.findUserById(payload._userId);
      if (!user) throw new AuthFailureError('revoked');
      if (!user._enabled) throw new AuthFailureError('disabled');
      if (defaultCredentialsRefused() && user._defaultPasswordSuspect === true) {
        throw new AuthFailureError('revoked');
      }
      const credentialEpoch = credentialEpochOf(user);
      if (!sameGeneration(payload._cep ?? 0, credentialEpoch)) {
        throw new AuthFailureError('revoked');
      }
      return {
        _userId: payload._userId,
        _username: payload._username,
        _role: user._role,
        _type: payload._type,
        _tier: payload._tier,
        _organizationId: user._organizationId,
        _cep: credentialEpoch,
        iat: payload.iat,
        exp: payload.exp,
        iss: payload.iss,
        aud: payload.aud,
      };
    } catch (error) {
      throw asAuthFailure(error);
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
      throw new UserNotFoundError();
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
    try {
      const keyHash = this.hashKey(apiKey);
      const apiKeyRecord = await this.repository.findApiKeyByKey(keyHash);
      if (!apiKeyRecord) throw new AuthFailureError('invalid');
      if (!apiKeyRecord._enabled) throw new AuthFailureError('disabled');
      if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
        throw new AuthFailureError('expired');
      }

      const user = await this.repository.findUserById(apiKeyRecord._userId);
      if (!user) throw new AuthFailureError('revoked');
      if (!user._enabled) throw new AuthFailureError('disabled');
      if (defaultCredentialsRefused() && user._defaultPasswordSuspect === true) {
        throw new AuthFailureError('disabled');
      }
      const credentialEpoch = credentialEpochOf(user);
      if (!sameGeneration(apiKeyRecord._credentialEpoch ?? 0, credentialEpoch)) {
        throw new AuthFailureError('revoked');
      }

      // Agent and viewer are incomparable: the key can grant only permissions
      // held by both its stored role and the user's current role.
      const keyPermissions = ROLE_PERMISSIONS[apiKeyRecord._role];
      const userPermissions = ROLE_PERMISSIONS[user._role];
      if (keyPermissions === undefined || userPermissions === undefined) {
        throw new AuthFailureError('invalid');
      }
      const effectiveRole = keyPermissions.every(permission => userPermissions.includes(permission))
        ? apiKeyRecord._role
        : userPermissions.every(permission => keyPermissions.includes(permission))
          ? user._role
          : null;
      if (effectiveRole === null) throw new AuthFailureError('invalid');

      await this.repository.updateApiKeyLastUsed(apiKeyRecord._id);
      // The tenant claim is the owning user's org. API keys never carry
      // platform administration (P-6).
      return {
        _userId: user._id,
        _username: user._username,
        _role: effectiveRole,
        _type: 'access',
        _organizationId: user._organizationId,
        _cep: credentialEpoch,
      };
    } catch (error) {
      throw asAuthFailure(error);
    }
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
   * List all API keys for a user. A key of another credential generation no longer authenticates
   * (verifyApiKey), so it is listed with `_enabled: false` (HAP-1285; read side only).
   */
  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    const [user, keys] = await Promise.all([this.repository.findUserById(userId), this.repository.listApiKeys(userId)]);
    const current = user ? credentialEpochOf(user) : Number.NaN;
    return keys.map(({ _credentialEpoch, ...key }) => ({
      ...key, _enabled: key._enabled && sameGeneration(_credentialEpoch ?? 0, current),
    }));
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
      throw new UserNotFoundError();
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
   * It advances the generation with the hash, ending every session and API
   * key of the user (HAP-1285), and returns a new session for the caller's
   * device: a fresh authentication, so its absolute cap starts now. Never
   * touches the marker.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    authorizingEpoch: number
  ): Promise<LoginResponse> {
    if (!newPasswordAllowed(newPassword)) {
      throw new PasswordNotAllowedError();
    }

    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new UserNotFoundError();
    }
    const credentialEpoch = credentialEpochOf(user);
    if (!sameGeneration(authorizingEpoch, credentialEpoch)) {
      throw new CredentialsChangedError();
    }

    if (!(await this.verifyPassword(currentPassword, user._passwordHash))) {
      throw new CurrentPasswordIncorrectError();
    }

    const newHash = await this.passwordService.hash(newPassword);
    const written = await this.repository.updatePasswordHashGuarded({
      userId, elementId: user._elementId, credentialEpoch, readHash: user._passwordHash, newHash,
    });
    if (!written) {
      throw new CredentialsChangedError();
    }
    // The writer advanced the generation by exactly one (in Cypher, guarded by `credentialEpoch`).
    const nextEpoch = credentialEpoch + 1;
    // A new session for this device at the new generation; a fresh authentication, so its login time is now.
    return {
      _accessToken: this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, nextEpoch
      ),
      _refreshToken: this.jwtService.generateRefreshToken(user._id, user._username, user._role, nextEpoch),
      _expiresIn: this.jwtService.getTokenExpiresIn('access'),
      _user: { _id: user._id, _username: user._username, _role: user._role },
    };
  }

  /**
   * Converges a verified login's stored hash to the configured cost (HAP-1090). Best-effort: the login has already
   * succeeded, so a lost guard or a store error logs the error class only (never the password, hash or message) and
   * the login completes with the response it would have had. The write keeps the generation, so no session or API key ends.
   */
  private async rehashStoredPassword(user: User, password: string, credentialEpoch: number): Promise<void> {
    const readHash = user._passwordHash;
    try {
      if (!this.passwordService.needsRehash(readHash)) return;
      const newHash = await this.passwordService.hash(password);
      await this.repository.rehashPasswordGuarded({
        userId: user._id, elementId: user._elementId, credentialEpoch, readHash, newHash,
      });
    } catch (error) {
      logger.warn('Login password rehash failed', errorClassFields(error));
    }
  }

  /** HAP-1368: a self-service password change is refused (503) before anything changes while it cannot be audited. */
  auditChainReady(): boolean {
    return this.repository.auditChainReady();
  }

  /**
   * HAP-1368: one audit_log row for a self-service password change attempt: the verified user, the client address,
   * the outcome and the actor's organization claim; never a password, hash or token. Best-effort: the outcome is
   * already decided (a changed password stays changed), so a failed write or a missing organization (tenancy is
   * never inferred) logs fixed text and returns.
   */
  async auditPasswordChange(
    userId: string, organizationId: string | null, ipAddress: string | undefined, outcome: PasswordChangeOutcome
  ): Promise<void> {
    if (organizationId === null) {
      logger.error('Password change not audited: the actor has no organization claim');
      return;
    }
    try {
      await this.repository.recordAudit({
        entity_type: 'USER', entity_id: userId, action: 'UPDATE', actor: userId, actor_type: 'user', changes: [],
        metadata: { operation: 'password_change', outcome }, ip_address: auditClientAddress(ipAddress),
      }, organizationId);
    } catch {
      logger.error('Password change audit write failed');
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
      throw new UserNotFoundError();
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
   * bcrypt hash of 32 random bytes at the configured cost, created on the
   * first login attempt and memoized; compared when there is no usable stored
   * hash so that every attempt costs exactly one compare (HAP-552). Its
   * plaintext is discarded. A failed generation is not memoized.
   */
  private loginDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwordService.hash(randomBytes(32).toString('hex')).catch((error: unknown) => {
      this.dummyHash = undefined;
      throw error;
    });
    return this.dummyHash;
  }

  /**
   * A refused default-equivalent login whose password matched the stored
   * hash marks the account (transition only) and audits that transition.
   * Failures here never turn the refusal into a different response.
   */
  private async markIfDefaultHash(user: User): Promise<void> {
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
