// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** LH-4: real routes/controllers/SQL on embedded PostgreSQL; identities are test-only. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (err: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: Record<string, unknown>[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error) p.reject(Object.assign(new Error(error), { code }));
  else p.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query'): Promise<Record<string, unknown>[]> {
  const id = serial++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql: text, params });
  });
}
const pool = { connect: async () => ({ query: async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) }), release: () => undefined }) };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool }),
  getUnifiedCredentialService: (pg: unknown) => new (require('../../../../../database/src/postgres/unified-credential.service').UnifiedCredentialService)(pg),
  getCredentialSetService: (pg: unknown) => new (require('../../../../../database/src/postgres/credential-set.service').CredentialSetService)(pg),
  getAuditService: () => ({}),
  getOAuthSubstrate: () => ({}),
  SERVICENOW_PROVIDER_ID: 'servicenow',
}));
jest.mock('bcrypt', () => ({}));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const identities: Record<string, { _id: string; _username: string; _role: 'operator' | 'admin' | 'viewer' | 'agent'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A },
  b: { _id: 'b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: B },
  c: { _id: 'c', _username: 'carol', _role: 'operator', _enabled: true, _organizationId: B },
  none: { _id: 'none', _username: 'nora', _role: 'admin', _enabled: true },
  viewer: { _id: 'viewer', _username: 'vicky', _role: 'viewer', _enabled: true, _organizationId: A },
  agent: { _id: 'agent', _username: 'worker', _role: 'agent', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => identities[id] ?? null })),
}));
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';
import { UnifiedCredentialService } from '../../../../../database/src/postgres/unified-credential.service';
const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1', unifiedCredentialRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const as = (id: string) => ({ Authorization: `Bearer ${jwt.generateAccessToken(id, identities[id]._username, identities[id]._role, identities[id]._organizationId)}` });
const credential = (name: string) => ({ name, protocol: 'api_key', scope: 'api', credentials: { key: `only-${name}` } });
const missing = '99999999-9999-4999-8999-999999999999';
const legacyId = '88888888-8888-4888-8888-888888888888';
let bId: string;
let aId: string;

beforeAll(async () => {
  const baseline = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['credentials', 'credential_sets'].map(table => {
    const block = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    if (!block) throw new Error(`Missing ${table} DDL`);
    return block[0];
  });
  await sql(`${tables.join('\n')}
CREATE UNIQUE INDEX idx_credentials_unique_name ON credentials(name, created_by);
CREATE UNIQUE INDEX idx_credential_sets_unique_name ON credential_sets(name, created_by);
CREATE TABLE discovery_definitions (credential_id UUID, credential_set_id UUID);
CREATE TABLE connector_configurations (credential_id UUID);`, [], 'exec');
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by)
    VALUES ($1, 'legacy', 'api_key', 'api', '{"key":"legacy-secret"}', 'a')`, [legacyId]);
  await sql(readFileSync(join(migrations, '021_credential_organization_scope.sql'), 'utf8'), [], 'exec');
  const b = await request(app).post('/api/v1/credentials').set(as('b')).send(credential('B-private'));
  expect(b.status).toBe(201);
  bId = b.body.data.id;
  const a = await request(app).post('/api/v1/credentials').set(as('a')).send(credential('A-private'));
  expect(a.status).toBe(201);
  aId = a.body.data.id;
});
afterAll(() => host.kill());

it('org A and same-org nonowner cannot enumerate or read B; B owner reads redacted', async () => {
  for (const principal of ['a', 'c']) {
    const list = await request(app).get('/api/v1/credentials').set(as(principal));
    expect(list.status).toBe(200);
    expect(list.body.data.map((item: { id: string }) => item.id)).not.toContain(bId);
    const foreign = await request(app).get(`/api/v1/credentials/${bId}`).set(as(principal));
    const absent = await request(app).get(`/api/v1/credentials/${missing}`).set(as(principal));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(absent.body);
  }
  const owned = await request(app).get(`/api/v1/credentials/${bId}`).set(as('b'));
  expect(owned.status).toBe(200);
  expect(owned.body.data.credentials).toBe('***REDACTED***');
  expect(JSON.stringify(owned.body)).not.toContain('only-B-private');
  expect((await request(app).get('/api/v1/credentials').set(as('a'))).body.data.map((row: { id: string }) => row.id)).toEqual([aId]);
  const legacy = await request(app).get(`/api/v1/credentials/${legacyId}`).set(as('a'));
  expect(legacy.status).toBe(404);
  expect(legacy.body).toEqual((await request(app).get(`/api/v1/credentials/${missing}`).set(as('a'))).body);
  const foreignOAuth = await request(app).post(`/api/v1/credentials/${bId}/oauth/authorize`).set(as('a')).send({});
  const missingOAuth = await request(app).post(`/api/v1/credentials/${missing}/oauth/authorize`).set(as('a')).send({});
  expect(foreignOAuth.status).toBe(404);
  expect(foreignOAuth.body).toEqual(missingOAuth.body);
  expect((await request(app).post(`/api/v1/credentials/${bId}/oauth/authorize`).set(as('b')).send({})).status).toBe(403);
  expect((await request(app).get('/api/v1/credentials/oauth/callback?state=fake&code=fake').set(as('b'))).status).toBe(403);
});

it('foreign and missing writes/deletes are indistinguishable with no mutation; owner succeeds', async () => {
  const before = await sql('SELECT credentials::text AS encrypted FROM credentials WHERE id = $1', [bId]);
  await sql('INSERT INTO discovery_definitions (credential_id) VALUES ($1)', [bId]);
  for (const principal of ['a', 'c']) {
    const foreignPut = await request(app).put(`/api/v1/credentials/${bId}`).set(as(principal)).send({ credentials: { key: 'poison' } });
    const missingPut = await request(app).put(`/api/v1/credentials/${missing}`).set(as(principal)).send({ credentials: { key: 'poison' } });
    expect(foreignPut.status).toBe(404);
    expect(foreignPut.body).toEqual(missingPut.body);
    const foreignDelete = await request(app).delete(`/api/v1/credentials/${bId}`).set(as(principal));
    const missingDelete = await request(app).delete(`/api/v1/credentials/${missing}`).set(as(principal));
    expect(foreignDelete.status).toBe(404);
    expect(foreignDelete.body).toEqual(missingDelete.body);
  }
  expect(await sql('SELECT credentials::text AS encrypted FROM credentials WHERE id = $1', [bId])).toEqual(before);
  expect((await sql('SELECT name FROM credentials WHERE id = $1', [bId]))[0].name).toBe('B-private');
  expect((await request(app).delete(`/api/v1/credentials/${bId}`).set(as('b'))).status).toBe(409);
  await sql('DELETE FROM discovery_definitions WHERE credential_id = $1', [bId]);
  const ownerPut = await request(app).put(`/api/v1/credentials/${bId}`).set(as('b'))
    .send({ name: 'B-renamed', credentials: { key: 'owner-test-only' } });
  expect(ownerPut.status).toBe(200);
  expect(ownerPut.body.data.credentials).toBe('***REDACTED***');
  expect(await sql('SELECT credentials::text AS encrypted FROM credentials WHERE id = $1', [bId])).not.toEqual(before);
  expect((await request(app).delete(`/api/v1/credentials/${bId}`).set(as('b'))).status).toBe(204);
  expect(await sql('SELECT id FROM credentials WHERE id = $1', [bId])).toEqual([]);
});

it('rejects org-less identities before SQL and prevents match/rank/validate enumeration', async () => {
  expect((await request(app).get('/api/v1/credentials').set(as('none'))).status).toBe(403);
  const ranked = await request(app).post('/api/v1/credentials/rank').set(as('a')).send({});
  expect(ranked.body.data.map((result: { credential: { id: string } }) => result.credential.id)).toEqual([aId]);
  expect(ranked.body.data[0].credential.credentials).toBe('***REDACTED***');
  const matched = await request(app).post('/api/v1/credentials/match').set(as('a')).send({});
  expect(matched.body.data.credential.id).toBe(aId);
  expect(matched.body.data.credential.credentials).toBe('***REDACTED***');
  expect(JSON.stringify(matched.body)).not.toContain('only-A-private');
  const validation = await request(app).post(`/api/v1/credentials/${aId}/validate`).set(as('b')).send({});
  const absentValidation = await request(app).post(`/api/v1/credentials/${missing}/validate`).set(as('b')).send({});
  expect(validation.status).toBe(404);
  expect(validation.body).toEqual(absentValidation.body);
  expect((await sql('SELECT validation_status FROM credentials WHERE id = $1', [aId]))[0].validation_status).toBeNull();
  const ownedValidation = await request(app).post(`/api/v1/credentials/${aId}/validate`).set(as('a')).send({});
  expect(ownedValidation.body.data.valid).toBe(true);
});

it('requires authentication, an organization and write permission before credential mutation', async () => {
  expect((await request(app).get('/api/v1/credentials')).status).toBe(401);
  expect((await request(app).post('/api/v1/credentials').set(as('none')).send(credential('forbidden'))).status).toBe(403);
  expect((await request(app).put(`/api/v1/credentials/${aId}`).set(as('viewer')).send({ name: 'forbidden' })).status).toBe(403);
  expect((await request(app).post('/api/v1/credentials').set(as('agent')).send(credential('agent-forbidden'))).status).toBe(403);
  expect((await request(app).get('/api/v1/credentials').set(as('agent'))).status).toBe(403);
  expect((await sql('SELECT name FROM credentials WHERE id = $1', [aId]))[0].name).toBe('A-private');
});

it('scopes credential sets and their member IDs to the verified owner/org', async () => {
  const newB = await request(app).post('/api/v1/credentials').set(as('b')).send(credential('B-set-private'));
  expect(newB.status).toBe(201);
  const foreignId: string = newB.body.data.id;
  const denied = await request(app).post('/api/v1/credential-sets').set(as('a'))
    .send({ name: 'foreign-member', credential_ids: [foreignId] });
  expect(denied.status).toBe(400);
  const owned = await request(app).post('/api/v1/credential-sets').set(as('a'))
    .send({ name: 'A-set', credential_ids: [aId] });
  expect(owned.status).toBe(201);
  const setId: string = owned.body.data.id;
  expect((await request(app).get('/api/v1/credential-sets').set(as('b'))).body.data).toEqual([]);
  const foreign = await request(app).get(`/api/v1/credential-sets/${setId}`).set(as('b'));
  const absent = await request(app).get(`/api/v1/credential-sets/${missing}`).set(as('b'));
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(absent.body);
  expect((await request(app).put(`/api/v1/credential-sets/${setId}`).set(as('b')).send({ name: 'poison' })).status).toBe(404);
  const foreignMemberWrite = await request(app).put(`/api/v1/credential-sets/${setId}`).set(as('b'))
    .send({ credential_ids: [foreignId] });
  const missingSetWrite = await request(app).put(`/api/v1/credential-sets/${missing}`).set(as('b'))
    .send({ credential_ids: [foreignId] });
  expect(foreignMemberWrite.body).toEqual(missingSetWrite.body);
  expect((await request(app).put(`/api/v1/credential-sets/${setId}`).set(as('a'))
    .send({ credential_ids: [foreignId] })).status).toBe(400);
  expect((await sql('SELECT credential_ids FROM credential_sets WHERE id = $1', [setId]))[0].credential_ids).toEqual([aId]);
  expect((await request(app).delete(`/api/v1/credential-sets/${setId}`).set(as('b'))).status).toBe(404);
  const selected = await request(app).post(`/api/v1/credential-sets/${setId}/select`).set(as('a')).send({});
  expect(selected.status).toBe(200);
  expect(selected.body.data[0].credentials).toBe('***REDACTED***');
  expect((await request(app).delete(`/api/v1/credential-sets/${setId}`).set(as('a'))).status).toBe(204);
  expect((await request(app).delete(`/api/v1/credentials/${foreignId}`).set(as('b'))).status).toBe(204);
});

it('enforces owner and organization in SQL even when the service is called directly', async () => {
  const service = new UnifiedCredentialService(pool as unknown as Pool);
  expect(await service.getById(aId, 'b', B)).toBeNull();
  expect(await service.getById(aId, 'viewer', A)).toBeNull();
  expect(await service.list('b', B)).toEqual([]);
  await expect(service.update(aId, { credentials: { key: 'poison' } }, 'b', B)).rejects.toBeInstanceOf(Error);
  await expect(service.delete(aId, 'b', B)).rejects.toBeInstanceOf(Error);
  const owned = await service.getById(aId, 'a', A);
  expect(owned?.name).toBe('A-private');
  expect(owned?.credentials).toEqual({ key: 'only-A-private' });
});
