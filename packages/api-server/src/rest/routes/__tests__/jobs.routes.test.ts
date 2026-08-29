// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for jobs.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `jobsRoutes`, mirroring
 * production. Reads only need to be authenticated; every mutating route
 * (trigger discovery/ETL, schedule PUTs, queue clean/cancel/retry, queue
 * pause/resume) additionally requires the 'write' permission
 * (`authMiddleware.requirePermission('write')`).
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole } };

const mockJobsHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});
const mockQueueHandler = jest.fn((req: Request, res: Response) => {
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

jest.mock('../../controllers/jobs.controller', () => ({
  jobsController: {
    getJobStats: mockJobsHandler,
    getDiscoverySchedules: mockJobsHandler,
    getETLSchedules: mockJobsHandler,
    updateDiscoverySchedule: mockJobsHandler,
    updateETLSchedule: mockJobsHandler,
    getDiscoveryStats: mockJobsHandler,
    listDiscoveryJobs: mockJobsHandler,
    triggerDiscovery: mockJobsHandler,
    triggerETL: mockJobsHandler,
    getFailedJobs: mockJobsHandler,
    cleanQueue: mockJobsHandler,
    getJobStatus: mockJobsHandler,
    listJobs: mockJobsHandler,
    cancelJob: mockJobsHandler,
    retryJob: mockJobsHandler,
  },
}));

jest.mock('../../controllers/queue.controller', () => ({
  queueController: {
    getAllQueueStats: mockQueueHandler,
    getQueueStats: mockQueueHandler,
    getQueueMetrics: mockQueueHandler,
    getAllWorkerStatus: mockQueueHandler,
    getQueueHealth: mockQueueHandler,
    pauseQueue: mockQueueHandler,
    resumeQueue: mockQueueHandler,
    getJobLogs: mockQueueHandler,
  },
}));

import jobsRoutes from '../jobs.routes';

type RouteMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';
type RouteCase = [RouteMethod, string];

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
  app.use(jobsRoutes);
  return app;
}

function invokeRoute(app: express.Express, method: RouteMethod, path: string, token?: string) {
  const route =
    method === 'DELETE'
      ? request(app).delete(path)
      : method === 'GET'
        ? request(app).get(path)
        : method === 'POST'
          ? request(app).post(path)
          : request(app).put(path);

  return token ? route.set('authorization', token) : route;
}

const readRoutes: RouteCase[] = [
  ['GET', '/jobs/stats'],
  ['GET', '/jobs/schedules/discovery'],
  ['GET', '/jobs/schedules/etl'],
  ['GET', '/jobs/discovery/stats'],
  ['GET', '/jobs/discovery'],
  ['GET', '/jobs/default/failed'],
  ['GET', '/jobs/default/job-1'],
  ['GET', '/jobs/default'],
  ['GET', '/queues/stats'],
  ['GET', '/queues/default/stats'],
  ['GET', '/queues/default/metrics'],
  ['GET', '/queues/workers/status'],
  ['GET', '/queues/health'],
  ['GET', '/queues/default/jobs/job-1/logs'],
];

const writeRoutes: RouteCase[] = [
  ['PUT', '/jobs/schedules/discovery/aws'],
  ['PUT', '/jobs/schedules/etl/asset'],
  ['POST', '/jobs/discovery/aws'],
  ['POST', '/jobs/etl/asset'],
  ['POST', '/jobs/default/clean'],
  ['DELETE', '/jobs/default/job-1'],
  ['POST', '/jobs/default/job-1/retry'],
  ['POST', '/queues/default/pause'],
  ['POST', '/queues/default/resume'],
];

describe('jobs routes authentication and authorization', () => {
  beforeEach(() => {
    mockJobsHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
    mockQueueHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...readRoutes, ...writeRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path) => {
      const response = await invokeRoute(testApp(), method, path);

      expect(response.status).toBe(401);
      expect(mockJobsHandler).not.toHaveBeenCalled();
      expect(mockQueueHandler).not.toHaveBeenCalled();
    }
  );

  it.each(readRoutes)('a viewer (read-only) can reach %s %s', async (method, path) => {
    const response = await invokeRoute(testApp(), method, path, 'Bearer viewer-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
  });

  it.each(writeRoutes)('a viewer (read-only) receives 403 on %s %s', async (method, path) => {
    const response = await invokeRoute(testApp(), method, path, 'Bearer viewer-token');

    expect(response.status).toBe(403);
    expect(mockJobsHandler).not.toHaveBeenCalled();
    expect(mockQueueHandler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) can reach %s %s', async (method, path) => {
    const response = await invokeRoute(testApp(), method, path, 'Bearer operator-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
  });

  it.each(writeRoutes)('an admin (write) can reach %s %s', async (method, path) => {
    const response = await invokeRoute(testApp(), method, path, 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
  });

  it('dispatches authenticated GET requests with req.user', async () => {
    const response = await invokeRoute(testApp(), 'GET', '/jobs/schedules/discovery', 'Bearer viewer-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
    expect(mockJobsHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: { _userId: 'route-user', _role: 'viewer' } }),
      expect.anything()
    );
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invokeRoute(testApp(), 'GET', '/jobs/stats', 'Bearer garbage-token');

    expect(response.status).toBe(401);
    expect(mockJobsHandler).not.toHaveBeenCalled();
  });
});
