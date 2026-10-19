// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';

const queueAccess = jest.fn();
const platformAdmin = jest.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
jest.mock('@cmdb/common', () => ({
  getQueueManager: () => { queueAccess(); return {}; },
  QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap' },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@cmdb/discovery-engine', () => ({ getDiscoveryScheduler: () => ({}), getDiscoveryJobScheduler: () => ({}) }));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({}) }));
jest.mock('@cmdb/etl-processor', () => ({ getETLScheduler: () => ({}) }));
jest.mock('../../../auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({
  requirePlatformAdmin: () => platformAdmin,
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}) }));
import jobsRoutes from '../jobs.routes';

const app = express();
app.use((req, _res, next) => {
  (req as typeof req & { user: object }).user = { _userId: 'adminA', _role: 'admin', _organizationId: '11111111-1111-4111-8111-111111111111' };
  next();
});
app.use('/api/v1', jobsRoutes);

it('FD-S1 denies every mounted job and queue route before queue access', async () => {
  platformAdmin.mockImplementation((_req, res) => { res.status(403).json({ success: false, error: 'Forbidden' }); });
  const cases: Array<['get' | 'post' | 'put' | 'delete', string]> = [
    ['get', '/jobs/stats'], ['get', '/jobs/schedules/discovery'], ['get', '/jobs/schedules/etl'],
    ['put', '/jobs/schedules/discovery/nmap'], ['put', '/jobs/schedules/etl/sync'],
    ['get', '/jobs/discovery/stats'], ['get', '/jobs/discovery'], ['post', '/jobs/discovery/nmap'],
    ['post', '/jobs/etl/sync'], ['get', '/jobs/discovery-nmap/failed'],
    ['post', '/jobs/discovery-nmap/clean'], ['get', '/jobs/discovery-nmap/123'],
    ['get', '/jobs/discovery-nmap'], ['delete', '/jobs/discovery-nmap/123'],
    ['post', '/jobs/discovery-nmap/123/retry'], ['get', '/queues/stats'],
    ['get', '/queues/discovery-nmap/stats'], ['get', '/queues/discovery-nmap/metrics'],
    ['get', '/queues/workers/status'], ['get', '/queues/health'],
    ['post', '/queues/discovery-nmap/pause'], ['post', '/queues/discovery-nmap/resume'],
    ['get', '/queues/discovery-nmap/jobs/123/logs'],
  ];
  for (const [method, path] of cases) {
    expect((await request(app)[method](`/api/v1${path}`)).status).toBe(403);
  }
  expect(platformAdmin).toHaveBeenCalledTimes(cases.length);
  expect(queueAccess).not.toHaveBeenCalled();
});
