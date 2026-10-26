// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-784: a REST CI create/update/delete appends exactly one hash-chained audit_log row inside journal T2,
 * by the verified journal actor (never a request header); a refused write appends none; without
 * AUDIT_CHAIN_KEY the write is 503 before T1. Mounted ciRoutes, real JWT auth, journal, Neo4jClient and
 * AuditService on PGlite (migrations 001/003/011/028/029/037); Neo4j is an in-memory node map.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});
delete process.env['AUDIT_CHAIN_KEY'];
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
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, any>[]; rowCount: number }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
// The production PostgresClient, journal and AuditService run on one PGlite session (requests are sequential).
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
const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), fences: new Map<string, Record<string, unknown>>(),
  writes: [] as string[] };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owner = (id: unknown) => mockGraph.nodes.get(id as string)?.['organization_id'];
  const run = async (query: string, params: Record<string, any> = {}) => {
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('MERGE (op:ReconciliationOp')) {
      return { records: [record(mockGraph.fences.get(params['op']) ?? { outcome: 'aborted', org: params['org'], ci: params['ci'], operation: params['operation'] })] };
    }
    if (query.includes('fences_created')) {
      mockGraph.writes.push(query);
      let applied = owner(params['id']) === params['org'];
      if (query.startsWith('CREATE (ci:CI')) {
        applied = true;
        mockGraph.nodes.set(params['id'], { ...params['props'], id: params['id'], organization_id: params['org'] });
      } else if (query.includes('DETACH DELETE')) {
        if (applied) mockGraph.nodes.delete(params['id']);
      } else if (query.includes('MERGE (a)')) {
        applied = owner(params['from']) === params['org'] && owner(params['to']) === params['org'];
      } else if (applied) Object.assign(mockGraph.nodes.get(params['id'])!, params['props']);
      for (const fence of applied ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: applied ? params['fences'].length : 0 })] };
    }
    const node = owner(params['id']) === params['organizationId'] ? mockGraph.nodes.get(params['id']) : undefined;
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
const users: Record<string, { _id: string; _username: string; _role: 'admin' | 'viewer'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'actor-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  viewer: { _id: 'actor-v', _username: 'vera', _role: 'viewer', _enabled: true, _organizationId: A },
  none: { _id: 'actor-n', _username: 'nora', _role: 'admin', _enabled: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { getAuditService, getNeo4jClient, getPostgresClient, setJournalSeam } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
// Every request also carries a forged actor header; only the verified token subject may be recorded.
const headers = (user: string) => ({ 'x-actor': 'forged-admin', authorization: `Bearer ${jwt.generateAccessToken(
  users[user]!._id, users[user]!._username, users[user]!._role, users[user]!._organizationId)}` });
const post = (user: string, body: object) => request(app).post('/api/v1/cis').set(headers(user)).send(body);
const put = (user: string, id: string, body: object) => request(app).put(`/api/v1/cis/${id}`).set(headers(user)).send(body);
const del = (user: string, id: string) => request(app).delete(`/api/v1/cis/${id}`).set(headers(user));
const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const audit = (ciId?: string) => rows(`SELECT action, actor, actor_type, changes, metadata, organization_id, ip_address,
  user_agent FROM audit_log ${ciId ? 'WHERE entity_id = $1' : ''} ORDER BY timestamp, id`, ciId ? [ciId] : []);
const summary = async (ciId: string) => (await audit(ciId)).map(row => [row['action'], row['actor'], row['changes']]);
const history = (ciId: string) => rows('SELECT change_type FROM ci_change_history WHERE ci_id = $1', [ciId]);
/** An owned CI already in the graph. */
function seed(org: string): string {
  const id = randomUUID();
  mockGraph.nodes.set(id, { id, organization_id: org, name: 'seeded', type: 'server', incarnation_id: randomUUID() });
  return id;
}
const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['audit_log', 'cmdb.dim_ci', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts',
    'reconciliation_rules', 'source_authority', 'ci_change_history'];
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...tables.map(table =>
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]),
  // The delete T2 purges these derived tables; only the purge columns matter here.
  ...['drift_detection_results (ci_id', 'baseline_snapshots (ci_id', 'impact_analyses (source_ci_id', 'ci_criticality_scores (ci_id']
    .map(table => `CREATE TABLE ${table} text, organization_id uuid, ci_incarnation_id uuid);`)].join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) {
    await mockSql(readFileSync(join(migrations, file), 'utf8'), [], 'exec');
  }
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
    CHECK (organization_id IS NOT NULL) NOT VALID`, [], 'exec'); // 025, 036 (S4a)
});
afterAll(() => { host.kill(); });

// The D2 cases run first: the audit chain kernel is memoized once the key is present.
it('D2: without AUDIT_CHAIN_KEY a CI create, update or delete is 503 before T1: no journal row, graph write or audit row', async () => {
  const owned = seed(A);
  const statuses = [(await post('a', { name: 'n', type: 'server' })).status, (await put('a', owned, { name: 'x' })).status,
    (await del('a', owned)).status];
  expect(statuses).toEqual([503, 503, 503]);
  expect([await rows('SELECT id FROM ci_reconciliation_operations'), await audit(), mockGraph.writes, mockGraph.nodes.get(owned)?.['name']])
    .toEqual([[], [], [], 'seeded']);
});

it('D2: recovery without AUDIT_CHAIN_KEY leaves an audited pending op pending (backoff): never committed unaudited, never failed', async () => {
  const [ci, op] = [seed(A), randomUUID()];
  mockGraph.fences.set(op, { outcome: 'applied', org: A, ci, operation: 'direct_write' });
  await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation, graph_effect,
    state, actor, epoch, plan, lease_expires_at) VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'actor-a', 0,
    $4::jsonb, now() - interval '1 minute')`, [op, A, ci, JSON.stringify({ graph: null, audit: { action: 'UPDATE', changes: [] } })]);
  await getNeo4jClient().journal.sweep(op);
  expect([await rows('SELECT state, claim_token, lease_expires_at > now() AS backed_off FROM ci_reconciliation_operations WHERE id = $1',
    [op]), await audit()]).toEqual([[{ state: 'pending', claim_token: null, backed_off: true }], []]);
});

describe('with AUDIT_CHAIN_KEY', () => {
  beforeAll(() => { process.env['AUDIT_CHAIN_KEY'] = randomBytes(32).toString('hex'); });

  it('CREATE: one chained row by the verified actor, bound to the org and the journal group, served by GET /:id/audit; no history (H-6)', async () => {
    const res = await post('a', { name: 'created', type: 'server' });
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    const [journal] = await rows(`SELECT group_id FROM ci_reconciliation_operations WHERE ci_id = $1 AND state = 'committed'`, [id]);
    const [row, ...extra] = await audit(id);
    expect(extra).toEqual([]);
    expect(row).toMatchObject({ action: 'CREATE', actor: 'actor-a', actor_type: 'user', organization_id: A, ip_address: null,
      user_agent: null, metadata: { organization_id: A, correlation_id: journal!['group_id'] } });
    expect(row!['changes']).toContainEqual({ field: 'name', old_value: null, new_value: 'created' });
    expect(await history(id)).toEqual([]);
    const read = await request(app).get(`/api/v1/cis/${id}/audit`).set(headers('a'));
    expect([read.status, read.body.data]).toEqual([200, [expect.objectContaining({ action: 'CREATE', actor: 'actor-a' })]]);
  });

  it('UPDATE: one row of the changed keys only; a no-op PUT is still audited, with empty changes (D5); no history (H-6)', async () => {
    const id = seed(A);
    expect((await put('a', id, { name: 'renamed', type: 'server' })).status).toBe(200);
    expect((await put('a', id, { name: 'renamed' })).status).toBe(200);
    expect(await summary(id)).toEqual([
      ['UPDATE', 'actor-a', [{ field: 'name', old_value: 'seeded', new_value: 'renamed' }]], ['UPDATE', 'actor-a', []]]);
    expect(await history(id)).toEqual([]);
  });

  it('DELETE: one row with the previous snapshot, readable through AuditService (D7); the whole chain verifies', async () => {
    const id = seed(A);
    expect((await del('a', id)).status).toBe(204);
    const service = getAuditService(getPostgresClient().pool);
    const [entry, ...extra] = await service.getCIAuditHistory(id, A);
    expect(extra).toEqual([]);
    expect(entry).toMatchObject({ action: 'DELETE', actor: 'actor-a', actor_type: 'user' });
    expect(entry!.changes).toContainEqual({ field: 'name', old_value: 'seeded', new_value: null });
    expect(await rows(`SELECT actor FROM audit_log WHERE actor <> 'actor-a'`)).toEqual([]);
    expect(await service.verifyAuditChain()).toMatchObject({ ok: true });
  });

  it('a W left pending by an unproven outcome is audited once, by the original actor, when recovery commits it', async () => {
    const id = seed(A);
    setJournalSeam(async point => { if (point === 'afterW') throw new Error('reply lost'); });
    const res = await put('a', id, { name: 'recovered' });
    setJournalSeam(undefined);
    expect([res.status, await audit(id)]).toEqual([503, []]);
    await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute' WHERE ci_id = $1`, [id]);
    await getNeo4jClient().journal.sweep();
    await getNeo4jClient().journal.sweep();
    expect(await summary(id)).toEqual([['UPDATE', 'actor-a', [{ field: 'name', old_value: 'seeded', new_value: 'recovered' }]]]);
  });

  it('a refused, invalid, foreign, missing or gapped write appends no audit row', async () => {
    const [gapped, foreign, body] = [seed(A), seed(B), { name: 'n', type: 'server' }];
    await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation, graph_effect,
      state, actor, epoch, lease_expires_at) VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'actor-a', 0,
      now() + interval '1 hour')`, [randomUUID(), A, gapped]);
    const before = (await audit()).length;
    const cases: Array<[string, () => request.Test, number]> = [
      ['viewer', () => post('viewer', body), 403], ['org-less', () => post('none', body), 403],
      ['client id', () => post('a', { ...body, id: 'chosen' }), 400], ['org', () => post('a', { ...body, organization_id: B }), 400],
      ['foreign PUT', () => put('a', foreign, { name: 'x' }), 404], ['foreign DELETE', () => del('a', foreign), 404],
      ['missing PUT', () => put('a', randomUUID(), { name: 'x' }), 404], ['missing DELETE', () => del('a', randomUUID()), 404],
      ['gap', () => put('a', gapped, { name: 'x' }), 409],
    ];
    const statuses: Array<[string, number]> = [];
    for (const [name, send] of cases) statuses.push([name, (await send()).status]);
    expect(statuses).toEqual(cases.map(([name, , status]) => [name, status]));
    expect((await audit()).length).toBe(before);
  });

  it('D4: ITIL-style updateCIProperties, restore and relationship writes commit without an audit row', async () => {
    const graph = getNeo4jClient();
    const [from, to] = [seed(A), seed(A)];
    const before = (await audit()).length;
    expect(await graph.updateCIProperties(from, { itil_lifecycle: 'retired' }, A, 'actor-a')).toMatchObject({ itil_lifecycle: 'retired' });
    expect(await graph.restoreCI(from, { name: 'restored' }, null, null, A, 'actor-a')).toMatchObject({ name: 'restored' });
    expect(await graph.writeRelationship('relationship_create', from, to, 'DEPENDS_ON', A, 'actor-a')).toBe(true);
    expect((await audit()).length).toBe(before);
  });
});
