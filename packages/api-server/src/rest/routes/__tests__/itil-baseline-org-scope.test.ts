// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted REST baseline boundaries over the real DDL/migrations and in-memory PostgreSQL. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(Object.assign(new Error(error), { code }));
  else reply.resolve(rows);
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}
const db = {
  exec: (sql: string) => send('exec', sql),
  rows: <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>,
};
let writes = 0;
let graphWrites = 0;
let ciNodes: Record<string, { id: string; name: string; organization_id: string }> = {};
const pgClient = {
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('DELETE')) writes++;
      return { rows: await db.rows(sql, params) };
    },
  },
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({
    getCI: async (id: string, organizationId: string) => {
      const node = ciNodes[id];
      return node?.organization_id === organizationId ? { ...node } : null;
    },
    getSession: () => ({
      run: async (cypher: string, params: { ciId: string; organizationId: string; restoreProps: Record<string, unknown> }) => {
        const node = ciNodes[params.ciId];
        if (!node || !cypher.includes('WHERE ci.organization_id = $organizationId') || node.organization_id !== params.organizationId) {
          return { records: [] };
        }
        graphWrites++;
        Object.assign(node, params.restoreProps);
        return { records: [{ get: () => ({ properties: { ...node } }) }] };
      },
      close: async () => undefined,
    }),
  }),
  getAuditService: () => ({}),
}));
jest.mock('bcrypt', () => ({}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEFAULT = '00000000-0000-0000-0000-000000000000';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_NULL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_MISSING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A },
  b: { _id: 'b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: B },
  admin: { _id: 'admin', _username: 'admin', _role: 'admin', _enabled: true, _organizationId: DEFAULT },
  noorg: { _id: 'noorg', _username: 'noorg', _role: 'admin', _enabled: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => USERS[id] ?? null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { itilRoutes } from '../itil.routes';

const jwt = new JWTService(loadConfig().auth.jwt);
function authorization(id: string) {
  const user = USERS[id]!;
  return { Authorization: `Bearer ${jwt.generateAccessToken(id, user._username, user._role, user._organizationId)}` };
}
const app = express();
app.use(express.json());
// Matches server.ts: authentication precedes the mounted ITIL router.
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
const endpoint = (id: string) => `/api/v1/itil/baselines/${id}`;

const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const original = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
const ddl = original.match(/CREATE TABLE IF NOT EXISTS itil_baselines \([\s\S]*?\n\);/);
if (!ddl) throw new Error('itil_baselines schema missing');
const uniqueName = original.match(/CREATE UNIQUE INDEX idx_itil_baselines_unique_name ON itil_baselines\(name\);/);
if (!uniqueName) throw new Error('itil_baselines unique name index missing');
const scopedUnique = readFileSync(join(migrations, '013_itil_baseline_org_name_unique.sql'), 'utf8');
let preexistingDuplicateCode: string | undefined;

beforeAll(async () => {
  await db.exec(ddl[0] + '\n' + uniqueName[0]);
  await db.exec(`INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by)
    VALUES ('${ID_NULL}', 'legacy', 'configuration', '{}', 'legacy')`);
  await db.exec(readFileSync(join(migrations, '012_itil_baseline_organization_scope.sql'), 'utf8'));
  // Model a damaged pre-cutover table with two rows sharing an org/name. The
  // migration must reject it rather than silently drop the uniqueness guard.
  await db.exec(`BEGIN;
    DROP INDEX idx_itil_baselines_unique_name;
    INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by, organization_id)
    VALUES ('${ID_A}', 'duplicate', 'configuration', '{}', 'alice', '${A}'),
           ('${ID_B}', 'duplicate', 'configuration', '{}', 'bob', '${A}');`);
  try {
    await db.exec(scopedUnique);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      preexistingDuplicateCode = error.code;
    }
  } finally {
    await db.exec('ROLLBACK');
  }
  await db.exec(scopedUnique);
});
afterAll(() => { host.kill(); });
beforeEach(async () => {
  await db.exec(`DELETE FROM itil_baselines;
    INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by, organization_id) VALUES
    ('${ID_A}', 'shared-a', 'configuration', '{"ci-a":{"name":"baseline-a"},"ci-b":{"name":"foreign-snapshot"}}', 'alice', '${A}'),
    ('${ID_B}', 'shared-b', 'configuration', '{"ci-b":{"name":"baseline-b"}}', 'bob', '${B}'),
    ('${ID_NULL}', 'legacy', 'configuration', '{"ci-a":{"name":"legacy-a"}}', 'legacy', NULL);`);
  ciNodes = {
    'ci-a': { id: 'ci-a', name: 'current-a', organization_id: A },
    'ci-b': { id: 'ci-b', name: 'current-b', organization_id: B },
  };
  graphWrites = 0;
  writes = 0;
});
const remaining = async () => (await db.rows<{ id: string }>('SELECT id FROM itil_baselines ORDER BY id')).map(row => row.id);

it('refuses a pre-existing same-org duplicate during the index cutover', () => {
  expect(preexistingDuplicateCode).toBe('23505');
});

it('lists only own rows and gives identical detail not-found for foreign, missing and NULL rows', async () => {
  const list = (user: string) => request(app).get('/api/v1/itil/baselines').set(authorization(user));
  expect((await list('a')).body.data.map((row: { id: string }) => row.id)).toEqual([ID_A]);
  expect((await list('b')).body.data.map((row: { id: string }) => row.id)).toEqual([ID_B]);
  expect((await list('admin')).body.data).toEqual([]);
  expect((await list('noorg')).status).toBe(403);
  const detail = (id: string, user: string) => request(app).get(endpoint(id)).set(authorization(user));
  const foreign = await detail(ID_A, 'b');
  const missing = await detail(ID_MISSING, 'b');
  const legacy = await detail(ID_NULL, 'b');
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  expect(foreign.body).toEqual(legacy.body);
  expect((await detail(ID_A, 'a')).body.data.organization_id).toBe(A);
  expect((await detail(ID_B, 'b')).body.data.organization_id).toBe(B);
  expect((await detail(ID_NULL, 'admin')).status).toBe(404);
  expect((await detail(ID_A, 'noorg')).status).toBe(403);
  expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
});

it('restores only owned baselines into owned CIs, leaving foreign and NULL state intact', async () => {
  const restore = (id: string, user: string, ciId: string) =>
    request(app).post(`${endpoint(id)}/restore`).set(authorization(user))
      .send({ ciId, performedBy: user });
  const foreign = await restore(ID_A, 'b', 'ci-b');
  const missing = await restore(ID_MISSING, 'b', 'ci-b');
  const legacy = await restore(ID_NULL, 'b', 'ci-b');
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  expect(foreign.body).toEqual(legacy.body);
  expect((await restore(ID_NULL, 'admin', 'ci-a')).status).toBe(404);
  expect((await restore(ID_A, 'noorg', 'ci-a')).status).toBe(403);
  expect(graphWrites).toBe(0);
  expect((await restore(ID_A, 'a', 'ci-b')).status).toBe(404);
  expect(graphWrites).toBe(0);
  expect(ciNodes['ci-b']?.name).toBe('current-b');
  const own = await restore(ID_A, 'a', 'ci-a');
  expect(own.status).toBe(200);
  expect(graphWrites).toBe(1);
  expect(ciNodes['ci-a']?.name).toBe('baseline-a');
  expect(ciNodes['ci-b']?.name).toBe('current-b');
  expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
});

it('keeps old-writer NULL rows inaccessible to tenant reads and deletes', async () => {
  await db.exec(`INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by)
    VALUES ('${ID_MISSING}', 'new-orphan', 'configuration', '{}', 'old-writer')`);
  const listed = await request(app).get('/api/v1/itil/baselines').set(authorization('a'));
  expect(listed.status).toBe(200);
  expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([ID_A]);
  const detail = await request(app).get(endpoint(ID_MISSING)).set(authorization('a'));
  const removal = await request(app).delete(endpoint(ID_MISSING)).set(authorization('a'));
  expect(detail.status).toBe(404);
  expect(removal.status).toBe(404);
  expect(await db.rows<{ organization_id: string | null }>(
    'SELECT organization_id FROM itil_baselines WHERE id = $1', [ID_MISSING]
  )).toEqual([{ organization_id: null }]);
});

it('compares only a caller-owned baseline and conceals foreign, missing, and NULL ids', async () => {
  const comparison = (id: string, user: string) =>
    request(app).get(`${endpoint(id)}/comparison`).set(authorization(user));
  const foreign = await comparison(ID_A, 'b');
  const missing = await comparison(ID_MISSING, 'b');
  const legacy = await comparison(ID_NULL, 'b');
  expect(foreign.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(legacy.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  expect(legacy.body).toEqual(missing.body);
  const own = await comparison(ID_B, 'b');
  expect(own.status).toBe(200);
  expect(own.body.data.baselineId).toBe(ID_B);
  expect((await comparison(ID_NULL, 'admin')).status).toBe(404);
  expect((await comparison(ID_A, 'noorg')).status).toBe(403);
  expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
});

describe('mounted ITIL baseline DELETE tenant boundary', () => {
  it('deletes only own baseline; foreign, missing and NULL are indistinguishable and untouched', async () => {
    const foreign = await request(app).delete(endpoint(ID_A)).set(authorization('b'));
    const missing = await request(app).delete(endpoint(ID_MISSING)).set(authorization('b'));
    const legacy = await request(app).delete(endpoint(ID_NULL)).set(authorization('b'));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(legacy.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(legacy.body).toEqual(missing.body);
    expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);

    const own = await request(app).delete(endpoint(ID_A)).set(authorization('a'));
    expect(own.status).toBe(204);
    expect(await remaining()).toEqual([ID_B, ID_NULL]);
    const otherOwn = await request(app).delete(endpoint(ID_B)).set(authorization('b'));
    expect(otherOwn.status).toBe(204);
    expect(await remaining()).toEqual([ID_NULL]);
  });

  it('denies NULL ownership to seeded/default admin and denies org-less callers before SQL', async () => {
    const legacy = await request(app).delete(endpoint(ID_NULL)).set(authorization('admin'));
    expect(legacy.status).toBe(404);
    expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
    writes = 0;
    const orgless = await request(app).delete(endpoint(ID_A)).set(authorization('noorg'));
    expect(orgless.status).toBe(403);
    expect(writes).toBe(0);
    expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
  });
});

describe('mounted ITIL baseline create tenant names', () => {
  const create = (user: string, name: string, ciId: string) =>
    request(app).post('/api/v1/itil/baselines').set(authorization(user))
      .send({ name, ciIds: [ciId], createdBy: user });

  it('allows the caller to reuse a foreign or legacy name without exposing or changing those rows', async () => {
    const foreignName = await create('a', 'shared-b', 'ci-a');
    const legacyName = await create('a', 'legacy', 'ci-a');
    expect(foreignName.status).toBe(201);
    expect(legacyName.status).toBe(201);
    expect(await db.rows<{ name: string; organization_id: string | null }>(
      'SELECT name, organization_id FROM itil_baselines WHERE name IN ($1, $2) ORDER BY name, organization_id NULLS FIRST',
      ['shared-b', 'legacy']
    )).toEqual([
      { name: 'legacy', organization_id: null },
      { name: 'legacy', organization_id: A },
      { name: 'shared-b', organization_id: A },
      { name: 'shared-b', organization_id: B },
    ]);
  });

  it('rejects a duplicate name inside the same organization without changing the existing baseline', async () => {
    const duplicate = await create('a', 'shared-a', 'ci-a');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ success: false, error: 'Conflict', message: 'Baseline name already exists' });
    expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
  });

  it('rejects foreign and missing CI snapshots without writing any baseline', async () => {
    const foreign = await create('a', 'foreign-ci', 'ci-b');
    const missing = await create('a', 'missing-ci', 'ci-missing');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const mixed = await request(app).post('/api/v1/itil/baselines').set(authorization('a'))
      .send({ name: 'mixed-ci', ciIds: ['ci-a', 'ci-b'], createdBy: 'a' });
    expect(mixed.status).toBe(404);
    expect(foreign.body.error).toBe(missing.body.error);
    expect(await remaining()).toEqual([ID_A, ID_B, ID_NULL]);
    const own = await create('b', 'own-b', 'ci-b');
    expect(own.status).toBe(201);
    expect(own.body.data.organization_id).toBe(B);
    expect((await db.rows<{ baseline_data: Record<string, { organization_id: string }> }>(
      'SELECT baseline_data FROM itil_baselines WHERE id = $1', [own.body.data.id]
    ))[0]?.baseline_data['ci-b']?.organization_id).toBe(B);
  });
});
