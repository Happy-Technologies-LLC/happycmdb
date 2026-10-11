// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';

const jobs = [
  { id: 'own', name: 'discover', data: { organizationId: '11111111-1111-4111-8111-111111111111', credentials: { password: 'synthetic-secret' } }, returnvalue: { token: 'synthetic-secret' }, failedReason: 'synthetic-secret', stacktrace: ['synthetic-secret'], progress: 50, opts: { attempts: 1 }, timestamp: 1, attemptsMade: 0, getState: async () => 'failed' },
  { id: 'foreign', name: 'discover', data: { organizationId: '22222222-2222-4222-8222-222222222222', credentials: { password: 'foreign-secret' } }, returnvalue: { token: 'foreign-secret' }, failedReason: 'foreign-secret', stacktrace: ['foreign-secret'], progress: 0, opts: { attempts: 1 }, timestamp: 2, attemptsMade: 0, getState: async () => 'failed' },
  { id: 'legacy', name: 'discover', data: { credentials: { password: 'legacy-secret' } }, progress: 0, opts: { attempts: 1 }, timestamp: 3, attemptsMade: 0, getState: async () => 'failed' },
];
const queue = { getWaiting: async (start: number, end: number) => jobs.slice(start, end + 1), getFailed: async (start: number, end: number) => jobs.slice(start, end + 1), getJobLogs: async () => ({ logs: ['foreign-secret'], count: 1 }),
  client: Promise.resolve({ zrange: async () => ['own', 'foreign', 'legacy'] }) };
const manager = { getJob: async (_queue: string, id: string) => jobs.find(job => job.id === id), getQueue: () => queue,
  getFailedJobs: async (_queueName: string, start: number, end: number) => jobs.slice(start, end + 1), getQueueStats: async () => ({ waiting: 3, failed: 3 }),
  removeJob: jest.fn(), retryJob: jest.fn() };
jest.mock('@cmdb/common', () => ({ getQueueManager: () => manager, QUEUE_NAMES: { _DISCOVERY_NMAP: 'discovery-nmap', _DISCOVERY_SSH: 'discovery-ssh' }, logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
jest.mock('@cmdb/discovery-engine', () => ({ getDiscoveryScheduler: () => ({}), getDiscoveryJobScheduler: () => ({}) }));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({}) }));
jest.mock('@cmdb/etl-processor', () => ({ getETLScheduler: () => ({}) }));
jest.mock('../../../auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }) }));
jest.mock('bullmq', () => ({ Job: { fromId: async (_queue: unknown, id: string) => jobs.find(job => job.id === id) } }));
import jobsRoutes from '../jobs.routes';
const app = express();
app.use((req, _res, next) => {
  (req as typeof req & { user: object }).user = { _userId: req.get('x-test-user') ?? 'a', _organizationId: req.get('x-test-org') ?? undefined, _role: 'operator' };
  next();
});
app.use('/api/v1', jobsRoutes);
const a = { 'x-test-user': 'a', 'x-test-org': jobs[0]!.data.organizationId! };
const b = { 'x-test-user': 'b', 'x-test-org': jobs[1]!.data.organizationId! };

test('mounted job reads isolate two organizations, hide sensitive data, and make foreign/missing/legacy identical', async () => {
  const root = '/api/v1/jobs/discovery-nmap';
  const own = await request(app).get(`${root}/own`).set(a);
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).not.toContain('synthetic-secret');
  expect(own.body.data).not.toHaveProperty('data');
  expect(own.body.data).not.toHaveProperty('returnvalue');
  const other = await request(app).get(`${root}/foreign`).set(b);
  expect(other.status).toBe(200);
  for (const id of ['foreign', 'missing', 'legacy']) {
    const denied = await request(app).get(`${root}/${id}`).set(a);
    expect({ status: denied.status, body: denied.body }).toEqual({ status: 404, body: (await request(app).get(`${root}/missing`).set(a)).body });
    expect(JSON.stringify(denied.body)).not.toContain('secret');
  }
  for (const suffix of ['', '/failed']) {
    const listing = await request(app).get(`${root}${suffix}`).set(a);
    expect(listing.status).toBe(200);
    expect(JSON.stringify(listing.body)).not.toMatch(/foreign-secret|legacy-secret|synthetic-secret|"id":"foreign"|"id":"legacy"/);
  }
  const discovery = await request(app).get('/api/v1/jobs/discovery?status=failed&provider=nmap').set(a);
  expect(discovery.status).toBe(200);
  expect(discovery.body.data.map((job: { id: string }) => job.id)).toEqual(['own']);
  expect(JSON.stringify(discovery.body)).not.toMatch(/foreign-secret|legacy-secret|synthetic-secret/);
  const ownLogs = await request(app).get('/api/v1/queues/discovery-nmap/jobs/own/logs').set(a);
  expect(ownLogs.status).toBe(200);
  expect(ownLogs.body.data.logs).toEqual([]);
  const logs = await request(app).get('/api/v1/queues/discovery-nmap/jobs/foreign/logs').set(a);
  expect(logs.status).toBe(404);
  expect(JSON.stringify(logs.body)).not.toContain('foreign-secret');
  for (const id of ['foreign', 'missing', 'legacy']) {
    const remove = await request(app).delete(`${root}/${id}`).set(a);
    const retry = await request(app).post(`${root}/${id}/retry`).set(a);
    expect(remove.status).toBe(404);
    expect(retry.status).toBe(404);
    expect(remove.body).toEqual(retry.body);
  }
  expect(manager.removeJob).not.toHaveBeenCalled();
  expect(manager.retryJob).not.toHaveBeenCalled();
  expect((await request(app).get(`${root}/own`).set({ 'x-test-user': 'none' })).status).toBe(403);
});

test('queue and failed-job pages reject invalid ranges and bound BullMQ reads before tenant filtering', async () => {
  const root = '/api/v1/jobs/discovery-nmap';
  const waiting = jest.spyOn(queue, 'getWaiting');
  const failed = jest.spyOn(manager, 'getFailedJobs');
  for (const suffix of ['', '/failed']) {
    for (const query of ['?start=-1', '?start=1.5', '?end=Infinity', '?limit=NaN']) {
      const invalid = await request(app).get(`${root}${suffix}${query}`).set(a);
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ success: false, error: 'Invalid job pagination' });
    }
  }
  expect(waiting).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();

  const huge = await request(app).get(`${root}?start=0&end=999999999`).set(a);
  expect(huge.status).toBe(200);
  expect(waiting).toHaveBeenCalledWith(0, 99);
  expect(huge.body.pagination.truncated).toBe(true);
  expect(huge.body.data.jobs.map((job: { id: string }) => job.id)).toContain('own');

  const foreign = Array.from({ length: 1500 }, (_, index) => ({
    ...jobs[1]!, id: `foreign-${index}`,
  }));
  failed.mockImplementation(async (_queueName: string, start: number, end: number) =>
    foreign.slice(start, end + 1));
  const small = await request(app).get(`${root}/failed?start=0&end=999999999&limit=1`).set(a);
  expect(small.status).toBe(200);
  expect(failed).toHaveBeenLastCalledWith('discovery-nmap', 0, 0);
  expect(small.body.data.failedJobs).toEqual([]);
  expect(small.body.pagination.truncated).toBe(true);
  expect(JSON.stringify(small.body)).not.toContain('foreign-secret');
  waiting.mockRestore();
  failed.mockRestore();
});

test('deep generic and failed ranges refuse before BullMQ while cap boundary remains readable', async () => {
  const getQueue = jest.spyOn(manager, 'getQueue');
  const failed = jest.spyOn(manager, 'getFailedJobs');
  for (const suffix of ['', '/failed']) {
    for (const start of ['10001', '9999999999999999999999999']) {
      const response = await request(app).get(`/api/v1/jobs/discovery-nmap${suffix}?start=${start}`).set(a);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ success: false, error: 'Invalid job pagination' });
    }
  }
  expect(getQueue).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect((await request(app).get('/api/v1/jobs/discovery-nmap?start=10000&end=10000').set(a)).status).toBe(200);
  expect((await request(app).get('/api/v1/jobs/discovery-nmap/failed?start=10000&end=10000').set(a)).status).toBe(200);
  getQueue.mockRestore();
  failed.mockRestore();
});

test('discovery list page arithmetic rejects deep/unsafe positions before Redis', async () => {
  const getQueue = jest.spyOn(manager, 'getQueue');
  for (const query of ['?page=102&limit=100', '?page=9999999999999999999&limit=100', '?page=0', '?limit=101']) {
    const response = await request(app).get(`/api/v1/jobs/discovery${query}`).set(a);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ success: false, error: 'Invalid job pagination' });
  }
  expect(getQueue).not.toHaveBeenCalled();
  getQueue.mockRestore();
});

test('unknown queues and providers refuse before queue lookup with fixed responses', async () => {
  const getJob = jest.spyOn(manager, 'getJob');
  const getQueue = jest.spyOn(manager, 'getQueue');
  const failed = jest.spyOn(manager, 'getFailedJobs');
  for (let index = 0; index < 120; index++) {
    const name = `attacker-${index}`;
    const paths = [
      ['get', `/jobs/${name}`], ['get', `/jobs/${name}/failed`],
      ['get', `/jobs/${name}/missing`], ['delete', `/jobs/${name}/missing`],
      ['post', `/jobs/${name}/missing/retry`], ['get', `/queues/${name}/jobs/missing/logs`],
    ] as const;
    for (const [method, path] of paths) {
      const response = await request(app)[method](`/api/v1${path}`).set(a);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ success: false, error: 'Invalid queue name' });
    }
    const provider = await request(app).get(`/api/v1/jobs/discovery?provider=${name}`).set(a);
    expect(provider.status).toBe(400);
    expect(provider.body).toEqual({ success: false, error: 'Invalid discovery provider' });
    const trigger = await request(app).post(`/api/v1/jobs/discovery/${name}`).set(a).send({ config: {} });
    expect(trigger.status).toBe(400);
    expect(trigger.body).toEqual({ success: false, error: 'Invalid discovery provider' });
  }
  expect(getJob).not.toHaveBeenCalled();
  expect(getQueue).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  getJob.mockRestore();
  getQueue.mockRestore();
  failed.mockRestore();
});
