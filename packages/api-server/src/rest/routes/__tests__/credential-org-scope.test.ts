// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** LH-4: real routes/controllers/SQL on embedded PostgreSQL; identities are test-only. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';
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
  d: { _id: 'd', _username: 'dana', _role: 'operator', _enabled: true, _organizationId: A },
  none: { _id: 'none', _username: 'nora', _role: 'admin', _enabled: true },
  viewer: { _id: 'viewer', _username: 'vicky', _role: 'viewer', _enabled: true, _organizationId: A },
  admin: { _id: 'admin', _username: 'ada', _role: 'admin', _enabled: true, _organizationId: A },
  agent: { _id: 'agent', _username: 'worker', _role: 'agent', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => identities[id] ?? null })),
}));
import { loadConfig } from '@cmdb/common';
import { logger, EncryptionService, getEncryptionService } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';
import { UnifiedCredentialService } from '../../../../../database/src/postgres/unified-credential.service';
import { CredentialSetService } from '../../../../../database/src/postgres/credential-set.service';
import { CredentialCRUDService } from '../../../../../database/src/postgres/credential-services/crud.service';
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
  const beforeOAuthSql = serial;
  const refused = { success: false, error: 'Forbidden', message: 'Credential OAuth is unavailable' };
  for (const principal of ['a', 'b', 'none', 'agent']) {
    for (const id of [aId, bId, missing]) {
      const response = await request(app).post(`/api/v1/credentials/${id}/oauth/authorize`).set(as(principal)).send({});
      expect(response.status).toBe(403);
      expect(response.body).toEqual(refused);
    }
    const callback = await request(app).get('/api/v1/credentials/oauth/callback?state=fake&code=fake').set(as(principal));
    expect(callback.status).toBe(403);
    expect(callback.body).toEqual(refused);
  }
  expect(serial).toBe(beforeOAuthSql);
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
  expect((await request(app).post('/api/v1/credentials/rank').set(as('none')).send({})).status).toBe(403);
  expect((await request(app).post('/api/v1/credentials/match').set(as('none')).send({})).status).toBe(403);
  expect((await request(app).post(`/api/v1/credentials/${aId}/validate`).set(as('none')).send({})).status).toBe(403);
  expect((await request(app).post(`/api/v1/credentials/${aId}/oauth/authorize`).set(as('none')).send({})).status).toBe(403);
  const ranked = await request(app).post('/api/v1/credentials/rank').set(as('a')).send({});
  expect(ranked.body.data.map((result: { credential: { id: string } }) => result.credential.id)).toEqual([aId]);
  expect((await request(app).post('/api/v1/credentials/rank').set(as('d')).send({})).body.data).toEqual([]);
  expect(ranked.body.data[0].credential.credentials).toBe('***REDACTED***');
  const matched = await request(app).post('/api/v1/credentials/match').set(as('a')).send({});
  expect(matched.body.data.credential.id).toBe(aId);
  expect(matched.body.data.credential.credentials).toBe('***REDACTED***');
  expect(JSON.stringify(matched.body)).not.toContain('only-A-private');
  expect((await request(app).post('/api/v1/credentials/match').set(as('d')).send({})).status).toBe(404);
  const validation = await request(app).post(`/api/v1/credentials/${aId}/validate`).set(as('b')).send({});
  const absentValidation = await request(app).post(`/api/v1/credentials/${missing}/validate`).set(as('b')).send({});
  expect(validation.status).toBe(404);
  expect(validation.body).toEqual(absentValidation.body);
  expect((await request(app).post(`/api/v1/credentials/${aId}/validate`).set(as('d')).send({})).body).toEqual(
    (await request(app).post(`/api/v1/credentials/${missing}/validate`).set(as('d')).send({})).body
  );
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

it('HAP-514: a viewer owner cannot validate a credential or select a set before any SQL; with write permission the owner can', async () => {
  const viewer = identities.viewer;
  viewer._role = 'operator';
  const credId: string = (await request(app).post('/api/v1/credentials').set(as('viewer')).send(credential('V-private'))).body.data.id;
  const setId: string = (await request(app).post('/api/v1/credential-sets').set(as('viewer'))
    .send({ name: 'V-set', credential_ids: [credId] })).body.data.id;
  const callAs = async (role: 'operator' | 'viewer') => {
    viewer._role = role;
    const validate = await request(app).post(`/api/v1/credentials/${credId}/validate`).set(as('viewer')).send({});
    const select = await request(app).post(`/api/v1/credential-sets/${setId}/select`).set(as('viewer')).send({});
    return { validate, select };
  };
  const stamp = () => sql('SELECT validation_status, last_validated_at FROM credentials WHERE id = $1', [credId]);
  try {
    const beforeSql = serial;
    const refused = await callAs('viewer');
    const denied = { _error: 'Forbidden', _message: "Permission 'write' required" };
    expect([refused.validate.status, refused.validate.body, refused.select.status, refused.select.body]).toEqual([403, denied, 403, denied]);
    expect(serial).toBe(beforeSql);
    expect(await stamp()).toEqual([{ validation_status: null, last_validated_at: null }]);
    const allowed = await callAs('operator');
    expect([allowed.validate.status, allowed.validate.body.data.valid, allowed.select.status]).toEqual([200, true, 200]);
    expect(allowed.select.body.data.map((c: { id: string; credentials: string }) => [c.id, c.credentials])).toEqual([[credId, '***REDACTED***']]);
    expect((await stamp())[0].validation_status).toBe('valid');
  } finally {
    viewer._role = 'viewer';
    await sql('DELETE FROM credential_sets WHERE id = $1', [setId]);
    await sql('DELETE FROM credentials WHERE id = $1', [credId]);
  }
});

// One row per route registered in unified-credential.routes.ts. `write` routes sit behind requirePermission('write');
// `oauth` routes refuse every authenticated caller; `read` routes are open to a viewer owner.
type Verb = 'get' | 'post' | 'put' | 'delete';
const routeTable: { verb: Verb; path: string; kind: 'read' | 'write' | 'oauth' }[] = [
  { verb: 'post', path: '/credentials/:id/oauth/authorize', kind: 'oauth' },
  { verb: 'get', path: '/credentials/oauth/callback', kind: 'oauth' },
  { verb: 'post', path: '/credentials/match', kind: 'read' },
  { verb: 'post', path: '/credentials/rank', kind: 'read' },
  { verb: 'get', path: '/credentials', kind: 'read' },
  { verb: 'post', path: '/credentials', kind: 'write' },
  { verb: 'get', path: '/credentials/:id', kind: 'read' },
  { verb: 'put', path: '/credentials/:id', kind: 'write' },
  { verb: 'delete', path: '/credentials/:id', kind: 'write' },
  { verb: 'post', path: '/credentials/:id/validate', kind: 'write' },
  { verb: 'get', path: '/credential-sets', kind: 'read' },
  { verb: 'post', path: '/credential-sets', kind: 'write' },
  { verb: 'get', path: '/credential-sets/:id', kind: 'read' },
  { verb: 'put', path: '/credential-sets/:id', kind: 'write' },
  { verb: 'delete', path: '/credential-sets/:id', kind: 'write' },
  { verb: 'post', path: '/credential-sets/:id/select', kind: 'write' },
];

it('per-route wiring table covers every route registered on the credential router', () => {
  const registered = (unifiedCredentialRoutes.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
    .flatMap(layer => (layer.route ? Object.keys(layer.route.methods).map(m => `${m.toUpperCase()} ${layer.route!.path}`) : []));
  expect(routeTable.map(r => `${r.verb.toUpperCase()} ${r.path}`).sort()).toEqual([...registered].sort());
});

it('every credential route returns 401 anonymously; a viewer owner gets 403 on every write route and still reads; none runs SQL when refused', async () => {
  const viewer = identities.viewer;
  viewer._role = 'operator';
  const credId: string = (await request(app).post('/api/v1/credentials').set(as('viewer')).send(credential('W-private'))).body.data.id;
  const setId: string = (await request(app).post('/api/v1/credential-sets').set(as('viewer'))
    .send({ name: 'W-set', credential_ids: [credId] })).body.data.id;
  viewer._role = 'viewer';
  const url = (path: string) => `/api/v1${path.replace('/credentials/:id', `/credentials/${credId}`).replace('/credential-sets/:id', `/credential-sets/${setId}`)}`;
  const call = (row: (typeof routeTable)[number], headers: Record<string, string>) => request(app)[row.verb](url(row.path)).set(headers).send({});
  try {
    for (const row of routeTable) {
      const label = `${row.verb.toUpperCase()} ${row.path}`;
      const beforeAnon = serial;
      const anon = await call(row, {});
      expect([label, anon.status, serial]).toEqual([label, 401, beforeAnon]);
      const before = serial;
      const asViewer = await call(row, as('viewer'));
      if (row.kind === 'write') {
        expect([label, asViewer.status, asViewer.body, serial]).toEqual([label, 403, { _error: 'Forbidden', _message: "Permission 'write' required" }, before]);
      } else if (row.kind === 'oauth') {
        expect([label, asViewer.status, asViewer.body.message, serial]).toEqual([label, 403, 'Credential OAuth is unavailable', before]);
      } else {
        expect([label, asViewer.status]).toEqual([label, 200]);
      }
    }
    expect((await sql('SELECT count(*)::int AS n FROM credentials WHERE id = $1', [credId]))[0].n).toBe(1);
    expect((await sql('SELECT count(*)::int AS n FROM credential_sets WHERE id = $1', [setId]))[0].n).toBe(1);
  } finally {
    viewer._role = 'viewer';
    await sql('DELETE FROM credential_sets WHERE id = $1', [setId]);
    await sql('DELETE FROM credentials WHERE id = $1', [credId]);
  }
});

it('scopes credential sets and their member IDs to the verified owner/org', async () => {
  const newB = await request(app).post('/api/v1/credentials').set(as('b')).send(credential('B-set-private'));
  expect(newB.status).toBe(201);
  const foreignId: string = newB.body.data.id;
  const denied = await request(app).post('/api/v1/credential-sets').set(as('a'))
    .send({ name: 'foreign-member', credential_ids: [foreignId] });
  expect(denied.status).toBe(400);
  expect((await request(app).post('/api/v1/credential-sets').set(as('d'))
    .send({ name: 'same-org-foreign-member', credential_ids: [aId] })).body).toEqual(denied.body);
  const owned = await request(app).post('/api/v1/credential-sets').set(as('a'))
    .send({ name: 'A-set', credential_ids: [aId] });
  expect(owned.status).toBe(201);
  const setId: string = owned.body.data.id;
  expect((await request(app).get('/api/v1/credential-sets').set(as('d'))).body.data).toEqual([]);
  expect((await request(app).get('/api/v1/credential-sets').set(as('none'))).status).toBe(403);
  expect((await request(app).post('/api/v1/credential-sets').set(as('none'))
    .send({ name: 'orgless', credential_ids: [aId] })).status).toBe(403);
  expect((await request(app).get('/api/v1/credential-sets').set(as('b'))).body.data).toEqual([]);
  const foreign = await request(app).get(`/api/v1/credential-sets/${setId}`).set(as('b'));
  const absent = await request(app).get(`/api/v1/credential-sets/${missing}`).set(as('b'));
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(absent.body);
  const sameOrgNonowner = await request(app).get(`/api/v1/credential-sets/${setId}`).set(as('d'));
  expect(sameOrgNonowner.body).toEqual(absent.body);
  const foreignSelect = await request(app).post(`/api/v1/credential-sets/${setId}/select`).set(as('b')).send({});
  const absentSelect = await request(app).post(`/api/v1/credential-sets/${missing}/select`).set(as('b')).send({});
  expect(foreignSelect.status).toBe(404);
  expect(foreignSelect.body).toEqual(absentSelect.body);
  expect((await request(app).post(`/api/v1/credential-sets/${setId}/select`).set(as('d')).send({})).body)
    .toEqual((await request(app).post(`/api/v1/credential-sets/${missing}/select`).set(as('d')).send({})).body);
  expect((await request(app).post(`/api/v1/credential-sets/${setId}/select`).set(as('none')).send({})).status).toBe(403);
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
  await expect(service.update(aId, { credentials: { key: 'poison' } }, 'b', B, true)).rejects.toBeInstanceOf(Error);
  await expect(service.delete(aId, 'b', B, true)).rejects.toBeInstanceOf(Error);
  expect(await service.getById(aId, null as unknown as string, A)).toBeNull();
  expect(await service.getById(aId, 'a', null as unknown as string)).toBeNull();
  expect(await service.list(null as unknown as string, A)).toEqual([]);
  const sets = new CredentialSetService(pool as unknown as Pool);
  expect(await sets.list(null as unknown as string, A)).toEqual([]);
  const owned = await service.getById(aId, 'a', A);
  expect(owned?.name).toBe('A-private');
  expect(owned?.credentials).toEqual({ key: 'only-A-private' });
});

it('HAP-774 C-6: discovery credentials resolve only in-org, protocol-matched and never decode on refusal', async () => {
  const seen: string[] = [];
  const crud = new CredentialCRUDService({ connect: async () => ({ query: async (text: string, params?: unknown[]) => { seen.push(text); return { rows: await sql(text, params) }; }, release: () => undefined }) } as unknown as Pool);
  const ssh = async (name: string, protocol: 'ssh_password' | 'ssh_key', owner: string, org: string) => (await crud.create({ name, protocol, scope: 'ssh', credentials: { username: 'root', password: `pw-${name}` } }, owner, org, false)).id;
  const [own, key, foreign, nullOrg] = [await ssh('A-ssh', 'ssh_password', 'a', A), await ssh('A-key', 'ssh_key', 'a', A), await ssh('B-ssh', 'ssh_password', 'b', B), '77777777-7777-4777-8777-777777777777'];
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by) VALUES ($1, 'A-null', 'ssh_password', 'ssh', $2, 'a')`,
    [nullOrg, JSON.stringify(getEncryptionService().encrypt('{"password":"null-org"}'))]);
  const both = ['ssh_password', 'ssh_key'] as const;
  const decrypt = jest.spyOn(EncryptionService.prototype, 'decrypt');
  try {
    const refusals = await Promise.all([
      ...[foreign, nullOrg, missing, 'not-a-uuid', `${own}' OR '1'='1`, ''].map((id) => crud.resolveDiscoveryCredential(id, A, both)),
      crud.resolveDiscoveryCredential(own, null as unknown as string, both),
      crud.resolveDiscoveryCredential(key, A, ['ssh_password']),
      crud.resolveDiscoveryCredential(own, A, ['ssh_key']),
      crud.resolveDiscoveryCredential(aId, A, both),
      crud.resolveDiscoveryCredential(aId, A, ['api_key'] as never),
      ...[foreign, nullOrg, missing, 'not-a-uuid'].map((id) => crud.assertDiscoveryCredential(id, A, 'a', both)),
      crud.assertDiscoveryCredential(own, A, 'd', both),
      crud.assertDiscoveryCredential(own, A, null as unknown as string, both),
      crud.assertDiscoveryCredential(key, A, 'a', ['ssh_password']),
    ]);
    expect(refusals).toEqual(refusals.map(() => null));
    expect(decrypt).not.toHaveBeenCalled();
    seen.length = 0;
    expect(await crud.assertDiscoveryCredential(own, A, 'a', ['ssh_password'])).toBe(own);
    expect(await crud.assertDiscoveryCredential(own, A, undefined, both)).toBe(own);
    expect(seen).toEqual([expect.stringMatching(/^SELECT id FROM credentials WHERE /), expect.stringMatching(/^SELECT id FROM credentials WHERE /)]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await crud.resolveDiscoveryCredential(own, A, ['ssh_password'])).toEqual({ ok: true, protocol: 'ssh_password', credentials: { username: 'root', password: 'pw-A-ssh' } });
    expect(decrypt).toHaveBeenCalledTimes(1);
  } finally {
    decrypt.mockRestore();
  }
});

it('HAP-774 C-6: a decode failure is a fixed code and logs no id, payload or error text', async () => {
  const [bad, marker] = ['66666666-6666-4666-8666-666666666666', 'Zq7MarkerHAP774'];
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 'A-bad', 'ssh_password', 'ssh', $2, 'a', $3)`,
    [bad, JSON.stringify(getEncryptionService().encrypt(marker)), A]);
  const spies = (['error', 'warn', 'info', 'debug'] as const).map((level) => jest.spyOn(logger, level));
  try {
    expect(await new CredentialCRUDService(pool as unknown as Pool).resolveDiscoveryCredential(bad, A, ['ssh_password'])).toEqual({ ok: false, code: 'ERR_CREDENTIAL_DECODE' });
    const logged = inspect(spies.map((spy) => spy.mock.calls), { depth: 10 });
    expect(logged).toContain('ERR_CREDENTIAL_DECODE');
    for (const leak of [marker, bad, 'JSON']) expect(logged).not.toContain(leak);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

const C4 = 'happylab-c4';
const bearer = (name: string, tags: string[]) => ({ name, protocol: 'bearer', scope: 'api', credentials: { token: `tok-${name}` }, tags });
const c4Refusal = { success: false, error: 'Forbidden', code: 'c4_principal_admin_required', message: 'Only organization admins may manage the happylab-c4 credential tag' };
const c4 = (org: string) => new CredentialCRUDService({ query: async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) }) } as unknown as Pool).resolveC4Principal(org);
// HAP-1613: no test leaves a C4 principal behind, so each scenario starts with none in either org.
afterEach(() => sql('DELETE FROM credentials WHERE $1 = ANY(tags)', [C4]));

it('HAP-1613: a non-admin cannot create a happylab-c4 credential', async () => {
  const create = await request(app).post('/api/v1/credentials').set(as('a')).send(bearer('A-plant', ['ops', C4]));
  expect([create.status, create.body]).toEqual([403, c4Refusal]);
  expect(await sql('SELECT id FROM credentials WHERE $1 = ANY(tags)', [C4])).toEqual([]);
});

it('HAP-1613: a non-admin cannot add the happylab-c4 tag on update', async () => {
  const own = await request(app).post('/api/v1/credentials').set(as('a')).send(bearer('A-own', ['ops']));
  const add = await request(app).put(`/api/v1/credentials/${own.body.data.id}`).set(as('a')).send({ tags: ['ops', C4] });
  expect([add.status, add.body]).toEqual([403, c4Refusal]);
  expect(await c4(A)).toEqual({ code: 'c4_no_credential' });
});

it('HAP-1613: a non-admin owner cannot rotate, retag, rename or delete an existing happylab-c4 credential', async () => {
  const id = '55555555-5555-4555-8555-555555555555';
  await sql(`INSERT INTO credentials (id, name, protocol, scope, credentials, tags, created_by, organization_id) VALUES ($1, 'A-legacy-c4', 'bearer', 'api', $2, $3, 'd', $4)`,
    [id, JSON.stringify(getEncryptionService().encrypt('{"token":"legacy-c4-token"}')), [C4], A]);
  const before = await sql('SELECT * FROM credentials WHERE id = $1', [id]);
  for (const body of [{ tags: [] }, { tags: ['happylab-c5'] }, { credentials: { token: 'planted-token' } }, { name: 'renamed' }]) {
    const put = await request(app).put(`/api/v1/credentials/${id}`).set(as('d')).send(body);
    expect([put.status, put.body]).toEqual([403, c4Refusal]);
  }
  const del = await request(app).delete(`/api/v1/credentials/${id}`).set(as('d'));
  expect([del.status, del.body]).toEqual([403, c4Refusal]);
  const foreign = await request(app).put(`/api/v1/credentials/${id}`).set(as('a')).send({ tags: [] });
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual((await request(app).put(`/api/v1/credentials/${missing}`).set(as('a')).send({ tags: [] })).body);
  expect(await sql('SELECT * FROM credentials WHERE id = $1', [id])).toEqual(before);
  expect(await c4(A)).toEqual({ token: 'legacy-c4-token' });
});

it('HAP-1613: other tags are unaffected for non-admins', async () => {
  const created = await request(app).post('/api/v1/credentials').set(as('a')).send(bearer('A-other-tags', ['happylab-c4-staging', 'ops']));
  expect(created.status).toBe(201);
  const put = await request(app).put(`/api/v1/credentials/${created.body.data.id}`).set(as('a'))
    .send({ tags: ['HAPPYLAB-C4', 'ops'], credentials: { token: 'tok-other' } });
  expect([put.status, put.body.data.tags]).toEqual([200, ['HAPPYLAB-C4', 'ops']]);
  expect(await c4(A)).toEqual({ code: 'c4_no_credential' });
});

it('HAP-1613: an org admin manages the happylab-c4 credential and the C4 sync resolves it in that org only', async () => {
  const created = await request(app).post('/api/v1/credentials').set(as('admin')).send(bearer('A-c4', [C4]));
  expect(created.status).toBe(201);
  const id: string = created.body.data.id;
  expect([await c4(A), await c4(B)]).toEqual([{ token: 'tok-A-c4' }, { code: 'c4_no_credential' }]);
  expect((await request(app).put(`/api/v1/credentials/${id}`).set(as('admin')).send({ tags: ['ops'] })).status).toBe(200);
  expect(await c4(A)).toEqual({ code: 'c4_no_credential' });
  expect((await request(app).put(`/api/v1/credentials/${id}`).set(as('admin')).send({ tags: [C4], credentials: { token: 'tok-rotated' } })).status).toBe(200);
  expect(await c4(A)).toEqual({ token: 'tok-rotated' });
  expect((await request(app).delete(`/api/v1/credentials/${id}`).set(as('admin'))).status).toBe(204);
  expect(await c4(A)).toEqual({ code: 'c4_no_credential' });
});
