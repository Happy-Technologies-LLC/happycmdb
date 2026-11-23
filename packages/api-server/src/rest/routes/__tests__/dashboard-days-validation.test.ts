// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * `days` on the executive, CIO and FinOps dashboards: real routes, real auth
 * middleware (in-memory verifier), real admission and the real parseTimeRange;
 * only the data methods of the dashboard service are stubbed.
 */
import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const mockService = {
  parseTimeRange: undefined as unknown,
  getExecutiveSummary: jest.fn(),
  getCIOMetrics: jest.fn(),
  getFinOpsDashboard: jest.fn(),
  getITSMDashboard: jest.fn(),
};

// One identity per request: the admission limiter allows 10 requests per
// principal per minute, and this file sends more than that.
let identity = 0;
const orgFor = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => {
    const n = Number(token.replace('user-', ''));
    if (!Number.isInteger(n)) throw new Error('Invalid token');
    return { _userId: token, _username: token, _role: 'viewer', _organizationId: orgFor(n), _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});

// The real @cmdb/database opens a Redis connection on import; the dashboard
// service is stubbed below, so only the names its module imports are needed.
jest.mock('@cmdb/database', () => ({
  CITraversalLimitError: class CITraversalLimitError extends Error {},
  MAX_CI_TRAVERSAL_NODES: 100,
  MAX_CI_TRAVERSAL_WORK: 400,
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

jest.mock('../../../services/dashboard.service', () => {
  const actual = jest.requireActual('../../../services/dashboard.service');
  mockService.parseTimeRange = actual.DashboardService.prototype.parseTimeRange;
  return { ...actual, getDashboardService: () => mockService };
});

import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { dashboardRoutes } from '../dashboard.routes';

const app = express();
app.use(express.json());
app.use('/dashboards', getAuthMiddleware().authenticate(), dashboardRoutes);

const get = (path: string) => request(app).get(path).set('authorization', `Bearer user-${++identity}`);

const ROUTES = [
  { path: '/dashboards/executive', method: mockService.getExecutiveSummary },
  { path: '/dashboards/cio', method: mockService.getCIOMetrics },
  { path: '/dashboards/finops', method: mockService.getFinOpsDashboard },
] as const;

beforeEach(() => {
  for (const fn of [mockService.getExecutiveSummary, mockService.getCIOMetrics,
    mockService.getFinOpsDashboard, mockService.getITSMDashboard]) {
    fn.mockReset();
    fn.mockResolvedValue({});
  }
});

const REFUSED = ['0', '-5', '3651', '1000000000', 'abc', '1.5', '', '7days'];
const ACCEPTED = [1, 7, 30, 90, 365, 3650];

describe.each(ROUTES)('GET $path', ({ path, method }) => {
  it.each(REFUSED)('refuses days=%j with 400 and never calls the service', async (days) => {
    const response = await get(`${path}?days=${days}`);
    expect(response.status).toBe(400);
    expect(response.body._error).toBe('Validation Error');
    expect(response.body._details[0]._field).toBe('days');
    expect(method).not.toHaveBeenCalled();
  });

  it('refuses a repeated days parameter', async () => {
    const response = await get(`${path}?days=7&days=30`);
    expect(response.status).toBe(400);
    expect(method).not.toHaveBeenCalled();
  });

  it.each(ACCEPTED)('accepts days=%d and reports a past window of that length', async (days) => {
    const response = await get(`${path}?days=${days}`);
    expect(response.status).toBe(200);
    expect(response.body.timeRange.days).toBe(days);
    expect(Date.parse(response.body.timeRange.startDate)).toBeLessThan(Date.parse(response.body.timeRange.endDate));
    expect(method).toHaveBeenCalledTimes(1);
    expect(method.mock.calls[0]![1].days).toBe(days);
  });

  it('defaults to 30 days without a query', async () => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.body.timeRange.days).toBe(30);
  });

  it('keeps serving a client that sends other query keys alongside a valid days', async () => {
    const response = await get(`${path}?days=7&unrelated=x`);
    expect(response.status).toBe(200);
    expect(response.body.timeRange.days).toBe(7);
  });
});

it('does not validate days on /dashboards/itsm, which takes none', async () => {
  const response = await get('/dashboards/itsm?days=abc');
  expect(response.status).toBe(200);
  expect(mockService.getITSMDashboard).toHaveBeenCalledTimes(1);
});
