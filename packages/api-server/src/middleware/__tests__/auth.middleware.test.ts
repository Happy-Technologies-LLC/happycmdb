// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AuthMiddleware.requireRole, the guard settings.routes.ts
 * uses on GET /api/v1/settings/database (admin only). requireRole reads
 * only the already-populated req.user, so it's tested standalone without
 * a live AuthService/DB. Also covers the GraphQL-side counterparts,
 * authenticateGraphQLContext (the Apollo context factory's identity
 * resolution -- throws GraphQLError UNAUTHENTICATED instead of returning
 * an empty context) and checkGraphQLPermission (the shared role/permission
 * gate every GraphQL resolver reuses instead of re-deriving its own copy
 * of ROLE_PERMISSIONS).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { GraphQLError } from 'graphql';
import {
  AuthMiddleware,
  AuthenticatedRequest,
  authenticateGraphQLContext,
  checkGraphQLPermission,
} from '../auth.middleware';
import type { AuthService } from '../../auth/auth.service';
import type { TokenPayload } from '../../auth/types';

const authConfig = {
  jwt: { secret: 'test-secret-at-least-32-characters-long', accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d' },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

describe('AuthMiddleware.requireRole', () => {
  // requireRole never calls into AuthService -- it only reads req.user,
  // already populated by an earlier authenticate() step.
  const middleware = new AuthMiddleware({} as AuthService, authConfig as any);

  it('returns 401 when no user is attached to the request', () => {
    const req = {} as AuthenticatedRequest;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    middleware.requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated non-admin user', () => {
    const req = { user: { _userId: 'u1', _username: 'bob', _role: 'operator', _type: 'access' } } as AuthenticatedRequest;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    middleware.requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for an authenticated admin user', () => {
    const req = { user: { _userId: 'u1', _username: 'alice', _role: 'admin', _type: 'access' } } as AuthenticatedRequest;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    middleware.requireRole('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('AuthMiddleware.authenticate', () => {
  const middleware = new AuthMiddleware({} as AuthService, authConfig as any);

  it('returns 401 when the request has no bearer token or API key', async () => {
    const req = { headers: {} } as unknown as AuthenticatedRequest;
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    await middleware.authenticate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

const testUser: TokenPayload = {
  _userId: 'u1',
  _username: 'alice',
  _role: 'operator',
  _type: 'access',
};

function fakeAuthService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    verifyToken: jest.fn(),
    verifyApiKey: jest.fn(),
    ...overrides,
  } as unknown as AuthService;
}

function fakeRequest(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

async function expectGraphQLErrorCode(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await promise;
    throw new Error('expected promise to reject, but it resolved');
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    const graphqlError = error as GraphQLError;
    expect(graphqlError.extensions?.['code']).toBe(code);
    expect((graphqlError.extensions?.['http'] as { status?: number } | undefined)?.status).toBe(status);
  }
}

describe('authenticateGraphQLContext', () => {
  it('throws GraphQL UNAUTHENTICATED (401) when no bearer token or API key is present', async () => {
    const authService = fakeAuthService();

    await expectGraphQLErrorCode(
      authenticateGraphQLContext(authService, 'X-API-Key', fakeRequest({})),
      'UNAUTHENTICATED',
      401
    );
    expect(authService.verifyToken).not.toHaveBeenCalled();
    expect(authService.verifyApiKey).not.toHaveBeenCalled();
  });

  it('throws GraphQL UNAUTHENTICATED (401) when the bearer token fails verification', async () => {
    const authService = fakeAuthService({
      verifyToken: jest.fn().mockRejectedValue(new Error('jwt expired')) as unknown as AuthService['verifyToken'],
    });

    await expectGraphQLErrorCode(
      authenticateGraphQLContext(authService, 'X-API-Key', fakeRequest({ authorization: 'Bearer bad-token' })),
      'UNAUTHENTICATED',
      401
    );
  });

  it('throws GraphQL UNAUTHENTICATED (401) when the API key fails verification', async () => {
    const authService = fakeAuthService({
      verifyApiKey: jest.fn().mockRejectedValue(new Error('invalid key')) as unknown as AuthService['verifyApiKey'],
    });

    await expectGraphQLErrorCode(
      authenticateGraphQLContext(authService, 'X-API-Key', fakeRequest({ 'x-api-key': 'bad-key' })),
      'UNAUTHENTICATED',
      401
    );
  });

  it('resolves { user } for a valid bearer token', async () => {
    const authService = fakeAuthService({
      verifyToken: jest.fn().mockResolvedValue(testUser) as unknown as AuthService['verifyToken'],
    });

    const result = await authenticateGraphQLContext(
      authService,
      'X-API-Key',
      fakeRequest({ authorization: 'Bearer good-token' })
    );

    expect(result).toEqual({ user: testUser });
  });

  it('resolves { user } for a valid API key when no bearer token is present', async () => {
    const authService = fakeAuthService({
      verifyApiKey: jest.fn().mockResolvedValue(testUser) as unknown as AuthService['verifyApiKey'],
    });

    const result = await authenticateGraphQLContext(
      authService,
      'X-API-Key',
      fakeRequest({ 'x-api-key': 'good-key' })
    );

    expect(result).toEqual({ user: testUser });
  });
});

describe('checkGraphQLPermission', () => {
  it('throws GraphQL UNAUTHENTICATED (401) when the context has no user', () => {
    expect(() => checkGraphQLPermission({}, 'write')).toThrow(GraphQLError);
    try {
      checkGraphQLPermission({}, 'write');
      throw new Error('expected checkGraphQLPermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLError);
      const graphqlError = error as GraphQLError;
      expect(graphqlError.extensions?.['code']).toBe('UNAUTHENTICATED');
      expect((graphqlError.extensions?.['http'] as { status?: number } | undefined)?.status).toBe(401);
    }
  });

  it('throws GraphQL FORBIDDEN (403) when the role lacks the permission', () => {
    const viewer: TokenPayload = { ...testUser, _role: 'viewer' };
    try {
      checkGraphQLPermission({ user: viewer }, 'write');
      throw new Error('expected checkGraphQLPermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLError);
      const graphqlError = error as GraphQLError;
      expect(graphqlError.extensions?.['code']).toBe('FORBIDDEN');
      expect((graphqlError.extensions?.['http'] as { status?: number } | undefined)?.status).toBe(403);
    }
  });

  it('returns the user when the role grants the permission', () => {
    const operator: TokenPayload = { ...testUser, _role: 'operator' };
    expect(checkGraphQLPermission({ user: operator }, 'write')).toBe(operator);
  });

  it('grants admin every permission, including write', () => {
    const admin: TokenPayload = { ...testUser, _role: 'admin' };
    expect(checkGraphQLPermission({ user: admin }, 'write')).toBe(admin);
    expect(checkGraphQLPermission({ user: admin }, 'admin')).toBe(admin);
  });
});
