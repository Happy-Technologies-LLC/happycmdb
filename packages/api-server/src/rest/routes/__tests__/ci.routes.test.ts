// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for ci.routes.ts. Authentication is applied centrally
 * by server.ts (`authMiddleware.authenticate()` mounted on every /api/v1
 * route before any router), so this suite simulates that by mounting the
 * captured mock middleware ahead of `ciRoutes`, mirroring production.
 * Reads (including the read-like POST /search lookup) only need to be
 * authenticated; POST/PUT/DELETE mutations additionally require the
 * 'write' permission (`authMiddleware.requirePermission('write')`).
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const TOKEN_ROLES: Record<string, UserRole> = {
  'Bearer admin-token': 'admin',
  'Bearer operator-token': 'operator',
  'Bearer viewer-token': 'viewer',
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const role = TOKEN_ROLES[req.get('authorization') ?? ''];
  if (!role) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = { _userId: 'route-user', _role: role };
  next();
});

const mockRequirePermission = jest.fn(
  (permission: Permission) => (req: Request, res: Response, next: () => void) => {
    const role = (req as ReqWithUser).user?._role;
    if (!role) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ROLE_PERMISSIONS[role].includes(permission)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  }
);

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({
    authenticate: mockAuthenticate,
    requirePermission: mockRequirePermission,
  })),
}));

jest.mock('../../controllers/ci.controller', () => ({
  CIController: jest.fn(() => ({
    getAllCIs: mockRouteHandler,
    searchCIs: mockRouteHandler,
    getCIById: mockRouteHandler,
    createCI: mockRouteHandler,
    updateCI: mockRouteHandler,
    deleteCI: mockRouteHandler,
    getCIRelationships: mockRouteHandler,
    getCIDependencies: mockRouteHandler,
    getImpactAnalysis: mockRouteHandler,
    getCIAuditHistory: mockRouteHandler,
  })),
}));

import { ciRoutes } from '../ci.routes';

// Captured once at module scope (mirrors server.ts, which builds this
// middleware once via `authMiddleware.authenticate()` when the app is
// constructed). jest.config.unit.js sets `resetMocks: true`, which wipes
// `mockAuthenticate`'s implementation before every test; calling it fresh
// inside testApp() would return undefined once the suite is running.
const authenticateMiddleware = mockAuthenticate();

function testApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authenticateMiddleware);
  app.use('/cis', ciRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/cis', undefined],
  ['GET', '/cis/ci-1', undefined],
  ['GET', '/cis/ci-1/relationships', undefined],
  ['GET', '/cis/ci-1/dependencies', undefined],
  ['GET', '/cis/ci-1/impact', undefined],
  ['GET', '/cis/ci-1/audit', undefined],
  // Read-like: a lookup query that does not persist state.
  ['POST', '/cis/search', { query: 'web-server' }],
];

const writeRoutes: RouteCase[] = [
  ['POST', '/cis', { id: 'ci-1', name: 'Test CI', type: 'server' }],
  ['PUT', '/cis/ci-1', { name: 'Updated CI' }],
  ['DELETE', '/cis/ci-1', undefined],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req =
    method === 'GET'
      ? request(app).get(path)
      : method === 'DELETE'
        ? request(app).delete(path)
        : method === 'PUT'
          ? request(app).put(path).send(body ?? {})
          : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('ci routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...readRoutes, ...writeRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body);
      expect(response.status).toBe(401);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(readRoutes)('a viewer (read-only) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(writeRoutes)('a viewer (read-only) receives 403 on %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(403);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/cis', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
