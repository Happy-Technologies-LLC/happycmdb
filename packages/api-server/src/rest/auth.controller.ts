// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication REST Controller
 * Handles login, logout, token refresh, and API key management
 */

import { NextFunction, Request, Response, Router } from 'express';
import { logger } from '@cmdb/common';
import {
  ApiKeyNotFoundError, AuthFailureError, AuthService, CredentialsChangedError, CurrentPasswordIncorrectError,
  PasswordNotAllowedError, type PasswordChangeOutcome,
} from '../auth/auth.service';
import { ValidationMiddleware } from './middleware/validation.middleware';
import { clearRefreshCookie, hasAuthHeader, readRefreshCookie, requireAuthHeader, setRefreshCookie } from './middleware/refresh-cookie';
import { authSchemas } from '../validation/schemas';
import { AuthMiddleware, AuthenticatedRequest, logAuthFailure, optionalRequestOrganizationId } from '../middleware/auth.middleware';
import { RateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { errorClassFields } from '../utils/log-error';

const AUTHENTICATION_FAILURE = { success: false, error: 'Authentication failed' };
/** HAP-1368: a password change that could not be audited is refused before anything changes. */
const PASSWORD_CHANGE_UNAVAILABLE = { success: false, error: 'Service Unavailable', message: 'Password change temporarily unavailable' };

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
     * verified subject.
     */
    this.router.put(
      '/password',
      this.authMiddleware.authenticate(),
      this.authMiddleware.requireJwtSession(),
      this.rateLimiter.limit('auth', { perUser: true, failClosed: true }),
      this.validator.validate(authSchemas._changePassword),
      this.changePassword.bind(this)
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
   * Shapes a sanitized user record into the RawUserPayload-compatible
   * response body the frontend's ApiService.mapUser() expects (see
   * web-ui/src/services/api.ts).
   */
  private toRawUserPayload(user: {
    _id: string;
    _username: string;
    _email: string;
    _role: string;
    _createdAt?: Date;
    lastLoginAt?: Date;
    _name?: string;
    _avatar?: string;
  }): Record<string, unknown> {
    return {
      userId: user._id,
      username: user._username,
      email: user._email,
      name: user._name || user._username,
      avatar: user._avatar,
      role: user._role,
      createdAt: user._createdAt,
      lastLoginAt: user.lastLoginAt,
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
      if (error instanceof Error && error.message === 'User not found') {
        res.status(404).json({ success: false, error: 'Profile Update Failed', message: 'User not found' });
        return;
      }
      logger.error('Error updating profile', { ...errorClassFields(error), userId: req.user?._userId });
      res.status(500).json({ success: false, error: 'Profile Update Failed', message: 'Internal error' });
    }
  }

  /**
   * Change password endpoint
   * HAP-1368: refused (503) before anything changes while the audit chain is not ready; each success and each wrong
   * current password then appends one audit row (best-effort once the outcome is decided).
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
    if (!this.authService.auditChainReady()) {
      res.status(503).json(PASSWORD_CHANGE_UNAVAILABLE);
      return;
    }

    const userId = req.user._userId;
    const audit = (outcome: PasswordChangeOutcome) =>
      this.authService.auditPasswordChange(userId, optionalRequestOrganizationId(req), req.ip, outcome);
    try {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      // HAP-1285: the change ended every session of the user; this device gets a new one.
      const { _refreshToken, ...data } = await this.authService.changePassword(
        userId, currentPassword, newPassword, authorizingEpoch(req)
      );
      setRefreshCookie(res, _refreshToken);
      await audit('success');

      res.json({
        success: true,
        data,
        message: 'Password changed. All other sessions and all your API keys have been revoked; this device stays signed in.',
      });
    } catch (error: any) {
      if (error instanceof CurrentPasswordIncorrectError) {
        await audit('wrong_password');
        res.status(400).json({ success: false, error: 'Password Change Failed', message: 'Current password is incorrect' });
        return;
      }
      if (credentialRefusal(res, error)) return;
      if (error instanceof Error && error.message === 'User not found') {
        res.status(404).json({ success: false, error: 'Password Change Failed', message: 'User not found' });
        return;
      }
      logger.error('Error changing password', { ...errorClassFields(error), userId });
      res.status(500).json({ success: false, error: 'Password Change Failed', message: 'Internal error' });
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
      const notFound = error.message === 'User not found';
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
