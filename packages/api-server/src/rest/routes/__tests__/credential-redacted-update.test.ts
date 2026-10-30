// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** HAP-1227: an update never stores the read placeholder or a non-object payload, and no validation log carries a client value. */
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
import Joi from 'joi';
import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';
import { REDACTED_PLACEHOLDER, INVALID_CREDENTIALS_UPDATE } from '../../controllers/unified-credential.controller';
import { CredentialCRUDService, DISCOVERY_CREDENTIAL_PROTOCOLS } from '../../../../../database/src/postgres/credential-services/crud.service';
import { validateRequest, validateOptional, validateMultiple } from '../../middleware/validation.middleware';

const [A, MARK] = ['11111111-1111-4111-8111-111111111111', rnd()];
const stored = { username: 'svc', password: MARK };
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const auth = { Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('a', 'alice', 'operator', A)}` };
const crud = new CredentialCRUDService(pool as unknown as Pool);
const row = async (id: string) => (await sql('SELECT row_to_json(c)::text AS r FROM credentials c WHERE id = $1', [id]))[0];
const post = (credentials: unknown) => request(app).post('/api/v1/credentials').set(auth).send({ name: rnd(), protocol: DISCOVERY_CREDENTIAL_PROTOCOLS[0], scope: 'ssh', credentials });
const put = (id: string, body: object) => request(app).put(`/api/v1/credentials/${id}`).set(auth).send(body);
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

it('(a) an update with the placeholder, a non-object or an object holding the placeholder gets a fixed 400 and writes nothing; a metadata-only update keeps the secret', async () => {
  const id = (await post(stored)).body.data.id;
  const before = await row(id);
  for (const credentials of [REDACTED_PLACEHOLDER, rnd(), [stored], null, { ...stored, password: REDACTED_PLACEHOLDER }, { username: 'svc', extra: { note: `${rnd()}${REDACTED_PLACEHOLDER}` } }]) {
    const from = seen.length;
    const res = await put(id, { name: rnd(), credentials });
    expect([res.status, res.body._message, res.body._details, seen.length - from]).toEqual([400, INVALID_CREDENTIALS_UPDATE, undefined, 0]);
  }
  expect(await row(id)).toEqual(before);
  const renamed = await put(id, { name: 'renamed' });
  expect([renamed.status, renamed.body.data.credentials]).toEqual([200, REDACTED_PLACEHOLDER]);
  const after = await crud.getById(id, 'a', A);
  expect([after?.name, after?.credentials, JSON.parse(String((await row(id)).r)).credentials]).toEqual(['renamed', stored, JSON.parse(String(before.r)).credentials]);
});

it('(b) a create and an update with a non-object payload log the refusal but never the value', async () => {
  const [PM, id] = [rnd(), (await post(stored)).body.data.id];
  const logs = capture();
  const [created, updated] = [await post(PM), await put(id, { credentials: PM })];
  const logged = logs();
  expect([created.status, updated.status, JSON.stringify([created.body, updated.body]).includes(PM)]).toEqual([400, 400, false]);
  expect([logged.includes('Request validation failed'), logged.includes(PM), logged.includes(MARK)]).toEqual([true, false, false]);
});

it('(c) no validator logs a Joi message, even one that quotes the refused value', async () => {
  // No credential-route rule quotes its value, so a pattern rule (whose message does) is mounted on each validator.
  const [PM, schema] = [`x${rnd()}`, Joi.object({ v: Joi.string().pattern(/^\d+$/) })];
  const probe = express().use(express.json()).post('/r', validateRequest(schema)).post('/o', validateOptional(schema)).post('/m', validateMultiple({ body: schema }));
  const logs = capture();
  const statuses: number[] = [];
  for (const path of ['/r', '/o', '/m']) statuses.push((await request(probe).post(path).send({ v: PM })).status);
  const logged = logs();
  expect([statuses, logged.includes('Request validation failed'), logged.includes(PM)]).toEqual([[400, 400, 400], true, false]);
});
