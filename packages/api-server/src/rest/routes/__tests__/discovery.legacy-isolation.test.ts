// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';
import type { ConfigSchema } from '@cmdb/common';
import type { UserRole } from '../../../auth/types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const secret = 'nested-synthetic-secret';
const remove = jest.fn();
const add = jest.fn();
const records = [
  { id: 'own', data: { organizationId: A, provider: 'nmap', config: { nested: { password: secret } }, created_at: '2026-01-01' }, returnvalue: { nested: { password: secret } }, failedReason: secret, progress: { completed: 1, total: 2, nested: secret }, timestamp: 1, attemptsMade: 0, getState: async () => 'waiting', remove },
  { id: 'foreign', data: { organizationId: B, provider: 'nmap', config: { password: secret } }, getState: async () => 'waiting', remove },
  { id: 'orgless', data: { provider: 'nmap', config: { password: secret } }, getState: async () => 'waiting', remove },
  { id: 'failed-own', data: { organizationId: A, provider: 'nmap', config: { nested: { token: secret } } }, returnvalue: { password: secret }, failedReason: secret, timestamp: 2, attemptsMade: 1, getState: async () => 'failed', remove },
  { id: 'completed-own', data: { organizationId: A, provider: 'nmap', config: { nested: { token: secret } } }, returnvalue: { discovered: 7, nested: { credential: secret } }, timestamp: 3, attemptsMade: 1, getState: async () => 'completed', remove },
];
const queue = { getJob: async (id: string) => records.find(j => j.id === id), getWaiting: async (start: number, end: number) => records.filter(j => !['failed-own', 'completed-own'].includes(j.id)).slice(start, end + 1), getActive: async () => [], getCompleted: async () => records.filter(j => j.id === 'completed-own'), getFailed: async () => records.filter(j => j.id === 'failed-own'), add };
const emptyQueue = { ...queue, getJob: async () => undefined, getWaiting: async () => [], getCompleted: async () => [], getFailed: async () => [] };
jest.mock('@cmdb/database', () => ({ queueManager: { getQueue: (name: string) => name === 'discovery-nmap' ? queue : emptyQueue }, QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap', _DISCOVERY_SSH: 'discovery-ssh' } }));
jest.mock('@cmdb/common', () => ({ ...jest.requireActual('@cmdb/common'), logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../controllers/settings.controller', () => ({ SettingsController: jest.fn(() => ({ testDiscoveryConnection: jest.fn() })) }));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../../middleware/auth.middleware');
  const service = { verifyToken: async (token: string) => {
    const [role, org] = token.split(':');
    if (!['viewer', 'operator', 'admin'].includes(role ?? '')) throw new Error('Invalid token');
    return { _role: role as UserRole, _organizationId: org };
  } } as unknown as AuthService;
  const middleware = new AuthMiddleware(service, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']);
  return { getAuthMiddleware: () => middleware };
});
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { discoveryRoutes } from '../discovery.routes';
const app = express();
app.use(express.json());
app.use('/api/v1/discovery', getAuthMiddleware().authenticate(), discoveryRoutes);
const auth = (role: string, org = A) => `Bearer ${role}:${org}`;

test('legacy reads and cancel are org-owned, allowlisted and indistinguishable for foreign, missing and NULL org', async () => {
  const own = await request(app).get('/api/v1/discovery/jobs/own').set('authorization', auth('viewer'));
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).not.toContain(secret);
  expect(own.body.data).not.toHaveProperty('config');
  expect(own.body.data).not.toHaveProperty('result');
  const list = await request(app).get('/api/v1/discovery/jobs').set('authorization', auth('viewer'));
  expect(list.status).toBe(200);
  expect(list.body.data.map((j: { id: string }) => j.id)).toEqual(['completed-own', 'failed-own', 'own']);
  expect(JSON.stringify(list.body)).not.toContain(secret);
  const failure = await request(app).get('/api/v1/discovery/jobs/failed-own').set('authorization', auth('viewer'));
  expect(failure.body.data.failureCode).toBe('DISCOVERY_JOB_FAILED');
  expect(JSON.stringify(failure.body)).not.toContain(secret);
  const completed = await request(app).get('/api/v1/discovery/jobs/completed-own').set('authorization', auth('viewer'));
  expect(completed.body.data).toMatchObject({ provider: 'nmap', summary: { discoveredCIs: 7 } });
  expect(JSON.stringify(completed.body)).not.toContain(secret);
  expect((await request(app).get('/api/v1/discovery/jobs').set('authorization', auth('viewer', 'null'))).status).toBe(403);
  for (const id of ['foreign', 'orgless', 'missing']) {
    const detail = await request(app).get(`/api/v1/discovery/jobs/${id}`).set('authorization', auth('viewer'));
    const results = await request(app).get(`/api/v1/discovery/jobs/${id}/results`).set('authorization', auth('viewer'));
    const cancel = await request(app).delete(`/api/v1/discovery/jobs/${id}`).set('authorization', auth('operator'));
    expect(detail.status).toBe(404);
    expect(results.status).toBe(404);
    expect(cancel.status).toBe(404);
    expect(cancel.body).toEqual((await request(app).delete('/api/v1/discovery/jobs/missing').set('authorization', auth('operator'))).body);
  }
  expect(remove).not.toHaveBeenCalled();
  expect((await request(app).delete('/api/v1/discovery/jobs/own').set('authorization', auth('viewer'))).status).toBe(403);
  expect((await request(app).delete('/api/v1/discovery/jobs/own').set('authorization', auth('operator'))).status).toBe(200);
  expect(remove).toHaveBeenCalledTimes(1);
  expect((await request(app).get('/api/v1/discovery/jobs/foreign').set('authorization', auth('viewer', B))).status).toBe(200);
});

test('small legacy list pages never load unbounded foreign jobs or call their state', async () => {
  const foreignState = jest.fn(async () => 'waiting');
  const foreign = Array.from({ length: 1500 }, (_, index) => ({
    ...records[0]!, id: `foreign-${index}`,
    data: { ...records[0]!.data, organizationId: B, config: { password: secret } },
    getState: foreignState,
  }));
  const waiting = jest.spyOn(queue, 'getWaiting').mockImplementation(async (start, end) =>
    foreign.slice(start, end + 1));
  try {
    const response = await request(app).get('/api/v1/discovery/jobs?status=pending&limit=1')
      .set('authorization', auth('viewer'));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(waiting).toHaveBeenCalledWith(0, 0);
    expect(foreignState).not.toHaveBeenCalled();
  } finally {
    waiting.mockRestore();
  }
});

test('legacy bounded pages continue past 100 owned jobs without claiming an exact total', async () => {
  const owned = Array.from({ length: 150 }, (_, index) => ({
    ...records[0]!, id: `owned-${index}`, timestamp: index,
  }));
  const waiting = jest.spyOn(queue, 'getWaiting').mockImplementation(async (start, end) =>
    owned.slice(start, end + 1));
  try {
    const first = await request(app).get('/api/v1/discovery/jobs?status=pending&limit=100')
      .set('authorization', auth('viewer'));
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(100);
    expect(waiting).toHaveBeenCalledWith(0, 99);

    const second = await request(app).get('/api/v1/discovery/jobs?status=pending&offset=100&limit=50')
      .set('authorization', auth('viewer'));
    expect(second.status).toBe(200);
    expect(waiting).toHaveBeenLastCalledWith(100, 149);
    expect(second.body.data).toHaveLength(50);
    expect(new Set(second.body.data.map((job: { id: string }) => job.id))).toEqual(
      new Set(owned.slice(100).map((job) => job.id))
    );
    expect(first.body.pagination).toMatchObject({ offset: 0, limit: 100, truncated: true });
    expect(first.body.pagination).not.toHaveProperty('total');
    expect(second.body.pagination).toMatchObject({ offset: 100, limit: 50, truncated: true });
    expect(second.body.pagination).not.toHaveProperty('total');

    const oversized = await request(app).get('/api/v1/discovery/jobs?status=pending&limit=1000')
      .set('authorization', auth('viewer'));
    expect(oversized.status).toBe(400);
  } finally {
    waiting.mockRestore();
  }
});

test('legacy schedule stamps org and allowlists config; credential-backed providers refuse before enqueue', async () => {
  for (const provider of ['ssh', 'snmp', 'active-directory']) {
    const response = await request(app).post('/api/v1/discovery/schedule').set('authorization', auth('admin'))
      .send({ provider, config: { credentials: { password: secret }, targets: ['192.0.2.1'] } });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ success: false, error: 'Credential-backed discovery execution unavailable' });
  }
  expect(add).not.toHaveBeenCalled();
  const noOrg = await request(app).post('/api/v1/discovery/schedule').set('authorization', auth('operator', 'null'))
    .send({ provider: 'nmap', config: { targets: ['192.0.2.1'] } });
  expect(noOrg.status).toBe(403);
  expect(add).not.toHaveBeenCalled();
  const response = await request(app).post('/api/v1/discovery/schedule').set('authorization', auth('operator'))
    .send({ provider: 'nmap', config: { targets: ['192.0.2.1'], credentials: { password: secret }, nested: { token: secret } } });
  expect(response.status).toBe(201);
  expect(add).toHaveBeenCalledTimes(1);
  const data = add.mock.calls[0]![1] as { organizationId: string; config: unknown };
  expect(data.organizationId).toBe(A);
  expect(data.config).toEqual({ targets: ['192.0.2.1'] });
  expect(JSON.stringify(add.mock.calls)).not.toContain(secret);
});
