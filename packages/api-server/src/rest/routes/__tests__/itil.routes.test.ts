// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for itil.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `itilRoutes`, mirroring
 * production. Reads only need to be authenticated; POST/PUT/PATCH/DELETE
 * mutations additionally require the 'write' permission
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

jest.mock('../../controllers/itil.controller', () => ({
  ITILController: jest.fn(() => ({
    getConfigurationItems: mockRouteHandler,
    getConfigurationItem: mockRouteHandler,
    updateLifecycleStage: mockRouteHandler,
    updateConfigurationStatus: mockRouteHandler,
    getCIHistory: mockRouteHandler,
    getCIsDueForAudit: mockRouteHandler,
    scheduleAudit: mockRouteHandler,
    completeAudit: mockRouteHandler,
    createIncident: mockRouteHandler,
    getIncidents: mockRouteHandler,
    getIncident: mockRouteHandler,
    updateIncident: mockRouteHandler,
    resolveIncident: mockRouteHandler,
    getIncidentPriority: mockRouteHandler,
    createChange: mockRouteHandler,
    getChanges: mockRouteHandler,
    getChange: mockRouteHandler,
    updateChange: mockRouteHandler,
    assessChangeRisk: mockRouteHandler,
    approveChange: mockRouteHandler,
    implementChange: mockRouteHandler,
    closeChange: mockRouteHandler,
    createBaseline: mockRouteHandler,
    getBaselines: mockRouteHandler,
    getBaseline: mockRouteHandler,
    deleteBaseline: mockRouteHandler,
    compareToBaseline: mockRouteHandler,
    restoreFromBaseline: mockRouteHandler,
    getConfigurationAccuracy: mockRouteHandler,
    getIncidentSummary: mockRouteHandler,
    getChangeSuccessRate: mockRouteHandler,
    getMeanTimeToResolve: mockRouteHandler,
    getMeanTimeBetweenFailures: mockRouteHandler,
  })),
}));

import { itilRoutes } from '../itil.routes';

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
  app.use('/itil', itilRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['GET', '/itil/configuration-items', undefined],
  ['GET', '/itil/configuration-items/ci-1', undefined],
  ['GET', '/itil/configuration-items/ci-1/history', undefined],
  ['GET', '/itil/configuration-items/audit/due', undefined],
  ['GET', '/itil/incidents', undefined],
  ['GET', '/itil/incidents/inc-1', undefined],
  ['GET', '/itil/incidents/inc-1/priority', undefined],
  ['GET', '/itil/changes', undefined],
  ['GET', '/itil/changes/chg-1', undefined],
  ['GET', '/itil/changes/chg-1/risk-assessment', undefined],
  ['GET', '/itil/baselines', undefined],
  ['GET', '/itil/baselines/base-1', undefined],
  ['GET', '/itil/baselines/base-1/comparison', undefined],
  ['GET', '/itil/metrics/configuration-accuracy', undefined],
  ['GET', '/itil/metrics/incident-summary', undefined],
  ['GET', '/itil/metrics/change-success-rate', undefined],
  ['GET', '/itil/metrics/mttr', undefined],
  ['GET', '/itil/metrics/mtbf', undefined],
];

const writeRoutes: RouteCase[] = [
  ['PATCH', '/itil/configuration-items/ci-1/lifecycle', { stage: 'BUILD' }],
  ['PATCH', '/itil/configuration-items/ci-1/status', { status: 'ACTIVE' }],
  [
    'POST',
    '/itil/incidents',
    { affectedCIId: 'ci-1', description: 'disk usage exceeded threshold', reportedBy: 'alice' },
  ],
  ['PATCH', '/itil/incidents/inc-1', { status: 'IN_PROGRESS' }],
  [
    'POST',
    '/itil/incidents/inc-1/resolve',
    { resolution: 'root cause identified and patched', resolvedBy: 'alice' },
  ],
  [
    'POST',
    '/itil/changes',
    {
      changeType: 'STANDARD',
      description: 'roll out patched kernel to web tier',
      affectedCIIds: ['ci-1'],
      requestedBy: 'alice',
      plannedStart: '2026-09-01T00:00:00.000Z',
      plannedDuration: 60,
      implementationPlan: 'drain traffic, apply patch, restart service, verify health checks pass',
    },
  ],
  ['PATCH', '/itil/changes/chg-1', { status: 'APPROVED' }],
  ['POST', '/itil/changes/chg-1/approve', undefined],
  ['POST', '/itil/changes/chg-1/implement', undefined],
  ['POST', '/itil/changes/chg-1/close', { result: 'SUCCESS', closedBy: 'alice' }],
  ['POST', '/itil/baselines', { name: 'pre-patch-baseline', ciIds: ['ci-1'], createdBy: 'alice' }],
  ['DELETE', '/itil/baselines/base-1', undefined],
  ['POST', '/itil/baselines/base-1/restore', { ciId: 'ci-1', performedBy: 'alice' }],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req =
    method === 'GET'
      ? request(app).get(path)
      : method === 'DELETE'
        ? request(app).delete(path)
        : method === 'PATCH'
          ? request(app).patch(path).send(body ?? {})
          : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('itil routes', () => {
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
    const response = await invoke(testApp(), 'GET', '/itil/incidents', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
