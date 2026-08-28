// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for analytics.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `analyticsRoutes`,
 * mirroring production. Every route here is a read, so -- unlike
 * itil/business-service -- no route layers an additional
 * `requirePermission('write')` gate: any authenticated role, including a
 * read-only viewer, can reach every analytics endpoint.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const TOKEN_ROLES: Record<string, UserRole> = {
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

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({ authenticate: mockAuthenticate })),
}));

jest.mock('../../controllers/analytics.controller', () => ({
  AnalyticsController: jest.fn(() => ({
    getDashboardStats: mockRouteHandler,
    getCICountsByType: mockRouteHandler,
    getCICountsByStatus: mockRouteHandler,
    getCICountsByEnvironment: mockRouteHandler,
    getRelationshipCounts: mockRouteHandler,
    getDiscoveryStats: mockRouteHandler,
    getDiscoveryTimeline: mockRouteHandler,
    getTopConnectedCIs: mockRouteHandler,
    getDependencyDepthStats: mockRouteHandler,
    getChangeHistory: mockRouteHandler,
    getRelationshipMatrix: mockRouteHandler,
    getChangeTimeline: mockRouteHandler,
    getHealthMetrics: mockRouteHandler,
  })),
}));

import { analyticsRoutes } from '../analytics.routes';

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
  app.use('/analytics', analyticsRoutes);
  return app;
}

const readRoutes: string[] = [
  '/analytics/dashboard',
  '/analytics/ci-counts',
  '/analytics/ci-status',
  '/analytics/ci-environments',
  '/analytics/relationship-counts',
  '/analytics/discovery-stats',
  '/analytics/discovery-timeline',
  '/analytics/top-connected',
  '/analytics/dependency-depth',
  '/analytics/change-history',
  '/analytics/relationship-matrix',
  '/analytics/change-timeline',
  '/analytics/health-metrics/ci-1',
];

describe('analytics routes', () => {
  beforeEach(() => {
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each(readRoutes)('returns 401 before reaching GET %s without credentials', async (path) => {
    const response = await request(testApp()).get(path);
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(readRoutes)('a viewer (read-only) can reach GET %s -- reads authenticate only', async (path) => {
    const response = await request(testApp()).get(path).set('authorization', 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(readRoutes)('an operator can also reach GET %s', async (path) => {
    const response = await request(testApp()).get(path).set('authorization', 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await request(testApp())
      .get('/analytics/dashboard')
      .set('authorization', 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
