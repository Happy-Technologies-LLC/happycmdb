// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** HAP-444 K1: one SSH port rule (JSON integer 1-65535, absent = 22) at the routes, CRUD, /validate and toSSHConfig. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// Every value is random at runtime, so no source line reads as a secret assignment.
const rnd = () => randomBytes(16).toString('hex');
Object.assign(process.env, { JWT_SECRET: rnd() + rnd(), CREDENTIAL_ENCRYPTION_KEY: rnd() + rnd(), NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: rnd(), NEO4J_PASSWORD: rnd(),
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: rnd(), POSTGRES_USER: rnd(), POSTGRES_PASSWORD: rnd(), REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: rnd(), KAFKA_GROUP_ID: rnd() });
type Rows = Record<string, unknown>[];
const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
const pending = new Map<number, (m: { rows: Rows; error?: string }) => void>();
host.on('message', (m: { id: number; rows: Rows; error?: string }) => pending.get(m.id)!(m));
const seen: string[] = [];
const sql = (text: string, params: unknown[] = [], op = 'query') => new Promise<Rows>((resolve, reject) => {
  pending.set(seen.push(text), (m) => (m.error ? reject(new Error(m.error)) : resolve(m.rows)));
  host.send({ id: seen.length, op, sql: text, params });
});
const pool = { connect: async () => ({ query: async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) }), release: () => undefined }) };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }), getCredentialSetService: () => ({}), getAuditService: () => ({}), getOAuthSubstrate: () => ({}), SERVICENOW_PROVIDER_ID: 'servicenow',
  getUnifiedCredentialService: (pg: unknown) => new (require('../../../../../database/src/postgres/unified-credential.service').UnifiedCredentialService)(pg),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => (id === 'a' ? { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A } : null) })) }));
import { loadConfig, CredentialProtocolAdapter, getEncryptionService, logger, type UnifiedCredential } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';
import { CredentialCRUDService, DISCOVERY_CREDENTIAL_PROTOCOLS } from '../../../../../database/src/postgres/credential-services/crud.service';

const [A, FIXED, MARK] = ['11111111-1111-4111-8111-111111111111', 'Invalid SSH port', rnd()];
const ssh = (port?: unknown) => ({ username: 'svc', password: MARK, ...(port === undefined ? {} : { port }) });
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const auth = { Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('a', 'alice', 'operator', A)}` };
const crud = new CredentialCRUDService(pool as unknown as Pool);
const row = async (id: string) => (await sql('SELECT credentials::text AS c, validation_status, last_validated_at FROM credentials WHERE id = $1', [id]))[0];
const post = (credentials: object, protocol: string = DISCOVERY_CREDENTIAL_PROTOCOLS[0]) => request(app).post('/api/v1/credentials').set(auth).send({ name: rnd(), protocol, scope: 'ssh', credentials });
const capture = () => {
  jest.replaceProperty(logger, 'level', 'silly');
  const sinks = [...(['error', 'warn', 'info', 'debug'] as const).flatMap((l) => [jest.spyOn(logger, l), jest.spyOn(console, l)]), ...logger.transports.map((t) => jest.spyOn(t as unknown as { log: () => void }, 'log')), jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write')];
  return () => { const logged = inspect(sinks.map((s) => s.mock.calls), { depth: null, maxArrayLength: null, maxStringLength: null }); jest.restoreAllMocks(); return logged; };
};

beforeAll(async () => {
  const baseline = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  await sql(`${baseline.match(/CREATE TABLE IF NOT EXISTS credentials \([\s\S]*?\n\);/)![0]}
ALTER TABLE credentials ADD COLUMN organization_id VARCHAR(255);`, [], 'exec');
});
afterAll(() => host.kill());

it('(a) POST refuses a non-integer or out-of-range SSH port with a fixed 400, inserts nothing and logs no refused value', async () => {
  const PM = rnd();
  const logs = capture();
  for (const port of [70000, 0, '22', 22.5, null, PM]) {
    const res = await post(ssh(port));
    expect([res.status, JSON.stringify(res.body).includes(FIXED), JSON.stringify(res.body).includes(MARK)]).toEqual([400, true, false]);
  }
  const logged = logs();
  expect([await sql('SELECT id FROM credentials'), logged.includes('Request validation failed'), logged.includes(PM), logged.includes(MARK)]).toEqual([[], true, false, false]);
  expect((await post(ssh(65535))).status).toBe(201);
});

it('(b) direct CRUD create/update refuse port -1 with a fixed throw, leave the row unchanged and no transaction open', async () => {
  await expect(crud.create({ name: 'direct', protocol: 'ssh_key', scope: 'ssh', credentials: ssh(-1) }, 'a', A)).rejects.toThrow(new Error(FIXED));
  const { id } = await crud.create({ name: 'kept', protocol: 'ssh_password', scope: 'ssh', credentials: ssh(22) }, 'a', A);
  const [before, from] = [await row(id), seen.length];
  await expect(crud.update(id, { name: 'renamed', credentials: ssh(-1) }, 'a', A)).rejects.toThrow(new Error(FIXED));
  expect(seen.slice(from).some((q) => /^SELECT protocol FROM credentials WHERE id = \$1 .*FOR UPDATE$/s.test(q))).toBe(true);
  expect([await row(id), (await crud.getById(id, 'a', A))?.name, (await sql('SELECT txid_current_if_assigned() AS xid'))[0].xid, await sql(`SELECT id FROM credentials WHERE name = 'direct'`)]).toEqual([before, 'kept', null, []]);
});

it('(c) toSSHConfig refuses an invalid port, defaults an absent one to 22 and keeps 65535', () => {
  const cfg = (port?: unknown) => CredentialProtocolAdapter.toSSHConfig({ protocol: 'ssh_password', credentials: ssh(port) } as unknown as UnifiedCredential, '192.0.2.1');
  for (const bad of [0, 65536, '22', null]) expect(() => cfg(bad)).toThrow(new Error(FIXED));
  expect([cfg().port, cfg(65535).port]).toEqual([22, 65535]);
});

it('(d) /validate marks a stored out-of-range port invalid', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 'stored', 'ssh_password', 'ssh', $2, 'a', $3)`, [id, JSON.stringify(getEncryptionService().encrypt(JSON.stringify(ssh(70000)))), A]);
  const res = await request(app).post(`/api/v1/credentials/${id}/validate`).set(auth);
  expect([res.status, res.body.data.valid, res.body.data.message, (await row(id)).validation_status]).toEqual([200, false, FIXED, 'invalid']);
});

it('(e) an update with a new payload resets validation_status; the update route applies the same rule', async () => {
  const id = (await post(ssh())).body.data.id;
  expect([(await request(app).post(`/api/v1/credentials/${id}/validate`).set(auth)).body.data.valid, (await row(id)).validation_status]).toEqual([true, 'valid']);
  const put = (credentials: object) => request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ credentials });
  expect([(await put(ssh('22'))).status, (await put(ssh(2222))).status]).toEqual([400, 200]);
  expect(await row(id)).toMatchObject({ validation_status: null, last_validated_at: null });
  expect((await crud.getById(id, 'a', A))?.credentials).toEqual(ssh(2222));
});

it('(f) a WinRM update keeps its port as given, as before #156: no SSH port rule applies to a non-SSH protocol', async () => {
  const winrm = CredentialProtocolAdapter.getSupportedProtocols().find((p) => /^winrm$/.test(p))!;
  const id = (await post(ssh(5985), winrm)).body.data.id;
  for (const port of [5985, String(5985)]) {
    const res = await request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ credentials: ssh(port) });
    expect([res.status, (await crud.getById(id, 'a', A))?.credentials]).toEqual([200, ssh(port)]);
  }
});

it('(g) an SSH update with a string or out-of-range port gets the fixed 400, leaves the row unchanged and logs no value', async () => {
  const [PM, id] = [rnd(), (await post(ssh(22), DISCOVERY_CREDENTIAL_PROTOCOLS[1])).body.data.id];
  const [before, logs] = [await row(id), capture()];
  for (const port of [String(22), 70000, PM]) {
    const res = await request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ name: rnd(), credentials: ssh(port) });
    expect([res.status, res.body._message, JSON.stringify(res.body).includes(MARK)]).toEqual([400, FIXED, false]);
  }
  const logged = logs();
  expect([await row(id), logged.includes(PM), logged.includes(MARK)]).toEqual([before, false, false]);
});
