// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication REST Controller
 * Handles login, logout, token refresh, and API key management
 */

import { Request, Response, Router } from 'express';
import { ApiKeyNotFoundError, AuthService } from '../auth/auth.service';
import { ValidationMiddleware } from './middleware/validation.middleware';
import { authSchemas } from '../validation/schemas';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { RateLimitMiddleware } from '../middleware/rate-limit.middleware';

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
    /**
     * POST /api/auth/login
     * Login with username and password
     */
    this.router.post(
      '/login',
      this.rateLimiter.limit('auth'),
      this.validator.validate(authSchemas._login),
      this.login.bind(this)
    );

    /**
     * POST /api/auth/refresh
     * Refresh access token using refresh token
     */
    this.router.post(
      '/refresh',
      this.rateLimiter.limit('auth'),
      this.validator.validate(authSchemas._refreshToken),
      this.refreshToken.bind(this)
    );

    /**
     * POST /api/auth/logout
     * Logout (client-side token invalidation)
     */
    this.router.post(
      '/logout',
      this.authMiddleware.authenticate(),
      this.logout.bind(this)
    );

    /**
     * POST /api/auth/api-key
     * Generate new API key
     */
    this.router.post(
      '/api-key',
      this.authMiddleware.authenticate(),
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
      this.listApiKeys.bind(this)
    );

    /**
     * DELETE /api/auth/api-key/:keyId
     * Revoke API key
     */
    this.router.delete(
      '/api-key/:keyId',
      this.authMiddleware.authenticate(),
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
      this.validator.validate(authSchemas._updateProfile),
      this.updateProfile.bind(this)
    );

    /**
     * PUT /api/auth/password
     * Change the authenticated user's password
     */
    this.router.put(
      '/password',
      this.authMiddleware.authenticate(),
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
      this.deleteAccount.bind(this)
    );
  }

  /**
   * Login endpoint
   */
  private async login(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.authService.login(req.body);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(401).json({
        success: false,
        error: 'Authentication Failed',
        message: error.message || 'Invalid credentials',
      });
    }
  }

  /**
   * Refresh token endpoint
   */
  private async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.authService.refreshToken(req.body);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(401).json({
        success: false,
        error: 'Token Refresh Failed',
        message: error.message || 'Invalid or expired refresh token',
      });
    }
  }

  /**
   * Logout endpoint
   */
  private async logout(_req: AuthenticatedRequest, res: Response): Promise<void> {
    // Logout is primarily client-side (discarding tokens)
    // Server-side token blacklist could be implemented here if needed

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

      const result = await this.authService.generateApiKey(req.user._userId, req.body);

      res.json({
        success: true,
        data: result,
        message: 'API key generated. Save it securely - it will not be shown again.',
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'API Key Generation Failed',
        message: error.message || 'Failed to generate API key',
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
      res.status(500).json({
        success: false,
        error: 'Failed to List API Keys',
        message: error.message || 'Failed to retrieve API keys',
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

      res.status(500).json({
        success: false,
        error: 'API Key Revocation Failed',
        message: error instanceof Error ? error.message : 'Failed to revoke API key',
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
      res.status(500).json({
        success: false,
        error: 'Failed to Load User',
        message: error.message || 'Failed to load current user',
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
      const status = error.message === 'User not found' ? 404 : 400;
      res.status(status).json({
        success: false,
        error: 'Profile Update Failed',
        message: error.message || 'Failed to update profile',
      });
    }
  }

  /**
   * Change password endpoint
   */
  private async changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      await this.authService.changePassword(req.user._userId, currentPassword, newPassword);

      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error: any) {
      const status = error.message === 'User not found' ? 404 : 400;
      res.status(status).json({
        success: false,
        error: 'Password Change Failed',
        message: error.message || 'Failed to change password',
      });
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

      await this.authService.deleteAccount(req.user._userId);

      res.json({
        success: true,
        message: 'Account deleted successfully',
      });
    } catch (error: any) {
      const status = error.message === 'User not found' ? 404 : 500;
      res.status(status).json({
        success: false,
        error: 'Account Deletion Failed',
        message: error.message || 'Failed to delete account',
      });
    }
  }

  public getRouter(): Router {
    return this.router;
  }
}
