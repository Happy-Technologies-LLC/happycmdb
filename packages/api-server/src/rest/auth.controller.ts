// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication REST Controller
 * Handles login, logout, token refresh, and API key management
 */

import { NextFunction, Request, Response, Router } from 'express';
import { logger, errorClassFields } from '@cmdb/common';
import {
  ApiKeyNotFoundError, ApiKeysDisabledError, AuthFailureError, AuthService, CredentialsChangedError, CurrentPasswordIncorrectError,
  OrganizationChangedError, OrganizationRequiredError, PasswordNotAllowedError, type ApiKeyRevocation,
  type CredentialAuditOperation, type PasswordChangeOutcome, type UserProfile,
} from '../auth/auth.service';
import { ROLE_PERMISSIONS, UserNotFoundError } from '../auth/types';
import { ValidationMiddleware } from './middleware/validation.middleware';
import { clearRefreshCookie, hasAuthHeader, readRefreshCookie, requireAuthHeader, setRefreshCookie } from './middleware/refresh-cookie';
import { authSchemas } from '../validation/schemas';
import { AuthMiddleware, AuthenticatedRequest, logAuthFailure, optionalRequestOrganizationId } from '../middleware/auth.middleware';
import { sendForbidden } from '../middleware/forbidden-response';
import { RateLimitMiddleware, type Refusal, type RefusalBucket } from '../middleware/rate-limit.middleware';

const AUTHENTICATION_FAILURE = { success: false, error: 'Authentication failed' };
/** HAP-1368: a password change that could not be audited is refused before anything changes. */
const PASSWORD_CHANGE_UNAVAILABLE = { success: false, error: 'Service Unavailable', message: 'Password change temporarily unavailable' };
/** HAP-1716: the same refusal for the revoke-other-sessions step-up. */
const SESSION_REVOKE_UNAVAILABLE = { success: false, error: 'Service Unavailable', message: 'Session revoke temporarily unavailable' };

/**
 * HAP-1714: a password change by a user with no organization (or whose token claim is not the stored organization) is
 * refused with 403, nothing written, nothing audited (there is no tenant to audit into), no cookie or token set. The
 * state is the caller's own, so the refusal reveals nothing before the password is checked. One fixed warn line,
 * user id only.
 */
function refuseOrganizationRequired(res: Response, userId: string, operation: CredentialAuditOperation = 'password_change'): void {
  const action = operation === 'password_change' ? 'Password change' : 'Session revoke';
  logger.warn(`${action} refused: the user has no usable organization`, { userId });
  sendForbidden(res, 'ORGANIZATION_REQUIRED',
    operation === 'password_change' ? 'Organization required to change password' : 'Organization required to revoke sessions');
}

/**
 * After a refusal-audit write fails (or is skipped), the claim for that user and bucket is cut to this many
 * milliseconds: at most one further attempt per user and bucket per backoff window. Documented in api/authentication.md.
 */
export const REFUSAL_AUDIT_BACKOFF_MS = 30_000;

/**
 * HAP-1382 P-4: every /auth response may carry an access token, an API key, the refresh cookie or account data, so no
 * browser or shared cache may store it (Pragma for HTTP/1.0 caches, as infrastructure/docker/nginx.conf does).
 */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

/** Credential generation of the credential that authorized this request (HP1-S6); NaN when absent. */
function authorizingEpoch(req: AuthenticatedRequest): number {
  return req.user?._cep ?? Number.NaN;
}

/** Sends the fixed response for an S6 credential refusal; false when `error` is not one. */
function credentialRefusal(res: Response, error: unknown): boolean {
  if (error instanceof CredentialsChangedError) {
    res.status(401).json({ success: false, error: 'Unauthorized', message: 'Credentials changed' });
    return true;
  }
  if (error instanceof PasswordNotAllowedError) {
    res.status(400).json({ success: false, error: 'Bad Request', message: 'Password not allowed' });
    return true;
  }
  if (error instanceof ApiKeysDisabledError) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'API keys are disabled' });
    return true;
  }
  return false;
}

export class AuthController {
  private router: Router;
  private authService: AuthService;
  private validator: ValidationMiddleware;
  private authMiddleware: AuthMiddleware;
  private rateLimiter: RateLimitMiddleware;

  constructor(
    authService: AuthService,
    validator: ValidationMiddleware,
    authMiddleware: AuthMiddleware,
    rateLimiter: RateLimitMiddleware
  ) {
    this.authService = authService;
    this.validator = validator;
    this.authMiddleware = authMiddleware;
    this.rateLimiter = rateLimiter;
    this.router = Router();

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // First, so refusals (limiter, CSRF header, validation, authentication) carry it too.
    this.router.use(noStore);

    /**
     * POST /api/auth/login
     * Login with username and password
     */
    this.router.post(
      '/login',
      // HAP-1091/HAP-1764: per client (req.ip), per account+client and per account across all clients; a limiter store
      // error refuses the login (fixed 503, no-store) before the password is checked.
      this.rateLimiter.limit('auth', { account: req => req.body?.username, failClosed: true }),
      this.validator.validate(authSchemas._login),
      this.login.bind(this)
    );

    /**
     * POST /api/auth/refresh
     * Refresh access token using refresh token
     * HAP-1211 H1: read only from the refresh cookie (__Secure-cmdb_rt since H2), after X-CMDB-Auth is checked.
     * HAP-1211 H2 ruling A: the web UI renews every session through here, so refresh has its own bucket
     * (auth-refresh) at the configured REST budget and never uses up login's brute-force budget. REST max 0 means
     * unlimited (as in limit()), so no limiter then (addendum).
     */
    const refreshBudget = this.rateLimiter.endpointBudget('rest');
    const refreshLimit = refreshBudget._max === 0 ? [] : [this.rateLimiter.custom(refreshBudget, 'auth-refresh')];
    this.router.post(
      '/refresh',
      requireAuthHeader,
      ...refreshLimit,
      this.validator.validate(authSchemas._refreshToken),
      this.refreshToken.bind(this)
    );

    /**
     * POST /api/auth/logout
     * Logout (client-side token invalidation)
     * HAP-1211 H1: clears the refresh cookie. Neither X-CMDB-Auth (operator ruling Q1, kept in H2) nor an access token.
     */
    this.router.post(
      '/logout',
      this.logout.bind(this)
    );

    /**
     * POST /api/auth/api-key
     * Generate new API key
     */
    this.router.post(
      '/api-key',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.validator.validate(authSchemas._generateApiKey),
      this.generateApiKey.bind(this)
    );

    /**
     * GET /api/auth/api-keys
     * List all API keys for the current user
     */
    this.router.get(
      '/api-keys',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.listApiKeys.bind(this)
    );

    /**
     * DELETE /api/auth/api-key/:keyId
     * Revoke API key
     */
    this.router.delete(
      '/api-key/:keyId',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.revokeApiKey.bind(this)
    );

    /**
     * GET /api/auth/me
     * Get current user info
     */
    this.router.get(
      '/me',
      this.authMiddleware.authenticate(),
      this.getCurrentUser.bind(this)
    );

    /**
     * PUT /api/auth/profile
     * Update the authenticated user's profile (name/avatar)
     */
    this.router.put(
      '/profile',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.validator.validate(authSchemas._updateProfile),
      this.updateProfile.bind(this)
    );

    /**
     * PUT /api/auth/password
     * Change the authenticated user's password
     * HAP-1368: per client (req.ip, login's bucket) plus per user across all clients at login's account budget; a
     * limiter store error refuses the change (503). Mounted after authentication: the user bucket keys on the
     * verified subject. HAP-1712: the audit-chain readiness refusal (503) comes before the limiter, so a refused
     * change spends neither bucket.
     */
    this.router.put(
      '/password',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.requireAuditChain(PASSWORD_CHANGE_UNAVAILABLE),
      this.rateLimiter.limit('auth', {
        perUser: true,
        failClosed: true,
        onRefused: (req, refusal) => this.auditFirstRefusal(req, refusal, 'password_change'),
      }),
      this.validator.validate(authSchemas._changePassword),
      this.changePassword.bind(this)
    );

    /**
     * POST /api/auth/sessions/revoke-others
     * Revoke every other session and API key of the user, behind a re-entered current password (HAP-1716). Same
     * chain as /password (JWT session only, audit-chain 503 before the limiter), but the limiter is the client bucket
     * plus a bucket keyed by user AND client address, plus (F1) a bucket keyed by user AND the session's login time
     * (`_authTime`), at /password's budget. The per-address buckets alone let a session holder guess from every
     * address they control; the session bucket caps that across all addresses, yet another login of the user (the
     * owner's) has its own bucket. Never the shared per-user bucket nor the account-global one, both of which a stolen
     * session could spend from another address to hold the owner out of this action. An access token without the
     * claim (minted before it existed) is refused 401 before the limiter, so the client refreshes.
     */
    this.router.post(
      '/sessions/revoke-others',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.requireAuditChain(SESSION_REVOKE_UNAVAILABLE),
      this.requireSessionFamily(),
      this.rateLimiter.limit('auth', {
        perUserClient: true,
        perSession: true,
        failClosed: true,
        onRefused: (req, refusal) => this.auditFirstRefusal(req, refusal, 'revoke_other_sessions'),
      }),
      this.validator.validate(authSchemas._revokeOtherSessions),
      this.revokeOtherSessions.bind(this)
    );

    /**
     * DELETE /api/auth/account
     * Permanently delete the authenticated user's account
     */
    this.router.delete(
      '/account',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.deleteAccount.bind(this)
    );
  }

  /**
   * Login endpoint
   * HAP-1211 H2 (F2): the refresh cookie is set only with X-CMDB-Auth: 1 (the web-ui sends it). Without it the
   * caller (CLI, scripts, or a cross-site form) gets the body access token and no cookie, so login CSRF cannot plant one.
   */
  private async login(req: Request, res: Response): Promise<void> {
    try {
      const { _refreshToken, ...data } = await this.authService.login(req.body);
      if (hasAuthHeader(req)) setRefreshCookie(res, _refreshToken);

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      logAuthFailure('login', error);
      res.status(401).json(AUTHENTICATION_FAILURE);
    }
  }

  /**
   * Refresh token endpoint
   */
  private async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const presented = readRefreshCookie(req);
      if (presented === null) throw new AuthFailureError('invalid');
      const { _refreshToken, ...data } = await this.authService.refreshToken({ refreshToken: presented });
      setRefreshCookie(res, _refreshToken);

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      logAuthFailure('refresh', error);
      res.status(401).json(AUTHENTICATION_FAILURE);
    }
  }

  /**
   * Logout endpoint
   */
  private async logout(_req: AuthenticatedRequest, res: Response): Promise<void> {
    // Stateless (founder decision, H1b not built): nothing is stored to revoke; a captured refresh token stays renewable until the 7-day cap from its login or a credential-epoch change (HAP-1285).
    clearRefreshCookie(res);

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  }

  /**
   * Generate API key endpoint
   */
  private async generateApiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const result = await this.authService.generateApiKey(req.user._userId, req.body, authorizingEpoch(req));

      res.json({
        success: true,
        data: result,
        message: 'API key generated. Save it securely - it will not be shown again.',
      });
    } catch (error: any) {
      if (credentialRefusal(res, error)) return;
      logger.error('Error generating API key', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({
        success: false,
        error: 'API Key Generation Failed',
        message: 'Internal error',
      });
    }
  }

  /**
   * List API keys endpoint
   */
  private async listApiKeys(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const apiKeys = await this.authService.listApiKeys(req.user._userId);

      res.json({
        success: true,
        data: apiKeys,
      });
    } catch (error: any) {
      logger.error('Error listing API keys', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({
        success: false,
        error: 'Failed to List API Keys',
        message: 'Internal error',
      });
    }
  }

  /**
   * Revoke API key endpoint
   */
  private async revokeApiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const { keyId } = req.params;
      if (!keyId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Key ID is required',
        });
        return;
      }
      await this.authService.revokeApiKey(req.user._userId, keyId);

      res.json({
        success: true,
        message: 'API key revoked successfully',
      });
    } catch (error: unknown) {
      if (error instanceof ApiKeyNotFoundError) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'API key not found',
        });
        return;
      }

      logger.error('Error revoking API key', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({
        success: false,
        error: 'API Key Revocation Failed',
        message: 'Internal error',
      });
    }
  }

  /**
   * Shapes the caller's own profile into the RawUserPayload-compatible
   * response body the frontend's ApiService.mapUser() expects (see
   * web-ui/src/services/api.ts). `platformAdmin` and `organizationId` come
   * from the stored user the service just loaded (HAP-1911), never from the
   * request.
   */
  private toRawUserPayload(user: UserProfile): Record<string, unknown> {
    return {
      userId: user._id,
      username: user._username,
      email: user._email,
      name: user._name || user._username,
      avatar: user._avatar,
      role: user._role,
      // HAP-1930 (BW16): what the server's role table grants this role, so a client need not mirror the table.
      permissions: [...(ROLE_PERMISSIONS[user._role] ?? [])],
      createdAt: user._createdAt,
      lastLoginAt: user.lastLoginAt,
      platformAdmin: user.platformAdmin,
      organizationId: user._organizationId ?? null,
    };
  }

  /**
   * Get current user info endpoint
   */
  private async getCurrentUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const profile = await this.authService.getUserProfile(req.user._userId);
      if (!profile) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'User not found',
        });
        return;
      }

      res.json({
        success: true,
        data: this.toRawUserPayload(profile),
      });
    } catch (error: any) {
      logger.error('Error loading current user', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({
        success: false,
        error: 'Failed to Load User',
        message: 'Internal error',
      });
    }
  }

  /**
   * Update profile endpoint
   */
  private async updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const { name, avatar } = req.body as { name?: string; avatar?: string };
      const profile = await this.authService.updateProfile(req.user._userId, { name, avatar });

      res.json({
        success: true,
        data: this.toRawUserPayload(profile),
        message: 'Profile updated successfully',
      });
    } catch (error: any) {
      if (error instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: 'Profile Update Failed', message: 'User not found' });
        return;
      }
      logger.error('Error updating profile', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({ success: false, error: 'Profile Update Failed', message: 'Internal error' });
    }
  }

  /**
   * One audit row for a self-service credential attempt by the verified user; best-effort and never throws (see
   * AuthService.auditPasswordChange). Resolves true only when the row was written.
   */
  private auditCredentialAttempt(
    req: AuthenticatedRequest, outcome: PasswordChangeOutcome, operation: CredentialAuditOperation, refusedBy?: RefusalBucket,
    apiKeyRevocation?: ApiKeyRevocation
  ): Promise<boolean> {
    return this.authService.auditPasswordChange(
      req.user!._userId, optionalRequestOrganizationId(req), req.ip, outcome, refusedBy, operation, apiKeyRevocation
    );
  }

  /**
   * cmdb#321: only the first refusal per user and refusing bucket per window is audited. Each audit write takes the
   * global audit-chain lock, so a client retrying past the limit must not turn every 429 into one. The claim is a
   * Redis SET NX PX of the bucket's window holding a random owner token; if Redis fails the claim rejects (the
   * limiter logs the class) and nothing is audited. The claim is taken before the write (concurrent refusals must not
   * both write). A write that fails or is skipped (no organization claim) does not give the claim back: its TTL is
   * cut to REFUSAL_AUDIT_BACKOFF_MS, owner-checked, so an audit-store fault costs at most one attempt per user and
   * bucket per backoff window and the row is still written by the first refusal after it. A slow writer whose claim
   * has since expired and been retaken leaves the newer claim alone. If the backoff itself fails (Redis), the claim
   * keeps its window TTL: no row for the rest of that window, as when the claim itself fails.
   * HAP-1716: the revoke route has its own claim keys, so its refusals neither use up nor wait on the password change's.
   */
  private async auditFirstRefusal(req: AuthenticatedRequest, refusal: Refusal, operation: CredentialAuditOperation): Promise<void> {
    const userId = req.user!._userId;
    const suffix = refusal.bucket === 'user' ? '' : `:${refusal.bucket}`;
    const claim = operation === 'password_change'
      ? `rate-limit:auth-user-refused:${userId}${suffix}`
      : `rate-limit:auth-session-revoke-refused:${userId}:${refusal.bucket}`;
    const token = await refusal.claim(claim);
    if (token === null) return;
    let audited = false;
    try {
      audited = await this.auditCredentialAttempt(req, 'rate_limited', operation, refusal.bucket);
    } finally {
      if (!audited) await refusal.backoff(claim, token, REFUSAL_AUDIT_BACKOFF_MS);
    }
  }

  /**
   * HAP-1368/HAP-1712: the request is refused (503; the router sets no-store) before the limiter and before anything
   * changes while it cannot be audited. `unavailable` is the route's fixed body.
   */
  private requireAuditChain(unavailable: typeof PASSWORD_CHANGE_UNAVAILABLE) {
    return (_req: Request, res: Response, next: NextFunction): void => {
      if (this.authService.auditChainReady()) {
        next();
        return;
      }
      res.status(503).json(unavailable);
    };
  }

  /**
   * HAP-1716 F1: the session-family id (`_authTime`) must be on the verified access token: it keys the session bucket.
   * A token minted before it existed lacks it and is refused 401 (the web client then renews from its refresh cookie,
   * whose renewal carries the claim) before any bucket is spent or password checked. Never a fall back to the
   * per-address buckets alone. Mounted after authentication.
   */
  private requireSessionFamily() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      const authTime = req.user?._authTime;
      if (typeof authTime === 'number' && Number.isSafeInteger(authTime)) {
        next();
        return;
      }
      res.status(401).json({ success: false, error: 'Unauthorized', message: 'Session must be renewed' });
    };
  }

  /**
   * Change password endpoint
   * HAP-1368: each attempt appends one audit row (best-effort once the outcome is decided): success, wrong current
   * password, and (cmdb#321) policy failure, lost rotation, unknown user and rate limited (the limiter's onRefused: the first refusal
   * per user and bucket per window).
   * The audit-chain readiness refusal is the requireAuditChain step before the limiter and is not audited: the chain
   * cannot be written then. Refusal bodies are unchanged.
   */
  private async changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!req.user?._userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    const userId = req.user._userId;
    // HAP-1714: no organization claim means the change could not be audited; refused before the service is called.
    const organizationClaim = optionalRequestOrganizationId(req);
    if (organizationClaim === null) {
      refuseOrganizationRequired(res, userId);
      return;
    }
    const audit = (outcome: PasswordChangeOutcome, apiKeyRevocation?: ApiKeyRevocation) =>
      this.auditCredentialAttempt(req, outcome, 'password_change', undefined, apiKeyRevocation);
    try {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      // HAP-1285: the change ended every session of the user; this device gets a new one.
      const { _refreshToken, apiKeyRevocation, ...data } = await this.authService.changePassword(
        userId, currentPassword, newPassword, authorizingEpoch(req), organizationClaim
      );
      setRefreshCookie(res, _refreshToken);
      await audit('success', apiKeyRevocation);

      res.json({
        success: true,
        data,
        message: 'Password changed. All other sessions and all your API keys have been revoked; this device stays signed in.',
      });
    } catch (error: any) {
      if (error instanceof OrganizationRequiredError) {
        refuseOrganizationRequired(res, userId);
        return;
      }
      if (error instanceof CurrentPasswordIncorrectError) {
        await audit('wrong_password');
        res.status(400).json({ success: false, error: 'Password Change Failed', message: 'Current password is incorrect' });
        return;
      }
      // OrganizationChangedError (HAP-2061) is not audited: the claim's organization is not the user's any more.
      const orgChanged = error instanceof OrganizationChangedError;
      if (error instanceof PasswordNotAllowedError || (error instanceof CredentialsChangedError && !orgChanged)) {
        await audit(error instanceof PasswordNotAllowedError ? 'policy_failure' : 'rotation_lost');
      }
      if (credentialRefusal(res, error)) return;
      if (error instanceof UserNotFoundError) {
        await audit('user_not_found');
        res.status(404).json({ success: false, error: 'Password Change Failed', message: 'User not found' });
        return;
      }
      logger.error('Error changing password', { ...errorClassFields(error), userId });
      res.status(500).json({ success: false, error: 'Password Change Failed', message: 'Internal error' });
    }
  }

  /**
   * Revoke other sessions endpoint (HAP-1716): a step-up (the current password), not a password change. Ends every
   * other session and API key of the user by advancing the credential generation; this device gets a new session.
   * Each attempt appends one audit row (`metadata.operation` revoke_other_sessions): success, wrong current password,
   * lost rotation, unknown user, and rate limited (the limiter's onRefused). The audit-chain readiness refusal is the
   * requireAuditChain step before the limiter and is not audited: the chain cannot be written then.
   */
  private async revokeOtherSessions(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!req.user?._userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', message: 'User not authenticated' });
      return;
    }

    const userId = req.user._userId;
    const organizationClaim = optionalRequestOrganizationId(req);
    if (organizationClaim === null) {
      refuseOrganizationRequired(res, userId, 'revoke_other_sessions');
      return;
    }
    const audit = (outcome: PasswordChangeOutcome, apiKeyRevocation?: ApiKeyRevocation) =>
      this.auditCredentialAttempt(req, outcome, 'revoke_other_sessions', undefined, apiKeyRevocation);
    try {
      const { currentPassword } = req.body as { currentPassword: string };
      const { _refreshToken, apiKeyRevocation, ...data } = await this.authService.revokeOtherSessions(
        userId, currentPassword, authorizingEpoch(req), organizationClaim
      );
      setRefreshCookie(res, _refreshToken);
      await audit('success', apiKeyRevocation);

      res.json({
        success: true,
        data,
        message: 'All other sessions and all your API keys have been revoked (both end with the credential generation); this device stays signed in. Your password is unchanged.',
      });
    } catch (error: any) {
      if (error instanceof OrganizationRequiredError) {
        refuseOrganizationRequired(res, userId, 'revoke_other_sessions');
        return;
      }
      if (error instanceof CurrentPasswordIncorrectError) {
        await audit('wrong_password');
        res.status(400).json({ success: false, error: 'Session Revoke Failed', message: 'Current password is incorrect' });
        return;
      }
      // OrganizationChangedError (HAP-2061) is not audited: the claim's organization is not the user's any more.
      if (error instanceof CredentialsChangedError && !(error instanceof OrganizationChangedError)) {
        await audit('rotation_lost');
      }
      if (credentialRefusal(res, error)) return;
      if (error instanceof UserNotFoundError) {
        await audit('user_not_found');
        res.status(404).json({ success: false, error: 'Session Revoke Failed', message: 'User not found' });
        return;
      }
      logger.error('Error revoking other sessions', { ...errorClassFields(error), userId });
      res.status(500).json({ success: false, error: 'Session Revoke Failed', message: 'Internal error' });
    }
  }

  /**
   * Delete account endpoint
   */
  private async deleteAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      await this.authService.deleteAccount(req.user._userId, authorizingEpoch(req));

      res.json({
        success: true,
        message: 'Account deleted successfully',
      });
    } catch (error: any) {
      if (credentialRefusal(res, error)) return;
      const notFound = error instanceof UserNotFoundError;
      if (!notFound) logger.error('Error deleting account', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(notFound ? 404 : 500).json({
        success: false,
        error: 'Account Deletion Failed',
        message: notFound ? 'User not found' : 'Internal error',
      });
    }
  }

  public getRouter(): Router {
    return this.router;
  }
}
