// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';
import type { UserRole } from '../../../auth/types';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const touched = jest.fn();
const controller = new Proxy({}, { get: () => touched });
jest.mock('../../controllers/jobs.controller', () => ({ jobsController: controller }));
jest.mock('../../controllers/queue.controller', () => ({ queueController: controller }));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../../middleware/auth.middleware');
  const authService = {
    verifyToken: async (token: string) => {
      if (!['viewer', 'operator', 'admin'].includes(token)) throw new Error('Invalid token');
      return { _role: token as UserRole, _organizationId: '11111111-1111-4111-8111-111111111111' };
    },
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

test('every authenticated role receives identical global refusal without touching queues or schedules', async () => {
  touched.mockImplementation((_req: express.Request, res: express.Response) =>
    res.status(200).json({ success: true, data: { queueName: 'foreign', counts: { failed: 42 } } }));
  const responses = [];
  for (const role of ['viewer', 'operator', 'admin']) {
    for (const [method, path] of paths) {
      const response = await request(app)[method](`/api/v1${path}`).set('authorization', `Bearer ${role}`).send({ enabled: true });
      responses.push({ status: response.status, body: response.body });
    }
  }
  expect(responses).toEqual(Array(responses.length).fill({ status: 403, body: { success: false, error: 'Global queue operations unavailable' } }));
  expect(touched).not.toHaveBeenCalled();
});
