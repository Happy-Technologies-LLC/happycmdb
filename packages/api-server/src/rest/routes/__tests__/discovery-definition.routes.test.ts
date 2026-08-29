// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for discovery-definition.routes.ts. Authentication is
 * applied centrally by server.ts (`authMiddleware.authenticate()` mounted
 * on every /api/v1 route before any router), so this suite simulates that
 * by mounting the captured mock middleware ahead of
 * `discoveryDefinitionRoutes`, mirroring production. Create/update/delete/
 * run and enabling or disabling a schedule mutate definition state and
 * additionally require the 'write' permission
 * (`authMiddleware.requirePermission('write')`, satisfied by operator,
 * agent, and admin). Listing and reading a single definition are
 * read-only and only need to be authenticated.
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
  // API-key-shaped credential for a discovery agent: the 'agent' role
  // has 'write' (ROLE_PERMISSIONS), so agents can run/manage definitions
  // alongside operator/admin.
  'Bearer agent-token': 'agent',
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

jest.mock('../../controllers/discovery-definition.controller', () => ({
  DiscoveryDefinitionController: jest.fn(() => ({
    createDefinition: mockRouteHandler,
    listDefinitions: mockRouteHandler,
    getDefinition: mockRouteHandler,
    updateDefinition: mockRouteHandler,
    deleteDefinition: mockRouteHandler,
    runDefinition: mockRouteHandler,
    enableSchedule: mockRouteHandler,
    disableSchedule: mockRouteHandler,
  })),
}));

import { discoveryDefinitionRoutes } from '../discovery-definition.routes';

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
  app.use('/discovery/definitions', discoveryDefinitionRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/discovery/definitions', undefined],
  ['GET', '/discovery/definitions/def-1', undefined],
];

// provider: 'nmap' sidesteps createDefinitionSchema's conditional
// credential_id/agent_id requirements, keeping the write-route bodies
// minimal and schema-valid.
const writeRoutes: RouteCase[] = [
  ['POST', '/discovery/definitions', { name: 'Test Definition', provider: 'nmap', method: 'agentless' }],
  ['PUT', '/discovery/definitions/def-1', { name: 'Updated Definition' }],
  ['DELETE', '/discovery/definitions/def-1', undefined],
  ['POST', '/discovery/definitions/def-1/run', undefined],
  ['POST', '/discovery/definitions/def-1/schedule/enable', undefined],
  ['POST', '/discovery/definitions/def-1/schedule/disable', undefined],
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

describe('discovery definition routes', () => {
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

  it.each(writeRoutes)('a discovery agent (API-key-shaped req.user, write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer agent-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/discovery/definitions', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
