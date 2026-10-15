// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const touched = jest.fn();
const controller = new Proxy({}, { get: () => touched });
jest.mock('../../controllers/jobs.controller', () => ({ jobsController: controller }));
jest.mock('../../controllers/queue.controller', () => ({ queueController: controller }));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../../middleware/auth.middleware');
  const authService = {
    verifyToken: async (token: string) => {
      if (!['viewer', 'operator', 'admin', 'internal-admin', 'seed', 'platform'].includes(token)) throw new Error('Invalid token');
      return { _userId: token, _role: token === 'viewer' ? 'viewer' : 'admin',
        _organizationId: token === 'platform' ? undefined : '11111111-1111-4111-8111-111111111111' };
    },
    findEnabledUser: async (id: string) => ({
      _id: id === 'seed' ? 'user-admin-001' : id, _username: id,
      _platformAdmin: id === 'seed' || id === 'platform',
    }),
  } as unknown as AuthService;
  const middleware = new AuthMiddleware(authService, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']);
  return { getAuthMiddleware: () => middleware };
});
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import jobsRoutes from '../jobs.routes';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate(), jobsRoutes);

const paths = [
  ['get', '/jobs/stats'], ['get', '/jobs/discovery/stats'],
  ['get', '/jobs/schedules/discovery'], ['get', '/jobs/schedules/etl'],
  ['get', '/queues/stats'], ['get', '/queues/discovery-nmap/stats'],
  ['get', '/queues/discovery-nmap/metrics'], ['get', '/queues/health'],
  ['get', '/queues/workers/status'],
  ['post', '/jobs/discovery-nmap/clean'], ['post', '/queues/discovery-nmap/pause'],
  ['post', '/queues/discovery-nmap/resume'], ['put', '/jobs/schedules/discovery/nmap'],
  ['put', '/jobs/schedules/etl/sync'],
] as const;

test('tenant admins, internal admins and flagged seeds cannot reach global queues', async () => {
  touched.mockImplementation((_req: express.Request, res: express.Response) =>
    res.status(200).json({ success: true, data: { queueName: 'foreign', counts: { failed: 42 } } }));
  for (const role of ['viewer', 'operator', 'admin', 'internal-admin', 'seed']) {
    for (const [method, path] of paths) {
      const response = await request(app)[method](`/api/v1${path}`)
        .set('authorization', `Bearer ${role}`).send({ enabled: true });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false, error: 'Forbidden', message: 'Platform administrator required',
      });
    }
  }
  expect(touched).not.toHaveBeenCalled();
  const platform = await request(app).get('/api/v1/jobs/stats').set('authorization', 'Bearer platform');
  expect(platform.status).toBe(200);
  expect(touched).toHaveBeenCalledTimes(1);
});
