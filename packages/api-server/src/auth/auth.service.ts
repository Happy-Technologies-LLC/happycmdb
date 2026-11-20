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
import { isPlatformAdmin } from './platform-admin';
import type { RefusalBucket } from '../middleware/rate-limit.middleware';
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

/**
 * What the authenticated user may read about their own record. Disclosure
 * is exactly these fields (HAP-1911): see AuthService.toProfile.
 */
export interface UserProfile {
  _id: string;
  _username: string;
  _email: string;
  _role: User['_role'];
  _createdAt: Date;
  lastLoginAt?: Date;
  _name?: string;
  _avatar?: string;
  _organizationId?: string;
  /** Effective platform-administrator status (isPlatformAdmin), not the stored flag. */
  platformAdmin: boolean;
}

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
  /** The organization the request is bound to; the write lands only while the node still stores it (HAP-2061). */
  organizationId: string;
}

/** Cost-convergence write of a successful login: the same password at the configured cost, same generation (HAP-1090). */
export interface GuardedPasswordRehash extends GuardedUserWrite {
  /** Hash the password was verified against; the write lands only while it is still stored. */
  readHash: string;
  newHash: string;
}

/** Revoke-other-sessions write (HAP-1716): the generation advances, the hash is untouched. */
export interface GuardedEpochBump extends GuardedUserWrite {
  /** Hash the current password was verified against; the write lands only while it is still stored. */
  readHash: string;
  /** The organization the request is bound to; the write lands only while the node still stores it (HAP-2061). */
  organizationId: string;
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
   * generation, is unmarked, stores `readHash` and still stores `organizationId`. False when nothing was written.
   */
  updatePasswordHashGuarded(write: GuardedPasswordWrite): Promise<boolean>;
  /**
   * Replaces the hash with the same password at a new cost only while the node still has the verified
   * generation, is unmarked and stores `readHash`. Never changes the generation. False when nothing was written.
   */
  rehashPasswordGuarded(write: GuardedPasswordRehash): Promise<boolean>;
  /**
   * Advances the credential generation by exactly one, leaving the hash as it is, only while the node still has the
   * authorizing generation, is unmarked, stores `organizationId` and stores `readHash` (HAP-1716). False when nothing
   * was written.
   */
  bumpCredentialEpochGuarded(write: GuardedEpochBump): Promise<boolean>;
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
  /** Revokes the user's live keys issued below `nextEpoch` (generation-dead after a password change); returns the count. */
  revokeApiKeysBelowEpoch(userId: string, nextEpoch: number): Promise<number>;
  listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]>;
}

/** A new password that is default-equivalent, contains U+0000 or exceeds 72 UTF-8 bytes (→ 400). */
export class PasswordNotAllowedError extends Error {
  constructor() {
    super('Password not allowed');
    this.name = 'PasswordNotAllowedError';
  }
}

/** API key creation while `auth.apiKeys.enabled` is false (→ 403). */
export class ApiKeysDisabledError extends Error {
  constructor() {
    super('API keys are disabled');
    this.name = 'ApiKeysDisabledError';
  }
}

/** The authorizing credential's generation is no longer current (→ 401). */
export class CredentialsChangedError extends Error {
  constructor() {
    super('Credentials changed');
    this.name = 'CredentialsChangedError';
  }
}

/**
 * A guarded self-service write was lost because the stored organization is no longer the request's claim (HAP-2061).
 * A CredentialsChangedError for the client (→ 401), but the attempt is not audited: the only organization it could be
 * bound to is the one the user has left.
 */
export class OrganizationChangedError extends CredentialsChangedError {
  constructor() {
    super();
    this.name = 'OrganizationChangedError';
  }
}

/** The current password of a self-service change did not match (→ 400; HAP-1368 audits it as wrong_password). */
export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'CurrentPasswordIncorrectError';
  }
}

/** The user has no organization, or the request's organization claim is not the stored one: a self-service password change cannot be audited, so it is refused (HAP-1714; → 403). */
export class OrganizationRequiredError extends Error {
  constructor() {
    super('Organization required');
    this.name = 'OrganizationRequiredError';
  }
}

/**
 * Audited outcomes of a self-service password change attempt (HAP-1368; refusals: cmdb#321). Fixed codes, never
 * free text. Not listed: the audit-chain-not-ready 503, which is refused before anything runs because the chain
 * cannot be written then.
 */
export const PASSWORD_CHANGE_OUTCOMES = [
  'success', 'wrong_password', 'policy_failure', 'rotation_lost', 'user_not_found', 'rate_limited',
] as const;
export type PasswordChangeOutcome = (typeof PASSWORD_CHANGE_OUTCOMES)[number];

/** The self-service credential operations that write an audit row per attempt (`metadata.operation`). */
export type CredentialAuditOperation = 'password_change' | 'revoke_other_sessions';
const CREDENTIAL_AUDIT_LABELS: Record<CredentialAuditOperation, string> = {
  password_change: 'Password change',
  revoke_other_sessions: 'Session revoke',
};

/**
 * What the best-effort API-key revoke of a self-service credential change did (HAP-2061): the number of key rows it
 * revoked, or that it failed. Never a key id, hash or token.
 */
export type ApiKeyRevocation = { revoked: number } | { failed: true };

/** A self-service credential change's new session for the caller's device, and what its API-key revoke did. */
export type CredentialChangeResult = LoginResponse & { apiKeyRevocation: ApiKeyRevocation };

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
 * identifier matching more than one :User node. `api_keys_disabled` is a
 * request carrying only a non-empty API key header while `auth.apiKeys.enabled`
 * is false (logged with credentialType `api-key`, never the key). Callers send
 * all of these the same response as any other failure.
 */
export type AuthFailureReason =
  | 'invalid' | 'expired' | 'wrong_type' | 'disabled' | 'revoked' | 'store_error' | 'default_credential_refused'
  | 'ambiguous_identity' | 'api_keys_disabled';

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
  /** Same semantics as the middleware: only an explicit `false` disables API keys. */
  private readonly apiKeysEnabled: boolean;

  constructor(
    _config: ConfigSchema['auth'],
    _repository: AuthRepository
  ) {
    this.jwtService = new JWTService(_config.jwt);
    this.passwordService = new PasswordService(_config.bcrypt);
    this.repository = _repository;
    this.apiKeysEnabled = _config.apiKeys?.enabled !== false;
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
      // Tenant claim comes from the user record, never the request. One login time for both tokens (HAP-1716).
      const authTime = Math.floor(Date.now() / 1000);
      const accessToken = this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, credentialEpoch, authTime
      );
      const refreshToken = this.jwtService.generateRefreshToken(
        user._id, user._username, user._role, credentialEpoch, authTime
      );
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

      // New tokens from the current user record (org re-read, not copied from the old token); the login time is kept,
      // in the access token too (HAP-1716: it is the session-family id, so it must never restart on refresh).
      const accessToken = this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, credentialEpoch, authTime!
      );
      const newRefreshToken = this.jwtService.generateRefreshToken(
        user._id, user._username, user._role, credentialEpoch, authTime!
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
        _authTime: payload._authTime,
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
    if (!this.apiKeysEnabled) {
      throw new ApiKeysDisabledError();
    }
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
   * Verify API key and return associated user info. Refused with AuthFailureError('disabled') before any hash or
   * repository read while auth.apiKeys.enabled is false, so the kill switch holds for every caller, not only the middleware.
   */
  async verifyApiKey(apiKey: string): Promise<TokenPayload> {
    if (!this.apiKeysEnabled) {
      throw new AuthFailureError('disabled');
    }
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
   * List the user's API keys that are not revoked. A password change revokes every key below the new
   * generation (HAP-1669), so those rows are not listed. A row of another credential generation that is
   * still unrevoked (the best-effort revoke failed, or it predates HAP-1669) no longer authenticates
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
   * The authenticated user's own profile: an explicit projection of the
   * stored user, never a spread of it. No password hash, credential
   * generation, seed marker, element id or scopes. `platformAdmin` is the
   * effective status (isPlatformAdmin: the stored flag, and never for a
   * seeded account), the same decision the ACL layer makes.
   */
  private toProfile(user: User): UserProfile {
    return {
      _id: user._id,
      _username: user._username,
      _email: user._email,
      _role: user._role,
      _createdAt: user._createdAt,
      lastLoginAt: user.lastLoginAt,
      _name: user._name,
      _avatar: user._avatar,
      _organizationId: user._organizationId,
      platformAdmin: isPlatformAdmin(user),
    };
  }

  /**
   * Get the authenticated user's profile (see toProfile for what it holds)
   */
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const user = await this.repository.findUserById(userId);
    return user ? this.toProfile(user) : null;
  }

  /**
   * Update the authenticated user's profile (name/avatar only)
   */
  async updateProfile(
    userId: string,
    updates: { name?: string; avatar?: string }
  ): Promise<UserProfile> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new UserNotFoundError();
    }

    return this.toProfile(await this.repository.updateUser(userId, updates));
  }

  /**
   * Change the authenticated user's password, verifying the current
   * password against the stored hash before replacing it. The new password
   * must not be default-equivalent, contain U+0000 or exceed 72 bytes (every
   * environment). A STORED user without an organization, or whose stored
   * organization is not the request's claim, is refused with
   * OrganizationRequiredError before the generation or the password is
   * checked and before any hash is computed: the change could not be audited
   * (HAP-1714). The write is a compare-and-set against the authorizing
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
    authorizingEpoch: number,
    organizationClaim: string
  ): Promise<CredentialChangeResult> {
    if (!newPasswordAllowed(newPassword)) {
      throw new PasswordNotAllowedError();
    }

    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new UserNotFoundError();
    }
    const storedOrganization = user._organizationId;
    if (typeof storedOrganization !== 'string' || storedOrganization === '' || storedOrganization !== organizationClaim) {
      throw new OrganizationRequiredError();
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
      userId, elementId: user._elementId, credentialEpoch, organizationId: organizationClaim, readHash: user._passwordHash, newHash,
    });
    if (!written) {
      throw await this.lostWriteError(userId, organizationClaim);
    }
    // The writer advanced the generation by exactly one (in Cypher, guarded by `credentialEpoch`).
    const nextEpoch = credentialEpoch + 1;
    // The generation already refuses every older key; revoking the rows keeps them dead across a rollback that
    // resets the generation. Best-effort: the change has committed, so a failure logs the error class only.
    const apiKeyRevocation = await this.revokeApiKeyRows(user._id, nextEpoch, 'Password change API key revocation failed');
    // A new session for this device at the new generation; a fresh authentication, so its login time is now.
    const authTime = Math.floor(Date.now() / 1000);
    return {
      _accessToken: this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, nextEpoch, authTime
      ),
      _refreshToken: this.jwtService.generateRefreshToken(user._id, user._username, user._role, nextEpoch, authTime),
      _expiresIn: this.jwtService.getTokenExpiresIn('access'),
      _user: { _id: user._id, _username: user._username, _role: user._role },
      apiKeyRevocation,
    };
  }

  /**
   * HAP-1716: ends every other session and API key of the user without changing the password, behind a step-up: the
   * current password is re-entered and verified. Same order as changePassword: unknown user, then a stored user
   * without an organization (or whose stored organization is not the request's claim; the attempt could not be
   * audited) is refused with OrganizationRequiredError, then the authorizing generation, then the password. The write
   * is a compare-and-set that advances the generation by exactly one and leaves the hash and the marker alone, so a
   * request authorized before an operator rotation or a concurrent change lands nowhere. The generation bump is the
   * existing mechanism that ends sessions and API keys together (HAP-1285); the API-key rows are then revoked as in
   * changePassword. Returns a new session for the caller's device at the new generation: the password was just
   * re-entered, so its login time is now.
   */
  async revokeOtherSessions(
    userId: string,
    currentPassword: string,
    authorizingEpoch: number,
    organizationClaim: string
  ): Promise<CredentialChangeResult> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new UserNotFoundError();
    }
    const storedOrganization = user._organizationId;
    if (typeof storedOrganization !== 'string' || storedOrganization === '' || storedOrganization !== organizationClaim) {
      throw new OrganizationRequiredError();
    }
    const credentialEpoch = credentialEpochOf(user);
    if (!sameGeneration(authorizingEpoch, credentialEpoch)) {
      throw new CredentialsChangedError();
    }

    if (!(await this.verifyPassword(currentPassword, user._passwordHash))) {
      throw new CurrentPasswordIncorrectError();
    }

    const written = await this.repository.bumpCredentialEpochGuarded({
      userId, elementId: user._elementId, credentialEpoch, organizationId: organizationClaim, readHash: user._passwordHash,
    });
    if (!written) {
      throw await this.lostWriteError(userId, organizationClaim);
    }
    // The writer advanced the generation by exactly one (in Cypher, guarded by `credentialEpoch`).
    const nextEpoch = credentialEpoch + 1;
    // Best-effort, as in changePassword: the generation already refuses every older key and the bump has committed.
    const apiKeyRevocation = await this.revokeApiKeyRows(user._id, nextEpoch, 'Session revoke API key revocation failed');
    // Only a correct password reaches here, so this restart of the session family (a new login time, a fresh
    // revoke-other-sessions budget) is intended: a wrong guess returns above and never yields a new login time.
    const authTime = Math.floor(Date.now() / 1000);
    return {
      _accessToken: this.jwtService.generateAccessToken(
        user._id, user._username, user._role, user._organizationId, nextEpoch, authTime
      ),
      _refreshToken: this.jwtService.generateRefreshToken(user._id, user._username, user._role, nextEpoch, authTime),
      _expiresIn: this.jwtService.getTokenExpiresIn('access'),
      _user: { _id: user._id, _username: user._username, _role: user._role },
      apiKeyRevocation,
    };
  }

  /**
   * The error for a lost guarded write: OrganizationChangedError when the stored organization is no longer the
   * request's claim (the write's organization predicate refused it), otherwise CredentialsChangedError. A failed
   * re-read keeps the plain refusal.
   */
  private async lostWriteError(userId: string, organizationClaim: string): Promise<CredentialsChangedError> {
    try {
      const current = await this.repository.findUserById(userId);
      if (current !== null && current._organizationId !== organizationClaim) {
        return new OrganizationChangedError();
      }
    } catch {
      // The re-read only classifies the refusal; the write already landed nowhere.
    }
    return new CredentialsChangedError();
  }

  /** Revokes the user's API-key rows below `nextEpoch`; a failure logs `warning` with the error class only. Never throws. */
  private async revokeApiKeyRows(userId: string, nextEpoch: number, warning: string): Promise<ApiKeyRevocation> {
    try {
      return { revoked: await this.repository.revokeApiKeysBelowEpoch(userId, nextEpoch) };
    } catch (error) {
      logger.warn(warning, errorClassFields(error));
      return { failed: true };
    }
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
   * HAP-1368: one audit_log row for a self-service credential attempt (`operation`: the password change, or HAP-1716's
   * revoke of other sessions): the verified user, the client address, the outcome and the actor's organization claim;
   * never a password, hash or token. A rate_limited row also names the refusing bucket (`metadata.bucket`, a fixed
   * code). A success row carries what the API-key revoke did (HAP-2061): `revoked_api_keys` (the count) or
   * `api_key_revoke_failed: true`, never a key id or hash. Best-effort: the outcome is already decided (a changed
   * password stays changed), so a failed write or a missing organization (tenancy is never inferred) logs fixed text
   * and returns false; true means the row was written.
   */
  async auditPasswordChange(
    userId: string, organizationId: string | null, ipAddress: string | undefined, outcome: PasswordChangeOutcome,
    refusedBy?: RefusalBucket, operation: CredentialAuditOperation = 'password_change', apiKeyRevocation?: ApiKeyRevocation
  ): Promise<boolean> {
    const label = CREDENTIAL_AUDIT_LABELS[operation];
    if (organizationId === null) {
      logger.error(`${label} not audited: the actor has no organization claim`);
      return false;
    }
    try {
      await this.repository.recordAudit({
        entity_type: 'USER', entity_id: userId, action: 'UPDATE', actor: userId, actor_type: 'user', changes: [],
        metadata: {
          operation, outcome,
          ...(refusedBy === undefined ? {} : { bucket: refusedBy }),
          ...(apiKeyRevocation === undefined ? {} : 'revoked' in apiKeyRevocation
            ? { revoked_api_keys: apiKeyRevocation.revoked } : { api_key_revoke_failed: true }),
        },
        ip_address: auditClientAddress(ipAddress),
      }, organizationId);
      return true;
    } catch {
      logger.error(`${label} audit write failed`);
      return false;
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
