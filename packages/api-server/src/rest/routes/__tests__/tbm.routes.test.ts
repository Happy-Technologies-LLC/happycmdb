// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for tbm.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `tbmRoutes`, mirroring
 * production. Every route requires an organization claim
 * (`authMiddleware.requireOrganization()`, router level). Business-service
 * and capability costs are readable by any role; the global aggregates over
 * every CI (FD-3 b), including the cost allocate and GL import mutations,
 * additionally require the 'admin' permission.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole; _organizationId?: string } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const ORG = '11111111-1111-4111-8111-111111111111';
const TOKENS: Record<string, { role: UserRole; organizationId?: string }> = {
  'Bearer admin-token': { role: 'admin', organizationId: ORG },
  'Bearer operator-token': { role: 'operator', organizationId: ORG },
  'Bearer viewer-token': { role: 'viewer', organizationId: ORG },
  'Bearer no-org-admin-token': { role: 'admin' },
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const token = TOKENS[req.get('authorization') ?? ''];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = { _userId: 'route-user', _role: token.role, _organizationId: token.organizationId };
  next();
});

const mockRequireOrganization = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  if ((req as ReqWithUser).user?._organizationId === undefined) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
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
    requireOrganization: mockRequireOrganization,
    requirePermission: mockRequirePermission,
  })),
}));

jest.mock('../../controllers/tbm.controller', () => ({
  TBMController: jest.fn(() => ({
    getCostSummary: mockRouteHandler,
    getCostsByTower: mockRouteHandler,
    getCostsByCapability: mockRouteHandler,
    getCostsByBusinessService: mockRouteHandler,
    getCostTrends: mockRouteHandler,
    allocateCosts: mockRouteHandler,
    getCostAllocations: mockRouteHandler,
    importGLData: mockRouteHandler,
    getLicenses: mockRouteHandler,
    getUpcomingRenewals: mockRouteHandler,
  })),
}));

import { tbmRoutes } from '../tbm.routes';

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
  app.use('/tbm', tbmRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

// Org-scoped: the controller filters to the caller organization's business services.
const scopedRoutes: RouteCase[] = [
  ['GET', '/tbm/costs/by-capability/cap-1', undefined],
  ['GET', '/tbm/costs/by-service/bs-1', undefined],
];

// Global aggregates over every CI: admin-only (FD-3 b).
const globalRoutes: RouteCase[] = [
  ['GET', '/tbm/costs/summary', undefined],
  ['GET', '/tbm/costs/by-tower', undefined],
  ['GET', '/tbm/costs/trends', undefined],
  ['GET', '/tbm/costs/allocations/ci-1', undefined],
  ['GET', '/tbm/licenses', undefined],
  ['GET', '/tbm/licenses/renewals', undefined],
  [
    'POST',
    '/tbm/costs/allocate',
    {
      sourceId: 'gl-entry-1',
      targetType: 'business_service',
      targetIds: ['bs-1'],
    },
  ],
  ['POST', '/tbm/gl/import', undefined],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req = method === 'GET' ? request(app).get(path) : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('tbm routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...scopedRoutes, ...globalRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body);
      expect(response.status).toBe(401);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each([...scopedRoutes, ...globalRoutes])(
    'an admin without an organization claim receives 403 on %s %s',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body, 'Bearer no-org-admin-token');
      expect(response.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(scopedRoutes)('a viewer (read-only) with an organization can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(globalRoutes)('a viewer receives 403 on global aggregate %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(403);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(globalRoutes)('an operator (write, not admin) receives 403 on global aggregate %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(403);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(globalRoutes)('an admin with an organization can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer admin-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/tbm/costs/summary', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
