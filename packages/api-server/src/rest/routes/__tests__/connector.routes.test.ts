// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for connector.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `connectorRoutes`,
 * mirroring production. Registry/installed/outdated reads stay open to any
 * authenticated role. Install/update/uninstall/cache-refresh are gated to
 * the 'admin' role given their infrastructure/supply-chain risk; verifying
 * an installed connector only requires the 'write' permission.
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

// Mirrors AuthMiddleware.requirePermission/.requireRole (packages/api-server/
// src/middleware/auth.middleware.ts): 401 with no req.user (unreachable here
// since authenticate() always runs first), 403 when the role lacks the
// permission/isn't in the allowed set, else next().
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

jest.mock('../../controllers/connector.controller', () => ({
  ConnectorController: jest.fn(() => ({
    getRegistry: mockRouteHandler,
    searchRegistry: mockRouteHandler,
    getRegistryDetails: mockRouteHandler,
    getInstalledConnectors: mockRouteHandler,
    getInstalledConnectorDetails: mockRouteHandler,
    installConnector: mockRouteHandler,
    updateConnector: mockRouteHandler,
    uninstallConnector: mockRouteHandler,
    verifyConnector: mockRouteHandler,
    refreshRegistryCache: mockRouteHandler,
    checkOutdatedConnectors: mockRouteHandler,
  })),
}));

import { connectorRoutes } from '../connector.routes';

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
  app.use('/connectors', connectorRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/connectors/registry', undefined],
  ['GET', '/connectors/registry/search?q=aws', undefined],
  ['GET', '/connectors/registry/aws', undefined],
  ['GET', '/connectors/installed', undefined],
  ['GET', '/connectors/installed/aws', undefined],
  ['GET', '/connectors/outdated', undefined],
];

// Gated by requirePermission('write'), reachable by operator and admin.
const writeRoutes: RouteCase[] = [['POST', '/connectors/aws/verify', undefined]];

// Gated by requireRole('admin'); an operator (has 'write' but isn't admin)
// must be rejected too.
const adminRoutes: RouteCase[] = [
  ['POST', '/connectors/install', { connector_type: 'aws' }],
  ['PUT', '/connectors/aws/update', {}],
  ['DELETE', '/connectors/aws', undefined],
  ['POST', '/connectors/cache/refresh', undefined],
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

describe('connector routes', () => {
  beforeEach(() => {
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

  it.each([...writeRoutes, ...adminRoutes])(
    'a viewer (read-only) receives 403 on %s %s',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
      expect(response.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(writeRoutes)('a write-permitted, non-admin operator can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(adminRoutes)(
    'a non-admin operator (write only) receives 403 on the admin-gated %s %s',
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

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/connectors/installed', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
