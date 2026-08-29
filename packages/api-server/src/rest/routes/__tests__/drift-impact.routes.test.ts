// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for drift-impact.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `driftRoutes`/
 * `impactRoutes`, mirroring production. Reads only need to be
 * authenticated; persisting mutations additionally require the 'write'
 * permission (`authMiddleware.requirePermission('write')`); baseline
 * approval is governance-sensitive and requires the 'admin' role
 * (`authMiddleware.requireRole('admin')`).
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

const mockRequireRole = jest.fn(
  (...roles: string[]) =>
    (req: Request, res: Response, next: () => void) => {
      const role = (req as ReqWithUser).user?._role;
      if (!role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!roles.includes(role)) {
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
    requireRole: mockRequireRole,
  })),
}));

jest.mock('../../controllers/drift-impact.controller', () => ({
  DriftImpactController: jest.fn(() => ({
    detectDrift: mockRouteHandler,
    getDriftHistory: mockRouteHandler,
    createBaseline: mockRouteHandler,
    approveBaseline: mockRouteHandler,
    getApprovedBaseline: mockRouteHandler,
    predictImpact: mockRouteHandler,
    getDependencyGraph: mockRouteHandler,
    getCriticalityScore: mockRouteHandler,
    getImpactHistory: mockRouteHandler,
  })),
}));

import { driftRoutes, impactRoutes } from '../drift-impact.routes';

// Captured once at module scope (mirrors server.ts, which builds this
// middleware once via `authMiddleware.authenticate()` when the app is
// constructed). jest.config.unit.js sets `resetMocks: true`, which wipes
// `mockAuthenticate`'s implementation before every test; calling it fresh
// inside testApp() would return undefined once the suite is running.
const authenticateMiddleware = mockAuthenticate();

function testApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Mirrors server.ts: authentication is applied centrally on /api/v1
  // before any router, not by the router itself.
  app.use(authenticateMiddleware);
  app.use('/drift', driftRoutes);
  app.use('/impact', impactRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/drift/history/ci-1', undefined],
  ['GET', '/drift/baseline/ci-1?snapshot_type=configuration', undefined],
  ['GET', '/impact/graph/ci-1', undefined],
  ['GET', '/impact/criticality/ci-1', undefined],
  ['GET', '/impact/history/ci-1', undefined],
];

const writeRoutes: RouteCase[] = [
  ['POST', '/drift/detect/ci-1', {}],
  ['POST', '/drift/baseline', { ci_id: 'ci-1', snapshot_type: 'configuration' }],
  ['POST', '/impact/predict', { ci_id: 'ci-1', change_type: 'RESTART' }],
];

const adminRoutes: RouteCase[] = [['POST', '/drift/baseline/baseline-1/approve', {}]];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req = method === 'GET' ? request(app).get(path) : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('drift and impact routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...readRoutes, ...writeRoutes, ...adminRoutes])(
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

  it.each(adminRoutes)('a viewer (read-only) receives 403 on the admin-gated %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(403);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(adminRoutes)(
    'an operator (write, non-admin) receives 403 on the admin-gated %s %s',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
      expect(response.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(adminRoutes)('an admin can reach the admin-gated %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer admin-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('passes the authenticated request user to the baseline create mutation', async () => {
    const response = await request(testApp())
      .post('/drift/baseline')
      .set('authorization', 'Bearer operator-token')
      .send({ ci_id: 'ci-1', snapshot_type: 'configuration' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
    expect(mockRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ _userId: 'route-user' }) }),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/drift/history/ci-1', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
