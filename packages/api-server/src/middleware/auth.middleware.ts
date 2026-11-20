// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication Middleware
 * Handles JWT and API key authentication for Express and GraphQL
 */

import { Request, Response, NextFunction } from 'express';
import { GraphQLError } from 'graphql';
import { logger, type ConfigSchema } from '@cmdb/common';
import { AuthFailureError, AuthService } from '../auth/auth.service';
import { isPlatformAdmin } from '../auth/platform-admin';
import { holdsScope, type Scope } from '../auth/scopes';
import { TokenPayload, Permission, ROLE_PERMISSIONS } from '../auth/types';
import { sendForbidden } from './forbidden-response';

const UNAUTHORIZED = { _error: 'Unauthorized', _message: 'Authentication failed' };
/** Keep the cause internally; never serialize or log untrusted error text. */
export function logAuthFailure(credentialType: 'jwt' | 'api-key' | 'login' | 'refresh' | 'none', error: unknown): void {
  logger.warn('Authentication failed', {
    credentialType,
    reason: error instanceof AuthFailureError ? error.reason : 'store_error',
  });
}

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
  /** Set only after verifying the credential used for this request. */
  credentialType?: 'jwt' | 'api-key';
}

/** Any RFC 4122-shaped UUID (the nil internal-org UUID included). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The well-formed (UUID) organization claim of an identity, or null. */
export function organizationClaim(user: TokenPayload | undefined): string | null {
  const organizationId = user?._organizationId;
  return typeof organizationId === 'string' && ORGANIZATION_ID_RE.test(organizationId) ? organizationId : null;
}

/**
 * Tenant of an authenticated request. Only valid after requireOrganization()
 * has run on the route; throws otherwise so a missing guard fails closed.
 */
export function requestOrganizationId(req: Request): string {
  const organizationId = organizationClaim((req as AuthenticatedRequest).user);
  if (organizationId === null) {
    throw new Error('Organization-scoped handler reached without requireOrganization()');
  }
  return organizationId;
}

/**
 * Tenant of a request that may not have passed requireOrganization(): the
 * organization claim, or null when the request has none. Callers must treat
 * null as "no tenant" (fail closed), never as "all tenants".
 */
export function optionalRequestOrganizationId(req: Request): string | null {
  return organizationClaim((req as AuthenticatedRequest).user);
}

export class AuthMiddleware {
  private authService: AuthService;
  private apiKeyHeader: string;
  /** Only an explicit `false` disables API keys; a config without `enabled` keeps them on. */
  private apiKeysEnabled: boolean;

  constructor(authService: AuthService, config: ConfigSchema['auth']) {
    this.authService = authService;
    this.apiKeyHeader = config.apiKeys.headerName;
    this.apiKeysEnabled = config.apiKeys.enabled !== false;
  }

  /**
   * Middleware to authenticate JWT or API key
   */
  authenticate() {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const token = this.extractToken(req);
      const apiKey = this.extractApiKey(req);
      try {
        if (token) {
          // Verify JWT token
          const payload = await this.authService.verifyToken(token);
          req.user = payload;
          req.credentialType = 'jwt';
          next();
        } else if (apiKey) {
          // Verify API key
          const payload = await this.authService.verifyApiKey(apiKey);
          req.user = payload;
          req.credentialType = 'api-key';
          next();
        } else {
          logAuthFailure('none', new AuthFailureError('invalid'));
          res.status(401).json(UNAUTHORIZED);
        }
      } catch (error) {
        logAuthFailure(token ? 'jwt' : 'api-key', error);
        res.status(401).json(UNAUTHORIZED);
      }
    };
  }

  /**
   * Optional authentication (sets user if available, but doesn't require it)
   */
  optionalAuthenticate() {
    return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      const token = this.extractToken(req);
      const apiKey = this.extractApiKey(req);
      try {
        if (token) {
          const payload = await this.authService.verifyToken(token);
          req.user = payload;
          req.credentialType = 'jwt';
        } else if (apiKey) {
          const payload = await this.authService.verifyApiKey(apiKey);
          req.user = payload;
          req.credentialType = 'api-key';
        }

        next();
      } catch (error) {
        logAuthFailure(token ? 'jwt' : 'api-key', error);
        next();
      }
    };
  }

  /** Account operations require a verified login session, never an API key. */
  requireJwtSession() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (req.user === undefined) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }
      if (req.credentialType !== 'jwt') {
        sendForbidden(res, 'JWT_SESSION_REQUIRED', 'JWT user session required');
        return;
      }
      next();
    };
  }

  /**
   * Middleware to require specific permission
   */
  requirePermission(permission: Permission) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      const userPermissions = ROLE_PERMISSIONS[req.user._role];

      if (!userPermissions.includes(permission)) {
        sendForbidden(res, 'PERMISSION_REQUIRED', `Permission '${permission}' required`, {
          required: { permission },
          role: req.user._role,
        });
        return;
      }

      next();
    };
  }

  /**
   * Middleware to require a tenant claim. Fails closed: an authenticated
   * token without a well-formed `_organizationId` claim gets 403 before any
   * data access.
   */
  requireOrganization() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (req.user === undefined) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      if (organizationClaim(req.user) === null) {
        sendForbidden(res, 'ORGANIZATION_REQUIRED', 'Organization claim required');
        return;
      }

      next();
    };
  }

  /**
   * Middleware to require specific role
   */
  requireRole(...roles: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      if (!roles.includes(req.user._role)) {
        sendForbidden(res, 'ROLE_REQUIRED', `Role '${roles.join(' or ')}' required`, {
          required: { roles },
          role: req.user._role,
        });
        return;
      }

      next();
    };
  }

  /**
   * Middleware to require the dedicated platform administrator (P-6, HP1-S6).
   * Decided on every request from the freshly re-read user record
   * (isPlatformAdmin: flag set and not a seeded account), never from any
   * token or payload field; verified identities carry no platform marker.
   * Only a JWT login session qualifies, never an API key. Role and
   * organization grant nothing here. Refuses before any data or queue access.
   */
  requirePlatformAdmin() {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      if (!req.user) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      let allowed = false;
      if (req.credentialType === 'jwt') {
        try {
          const user = await this.authService.findEnabledUser(req.user._userId);
          allowed = user !== null && isPlatformAdmin(user);
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        sendForbidden(res, 'PLATFORM_ADMIN_REQUIRED', 'Platform administrator required');
        return;
      }

      next();
    };
  }

  /**
   * Middleware to require a dedicated scope (HAP-1615). Decided on every
   * request from the freshly re-read user record (holdsScope: stored list
   * names it and not a seeded account), so removing the grant takes effect
   * on the next request. A JWT session and that user's API key qualify alike.
   * Role, organization and platform administration grant nothing. Refuses
   * before any handler, data or queue access; a store error refuses.
   */
  requireScope(scope: Scope) {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      if (req.user === undefined) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      let allowed = false;
      try {
        const user = await this.authService.findEnabledUser(req.user._userId);
        allowed = user !== null && holdsScope(user, scope);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        sendForbidden(res, 'SCOPE_REQUIRED', `Scope '${scope}' required`, { required: { scope } });
        return;
      }

      next();
    };
  }

  /**
   * Extract JWT token from request
   */
  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1] || null;
  }

  /**
   * Extract API key from request
   */
  private extractApiKey(req: Request): string | null {
    if (!this.apiKeysEnabled) {
      return null;
    }
    const apiKey = req.headers[this.apiKeyHeader.toLowerCase()] as string | undefined;
    return apiKey ?? null;
  }
}

/**
 * GraphQL permission checker
 *
 * Throws GraphQL UNAUTHENTICATED when no identity is present on the
 * context (defensive -- the GraphQL server mounts `authenticate()`, which
 * already guarantees `context.user` is set for every request that reaches a resolver), or
 * FORBIDDEN when the authenticated user's role does not grant
 * `permission`. Returns the authenticated user so callers can use it
 * (e.g. as an actor id) without a second lookup. Single source of truth
 * for GraphQL role/permission gating -- resolvers MUST call this instead
 * of re-deriving their own copy of `ROLE_PERMISSIONS`.
 */
export function checkGraphQLPermission(
  context: { user?: TokenPayload },
  permission: Permission
): TokenPayload {
  if (!context.user) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }

  const userPermissions = ROLE_PERMISSIONS[context.user._role];

  if (!userPermissions.includes(permission)) {
    throw new GraphQLError(`Permission '${permission}' required`, {
      extensions: { code: 'FORBIDDEN', http: { status: 403 } },
    });
  }

  return context.user;
}
