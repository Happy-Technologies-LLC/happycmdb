// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication Middleware
 * Handles JWT and API key authentication for Express and GraphQL
 */

import { Request, Response, NextFunction } from 'express';
import { GraphQLError } from 'graphql';
import type { ConfigSchema } from '@cmdb/common';
import { AuthService } from '../auth/auth.service';
import { TokenPayload, Permission, ROLE_PERMISSIONS } from '../auth/types';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export class AuthMiddleware {
  private authService: AuthService;
  private apiKeyHeader: string;

  constructor(authService: AuthService, config: ConfigSchema['auth']) {
    this.authService = authService;
    this.apiKeyHeader = config.apiKeys.headerName;
  }

  /**
   * Middleware to authenticate JWT or API key
   */
  authenticate() {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const token = this.extractToken(req);
        const apiKey = this.extractApiKey(req);

        if (token) {
          // Verify JWT token
          const payload = await this.authService.verifyToken(token);
          req.user = payload;
          next();
        } else if (apiKey) {
          // Verify API key
          const payload = await this.authService.verifyApiKey(apiKey);
          req.user = payload;
          next();
        } else {
          res.status(401).json({
            _error: 'Unauthorized',
            _message: 'No authentication credentials provided',
          });
        }
      } catch (error: any) {
        res.status(401).json({
          _error: 'Unauthorized',
          _message: error.message || 'Authentication failed',
        });
      }
    };
  }

  /**
   * Optional authentication (sets user if available, but doesn't require it)
   */
  optionalAuthenticate() {
    return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      try {
        const token = this.extractToken(req);
        const apiKey = this.extractApiKey(req);

        if (token) {
          const payload = await this.authService.verifyToken(token);
          req.user = payload;
        } else if (apiKey) {
          const payload = await this.authService.verifyApiKey(apiKey);
          req.user = payload;
        }

        next();
      } catch (error) {
        // Ignore authentication errors for optional auth
        next();
      }
    };
  }

  /**
   * Middleware to require specific permission
   */
  requirePermission(permission: Permission) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user) {
        res.status(401).json({
          _error: 'Unauthorized',
          _message: 'Authentication required',
        });
        return;
      }

      const userPermissions = ROLE_PERMISSIONS[req.user._role];

      if (!userPermissions.includes(permission)) {
        res.status(403).json({
          _error: 'Forbidden',
          _message: `Permission '${permission}' required`,
        });
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
        res.status(401).json({
          _error: 'Unauthorized',
          _message: 'Authentication required',
        });
        return;
      }

      if (!roles.includes(req.user._role)) {
        res.status(403).json({
          _error: 'Forbidden',
          _message: `Role '${roles.join(' or ')}' required`,
        });
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
    const apiKey = req.headers[this.apiKeyHeader.toLowerCase()] as string | undefined;
    return apiKey ?? null;
  }
}

/**
 * GraphQL context authentication
 *
 * Resolves the bearer token or API key on a GraphQL request into an
 * authenticated identity. This runs inside Apollo's context factory:
 * throwing here fails context creation *before any resolver executes*,
 * which Apollo Server surfaces as a top-level GraphQL error response
 * (see `errorResponse` in @apollo/server). That makes authentication
 * mandatory for every query and mutation with no per-resolver opt-in
 * required -- unlike returning `{}` and leaving each resolver to check
 * `context.user` itself, which silently permits anonymous access to any
 * resolver that forgets the check.
 */
export async function authenticateGraphQLContext(
  authService: AuthService,
  apiKeyHeader: string,
  req: Request
): Promise<{ user: TokenPayload }> {
  // Extract token
  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1] || null;
    }
  }

  // Extract API key
  const apiKey = (req.headers[apiKeyHeader.toLowerCase()] as string | undefined) || null;

  if (!token && !apiKey) {
    throw new GraphQLError('No authentication credentials provided', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }

  try {
    const payload = token
      ? await authService.verifyToken(token)
      : await authService.verifyApiKey(apiKey as string);
    return { user: payload };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Authentication failed';
    throw new GraphQLError(message, {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
    });
  }
}

/**
 * GraphQL permission checker
 *
 * Throws GraphQL UNAUTHENTICATED when no identity is present on the
 * context (defensive -- the context factory above already guarantees
 * `context.user` is set for every request that reaches a resolver), or
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
