// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted REST DELETE over the real baseline DDL/migration and in-memory PostgreSQL SQL. */
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
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
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
  getNeo4jClient: () => ({}),
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

beforeAll(async () => {
  await db.exec(ddl[0]);
  await db.exec(`INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by)
    VALUES ('${ID_NULL}', 'legacy', 'configuration', '{}', 'legacy')`);
  await db.exec(readFileSync(join(migrations, '012_itil_baseline_organization_scope.sql'), 'utf8'));
});
afterAll(() => { host.kill(); });
beforeEach(async () => {
  await db.exec(`DELETE FROM itil_baselines;
    INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by, organization_id) VALUES
    ('${ID_A}', 'A', 'configuration', '{}', 'alice', '${A}'),
    ('${ID_B}', 'B', 'configuration', '{}', 'bob', '${B}'),
    ('${ID_NULL}', 'legacy', 'configuration', '{}', 'legacy', NULL);`);
  writes = 0;
});
const remaining = async () => (await db.rows<{ id: string }>('SELECT id FROM itil_baselines ORDER BY id')).map(row => row.id);

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
