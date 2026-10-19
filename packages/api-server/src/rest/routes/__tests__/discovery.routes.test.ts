// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted legacy discovery authorization: queue reads require a platform JWT;
 * ad-hoc execution and credential testing stay disabled until journal cutover. */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole; _organizationId?: string } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const TOKEN_ROLES: Record<string, UserRole> = {
  'Bearer admin-token': 'admin',
  'Bearer operator-token': 'operator',
  'Bearer viewer-token': 'viewer',
  // API-key-shaped credentials cannot read the global queue.
  'Bearer agent-token': 'agent',
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const role = TOKEN_ROLES[req.get('authorization') ?? ''];
  if (!role) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = { _userId: 'route-user', _role: role, _organizationId: '11111111-1111-4111-8111-111111111111' };
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
const mockRequirePlatformAdmin = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  if ((req as ReqWithUser).user?._role !== 'admin') {
    res.status(403).json({ success: false, error: 'Global queue operations unavailable' });
    return;
  }
  next();
});

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({
    authenticate: mockAuthenticate,
    requirePermission: mockRequirePermission,
    requirePlatformAdmin: mockRequirePlatformAdmin,
  })),
}));

jest.mock('../../controllers/discovery.controller', () => ({
  DiscoveryController: jest.fn(() => ({
    scheduleDiscovery: mockRouteHandler,
    getJobStatus: mockRouteHandler,
    listJobs: mockRouteHandler,
    cancelJob: mockRouteHandler,
  })),
}));

jest.mock('../../controllers/settings.controller', () => ({
  SettingsController: jest.fn(() => ({
    testDiscoveryConnection: mockRouteHandler,
  })),
}));

import { discoveryRoutes } from '../discovery.routes';

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
  app.use('/discovery', discoveryRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];
const adminRoutes: RouteCase[] = [
  ['GET', '/discovery/jobs/job-1', undefined],
  ['GET', '/discovery/jobs', undefined],
  ['DELETE', '/discovery/jobs/job-1', undefined],
];
const unavailableRoutes: RouteCase[] = [
  ['POST', '/discovery/schedule', { provider: 'nmap' }],
  ['POST', '/discovery/test-connection', { provider: 'aws', credentials: {} }],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req =
    method === 'GET'
      ? request(app).get(path)
      : method === 'DELETE'
        ? request(app).delete(path)
        : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('discovery routes', () => {
  beforeEach(() => {
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...adminRoutes, ...unavailableRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body);
      expect(response.status).toBe(401);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(adminRoutes)('requires platform admin for %s %s', async (method, path, body) => {
    for (const token of ['Bearer viewer-token', 'Bearer operator-token', 'Bearer agent-token']) {
      const denied = await invoke(testApp(), method, path, body, token);
      expect(denied.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
    const allowed = await invoke(testApp(), method, path, body, 'Bearer admin-token');
    expect(allowed.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalledTimes(1);
  });

  it.each(unavailableRoutes)('keeps %s %s disabled after authentication', async (method, path, body) => {
    for (const token of ['Bearer viewer-token', 'Bearer operator-token', 'Bearer admin-token']) {
      const response = await invoke(testApp(), method, path, body, token);
      expect(response.status).toBe(token === 'Bearer viewer-token' && path.endsWith('schedule') ? 403 : 503);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/discovery/jobs', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
