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
const CRED_OWNED = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const CRED_SNMP = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const CRED_NULL_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
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
  strictDiscoveryDefinitionConfig: require('../../../../../common/src/utils/discovery-scan-config').strictDiscoveryDefinitionConfig,
  publicDiscoveryDefinitionConfig: require('../../../../../common/src/utils/discovery-scan-config').publicDiscoveryDefinitionConfig,
  hasUnsafeDiscoveryDefinitionConfig: require('../../../../../common/src/utils/discovery-scan-config').hasUnsafeDiscoveryDefinitionConfig,
  validate: (schema: Joi.Schema, value: unknown) => {
    const result = schema.validate(value);
    return { valid: !result.error, value: result.value, error: result.error?.message, details: result.error?.details };
  },
  schemas: { discoveryProvider: Joi.string().valid('ssh', 'nmap', 'snmp', 'active-directory'),
    discoveryMethod: Joi.string().valid('agentless', 'agent') },
}));
jest.mock('../../../auth/auth-bootstrap', () => ({ getAuthMiddleware: () => ({
  requirePermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = (req as express.Request & { user?: { _role: string } }).user?._role;
    if (role !== 'operator' && role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  },
  requireRole: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req as express.Request & { user?: { _role: string } }).user?._role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  },
  requirePlatformAdmin: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req as express.Request & { user?: { _role: string } }).user?._role !== 'admin') {
      res.status(403).json({ success: false, error: 'Global queue operations unavailable' });
      return;
    }
    next();
  },
}) }));
import { queueManager } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { DiscoveryScheduler } from '../../../../../discovery-engine/src/schedulers/discovery-scheduler';
import { discoveryDefinitionRoutes } from '../discovery-definition.routes';
import { DiscoveryDefinitionService } from '../../../services/discovery-definition.service';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = req.get('x-test-user');
  (req as typeof req & { user: object }).user = {
    _userId: user, _role: user === 'viewer' ? 'viewer' : user.startsWith('admin-') ? 'admin' : 'operator',
    _organizationId: user === 'a' || user === 'viewer' || user === 'admin-a' ? ORG_A :
      user === 'b' || user === 'admin-b' ? ORG_B : undefined,
  };
  next();
});
app.use('/api/v1/discovery/definitions', discoveryDefinitionRoutes);
const headers = (user: string) => ({ 'x-test-user': user });
const url = '/api/v1/discovery/definitions';
const inventoryUrl = `${url}/migration/inventory`;
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
  await exec(`ALTER TABLE credentials ADD COLUMN created_by TEXT;
    UPDATE credentials SET created_by = CASE id WHEN '${CRED_A}' THEN 'a' ELSE 'b' END`);
  await query(`INSERT INTO credentials (id, protocol, organization_id, created_by) VALUES ($1, 'ssh_password', $2, 'a'),
    ($3, 'snmp_v2c', $2, 'a'), ($4, 'ssh_password', NULL, 'a')`, [CRED_OWNED, ORG_A, CRED_SNMP, CRED_NULL_ORG]);
  await query(`INSERT INTO discovery_definitions (id, name, provider, method, created_by, organization_id)
    VALUES ($1, 'legacy', 'nmap', 'agentless', 'legacy', NULL)`, [LEGACY]);
});
afterAll(async () => {
  const exited = once(host, 'exit');
  host.kill();
  await exited;
});

test('mounted definitions isolate two organizations, redact credentials and refuse execution', async () => {
  const create = (name: string, user: string) => request(app).post(url).set(headers(user)).send({
    name, provider: 'nmap', method: 'agentless', config: {
      targets: ['192.0.2.1'], scanOptions: { serviceDetection: true },
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
    for (const method of ['put', 'delete'] as const) {
      const result = await request(app)[method](`${url}/${id}`).set(headers('a')).send({ name: 'changed' });
      expect({ status: result.status, body: result.body }).toEqual({ status: 404, body: denied.body });
    }
  }
  for (const credentialId of [CRED_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']) {
    for (const operation of [
      request(app).post(url).set(headers('a')).send({ name: `credential-${credentialId}`, provider: 'ssh', method: 'agentless', credential_id: credentialId }),
      request(app).put(`${url}/${idA}`).set(headers('a')).send({ provider: 'ssh', credential_id: credentialId }),
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
  expect(unavailable.status).toBe(503);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  const unavailableSchedule = await request(app).post(`${url}/${attached.body.data.id}/schedule/enable`).set(headers('admin-a'));
  expect(unavailableSchedule.status).toBe(503);
  expect(unavailableSchedule.body).toEqual(unavailable.body);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  await query('UPDATE credentials SET organization_id = $1 WHERE id = $2', [ORG_B, CRED_A]);
  const staleAttachment = await request(app).put(`${url}/${attached.body.data.id}`).set(headers('a'))
    .send({ credential_id: CRED_A });
  expect(staleAttachment.status).toBe(404);
  expect(staleAttachment.body).toEqual({ success: false, error: 'Not Found', message: 'Credential not found' });
  const reassigned = await request(app).post(`${url}/${attached.body.data.id}/run`).set(headers('a'));
  expect(reassigned.status).toBe(503);
  expect(reassigned.body).toEqual(unavailable.body);
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  for (const [user, id] of [['a', idA], ['b', idB], ['a', idB], ['a', LEGACY]] as const) {
    const run = await request(app).post(`${url}/${id}/run`).set(headers(user));
    const schedule = await request(app).post(`${url}/${id}/schedule/enable`).set(headers('admin-a'));
    expect([run.status, schedule.status]).toEqual([503, 503]);
    expect(run.body).toEqual(unavailable.body);
    expect(schedule.body).toEqual(unavailable.body);
  }
  expect(queue.add).toHaveBeenCalledTimes(queueBefore);
  expect((await request(app).get(url).set(headers('none'))).status).toBe(403);
  expect((await query('SELECT name FROM discovery_definitions WHERE id = $1', [idB])).rows).toEqual([{ name: other.body.data.name }]);
});

test('inline credentials and unknown settings never cross the writer-to-viewer boundary', async () => {
  const secret = 'synthetic-inline-credential';
  const payload = {
    name: `sensitive-${randomBytes(4).toString('hex')}`, provider: 'nmap', method: 'agentless',
    config: { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true, password: secret },
      credentials: { password: secret }, unexpected: { token: secret } },
  };
  const created = await request(app).post(url).set(headers('a')).send(payload);
  expect(created.status).toBe(400);
  expect(JSON.stringify(created.body)).not.toContain(secret);
  const allowed = await request(app).post(url).set(headers('a')).send({
    ...payload, config: { targets: ['10.0.0.0/24'],
      scanOptions: { serviceDetection: true, osDetection: false } },
  });
  expect(allowed.status).toBe(201);
  const id = allowed.body.data.id;
  const permittedDetail = await request(app).get(`${url}/${id}`).set(headers('viewer'));
  expect(permittedDetail.body.data.config)
    .toEqual({ targets: ['10.0.0.0/24'], scanOptions: { serviceDetection: true, osDetection: false } });
  expect((await request(app).put(`${url}/${id}`).set(headers('a')).send({ config: payload.config })).status).toBe(400);
  expect((await request(app).put(`${url}/${id}`).set(headers('viewer')).send({ config: payload.config })).status).toBe(403);
  const alias = { _targets: [secret] };
  await query('UPDATE discovery_definitions SET config = $1 WHERE id = $2', [JSON.stringify(alias), id]);
  const aliasDetail = await request(app).get(`${url}/${id}`).set(headers('viewer'));
  const aliasList = await request(app).get(url).set(headers('viewer'));
  expect(aliasDetail.body.data.config).toEqual({});
  expect(aliasList.body.data.find((row: { id: string }) => row.id === id).config).toEqual({});
  expect(JSON.stringify([aliasDetail.body, aliasList.body])).not.toContain(secret);
  expect((await request(app).get(`${url}/${id}`).set(headers('b'))).status).toBe(404);
  expect((await request(app).post(`${url}/${id}/run`).set(headers('a'))).status).toBe(503);
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [id])).rows[0].config).toEqual(alias);
  const legacy = { targets: ['192.0.2.1'], scanOptions: { serviceDetection: true, password: secret },
    credentials: { password: secret }, unexpected: { token: secret } };
  await query('UPDATE discovery_definitions SET config = $1 WHERE id = $2', [JSON.stringify(legacy), id]);
  const replacement = await request(app).put(`${url}/${id}`).set(headers('a'))
    .send({ config: { range: '192.0.2.1' } });
  expect(replacement.status).toBe(409);
  for (const updates of [
    { name: 'silently-renamed' }, { credential_id: CRED_A }, { schedule: '0 * * * *' },
    { is_active: true }, { is_active: false }, { provider: 'ssh' },
  ]) {
    const changed = await request(app).put(`${url}/${id}`).set(headers('a')).send(updates);
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual(replacement.body);
  }
  const foreignMutation = await request(app).put(`${url}/${id}`).set(headers('b')).send({ name: 'foreign' });
  expect(foreignMutation.status).toBe(404);
  const deleted = await request(app).delete(`${url}/${id}`).set(headers('a'));
  expect(deleted.status).toBe(409);
  expect(deleted.body).toEqual(replacement.body);
  const disabled = await request(app).post(`${url}/${id}/schedule/disable`).set(headers('admin-a'));
  expect(disabled.status).toBe(503);
  expect(disabled.body).toEqual({
    success: false, error: 'Service Unavailable',
    message: 'Discovery execution is disabled until the journaled cutover',
  });
  const detail = await request(app).get(`${url}/${id}`).set(headers('viewer'));
  const listed = await request(app).get(url).set(headers('viewer'));
  expect(detail.body.data.config).toEqual({});
  expect(listed.body.data.find((row: { id: string }) => row.id === id).config).toEqual(detail.body.data.config);
  expect(JSON.stringify([detail.body, listed.body])).not.toContain(secret);
  expect((await request(app).get(`${url}/${id}`).set(headers('b'))).status).toBe(404);
  expect((await request(app).post(`${url}/${id}/run`).set(headers('a'))).status).toBe(503);
  expect((await request(app).post(`${url}/${id}/schedule/enable`).set(headers('admin-a'))).status).toBe(503);
  const scheduler = Object.create(DiscoveryScheduler.prototype) as DiscoveryScheduler;
  Object.assign(scheduler, { queueManager, definitionMappings: new Map() });
  await expect(scheduler.scheduleDefinition(id, ORG_A))
    .rejects.toThrow('Unsafe legacy discovery configuration requires migration');
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [id])).rows[0].config).toEqual(legacy);
  await query('UPDATE discovery_definitions SET config = $1 WHERE id = $2',
    [JSON.stringify({ targets: [{ password: secret }], credentials: legacy.credentials }), id]);
  const malformedDetail = await request(app).get(`${url}/${id}`).set(headers('viewer'));
  expect(malformedDetail.body.data.config).toEqual({});
  expect(JSON.stringify([
    jest.mocked(logger.info).mock.calls, jest.mocked(logger.warn).mock.calls,
    jest.mocked(logger.error).mock.calls,
  ])).not.toContain(secret);
});

test('admin inventory lists only tenant-owned quarantined IDs without stored config', async () => {
  const unsafeId = 'dddddddd-dddd-4ddd-8ddd-000000000099';
  const safeId = 'dddddddd-dddd-4ddd-8ddd-000000000098';
  const foreignId = 'dddddddd-dddd-4ddd-8ddd-000000000097';
  const secret = 'synthetic-inventory-secret';
  await query(`INSERT INTO discovery_definitions (id, name, provider, method, config, created_by, organization_id)
    VALUES ($1, 'unsafe', 'nmap', 'agentless', $2::jsonb, 'a', $3),
      ($4, 'safe', 'nmap', 'agentless', '{"targets":["192.0.2.1"]}', 'a', $3),
      ($5, 'foreign', 'nmap', 'agentless', $2::jsonb, 'b', $6)`,
    [unsafeId, JSON.stringify({ credentials: { password: secret } }), ORG_A, safeId, foreignId, ORG_B]);
  const own = await request(app).get(inventoryUrl).set(headers('admin-a'));
  expect(own.status).toBe(200);
  expect(own.body.success).toBe(true);
  expect(own.body.data).toContain(unsafeId);
  expect(own.body.data).not.toContain(safeId);
  expect(own.body.data).not.toContain(foreignId);
  expect(JSON.stringify(own.body)).not.toContain(secret);
  const foreign = await request(app).get(inventoryUrl).set(headers('admin-b'));
  expect(foreign.body).toEqual({ success: true, data: [foreignId], count: 1 });
  for (const user of ['a', 'viewer', 'none']) {
    expect((await request(app).get(inventoryUrl).set(headers(user))).status).toBe(403);
  }
  expect((await request(app).delete(`${url}/${safeId}`).set(headers('a'))).status).toBe(204);
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [unsafeId])).rows[0].config)
    .toEqual({ credentials: { password: secret } });
});

test('credential-shaped targets are refused on write and quarantined on read and run', async () => {
  const target = 'root:pw@10.0.0.5';
  const control = { targets: ['example.com', '10.0.0.5', '2001:db8::1'], scanOptions: { serviceDetection: true } };
  const created = await request(app).post(url).set(headers('a'))
    .send({ name: `grammar-${randomBytes(4).toString('hex')}`, provider: 'nmap', method: 'agentless', config: control });
  expect(created.status).toBe(201);
  const controlId = created.body.data.id;
  const invalidConfig = { success: false, error: 'Bad Request', message: 'Invalid discovery scan configuration' };
  const refused = [
    await request(app).post(url).set(headers('a'))
      .send({ name: 'credential-target', provider: 'nmap', method: 'agentless', config: { targets: [target] } }),
    await request(app).put(`${url}/${controlId}`).set(headers('a')).send({ config: { targets: [target] } }),
  ];
  for (const result of refused) {
    expect({ status: result.status, body: result.body }).toEqual({ status: 400, body: invalidConfig });
    expect(JSON.stringify(result.body)).not.toMatch(/pw|10\.0\.0\.5/);
  }
  expect((await request(app).get(`${url}/${controlId}`).set(headers('viewer'))).body.data.config).toEqual(control);
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [controlId])).rows[0].config).toEqual(control);
  const legacyId = 'dddddddd-dddd-4ddd-8ddd-000000000768';
  await query(`INSERT INTO discovery_definitions (id, name, provider, method, config, created_by, organization_id)
    VALUES ($1, 'credential-target', 'nmap', 'agentless', $2::jsonb, 'a', $3)`,
  [legacyId, JSON.stringify({ targets: [target] }), ORG_A]);
  const detail = await request(app).get(`${url}/${legacyId}`).set(headers('viewer'));
  const listed = await request(app).get(url).set(headers('viewer'));
  expect(detail.body.data.config).toEqual({});
  expect(listed.body.data.find((row: { id: string }) => row.id === legacyId).config).toEqual({});
  expect(JSON.stringify([detail.body, listed.body])).not.toContain('pw');
  expect((await request(app).post(`${url}/${legacyId}/run`).set(headers('a'))).status).toBe(503);
  const scheduler = Object.create(DiscoveryScheduler.prototype) as DiscoveryScheduler;
  Object.assign(scheduler, { queueManager, definitionMappings: new Map() });
  await expect(scheduler.scheduleDefinition(legacyId, ORG_A))
    .rejects.toThrow('Unsafe legacy discovery configuration requires migration');
  const inventory = await request(app).get(inventoryUrl).set(headers('admin-a'));
  expect(inventory.body.data).toContain(legacyId);
  expect(inventory.body.data).not.toContain(controlId);
  expect(JSON.stringify(inventory.body)).not.toContain('pw');
  expect((await query('SELECT config FROM discovery_definitions WHERE id = $1', [legacyId])).rows[0].config)
    .toEqual({ targets: [target] });
});

const sshDefinition = (user: string, credential_id: string, config?: object) => request(app).post(url).set(headers(user))
  .send({ name: `ssh-${randomBytes(4).toString('hex')}`, provider: 'ssh', method: 'agentless', credential_id, config });
const definitionRows = async () => (await query('SELECT id, provider, credential_id, config FROM discovery_definitions ORDER BY id')).rows;

test('HAP-774 C-3: a non-owner, wrong-protocol or NULL-org credential gets the identical 404 and changes nothing', async () => {
  expect((await sshDefinition('a', CRED_OWNED)).status).toBe(201);
  const nmap = await request(app).post(url).set(headers('admin-a'))
    .send({ name: 'non-owner-nmap', provider: 'nmap', method: 'agentless', config: { targets: ['192.0.2.1'] } });
  const before = await definitionRows();
  for (const [user, credentialId] of [['admin-a', CRED_OWNED], ['a', CRED_SNMP], ['a', CRED_NULL_ORG]]) {
    const created = await sshDefinition(user, credentialId);
    const updated = await request(app).put(`${url}/${nmap.body.data.id}`).set(headers(user))
      .send({ provider: 'ssh', credential_id: credentialId });
    expect([created, updated].map(({ status, body }) => ({ status, body }))).toEqual(Array(2).fill({
      status: 404, body: { success: false, error: 'Not Found', message: 'Credential not found' } }));
  }
  expect(await definitionRows()).toEqual(before);
});

test('HAP-774 C-3 (D3 actor): a same-org non-owner re-attaching the owner credential on update gets the identical 404', async () => {
  const owned = await sshDefinition('a', CRED_OWNED, { targets: ['192.0.2.1'] });
  const before = await definitionRows();
  const retarget = { credential_id: CRED_OWNED, config: { targets: ['198.51.100.7'] } };
  const refused = await request(app).put(`${url}/${owned.body.data.id}`).set(headers('admin-a')).send(retarget);
  expect({ status: refused.status, body: refused.body }).toEqual({
    status: 404, body: { success: false, error: 'Not Found', message: 'Credential not found' } });
  expect(await definitionRows()).toEqual(before);
  expect((await request(app).put(`${url}/${owned.body.data.id}`).set(headers('a')).send(retarget)).status).toBe(200);
});

test('HAP-774 C-2: the service itself refuses an ssh definition without a credential', async () => {
  await expect(new DiscoveryDefinitionService().createDefinition(
    { name: 'direct-ssh', provider: 'ssh', method: 'agentless' } as never, 'a', ORG_A))
    .rejects.toThrow('Discovery provider requires credential');
});

test('HAP-774 C-4: ssh targets are hostnames or IP literals only, never a CIDR or range', async () => {
  const owned = await sshDefinition('a', CRED_OWNED, { targets: ['host.example.com', '192.0.2.1'] });
  expect(owned.status).toBe(201);
  const before = await definitionRows();
  for (const config of [{ targets: ['192.0.2.0/24'] }, { range: '192.0.2.1' }]) {
    const created = await sshDefinition('a', CRED_OWNED, config);
    const updated = await request(app).put(`${url}/${owned.body.data.id}`).set(headers('a')).send({ config });
    expect([created, updated].map(({ status, body }) => ({ status, body }))).toEqual(Array(2).fill({
      status: 400, body: { success: false, error: 'Bad Request', message: 'Invalid discovery scan configuration' } }));
  }
  expect(await definitionRows()).toEqual(before);
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
