// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics routes authenticate centrally (as server.ts does). Viewer and
 * operator roles may read; history/timeline also require an organization.
 */
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { UserRole } from '../../../auth/types';

type ReqWithUser = Request & {
  user?: { _userId?: string; _role?: UserRole; _organizationId?: string };
};

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const TOKEN_ROLES: Record<string, UserRole> = {
  'Bearer operator-token': 'operator',
  'Bearer viewer-token': 'viewer',
  'Bearer no-org-token': 'operator',
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const token = req.get('authorization') ?? '';
  const role = TOKEN_ROLES[token];
  if (!role) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = {
    _userId: 'route-user', _role: role,
    ...(token === 'Bearer no-org-token' ? {} : { _organizationId: '11111111-1111-4111-8111-111111111111' }),
  };
  next();
});

const mockRequireOrganization = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  if (!(req as ReqWithUser).user?._organizationId) {
    res.status(403).json({ error: 'Organization required' });
    return;
  }
  next();
});

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({
    authenticate: mockAuthenticate,
    requireOrganization: mockRequireOrganization,
  })),
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

// server.ts captures this once. resetMocks wipes mock implementations before
// each test, so calling mockAuthenticate again inside testApp would return undefined.
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
  '/analytics/change-history?ci_id=ci-1',
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

  it.each(readRoutes)('returns 401 before reaching GET %s without credentials', async path => {
    const response = await request(testApp()).get(path);
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(readRoutes)('a viewer (read-only) can reach GET %s', async path => {
    const response = await request(testApp()).get(path).set('authorization', 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(readRoutes)('an operator can also reach GET %s', async path => {
    const response = await request(testApp()).get(path).set('authorization', 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(['/analytics/change-history?ci_id=ci-1', '/analytics/change-timeline'])(
    'rejects GET %s with no organization', async path => {
      const response = await request(testApp()).get(path).set('authorization', 'Bearer no-org-token');
      expect(response.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await request(testApp())
      .get('/analytics/dashboard')
      .set('authorization', 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});
