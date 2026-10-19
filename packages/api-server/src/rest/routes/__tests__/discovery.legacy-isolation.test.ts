// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';
import type { ConfigSchema } from '@cmdb/common';

const secret = 'nested-synthetic-secret';
const oldJob = {
  id: 'old', data: { organizationId: 'another-organization', config: { password: secret } },
  returnvalue: { nested: { credential: secret } }, failedReason: secret,
  timestamp: 1, attemptsMade: 1, progress: { nested: secret }, getState: async () => 'failed',
};
const read = jest.fn(async () => oldJob);
const queue = {
  getJob: read, getWaiting: jest.fn(async () => []), getActive: jest.fn(async () => []),
  getCompleted: jest.fn(async () => []), getFailed: jest.fn(async () => [oldJob]),
  add: jest.fn(),
};
jest.mock('@cmdb/database', () => ({
  queueManager: { getQueue: () => queue },
  QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap', _DISCOVERY_SSH: 'discovery-ssh' },
}));
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'), logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('../../controllers/settings.controller', () => ({
  SettingsController: jest.fn(() => ({ testDiscoveryConnection: jest.fn() })),
}));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware');
  const service = {
    verifyToken: async (token: string) => ({ _userId: token, _username: token, _role: 'admin', _type: 'access' }),
    findEnabledUser: async (id: string) => ({
      _id: id, _username: id, _enabled: true, _role: 'admin', _platformAdmin: id === 'platform',
    }),
  } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(service, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { discoveryRoutes } from '../discovery.routes';
const app = express();
app.use(express.json());
app.use('/api/v1/discovery', getAuthMiddleware().authenticate(), discoveryRoutes);

beforeEach(() => {
  read.mockResolvedValue(oldJob);
  queue.getFailed.mockImplementation(async () => [oldJob]);
  queue.add.mockClear();
});

test('non-platform admins cannot touch legacy job queues; only platform admin sees redacted cross-org jobs', async () => {
  const denied = await request(app).get('/api/v1/discovery/jobs/old').set('authorization', 'Bearer tenant');
  expect(denied.status).toBe(403);
  expect(read).not.toHaveBeenCalled();

  const own = await request(app).get('/api/v1/discovery/jobs/old').set('authorization', 'Bearer platform');
  expect(read).toHaveBeenCalledWith('old');
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).not.toContain(secret);
  expect(own.body.data.failureCode).toBe('DISCOVERY_JOB_FAILED');
  const list = await request(app).get('/api/v1/discovery/jobs?status=failed').set('authorization', 'Bearer platform');
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain(secret);
});

test('legacy schedule refuses before enqueue even for platform administrator', async () => {
  const response = await request(app).post('/api/v1/discovery/schedule')
    .set('authorization', 'Bearer platform').send({ provider: 'nmap', config: { password: secret } });
  expect(response.status).toBe(503);
  expect(queue.add).not.toHaveBeenCalled();
});
