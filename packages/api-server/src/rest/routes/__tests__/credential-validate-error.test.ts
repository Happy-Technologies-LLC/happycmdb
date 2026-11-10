// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** HAP-1800: POST /credentials/:id/validate never echoes decrypt or PostgreSQL driver error text; the detail stays in the server log. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';
import express from 'express';
import request from 'supertest';

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
// A recognisable PostgreSQL-style failure injected into one statement shape at a time.
const DRIVER = `relation "${rnd()}" does not exist at character 17`;
let failOn: RegExp | null = null;
const pool = {
  connect: async () => ({
    query: async (text: string, params?: unknown[]) => {
      if (failOn?.test(text)) throw Object.assign(new Error(DRIVER), { code: '42P01', severity: 'ERROR' });
      return { rows: await sql(text, params) };
    },
    release: () => undefined,
  }),
};
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }), getCredentialSetService: () => ({}), getAuditService: () => ({}), getOAuthSubstrate: () => ({}), SERVICENOW_PROVIDER_ID: 'servicenow',
  getUnifiedCredentialService: (pg: unknown) => new (require('../../../../../database/src/postgres/unified-credential.service').UnifiedCredentialService)(pg),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => (id === 'a' ? { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A } : null) })) }));
import { loadConfig, getEncryptionService, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';

const [A, GENERIC, MARK] = ['11111111-1111-4111-8111-111111111111', 'Credential validation failed', rnd()];
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const auth = { Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('a', 'alice', 'operator', A)}` };
const validate = (id: string) => request(app).post(`/api/v1/credentials/${id}/validate`).set(auth);
const insert = (id: string, stored: unknown) => sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 'stored', 'ssh_password', 'ssh', $2, 'a', $3)`, [id, JSON.stringify(stored), A]);
// Serialized log output only: the strings that reach stdout/stderr or the console, never the arguments handed to logger.error.
const capture = () => {
  jest.replaceProperty(logger, 'level', 'silly');
  const streams = [console as unknown as { _stdout?: NodeJS.WriteStream; _stderr?: NodeJS.WriteStream }].flatMap((c) => [c._stdout, c._stderr]).filter((s): s is NodeJS.WriteStream => !!s);
  const sinks = [...(['log', 'error', 'warn', 'info', 'debug'] as const).map((l) => jest.spyOn(console, l)), ...[process.stdout, process.stderr, ...streams].map((s) => jest.spyOn(s, 'write'))];
  return () => { const logged = sinks.flatMap((s) => s.mock.calls.flat()).filter((a): a is string => typeof a === 'string').join('\n'); jest.restoreAllMocks(); return logged; };
};

beforeAll(async () => {
  const baseline = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  await sql(`${baseline.match(/CREATE TABLE IF NOT EXISTS credentials \([\s\S]*?\n\);/)![0]}
ALTER TABLE credentials ADD COLUMN organization_id VARCHAR(255);`, [], 'exec');
});
afterEach(() => { failOn = null; });
afterAll(() => host.kill());

const generic = (res: request.Response) => [res.status, res.body.data.valid, res.body.data.message];

it('(a) a stored envelope that cannot decrypt returns the generic message; the id and the decrypt text stay out of the body', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const enc = (s: string) => getEncryptionService().encrypt(s) as unknown as Record<string, unknown>;
  // Still an envelope (iv, encryptedData, authTag) but the auth tag belongs to another message, so decrypt throws.
  const broken = { ...enc(JSON.stringify({ username: 'svc', password: MARK })), authTag: enc(rnd())['authTag'] };
  await insert(id, broken);
  const logs = capture();
  const res = await validate(id);
  const logged = logs();
  expect(generic(res)).toEqual([200, false, GENERIC]);
  expect(logged).toContain(`Failed to decrypt credential ${id}`);
  const body = JSON.stringify(res.body);
  expect([body.includes(id), body.toLowerCase().includes('decrypt'), body.includes(MARK)]).toEqual([false, false, false]);
  expect(logged.includes(MARK)).toBe(false);
});

it('(b) a driver failure on the validation_status UPDATE returns the generic message with no driver text', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  await insert(id, getEncryptionService().encrypt(JSON.stringify({ username: 'svc', password: MARK })));
  failOn = /^\s*UPDATE credentials/;
  const logs = capture();
  const res = await validate(id);
  const logged = logs();
  expect(generic(res)).toEqual([200, false, GENERIC]);
  const body = JSON.stringify(res.body);
  expect([body.includes(DRIVER), body.includes('42P01'), body.includes('relation'), body.includes(MARK)]).toEqual([false, false, false, false]);
  // HAP-1382: a driver error logs class and SQLSTATE only, never its message.
  expect([logged.includes('42P01'), logged.includes(DRIVER), logged.includes(MARK)]).toEqual([true, false, false]);
});

it('(c) a driver failure on the credential fetch returns the generic message with no driver text', async () => {
  const id = '44444444-4444-4444-8444-444444444444';
  await insert(id, getEncryptionService().encrypt(JSON.stringify({ username: 'svc', password: MARK })));
  failOn = /^\s*SELECT \* FROM credentials/;
  const res = await validate(id);
  expect(generic(res)).toEqual([200, false, GENERIC]);
  expect(JSON.stringify(res.body).includes(DRIVER)).toBe(false);
});

it('(d) a stored payload that makes the structure check throw returns a fixed message, not the TypeError text', async () => {
  const id = '55555555-5555-4555-8555-555555555555';
  await insert(id, getEncryptionService().encrypt('null'));
  const logs = capture();
  const res = await validate(id);
  const logged = logs();
  expect(generic(res)).toEqual([200, false, 'Validation failed']);
  // The TypeError name and a non-empty message reach the serialized log; the body carries neither.
  expect(logged).toMatch(/"error":\{"name":"TypeError","message":"[^"]+"\}/);
  expect(JSON.stringify(res.body)).not.toContain('TypeError');
});

it('(e) deliberate fixed validation messages are unchanged', async () => {
  const id = '66666666-6666-4666-8666-666666666666';
  await insert(id, getEncryptionService().encrypt(JSON.stringify({ username: 'svc', password: MARK, port: 70000 })));
  expect(generic(await validate(id))).toEqual([200, false, 'Invalid SSH port']);
});
