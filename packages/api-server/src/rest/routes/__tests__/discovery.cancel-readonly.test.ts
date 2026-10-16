// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';
import type { ConfigSchema } from '@cmdb/common';

const queueNames = ['discovery-nmap', 'discovery-ssh', 'discovery-active-directory', 'discovery-snmp'] as const;
const remove = jest.fn(async () => undefined);
const getState = jest.fn(async () => 'waiting');
const jobs = new Map<string, { id: string; getState: typeof getState; remove: typeof remove }>();
const lookups = Object.fromEntries(queueNames.map((name) => [name, jest.fn(async (id: string) =>
  jobs.get(name)?.id === id ? jobs.get(name) : undefined)]));
jest.mock('@cmdb/database', () => ({
  queueManager: { getQueue: (name: string) => ({ getJob: lookups[name as keyof typeof lookups] }) },
  QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap', _DISCOVERY_SSH: 'discovery-ssh' },
}));
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'), logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
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
  jobs.clear();
  remove.mockImplementation(async () => undefined);
  getState.mockImplementation(async () => 'waiting');
  for (const name of queueNames) lookups[name].mockImplementation(async (id: string) =>
    jobs.get(name)?.id === id ? jobs.get(name) : undefined);
});

test('legacy platform-admin cancellation refuses actual read-only AD/SNMP queues before job removal', async () => {
  for (const name of ['discovery-active-directory', 'discovery-snmp']) {
    jobs.set(name, { id: `job-${name}`, getState, remove });
    const result = await request(app).delete(`/api/v1/discovery/jobs/job-${name}`)
      .set('authorization', 'Bearer platform');
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ success: false, error: 'Queue mutation unavailable' });
    expect(getState).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  }
});

test('legacy platform-admin cancellation still removes waiting nmap and SSH jobs', async () => {
  for (const name of ['discovery-nmap', 'discovery-ssh']) {
    const id = `job-${name}`;
    jobs.set(name, { id, getState, remove });
    const result = await request(app).delete(`/api/v1/discovery/jobs/${id}`)
      .set('authorization', 'Bearer platform');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, data: { id, previousState: 'waiting' } });
  }
  expect(remove).toHaveBeenCalledTimes(2);
});

test('legacy cancellation preserves missing-job and finished-job responses', async () => {
  const missing = await request(app).delete('/api/v1/discovery/jobs/absent')
    .set('authorization', 'Bearer platform');
  expect(missing.status).toBe(404);
  expect(remove).not.toHaveBeenCalled();

  jobs.set('discovery-nmap', { id: 'done', getState, remove });
  getState.mockResolvedValue('completed');
  const finished = await request(app).delete('/api/v1/discovery/jobs/done')
    .set('authorization', 'Bearer platform');
  expect(finished.status).toBe(400);
  expect(finished.body).toMatchObject({ success: false, error: 'Cannot cancel finished discovery job' });
  expect(remove).not.toHaveBeenCalled();
});

test('legacy discovery DELETE rejects tenant and anonymous callers before queue lookup', async () => {
  jobs.set('discovery-active-directory', { id: 'sensitive', getState, remove });
  const tenant = await request(app).delete('/api/v1/discovery/jobs/sensitive')
    .set('authorization', 'Bearer tenant');
  const anonymous = await request(app).delete('/api/v1/discovery/jobs/sensitive');
  expect(tenant.status).toBe(403);
  expect(anonymous.status).toBe(401);
  for (const lookup of Object.values(lookups)) expect(lookup).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('legacy discovery GET remains able to inspect read-only queue status', async () => {
  jobs.set('discovery-active-directory', { id: 'visible', getState, remove });
  const result = await request(app).get('/api/v1/discovery/jobs/visible')
    .set('authorization', 'Bearer platform');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, data: { id: 'visible', status: 'waiting' } });
  expect(remove).not.toHaveBeenCalled();
});
