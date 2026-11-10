// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** HAP-1233: a blank optional Description (what the web form sends) is accepted and stored as NULL; an edit with a blank clears it. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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
let serial = 0;
const sql = (text: string, params: unknown[] = [], op = 'query') => new Promise<Rows>((resolve, reject) => {
  const id = ++serial;
  pending.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.rows)));
  host.send({ id, op, sql: text, params });
});
const pool = { connect: async () => ({ query: async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) }), release: () => undefined }) };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }), getAuditService: () => ({}), getOAuthSubstrate: () => ({}), SERVICENOW_PROVIDER_ID: 'servicenow',
  getUnifiedCredentialService: (pg: unknown) => new (require('../../../../../database/src/postgres/unified-credential.service').UnifiedCredentialService)(pg),
  getCredentialSetService: (pg: unknown) => new (require('../../../../../database/src/postgres/credential-set.service').CredentialSetService)(pg),
}));
jest.mock('bcrypt', () => ({}));
const A = '11111111-1111-4111-8111-111111111111';
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => (id === 'a' ? { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A } : null) })) }));
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';

const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const auth = { Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('a', 'alice', 'operator', A)}` };
const stored = async (table: 'credentials' | 'credential_sets', id: string) => (await sql(`SELECT description FROM ${table} WHERE id = $1`, [id]))[0].description;
const credential = (extra: object) => ({ name: rnd(), protocol: 'api_key', scope: 'api', credentials: { key: rnd() }, ...extra });

beforeAll(async () => {
  const baseline = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const tables = ['credentials', 'credential_sets'].map((t) => baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))![0]);
  await sql(`${tables.join('\n')}
ALTER TABLE credentials ADD COLUMN organization_id VARCHAR(255);
ALTER TABLE credential_sets ADD COLUMN organization_id VARCHAR(255);`, [], 'exec');
});
afterAll(() => host.kill());

describe('credential', () => {
  it('(a) a create with a blank or whitespace-only description succeeds and stores NULL', async () => {
    for (const description of ['', '   ']) {
      const res = await request(app).post('/api/v1/credentials').set(auth).send(credential({ description }));
      expect([res.status, await stored('credentials', res.body.data.id)]).toEqual([201, null]);
    }
    const kept = await request(app).post('/api/v1/credentials').set(auth).send(credential({ description: '  prod SSH  ' }));
    expect([kept.status, await stored('credentials', kept.body.data.id)]).toEqual([201, 'prod SSH']);
  });

  it('(b) an update with a blank description clears the stored one; omitting it keeps it', async () => {
    const id = (await request(app).post('/api/v1/credentials').set(auth).send(credential({ description: 'has text' }))).body.data.id;
    expect(await stored('credentials', id)).toBe('has text');
    const renamed = await request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ name: rnd() });
    expect([renamed.status, await stored('credentials', id)]).toEqual([200, 'has text']);
    const cleared = await request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ description: '' });
    expect([cleared.status, await stored('credentials', id)]).toEqual([200, null]);
  });

  it('(c) a 1001-character description is still refused on create and update; 1000 is accepted', async () => {
    const id = (await request(app).post('/api/v1/credentials').set(auth).send(credential({ description: 'x'.repeat(1000) }))).body.data.id;
    expect(await stored('credentials', id)).toHaveLength(1000);
    const created = await request(app).post('/api/v1/credentials').set(auth).send(credential({ description: 'x'.repeat(1001) }));
    const updated = await request(app).put(`/api/v1/credentials/${id}`).set(auth).send({ description: 'x'.repeat(1001) });
    expect([created.status, updated.status, (await stored('credentials', id) as string).length]).toEqual([400, 400, 1000]);
  });
});

describe('credential set', () => {
  let credentialId: string;
  beforeAll(async () => { credentialId = (await request(app).post('/api/v1/credentials').set(auth).send(credential({}))).body.data.id; });
  const set = (extra: object) => ({ name: rnd(), credential_ids: [credentialId], ...extra });
  it('a create with a blank description stores NULL, an update with a blank clears, and 1001 characters is refused', async () => {
    const blank = await request(app).post('/api/v1/credential-sets').set(auth).send(set({ description: '' }));
    expect([blank.status, await stored('credential_sets', blank.body.data.id)]).toEqual([201, null]);
    const id = (await request(app).post('/api/v1/credential-sets').set(auth).send(set({ description: 'has text' }))).body.data.id;
    const cleared = await request(app).put(`/api/v1/credential-sets/${id}`).set(auth).send({ description: '' });
    expect([cleared.status, await stored('credential_sets', id)]).toEqual([200, null]);
    const long = await request(app).post('/api/v1/credential-sets').set(auth).send(set({ description: 'x'.repeat(1001) }));
    expect(long.status).toBe(400);
  });
});
