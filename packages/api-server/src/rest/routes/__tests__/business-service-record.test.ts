// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1423 (PoR S2): the business service record conforms to C1 and D15. Scenarios 1-6 of the story through the
 * real businessServiceRoutes behind the real AuthMiddleware (JWT, organization from the token), the real
 * PostgresClient and the real hash-chained audit writer and verifier (appendAuditEntry, AuditService), on PGlite.
 *
 * Every statement runs in one PGlite session as `cmdb_user`, a NOSUPERUSER role that owns the schema it migrated
 * (asserted before any test): the 001 audit enums and the audit_log, business-service and cmdb.dim_ci tables, then
 * 003, 028's audit_log column, 008, 011 and 043 verbatim. One service is inserted before 043 so it is backfilled live
 * with no owner principal (a legacy row); scenario 7's backfill matrix is in the migration test.
 */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const TENANT_T = '00000000-0000-0000-0000-000000000000';
const TENANT_T2 = '22222222-2222-4222-8222-222222222222';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<{ rows: Record<string, any>[]; rowCount: number }>>();
host.on('message', ({ id, rows, rowCount, error, code }: { id: number; rows: Record<string, any>[]; rowCount?: number;
  error?: string; code?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(Object.assign(new Error(error), { code }));
  else call.resolve({ rows, rowCount: rowCount || rows.length });
});
/** Fails the next audit_log INSERT with this error (a failed append after the service row was written). */
const mockFault: { auditInsert: Error | null } = { auditInsert: null };
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  if (mockFault.auditInsert && /^\s*INSERT INTO audit_log/.test(text)) {
    const fault = mockFault.auditInsert;
    mockFault.auditInsert = null;
    return Promise.reject(fault);
  }
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, any>[]; rowCount: number }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
// The production PostgresClient and AuditService run on one PGlite session (requests are sequential).
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { return mockSql(text, params); }
    async connect() { return { query: (text: string, params?: unknown[]) => mockSql(text, params), release: () => undefined }; }
    async end() { return undefined; }
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
const USERS: Record<string, { _id: string; _username: string; _role: 'operator'; _enabled: boolean; _organizationId: string }> = {
  t: { _id: 'actor-t', _username: 'tess', _role: 'operator', _enabled: true, _organizationId: TENANT_T },
  t2: { _id: 'actor-t2', _username: 'tom', _role: 'operator', _enabled: true, _organizationId: TENANT_T2 },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(USERS).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));
// bcrypt's native binding is only used for password hashing/login, which token verification never calls.
jest.mock('bcrypt', () => ({}));

import { loadConfig } from '@cmdb/common';
import { getAuditService, getPostgresClient } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/business-services', businessServiceRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
// Every request also carries a forged actor header; only the verified token subject may be recorded.
const headers = (user: string) => ({ 'x-actor': 'forged-admin', authorization: `Bearer ${jwt.generateAccessToken(
  USERS[user]!._id, USERS[user]!._username, USERS[user]!._role, USERS[user]!._organizationId)}` });
const BASE = { name: 'Payroll run', service_classification: 'application', tbm_tower: 'application', business_criticality: 'high' };
const NOT_FOUND = { success: false, error: 'Business service not found' };
const OWNER = 'idp|7f3c2a10-owner-alice';
const LEGACY = 'bs-0c9a6f1e-2b7d-4e3a-9f10-5d6c7b8a9e01';

const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const create = (body: object, user = 't') => request(app).post('/api/v1/business-services').set(headers(user)).send(body);
const patch = (id: string, body: object, ifMatch?: string, user = 't') => {
  const req = request(app).patch(`/api/v1/business-services/${id}`).set(headers(user));
  return (ifMatch === undefined ? req : req.set('If-Match', ifMatch)).send(body);
};
const del = (id: string, user = 't') => request(app).delete(`/api/v1/business-services/${id}`).set(headers(user));
const readC1 = (id: string, user = 't') => request(app).get(`/api/v1/business-services/${id}`).set(headers(user));
const stored = async (id: string) => (await rows(
  'SELECT lifecycle, owner_principal_id, owner_group, version, operational_status FROM dim_business_services WHERE service_id = $1',
  [id]))[0];
const audit = (id: string) => rows(`SELECT entity_type, action, actor, actor_type, organization_id, metadata, changes
  FROM audit_log WHERE entity_id = $1 ORDER BY timestamp, id`, [id]);
const auditCount = async () => (await rows('SELECT count(*)::int AS n FROM audit_log'))[0]!['n'] as number;
async function created(body: object = {}, user = 't'): Promise<string> {
  const res = await create({ ...BASE, ...body }, user);
  expect(res.status).toBe(201);
  return res.body.data.service_id as string;
}

const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const migration = (name: string) => readFileSync(join(migrations, name), 'utf8');

beforeAll(async () => {
  const [{ db }] = await rows('SELECT current_database() AS db');
  await mockSql(`CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user;
    GRANT CREATE ON SCHEMA public TO cmdb_user;
    SET ROLE cmdb_user;`, [], 'exec');
  const schema = migration('001_complete_schema.sql');
  const tables = ['audit_log', 'dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings',
    'cmdb.dim_ci'];
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...tables.map(table =>
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0])].join('\n'),
  [], 'exec');
  await mockSql(migration('003_audit_hash_chain.sql'), [], 'exec');
  await mockSql(migration('028_change_history_reconciliation_org_provenance.sql')
    .match(/ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id UUID;/)![0], [], 'exec');
  for (const name of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await mockSql(`BEGIN;\n${migration(name)}\nCOMMIT;`, [], 'exec');
  }
  await rows(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
    operational_status, organization_id) VALUES ($1, 'Legacy live', 'application', 'application', 'high', 'active', $2)`,
  [LEGACY, TENANT_T]);
  await mockSql(`BEGIN;\n${migration('043_business_service_record_c1.sql')}\nCOMMIT;`, [], 'exec');
  const [role] = await rows('SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user');
  if (role?.['name'] !== 'cmdb_user' || role['rolsuper'] !== false) throw new Error(`not the app role: ${JSON.stringify(role)}`);
}, 60000);
afterAll(() => { host.kill(); });
afterEach(() => { mockFault.auditInsert = null; });

describe('scenario 1: live needs an owner principal (D15)', () => {
  it('planned -> live without owner_principal_id is 422 and changes nothing; with it the C1 read shows live and the owner', async () => {
    const id = await created({ owned_by: 'Payroll team', owner_group: 'payroll-oncall' });
    expect(await stored(id)).toMatchObject({ lifecycle: 'planned', owner_principal_id: null, version: 1 });

    const refused = await patch(id, { lifecycle: 'live' });
    expect([refused.status, refused.body.success]).toEqual([422, false]);
    expect(await stored(id)).toMatchObject({ lifecycle: 'planned', version: 1 });
    expect((await audit(id)).map(row => row['action'])).toEqual(['CREATE']);

    const accepted = await patch(id, { lifecycle: 'live', owner_principal_id: OWNER });
    expect(accepted.status).toBe(200);
    const read = await readC1(id);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      service_id: id, tenant_id: TENANT_T, lifecycle: 'live', version: 2,
      owner: { principal_id: OWNER, display_name: 'Payroll team' }, owner_group: 'payroll-oncall',
    });
  });

  it('a create that starts live needs an owner principal too; clearing the principal of a live service is 422', async () => {
    expect((await create({ ...BASE, lifecycle: 'live' })).status).toBe(422);
    const id = await created({ lifecycle: 'live', owner_principal_id: OWNER });
    expect((await patch(id, { owner_principal_id: null })).status).toBe(422);
    expect(await stored(id)).toMatchObject({ lifecycle: 'live', owner_principal_id: OWNER, version: 1 });
  });
});

describe('scenario 2: lifecycle moves only forward and retired is terminal', () => {
  it('live -> planned and retired -> anything are 409 and leave the row and the audit log unchanged', async () => {
    const live = await created({ lifecycle: 'live', owner_principal_id: OWNER });
    const retired = await created({ lifecycle: 'retired' });
    const before = await auditCount();
    expect((await patch(live, { lifecycle: 'planned' })).status).toBe(409);
    for (const lifecycle of ['planned', 'live', 'retiring']) {
      expect((await patch(retired, { lifecycle, owner_principal_id: OWNER })).status).toBe(409);
    }
    expect([await stored(live), await stored(retired), await auditCount()]).toEqual([
      expect.objectContaining({ lifecycle: 'live', version: 1 }), expect.objectContaining({ lifecycle: 'retired', version: 1 }),
      before,
    ]);
  });

  it('a planned service (e.g. a backfilled decommissioned one) retires directly: planned -> retired, audited as retire', async () => {
    const id = await created({ operational_status: 'decommissioned' });
    const res = await patch(id, { lifecycle: 'retired' });
    expect([res.status, res.body.data.lifecycle, res.body.data.version]).toEqual([200, 'retired', 2]);
    expect((await audit(id)).map(row => [row['action'], row['metadata']['operation']])).toEqual([
      ['CREATE', 'create'], ['UPDATE', 'retire'],
    ]);
  });
});

describe('scenario 3: version and If-Match', () => {
  it('a stale If-Match is 409 and the row is unchanged; the current version increments version by one', async () => {
    const id = await created();
    expect((await patch(id, { description: 'v2' }, '"1"')).status).toBe(200);
    const stale = await patch(id, { description: 'lost update' }, '"1"');
    expect([stale.status, stale.body.version]).toEqual([409, 2]);
    expect(await rows('SELECT description, version FROM dim_business_services WHERE service_id = $1', [id]))
      .toEqual([{ description: 'v2', version: 2 }]);
    const current = await patch(id, { description: 'v3' }, '"2"');
    expect([current.status, current.body.data.version, (await audit(id)).length]).toEqual([200, 3, 3]);
  });

  it('a PATCH without If-Match still bumps version and writes one audit row (If-Match is optional)', async () => {
    const id = await created();
    const res = await patch(id, { description: 'no precondition' });
    expect([res.status, res.body.data.version]).toEqual([200, 2]);
    expect((await audit(id)).map(row => [row['action'], row['metadata']['version']])).toEqual([['CREATE', 1], ['UPDATE', 2]]);
  });

  it('a malformed If-Match or a client-chosen version is 400 and writes nothing', async () => {
    const id = await created();
    expect((await patch(id, { description: 'x' }, 'W/"1"')).status).toBe(400);
    expect((await patch(id, { description: 'x', version: 9 })).status).toBe(400);
    expect([await stored(id), (await audit(id)).length]).toEqual([expect.objectContaining({ version: 1 }), 1]);
  });
});

describe('scenario 4: each accepted write appends exactly one chained BUSINESS_SERVICE audit row', () => {
  it('create, update, retire and delete: one row each, actor from the token, linked by prev_hash; the chain verifies', async () => {
    const start = await auditCount();
    const id = await created({ owned_by: 'Payroll team' });
    expect((await patch(id, { lifecycle: 'live', owner_principal_id: OWNER })).status).toBe(200);
    expect((await patch(id, { lifecycle: 'retired' })).status).toBe(200);
    expect((await del(id)).status).toBe(200);

    expect(await auditCount()).toBe(start + 4);
    const entries = await audit(id);
    expect(entries.map(row => [row['entity_type'], row['action'], row['metadata']['operation'], row['actor'],
      row['actor_type'], row['organization_id'], row['metadata']['organization_id']])).toEqual([
      ['BUSINESS_SERVICE', 'CREATE', 'create', 'actor-t', 'user', TENANT_T, TENANT_T],
      ['BUSINESS_SERVICE', 'UPDATE', 'update', 'actor-t', 'user', TENANT_T, TENANT_T],
      ['BUSINESS_SERVICE', 'UPDATE', 'retire', 'actor-t', 'user', TENANT_T, TENANT_T],
      ['BUSINESS_SERVICE', 'DELETE', 'delete', 'actor-t', 'user', TENANT_T, TENANT_T],
    ]);
    expect(entries[1]!['changes']).toEqual(expect.arrayContaining([
      { field: 'lifecycle', old_value: 'planned', new_value: 'live' },
      { field: 'owner_principal_id', old_value: null, new_value: OWNER },
      { field: 'version', old_value: 1, new_value: 2 },
    ]));
    const chain = await rows('SELECT prev_hash, entry_hash FROM audit_log ORDER BY timestamp, id');
    for (let i = 1; i < chain.length; i++) expect(chain[i]!['prev_hash']).toBe(chain[i - 1]!['entry_hash']);
    expect(await getAuditService(getPostgresClient().pool).verifyAuditChain()).toMatchObject({ ok: true, orgBindingViolations: [] });
  });

  it('a failed audit append rolls the write back: no audit row, no version bump (500, or 503 on a chain-lock timeout)', async () => {
    const id = await created();
    const before = await auditCount();
    mockFault.auditInsert = new Error('disk full');
    expect((await patch(id, { description: 'lost' })).status).toBe(500);
    mockFault.auditInsert = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    expect((await patch(id, { lifecycle: 'retired' })).status).toBe(503);
    expect([await stored(id), await auditCount()]).toEqual([expect.objectContaining({ lifecycle: 'planned', version: 1 }), before]);
    expect(await rows('SELECT description FROM dim_business_services WHERE service_id = $1', [id])).toEqual([{ description: null }]);
  });
});

describe('scenario 5: operational_status is the DDL CHECK vocabulary; lifecycle the C1 one', () => {
  it.each(['planned', 'retired'])('operational_status = %s is 400 (never 500) on create and update, and writes nothing', async status => {
    const id = await created();
    const before = await auditCount();
    expect((await create({ ...BASE, operational_status: status })).status).toBe(400);
    expect((await patch(id, { operational_status: status })).status).toBe(400);
    expect([await stored(id), await auditCount()]).toEqual([expect.objectContaining({ operational_status: 'active', version: 1 }), before]);
  });

  it('an invalid lifecycle value is 400, never 500', async () => {
    const id = await created();
    expect((await create({ ...BASE, lifecycle: 'active' })).status).toBe(400);
    expect((await patch(id, { lifecycle: 'decommissioned' })).status).toBe(400);
    expect(await stored(id)).toMatchObject({ lifecycle: 'planned', version: 1 });
  });
});

describe('a legacy live service without an owner principal (043 backfill)', () => {
  it('stays editable; moving it to retiring or clearing the principal is 422; retiring it to retired is allowed', async () => {
    expect(await stored(LEGACY)).toMatchObject({ lifecycle: 'live', owner_principal_id: null, version: 1 });
    const edit = await patch(LEGACY, { description: 'still editable' });
    expect([edit.status, edit.body.data.version]).toEqual([200, 2]);
    expect((await patch(LEGACY, { lifecycle: 'retiring' })).status).toBe(422);
    expect((await patch(LEGACY, { owner_principal_id: null })).status).toBe(422);
    expect(await stored(LEGACY)).toMatchObject({ lifecycle: 'live', version: 2 });
    expect((await patch(LEGACY, { lifecycle: 'retired' })).status).toBe(200);
    expect((await audit(LEGACY)).map(row => row['metadata']['operation'])).toEqual(['update', 'retire']);
  });
});

describe('ETag', () => {
  it('POST and PATCH send the strong ETag "<version>", which PATCH accepts as If-Match (as is the read body\'s version)', async () => {
    const res = await create(BASE);
    expect(res.headers['etag']).toBe('"1"');
    const id = res.body.data.service_id as string;
    const read = await readC1(id);
    const updated = await patch(id, { description: 'x' }, `"${read.body.data.version}"`);
    expect([updated.status, updated.headers['etag']]).toEqual([200, '"2"']);
    expect((await patch(id, { description: 'y' }, updated.headers['etag'])).status).toBe(200);
    expect((await patch(id, { description: 'z' }, 'W/"3"')).status).toBe(400);
  });

  it('a conditional GET is never a stale 304: a dependency change and a target lifecycle change both return 200 with the new body', async () => {
    const [a, b] = [await created(), await created({ lifecycle: 'live', owner_principal_id: OWNER })];
    const ifNoneMatch = (etag: string) => readC1(a).set('If-None-Match', etag);
    const first = await readC1(a);
    expect((await ifNoneMatch(first.headers['etag'])).status).toBe(304); // unchanged representation

    // What POST /:id/dependencies stores; it does not bump A's version.
    await rows(`INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ($1, $2, 'technical')`, [a, b]);
    const afterDependency = await ifNoneMatch(first.headers['etag']);
    expect([afterDependency.status, afterDependency.body.data?.version, afterDependency.body.data?.dependencies_count])
      .toEqual([200, 1, 1]);

    expect((await patch(b, { lifecycle: 'retired' })).status).toBe(200);
    const afterTarget = await ifNoneMatch(afterDependency.headers['etag']);
    expect([afterTarget.status, afterTarget.body.data?.dependencies?.[0]?.lifecycle]).toEqual([200, 'retired']);
  });
});

describe('scenario 6: delete is refused once the service has CI mappings or dependencies', () => {
  it('DELETE with an owned CI mapping, a dependency or a dependent is 409, keeps the row and appends no audit row', async () => {
    const [mapped, dependent, dependency] = [await created(), await created(), await created()];
    await rows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current, organization_id)
      VALUES ('ci-owned', 'Owned CI', 'server', 'active', TRUE, $1)`, [TENANT_T]);
    await rows(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ('ci-owned', $1, 'hosts')`, [mapped]);
    await rows(`INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ($1, $2, 'technical')`, [dependent, dependency]);
    const before = await auditCount();
    for (const id of [mapped, dependent, dependency]) {
      const res = await del(id);
      expect([res.status, res.body.error]).toEqual([409, 'Conflict']);
    }
    expect([await rows('SELECT count(*)::int AS n FROM dim_business_services WHERE service_id = ANY($1)',
      [[mapped, dependent, dependency]]), await auditCount()]).toEqual([[{ n: 3 }], before]);
    expect((await patch(mapped, { lifecycle: 'retired' })).status).toBe(200);
  });

  it('a stale mapping (a CI that is not a current CI of the caller) neither blocks nor reveals itself', async () => {
    const id = await created();
    await rows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current, organization_id)
      VALUES ('ci-foreign', 'Foreign CI', 'server', 'active', TRUE, $1)`, [TENANT_T2]);
    await rows(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
      VALUES ('ci-foreign', $1, 'hosts'), ('ci-deleted', $1, 'hosts')`, [id]);
    expect((await del(id)).status).toBe(200);
  });
});

describe('tenancy: another tenant writing T\'s service', () => {
  it('PATCH and DELETE by T2 are the missing-service 404, with no version bump and no audit row', async () => {
    const id = await created();
    const before = await auditCount();
    const responses = [await patch(id, { description: 'T2 was here' }, undefined, 't2'),
      await patch(id, { description: 'T2 was here' }, '"1"', 't2'), await del(id, 't2'), await readC1(id, 't2')];
    expect(responses.map(res => [res.status, res.body])).toEqual(Array(4).fill([404, NOT_FOUND]));
    expect([await stored(id), await auditCount()]).toEqual([expect.objectContaining({ version: 1 }), before]);
  });

  it("a legacy dependency edge from T2's service neither blocks nor reveals itself on T's delete", async () => {
    const [mine, theirs] = [await created(), await created({}, 't2')];
    // Only a direct database write (pre-scoping data) can create a cross-tenant edge.
    await rows(`INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ($1, $2, 'technical')`, [theirs, mine]);
    expect((await del(mine)).status).toBe(200);
  });
});
