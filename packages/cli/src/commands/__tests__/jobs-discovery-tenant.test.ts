// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import { Command } from 'commander';
import request from 'supertest';
import { logger } from '@cmdb/common';
import { DiscoveryScheduler } from '../../../../discovery-engine/src/schedulers/discovery-scheduler';
import { createJobsCommand } from '../jobs.command';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const queueManager = {
  addJob: jest.fn().mockResolvedValue({ id: 'owned-job' }),
  getQueue: jest.fn(),
  getJob: jest.fn(),
  getQueueStats: jest.fn(),
  retryJob: jest.fn(),
  removeJob: jest.fn(),
};
let scheduler: DiscoveryScheduler;
let server: Server;
let apiUrl: string;
const originalKey = process.env['CMDB_API_KEY'];
const originalToken = process.env['CMDB_ACCESS_TOKEN'];
const originalHeader = process.env['API_KEY_HEADER_NAME'];

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  safeDiscoveryScanConfig: require('../../../../common/src/utils/discovery-scan-config').safeDiscoveryScanConfig,
  getQueueManager: () => queueManager,
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery-ssh', _DISCOVERY_NMAP: 'discovery-nmap' },
}));
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({}), getNeo4jClient: () => ({}) }));
jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryScheduler: () => scheduler, getDiscoveryJobScheduler: () => ({}),
}));
const triggerETL = jest.fn();
jest.mock('@cmdb/etl-processor', () => ({ getETLScheduler: () => ({ triggerETL }) }));
jest.mock('../../../../api-server/src/auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({
  requirePermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as express.Request & { user?: { _role: string } }).user?._role) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
  requirePlatformAdmin: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.get('Authorization') !== 'Bearer valid-jwt') {
      res.status(403).json({ success: false, error: 'Global queue operations unavailable' });
      return;
    }
    next();
  },
}) }));

async function invoke(args: string[], captured: string[] = []): Promise<number> {
  const exits: number[] = [];
  const exit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => { exits.push(code ?? 0); return undefined as never; });
  const output = jest.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { captured.push(parts.join(' ')); });
  try {
    const command = new Command('cmdb');
    command.option('-u, --url <url>').option('-k, --key <key>');
    command.addCommand(createJobsCommand());
    await command.parseAsync(['node', 'cmdb', ...args]);
    return exits[0] ?? -1;
  } finally {
    output.mockRestore();
    exit.mockRestore();
  }
}

beforeAll(async () => {
  delete process.env['CMDB_API_KEY'];
  delete process.env['CMDB_ACCESS_TOKEN'];
  process.env['API_KEY_HEADER_NAME'] = 'X-Workspace-Key';
  scheduler = Object.create(DiscoveryScheduler.prototype) as DiscoveryScheduler;
  Object.assign(scheduler, {
    schedules: new Map([
      ['nmap', { _provider: 'nmap', _queueName: 'discovery-nmap', _config: { _targets: [] } }],
      ['ssh', { _provider: 'ssh', _queueName: 'discovery-ssh', _config: { _targets: [] } }],
    ]),
    queueManager,
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const key = req.get('X-Workspace-Key');
    const token = req.get('Authorization');
    if (key !== 'valid-key' && key !== 'valid-key-b' && key !== 'tenantless-key' && token !== 'Bearer valid-jwt') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as typeof req & { user: object }).user = {
      _userId: 'operator', _role: 'operator',
      _organizationId: key === 'tenantless-key' ? undefined : key === 'valid-key-b' ? OTHER_ORG : ORG,
    };
    next();
  });
  const { default: routes } = require('../../../../api-server/src/rest/routes/jobs.routes');
  app.use('/api/v1', routes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (originalKey === undefined) delete process.env['CMDB_API_KEY']; else process.env['CMDB_API_KEY'] = originalKey;
  if (originalToken === undefined) delete process.env['CMDB_ACCESS_TOKEN']; else process.env['CMDB_ACCESS_TOKEN'] = originalToken;
  if (originalHeader === undefined) delete process.env['API_KEY_HEADER_NAME']; else process.env['API_KEY_HEADER_NAME'] = originalHeader;
});
beforeEach(() => queueManager.addJob.mockResolvedValue({ id: 'owned-job' }));


test('CLI cannot trigger legacy discovery even with a platform JWT or queue credentials', async () => {
  const base = ['--url', `${apiUrl}/`, 'jobs', 'run:discovery', 'nmap'];
  const config = JSON.stringify({ targets: ['192.0.2.1'], password: 'synthetic-secret' });
  for (const auth of [[], ['--key', 'invalid-key'], ['--key', 'valid-key'],
    ['--key', 'tenantless-key'], ['--token', 'valid-jwt']]) {
    expect(await invoke([...base, ...auth, '--config', config])).toBe(1);
  }
  expect(queueManager.addJob).not.toHaveBeenCalled();
  expect(JSON.stringify(jest.mocked(logger).error.mock.calls)).not.toMatch(/valid-key|invalid-key|tenantless-key|valid-jwt|synthetic-secret/);
});

test('mounted manual SSH refuses object and string targets without queueing credentials', async () => {
  const before = queueManager.addJob.mock.calls.length;
  const payloads = [
    { targets: [{ host: '192.0.2.1', username: 'operator', password: 'synthetic-secret' }] },
    { targets: ['192.0.2.1'], host: '192.0.2.1', credentials: { password: 'synthetic-secret' } },
  ];
  const responses = [];
  for (const config of payloads) {
    responses.push(await request(apiUrl).post('/jobs/discovery/ssh')
      .set('X-Workspace-Key', 'valid-key').send({ config }));
  }
  expect(responses.map(response => response.status)).toEqual([403, 403]);
  for (const denied of responses) {
    expect(denied.body).toEqual({ success: false, error: 'Global queue operations unavailable' });
    expect(JSON.stringify(denied.body)).not.toContain('synthetic-secret');
  }
  expect(queueManager.addJob).toHaveBeenCalledTimes(before);
  const schedule = await request(apiUrl).put('/jobs/schedules/discovery/ssh')
    .set('X-Workspace-Key', 'valid-key').send({ enabled: true });
  expect(schedule.status).toBe(403);
  expect(schedule.body).toEqual({ success: false, error: 'Global queue operations unavailable' });
  await expect(scheduler.triggerDiscovery('ssh', payloads[1], 'operator', ORG))
    .rejects.toThrow('Credential-backed discovery execution is unavailable');
  expect(queueManager.addJob).toHaveBeenCalledTimes(before);
  const cli = ['--url', `${apiUrl}/`, '--key', 'valid-key', 'jobs', 'run:discovery', 'ssh'];
  expect(await invoke([...cli, '--config', JSON.stringify(payloads[1])])).toBe(1);
  expect(queueManager.addJob).toHaveBeenCalledTimes(before);
});

test('CLI cannot bypass tenant-scoped job API or print worker secrets from direct BullMQ access', async () => {
  const secret = 'synthetic-cross-org-secret';
  const job = {
    id: 'foreign', name: 'reconciliation', data: { organizationId: '22222222-2222-4222-8222-222222222222' },
    progress: { nested: secret }, returnvalue: { token: secret }, failedReason: secret, stacktrace: [secret],
    timestamp: 1, getState: async () => 'completed',
  };
  queueManager.getJob.mockResolvedValue(job);
  queueManager.getQueue.mockReturnValue({ getWaiting: async () => [job] });
  queueManager.getQueueStats.mockResolvedValue({ waiting: 2, active: 1, completed: 5, failed: 0, delayed: 0 });
  for (const args of [
      ['jobs', 'list', 'discovery-nmap'],
      ['jobs', 'status', 'discovery-nmap', 'foreign'],
      ['jobs', 'retry', 'discovery-nmap', 'foreign'],
      ['jobs', 'cancel', 'discovery-nmap', 'foreign'],
      ['jobs', 'stats'],
      ['jobs', 'run:etl', 'reconciliation'],
  ]) expect(await invoke(args)).toBe(1);
  expect(logger.error).toHaveBeenCalledWith('Queue operations require the authenticated API; global operations unavailable');
  expect(queueManager.getQueue).not.toHaveBeenCalled();
  expect(queueManager.getJob).not.toHaveBeenCalled();
  expect(queueManager.getQueueStats).not.toHaveBeenCalled();
  expect(queueManager.retryJob).not.toHaveBeenCalled();
  expect(queueManager.removeJob).not.toHaveBeenCalled();
  expect(triggerETL).not.toHaveBeenCalled();
});

test('CLI requires a platform JWT for queue reads and never prints legacy job payloads', async () => {
  const secret = 'synthetic-cross-org-secret';
  const job = {
    id: 'legacy', name: 'scan', data: { organizationId: ORG, password: secret },
    returnvalue: { nested: secret }, progress: { password: secret },
    failedReason: secret, stacktrace: [secret], timestamp: 1, attemptsMade: 0, opts: { attempts: 1 },
    getState: async () => 'completed',
  };
  queueManager.getQueue.mockReturnValue({ getWaiting: async () => [job] });
  queueManager.getJob.mockResolvedValue(job);
  const output: string[] = [];
  const base = ['--url', apiUrl, 'jobs'];
  expect(await invoke([...base, '--key', 'valid-key', 'list', 'discovery-nmap'], output)).toBe(1);
  expect(queueManager.getQueue).not.toHaveBeenCalled();
  expect(await invoke([...base, 'list', 'discovery-nmap', '--token', 'valid-jwt'], output)).toBe(0);
  expect(await invoke([...base, 'status', 'discovery-nmap', 'legacy', '--token', 'valid-jwt'], output)).toBe(0);
  expect(output.join(' ')).toContain('legacy');
  expect(output.join(' ')).not.toContain(secret);
  expect(triggerETL).not.toHaveBeenCalled();
});
