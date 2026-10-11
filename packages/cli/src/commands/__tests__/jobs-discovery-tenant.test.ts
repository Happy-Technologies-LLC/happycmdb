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
const queueManager = {
  addJob: jest.fn().mockResolvedValue({ id: 'owned-job' }),
  getQueue: jest.fn(),
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
jest.mock('@cmdb/etl-processor', () => ({ getETLScheduler: () => ({}) }));
jest.mock('../../../../api-server/src/auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({
  requirePermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as express.Request & { user?: { _role: string } }).user?._role) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}) }));

async function invoke(args: string[]): Promise<number> {
  const exits: number[] = [];
  const exit = jest.spyOn(process, 'exit').mockImplementation((code?: number) => { exits.push(code ?? 0); return undefined as never; });
  const output = jest.spyOn(console, 'log').mockImplementation(() => undefined);
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
    if (key !== 'valid-key' && key !== 'tenantless-key' && token !== 'Bearer valid-jwt') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as typeof req & { user: object }).user = {
      _userId: 'operator', _role: 'operator',
      _organizationId: key === 'tenantless-key' ? undefined : ORG,
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


test('CLI uses authenticated API identity for nmap jobs and refuses absent, invalid and tenantless credentials', async () => {
  const base = ['--url', `${apiUrl}/`, 'jobs', 'run:discovery', 'nmap'];
  const config = JSON.stringify({
    targets: ['192.0.2.1'],
    scanOptions: { serviceDetection: true, password: 'synthetic-secret' },
    password: 'synthetic-secret',
  });
  expect(await invoke([...base, '--config', config])).toBe(1);
  expect(queueManager.addJob).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('Discovery API authentication required (--key or --token)');

  expect(await invoke(['--key', 'invalid-key', ...base])).toBe(1);
  expect(await invoke(['--key', 'tenantless-key', ...base])).toBe(1);
  expect(queueManager.addJob).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('Discovery API authorization failed');

  expect(await invoke(['--key', 'valid-key', ...base, '--config', config])).toBe(0);
  expect(queueManager.addJob).toHaveBeenCalledWith('discovery-nmap', 'discovery-nmap-manual',
    expect.objectContaining({
      organizationId: ORG, _config: { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true } },
    }), expect.any(Object));
  expect(JSON.stringify(queueManager.addJob.mock.calls)).not.toContain('synthetic-secret');
  expect(await invoke([...base, '--token', 'valid-jwt', '--config', config])).toBe(0);
  expect(queueManager.addJob).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(jest.mocked(logger).error.mock.calls)).not.toMatch(/valid-key|invalid-key|tenantless-key|valid-jwt|synthetic-secret/);
  expect(JSON.stringify(jest.mocked(logger).info.mock.calls)).not.toMatch(/valid-key|valid-jwt|synthetic-secret/);
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
  expect(responses.map(response => response.status)).toEqual([409, 409]);
  for (const denied of responses) {
    expect(denied.body).toEqual({ success: false, error: 'Credential-backed discovery execution unavailable' });
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
