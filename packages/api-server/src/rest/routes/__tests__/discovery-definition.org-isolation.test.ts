// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { once } from 'events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import Joi from 'joi';
import request from 'supertest';
import { runMigrations } from '../../../../../database/src/postgres/migrator';
import type { PostgresClient } from '../../../../../database/src/postgres/client';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEGACY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CRED_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CRED_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (error: Error) => void }>();
host.on('message', (reply: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
  const operation = pending.get(reply.id);
  if (!operation) throw new Error('Unexpected database reply');
  pending.delete(reply.id);
  if (reply.error) operation.reject(new Error(reply.error)); else operation.resolve(reply.rows);
});
function query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<{ rows: Record<string, unknown>[]; rowCount: number }>();
  pending.set(id, { resolve: rows => resolve({ rows, rowCount: rows.length }), reject });
  host.send({ id, op: 'query', sql, params });
  return promise;
}
function exec(sql: string): Promise<void> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  pending.set(id, { resolve: () => resolve(), reject });
  host.send({ id, op: 'exec', sql });
  return promise;
}
const db = { query, pool: { query }, getClient: async () => ({ query, release: () => undefined }) };
async function migrationQuery(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  // PGlite.query prepares one statement; the real pg client accepts migration batches.
  if (!params?.length && (sql.includes('CREATE SCHEMA IF NOT EXISTS cmdb;') ||
    sql.includes('ALTER TABLE discovery_definitions ADD COLUMN organization_id'))) {
    await exec(sql);
    return { rows: [], rowCount: 0 };
  }
  return query(sql, params);
}
const migrationClient = {
  query: migrationQuery,
  transaction: async (callback: (client: { query: typeof migrationQuery }) => Promise<void>) => {
    await query('BEGIN');
    try {
      await callback({ query: migrationQuery });
      await query('COMMIT');
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  },
} as unknown as PostgresClient;
async function run024Migration(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cmdb-024-migration-'));
  try {
    copyFileSync(join(migrationDir, '024_discovery_definition_organization_scope.sql'),
      join(directory, '024_discovery_definition_organization_scope.sql'));
    await runMigrations(migrationClient, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const queue = {
  add: jest.fn().mockResolvedValue({ id: 'queued' }),
  getRepeatableJobs: jest.fn(),
};
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => db,
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery-ssh', _DISCOVERY_NMAP: 'discovery-nmap' },
  queueManager: { getQueue: () => queue, registerWorker: jest.fn(), addRepeatableJob: jest.fn() },
}));
jest.mock('@cmdb/common', () => ({
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery-ssh', _DISCOVERY_NMAP: 'discovery-nmap' },
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  safeDiscoveryScanConfig: require('../../../../../common/src/utils/discovery-scan-config').safeDiscoveryScanConfig,
  validate: (schema: Joi.Schema, value: unknown) => {
    const result = schema.validate(value);
    return { valid: !result.error, value: result.value, error: result.error?.message, details: result.error?.details };
  },
  schemas: { discoveryProvider: Joi.string().valid('ssh', 'nmap', 'snmp', 'active-directory'),
    discoveryMethod: Joi.string().valid('agentless', 'agent') },
}));
jest.mock('../../../auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({
  requirePermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req as express.Request & { user?: { _role: string } }).user?._role !== 'operator') return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}) }));
jest.mock('../../../../../discovery-engine/src/workers/nmap-discovery.worker', () => ({
  NmapDiscoveryWorker: jest.fn(),
}));
jest.mock('@cmdb/ai-discovery', () => ({
  HybridDiscoveryOrchestrator: jest.fn(), PatternStorageService: jest.fn(), getDefaultLLMConfig: jest.fn(),
}));
import { queueManager } from '@cmdb/database';
import { DiscoveryOrchestrator } from '../../../../../discovery-engine/src/orchestrator/discovery-orchestrator';
import { DiscoveryScheduler } from '../../../../../discovery-engine/src/schedulers/discovery-scheduler';
import { NmapDiscoveryWorker } from '../../../../../discovery-engine/src/workers/nmap-discovery.worker';
import { discoveryDefinitionRoutes } from '../discovery-definition.routes';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = req.get('x-test-user');
  (req as typeof req & { user: object }).user = {
    _userId: user, _role: 'operator', _organizationId: user === 'a' ? ORG_A : user === 'b' ? ORG_B : undefined,
  };
  next();
});
app.use('/api/v1/discovery/definitions', discoveryDefinitionRoutes);
const headers = (user: string) => ({ 'x-test-user': user });
const url = '/api/v1/discovery/definitions';
const migrationDir = join(__dirname, '../../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
  const ddl = schema.match(/CREATE TABLE IF NOT EXISTS discovery_definitions \([\s\S]*?\n\);/);
  if (!ddl) throw new Error('Missing discovery definitions schema');
  await exec(`CREATE TABLE credentials (id UUID PRIMARY KEY, protocol TEXT NOT NULL, organization_id UUID);
    ${ddl[0]}`);
  await run024Migration();
  await query(`INSERT INTO credentials (id, protocol, organization_id) VALUES ($1, 'ssh_password', $2), ($3, 'ssh_password', $4)`,
    [CRED_B, ORG_B, CRED_A, ORG_A]);
  await query(`INSERT INTO discovery_definitions (id, name, provider, method, created_by, organization_id)
    VALUES ($1, 'legacy', 'nmap', 'agentless', 'legacy', NULL)`, [LEGACY]);
});
afterAll(async () => {
  const exited = once(host, 'exit');
  host.kill();
  await exited;
});

test('mounted definitions isolate two users and orgs, reject legacy and credential attachment, and stamp queued jobs', async () => {
  const create = (name: string, user: string) => request(app).post(url).set(headers(user)).send({
    name, provider: 'nmap', method: 'agentless', config: {
      targets: ['192.0.2.1'], scanOptions: { serviceDetection: true, password: 'synthetic-secret' },
      credentials: { password: 'synthetic-secret' },
    }, schedule: '0 * * * *',
  });
  const own = await create(`own-${randomBytes(4).toString('hex')}`, 'a');
  const other = await create(`other-${randomBytes(4).toString('hex')}`, 'b');
  expect([own.status, other.status]).toEqual([201, 201]);
  const idA = own.body.data.id;
  const idB = other.body.data.id;
  const invalidConfig = { success: false, error: 'Bad Request', message: 'Invalid discovery scan configuration' };
  for (const config of [
    { targets: [{ host: '192.0.2.1' }] },
    { targets: ['192.0.2.1'], scanOptions: { serviceDetection: 'yes' } },
  ]) {
    const created = await request(app).post(url).set(headers('a'))
      .send({ name: 'invalid-config', provider: 'nmap', method: 'agentless', config });
    const updated = await request(app).put(`${url}/${idA}`).set(headers('a')).send({ config });
    expect([created.status, updated.status]).toEqual([400, 400]);
    expect([created.body, updated.body]).toEqual([invalidConfig, invalidConfig]);
  }
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [idA])).rows[0])
    .toMatchObject({ config: { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true } } });
  const credentialRequired = { success: false, error: 'Bad Request', message: 'Discovery provider requires credential' };
  for (const provider of ['active-directory', 'snmp']) {
    const created = await request(app).post(url).set(headers('a'))
      .send({ name: 'credentialless', provider, method: 'agentless', config: {} });
    const updated = await request(app).put(`${url}/${idA}`).set(headers('a')).send({ provider });
    expect([created.status, updated.status]).toEqual([400, 400]);
    expect([created.body, updated.body]).toEqual([credentialRequired, credentialRequired]);
  }
  expect((await query('SELECT organization_id FROM discovery_definitions WHERE id = $1', [idA])).rows).toEqual([{ organization_id: ORG_A }]);
  const listA = await request(app).get(url).set(headers('a'));
  const listB = await request(app).get(url).set(headers('b'));
  expect(listA.body.data.map((row: { id: string }) => row.id)).toEqual([idA]);
  expect(listB.body.data.map((row: { id: string }) => row.id)).toEqual([idB]);
  for (const id of [idB, LEGACY, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']) {
    const denied = await request(app).get(`${url}/${id}`).set(headers('a'));
    expect({ status: denied.status, body: denied.body }).toEqual({ status: 404, body: { success: false, error: 'Not Found', message: 'Discovery definition not found' } });
    for (const method of ['put', 'delete', 'post'] as const) {
      const route = method === 'post' ? `${url}/${id}/run` : `${url}/${id}`;
      const result = await request(app)[method](route).set(headers('a')).send({ name: 'changed' });
      expect({ status: result.status, body: result.body }).toEqual({ status: 404, body: denied.body });
    }
    for (const action of ['enable', 'disable']) {
      const schedule = await request(app).post(`${url}/${id}/schedule/${action}`).set(headers('a'));
      expect({ status: schedule.status, body: schedule.body }).toEqual({ status: 404, body: denied.body });
    }
  }
  for (const credentialId of [CRED_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']) {
    for (const operation of [
      request(app).post(url).set(headers('a')).send({ name: `credential-${credentialId}`, provider: 'ssh', method: 'agentless', credential_id: credentialId }),
      request(app).put(`${url}/${idA}`).set(headers('a')).send({ credential_id: credentialId }),
    ]) {
      const result = await operation;
      expect({ status: result.status, body: result.body }).toEqual({
        status: 404, body: { success: false, error: 'Not Found', message: 'Credential not found' },
      });
    }
  }
  const attached = await request(app).post(url).set(headers('a')).send({
    name: 'owned-ssh', provider: 'ssh', method: 'agentless', credential_id: CRED_A, schedule: '0 * * * *',
  });
  expect(attached.status).toBe(201);
  const queueBefore = queue.add.mock.calls.length;
  const unavailable = await request(app).post(`${url}/${attached.body.data.id}/run`).set(headers('a'));
  expect(unavailable.status).toBe(409);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  const unavailableSchedule = await request(app).post(`${url}/${attached.body.data.id}/schedule/enable`).set(headers('a'));
  expect(unavailableSchedule.status).toBe(409);
  expect(unavailableSchedule.body).toEqual(unavailable.body);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  await query('UPDATE credentials SET organization_id = $1 WHERE id = $2', [ORG_B, CRED_A]);
  const staleAttachment = await request(app).put(`${url}/${attached.body.data.id}`).set(headers('a'))
    .send({ credential_id: CRED_A });
  expect(staleAttachment.status).toBe(404);
  expect(staleAttachment.body).toEqual({ success: false, error: 'Not Found', message: 'Credential not found' });
  const reassigned = await request(app).post(`${url}/${attached.body.data.id}/run`).set(headers('a'));
  expect(reassigned.status).toBe(409);
  expect(reassigned.body).toEqual(unavailable.body);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  const run = await request(app).post(`${url}/${idA}/run`).set(headers('a'));
  expect(run.status).toBe(202);
  expect(queue.add).toHaveBeenCalledWith('discover', expect.objectContaining({
    organizationId: ORG_A, definition_id: idA,
    config: { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true } },
  }), expect.any(Object));
  expect(JSON.stringify(queue.add.mock.calls)).not.toContain('synthetic-secret');
  const scanNetworks = jest.fn().mockResolvedValue([]);
  const scanNetwork = jest.fn().mockResolvedValue([]);
  jest.mocked(NmapDiscoveryWorker).mockImplementation(() => ({ scanNetworks, scanNetwork }) as never);
  const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
  Object.assign(orchestrator, {
    postgresClient: db,
    updateDefinitionRunStatus: jest.fn().mockResolvedValue(undefined),
    persistCIs: jest.fn().mockResolvedValue(undefined),
  });
  orchestrator.registerWorkers();
  const worker = jest.mocked(queueManager.registerWorker).mock.calls
    .find(([name]) => name === 'discovery-nmap')?.[1] as (job: unknown) => Promise<unknown>;
  expect(worker).toBeDefined();
  for (const [option, scanType] of [
    ['serviceDetection', 'version'], ['osDetection', 'os'], ['portScan', 'port'],
  ] as const) {
    if (option !== 'serviceDetection') {
      const updated = await request(app).put(`${url}/${idA}`).set(headers('a')).send({
        config: {
          targets: ['192.0.2.1'], scanOptions: { [option]: true, password: 'synthetic-secret' },
          credentials: { password: 'synthetic-secret' },
        },
      });
      expect(updated.status).toBe(200);
      expect((await request(app).post(`${url}/${idA}/run`).set(headers('a'))).status).toBe(202);
    }
    const queued = queue.add.mock.calls.at(-1)?.[1];
    expect(queued.config.scanOptions).toEqual({ [option]: true });
    expect(JSON.stringify(queued)).not.toContain('synthetic-secret');
    await expect(worker({ data: queued, updateProgress: jest.fn() })).resolves.toEqual({ discovered: 0 });
    expect(scanNetworks).toHaveBeenLastCalledWith(queued.jobId, [{ range: '192.0.2.1', scanType }]);
  }
  const updatedRange = await request(app).put(`${url}/${idA}`).set(headers('a')).send({
    config: { range: '192.0.2.1', scanOptions: { serviceDetection: true, password: 'synthetic-secret' } },
  });
  expect(updatedRange.status).toBe(200);
  expect((await request(app).post(`${url}/${idA}/run`).set(headers('a'))).status).toBe(202);
  const queuedRange = queue.add.mock.calls.at(-1)?.[1];
  expect(queuedRange.config).toEqual({ range: '192.0.2.1', scanOptions: { serviceDetection: true } });
  expect(JSON.stringify(queuedRange)).not.toContain('synthetic-secret');
  await expect(worker({ data: queuedRange, updateProgress: jest.fn() })).resolves.toEqual({ discovered: 0 });
  expect(scanNetwork).toHaveBeenCalledWith(queuedRange.jobId, '192.0.2.1', 'version');
  const scheduledConfig = await request(app).put(`${url}/${idA}`).set(headers('a')).send({
    config: {
      targets: ['192.0.2.1'], scanOptions: { serviceDetection: true, password: 'synthetic-secret' },
      credentials: { password: 'synthetic-secret' },
    },
  });
  expect(scheduledConfig.status).toBe(200);
  queue.getRepeatableJobs.mockResolvedValue([{ name: `discovery-definition-${idA}`, key: 'repeat-key' }]);
  const scheduler = Object.create(DiscoveryScheduler.prototype) as DiscoveryScheduler;
  Object.assign(scheduler, { queueManager, definitionMappings: new Map() });
  await scheduler.scheduleDefinition(idA, ORG_A);
  const repeatable = jest.mocked(queueManager.addRepeatableJob).mock.calls.at(-1)?.[2];
  expect(repeatable).toMatchObject({
    provider: 'nmap', organizationId: ORG_A, definition_id: idA,
    config: { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true } },
  });
  expect(repeatable).not.toHaveProperty('jobId');
  expect(JSON.stringify(repeatable)).not.toContain('synthetic-secret');
  for (const jobId of ['repeat:nmap-first', 'repeat:nmap-second']) {
    await expect(worker({ id: jobId, data: repeatable, updateProgress: jest.fn() }))
      .resolves.toEqual({ discovered: 0 });
    expect(scanNetworks).toHaveBeenLastCalledWith(jobId, [{ range: '192.0.2.1', scanType: 'version' }]);
  }
  const sshDefinition = await request(app).put(`${url}/${idA}`).set(headers('a')).send({
    provider: 'ssh',
    config: { targets: ['192.0.2.1'], credentials: { password: 'synthetic-secret' } },
  });
  expect(sshDefinition.status).toBe(200);
  const sshId = idA;
  const beforeSSH = queue.add.mock.calls.length;
  const sshRun = await request(app).post(`${url}/${sshId}/run`).set(headers('a'));
  const sshEnable = await request(app).post(`${url}/${sshId}/schedule/enable`).set(headers('a'));
  expect([sshRun.status, sshEnable.status]).toEqual([409, 409]);
  expect(sshRun.body).toEqual(unavailable.body);
  expect(sshEnable.body).toEqual(unavailable.body);
  expect(queue.add).toHaveBeenCalledTimes(beforeSSH);
  expect(JSON.stringify([sshRun.body, sshEnable.body])).not.toContain('synthetic-secret');
  expect((await request(app).get(url).set(headers('none'))).status).toBe(403);
  expect((await query('SELECT name FROM discovery_definitions WHERE id = $1', [idB])).rows).toEqual([{ name: other.body.data.name }]);
});

test('poisoned org A schedule cannot block org B load or cron re-add', async () => {
  const poisonId = 'dddddddd-dddd-4ddd-8ddd-000000000001';
  await query(`INSERT INTO discovery_definitions
    (id, name, provider, method, config, schedule, is_active, created_by, organization_id, created_at)
    VALUES ($1, 'legacy-poison', 'nmap', 'agentless', $2::jsonb, '0 * * * *', true,
      'legacy', $3, '2020-01-01')`, [poisonId, JSON.stringify({ targets: [{ host: '192.0.2.1' }] }), ORG_A]);
  const credentiallessIds: string[] = [];
  for (const [index, provider] of ['active-directory', 'snmp'].entries()) {
    const id = `dddddddd-dddd-4ddd-8ddd-00000000000${index + 2}`;
    credentiallessIds.push(id);
    await query(`INSERT INTO discovery_definitions
      (id, name, provider, method, config, schedule, is_active, created_by, organization_id)
      VALUES ($1, 'legacy-unbound', $2, 'agentless', '{}'::jsonb, '0 * * * *', true, 'legacy', $3)`,
    [id, provider, ORG_A]);
    const run = await request(app).post(`${url}/${id}/run`).set(headers('a'));
    const enable = await request(app).post(`${url}/${id}/schedule/enable`).set(headers('a'));
    expect([run.status, enable.status]).toEqual([409, 409]);
    expect(run.body).toEqual({ success: false, error: 'Credential-backed discovery execution unavailable' });
    expect(enable.body).toEqual(run.body);
  }
  const healthy = await request(app).post(url).set(headers('b')).send({
    name: 'healthy-org-b', provider: 'nmap', method: 'agentless',
    config: { targets: ['198.51.100.2'] }, schedule: '0 * * * *',
  });
  expect(healthy.status).toBe(201);
  const healthyId = healthy.body.data.id;
  const scheduled = jest.mocked(queueManager.addRepeatableJob);
  scheduled.mockClear();
  queue.getRepeatableJobs.mockImplementation(async () => [
    { name: `discovery-definition-${healthyId}`, key: 'healthy-repeat-key' },
  ]);
  const removeRepeatableByKey = jest.fn().mockResolvedValue(undefined);
  Object.assign(queue, { removeRepeatableByKey });
  const scheduler = Object.create(DiscoveryScheduler.prototype) as DiscoveryScheduler;
  Object.assign(scheduler, { queueManager, definitionMappings: new Map(), useDatabaseDefinitions: true });
  const load = scheduler as unknown as { loadAndScheduleDefinitions: () => Promise<void> };
  await load.loadAndScheduleDefinitions();
  expect(scheduled).toHaveBeenCalledWith('discovery-nmap', `discovery-definition-${healthyId}`,
    expect.objectContaining({ organizationId: ORG_B, config: { targets: ['198.51.100.2'] } }),
    { pattern: '0 * * * *', immediately: false });
  expect(scheduled.mock.calls.some(([, name]) => name === `discovery-definition-${poisonId}`)).toBe(false);
  for (const id of credentiallessIds) {
    await expect(scheduler.scheduleDefinition(id, ORG_A))
      .rejects.toThrow('Credential-backed discovery execution is unavailable');
    expect(scheduled.mock.calls.some(([, name]) => name === `discovery-definition-${id}`)).toBe(false);
  }
  await query('UPDATE discovery_definitions SET schedule = $1 WHERE id = $2 AND organization_id = $3',
    ['15 * * * *', healthyId, ORG_B]);
  await scheduler.syncSchedules();
  expect(removeRepeatableByKey).toHaveBeenCalledWith('healthy-repeat-key');
  expect(scheduled).toHaveBeenLastCalledWith('discovery-nmap', `discovery-definition-${healthyId}`,
    expect.objectContaining({ organizationId: ORG_B, config: { targets: ['198.51.100.2'] } }),
    { pattern: '15 * * * *', immediately: false });
});

test('real migrator applies, rolls back and reapplies organization migration on disposable schema', async () => {
  await exec(readFileSync(join(migrationDir, 'rollback/024_discovery_definition_organization_scope.down.sql'), 'utf8'));
  const columns = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'discovery_definitions' AND column_name = 'organization_id'`);
  expect(columns.rows).toEqual([]);
  const indexes = await query(`SELECT indexname FROM pg_indexes
    WHERE tablename = 'discovery_definitions' AND indexname = 'idx_discovery_definitions_organization_id_id'`);
  expect(indexes.rows).toEqual([]);
  expect((await query(`SELECT migration_name FROM cmdb.schema_migrations
    WHERE migration_name = '024_discovery_definition_organization_scope.sql'`)).rows).toEqual([]);
  await run024Migration();
  expect((await query(`SELECT migration_name FROM cmdb.schema_migrations
    WHERE migration_name = '024_discovery_definition_organization_scope.sql'`)).rows)
    .toEqual([{ migration_name: '024_discovery_definition_organization_scope.sql' }]);
  expect((await query(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'discovery_definitions' AND column_name = 'organization_id'`)).rows)
    .toEqual([{ column_name: 'organization_id' }]);
});
