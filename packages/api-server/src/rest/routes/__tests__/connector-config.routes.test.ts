// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for connector-config.routes.ts. Authentication is
 * applied centrally by server.ts (`authMiddleware.authenticate()` mounted
 * on every /api/v1 route before any router), so this suite simulates that
 * by mounting the captured mock middleware ahead of
 * `connectorConfigRoutes`, mirroring production. Reads (list/get,
 * resource listing, run history, metrics) and testing an existing
 * configuration's connection stay open to any authenticated role, since
 * testing only inspects connectivity without mutating stored state. Every
 * state-changing route -- create/update/delete a configuration, trigger a
 * run, enable/disable, update enabled resources, and cancel a run --
 * additionally requires the 'write' permission
 * (`authMiddleware.requirePermission('write')`).
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

jest.mock('../../controllers/connector-config.controller', () => ({
  ConnectorConfigController: jest.fn(() => ({
    listConfigurations: mockRouteHandler,
    getConfiguration: mockRouteHandler,
    createConfiguration: mockRouteHandler,
    updateConfiguration: mockRouteHandler,
    deleteConfiguration: mockRouteHandler,
    testConnection: mockRouteHandler,
    runConnector: mockRouteHandler,
    enableConfiguration: mockRouteHandler,
    disableConfiguration: mockRouteHandler,
    getAvailableResources: mockRouteHandler,
    updateEnabledResources: mockRouteHandler,
    getResourceConfig: mockRouteHandler,
    getConfigurationRuns: mockRouteHandler,
    getConfigurationMetrics: mockRouteHandler,
    getResourceMetrics: mockRouteHandler,
    getAllRuns: mockRouteHandler,
    getRunDetails: mockRouteHandler,
    cancelRun: mockRouteHandler,
  })),
}));

import { connectorConfigRoutes } from '../connector-config.routes';

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
  app.use('/connector-configs', connectorConfigRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/connector-configs', undefined],
  ['GET', '/connector-configs/cfg-1', undefined],
  ['POST', '/connector-configs/cfg-1/test', undefined],
  ['GET', '/connector-configs/cfg-1/resources', undefined],
  ['GET', '/connector-configs/cfg-1/resources/res-1', undefined],
  ['GET', '/connector-configs/cfg-1/runs', undefined],
  ['GET', '/connector-configs/cfg-1/metrics', undefined],
  ['GET', '/connector-configs/cfg-1/resources/res-1/metrics', undefined],
  ['GET', '/connector-configs/runs/all', undefined],
  ['GET', '/connector-configs/runs/run-1', undefined],
];

const writeRoutes: RouteCase[] = [
  ['POST', '/connector-configs', { name: 'cfg-1', connector_type: 'aws', connection: {} }],
  ['PUT', '/connector-configs/cfg-1', { name: 'cfg-1-renamed' }],
  ['DELETE', '/connector-configs/cfg-1', undefined],
  ['POST', '/connector-configs/cfg-1/run', undefined],
  ['POST', '/connector-configs/cfg-1/enable', undefined],
  ['POST', '/connector-configs/cfg-1/disable', undefined],
  ['PUT', '/connector-configs/cfg-1/resources', { enabled_resources: ['res-1'] }],
  ['POST', '/connector-configs/runs/run-1/cancel', undefined],
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

describe('connector-config routes', () => {
  beforeEach(() => {
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
    const response = await invoke(
      testApp(),
      'GET',
      '/connector-configs',
      undefined,
      'Bearer garbage-token'
    );
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
