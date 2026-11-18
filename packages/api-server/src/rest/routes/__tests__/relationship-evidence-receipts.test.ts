// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2029: a journaled relationship write appends exactly one server-assigned evidence receipt in T2 (a create
 * `supports`, a delete `contradicts`), stamped from the journal row, never from the request; the receipt is replay
 * idempotent, schema-gated and append-only; GET /relationships/evidence reads one edge's receipts for the caller's
 * organization only, fenced by both endpoints' current incarnations. Mounted ciRoutes and relationshipRoutes with real
 * JWT auth, the production journal, Neo4jClient and AuditService on PGlite (migrations 003/011/028/029/037/054);
 * Neo4j is an in-memory node and edge map.
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
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<{ rows: Record<string, any>[]; rowCount: number }>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}
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
  writes: [] as string[], edges: new Map<string, Record<string, unknown>>() };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const { randomUUID: uuid } = jest.requireActual('crypto');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owner = (id: unknown) => mockGraph.nodes.get(id as string)?.['organization_id'];
  const edgeKey = (query: string, params: Record<string, any>) => `${params['from']}|${/\[r:(\w+)\]/.exec(query)![1]}|${params['to']}`;
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
        mockGraph.nodes.set(params['id'], { ...params['props'], id: params['id'], organization_id: params['org'], incarnation_id: uuid() });
      } else if (query.includes('DETACH DELETE')) {
        if (applied) mockGraph.nodes.delete(params['id']);
      } else if ('from' in params) { // relationship_create MERGEs the edge; relationship_delete needs it to exist
        const key = edgeKey(query, params);
        applied = owner(params['from']) === params['org'] && owner(params['to']) === params['org'];
        if (applied && query.includes('MERGE (a)')) mockGraph.edges.set(key, { ...mockGraph.edges.get(key), ...params['props'] });
        else if (applied) applied = mockGraph.edges.delete(key);
      } else if (applied) Object.assign(mockGraph.nodes.get(params['id'])!, params['props']);
      for (const fence of applied ? params['fences'] : []) {
        mockGraph.fences.set(fence.op_id, { outcome: 'applied', org: params['org'], ci: fence.ci_id, operation: fence.operation });
      }
      return { records: [record({ fences_created: applied ? params['fences'].length : 0 })] };
    }
    const node = owner(params['id']) === params['organizationId'] ? mockGraph.nodes.get(params['id']) : undefined;
    if (query.includes('SET ci.incarnation_id = coalesce')) { // ensureCIIncarnation
      if (node) node['incarnation_id'] ??= uuid();
      return { records: node ? [record({ incarnationId: node['incarnation_id'] })] : [] };
    }
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    throw new Error(`unexpected statement: ${query}`);
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));
const users: Record<string, { _id: string; _username: string; _role: 'admin' | 'viewer'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'actor-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  b: { _id: 'actor-b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: B },
  viewer: { _id: 'actor-v', _username: 'vera', _role: 'viewer', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { getNeo4jClient, setJournalSeam } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { resolvers } from '../../../graphql/resolvers';
import { ciRoutes } from '../ci.routes';
import { relationshipRoutes } from '../relationship.routes';
import { receiptTableSql } from './fixtures/app-login';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
// Every request also carries a forged actor header; only the verified token subject may be recorded.
const headers = (user: string) => ({ 'x-actor': 'forged-admin', authorization: `Bearer ${jwt.generateAccessToken(
  users[user]!._id, users[user]!._username, users[user]!._role, users[user]!._organizationId, 0, Math.floor(Date.now() / 1000))}` });
const create = (user: string, from: string, to: string, extra: object = {}) =>
  request(app).post('/api/v1/relationships').set(headers(user)).send({ from_id: from, to_id: to, type: 'DEPENDS_ON', ...extra });
const remove = (user: string, from: string, to: string) =>
  request(app).delete('/api/v1/relationships').query({ from_id: from, to_id: to, type: 'DEPENDS_ON' }).set(headers(user));
const evidence = (user: string, query: Record<string, string | number | undefined>) =>
  request(app).get('/api/v1/relationships/evidence').query(query).set(headers(user));
const read = (user: string, from: string, to: string, extra: Record<string, string | number> = {}) =>
  evidence(user, { from_id: from, to_id: to, type: 'DEPENDS_ON', ...extra });
const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const receipts = (from: string, to: string) => rows(`SELECT * FROM relationship_evidence_receipts
  WHERE from_ci_id = $1 AND to_ci_id = $2 ORDER BY observed_at, receipt_id`, [from, to]);
const addAudit = (id: string) => rows(`SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'RELATIONSHIP_ADD'`, [id]);
const NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };
/** An owned CI already in the graph; `incarnation: false` is a legacy CI that predates incarnation ids. */
function seed(org: string | undefined, incarnation = true): string {
  const id = randomUUID();
  mockGraph.nodes.set(id, { id, ...(org ? { organization_id: org } : {}), name: 'seeded', type: 'server',
    ...(incarnation ? { incarnation_id: randomUUID() } : {}) });
  return id;
}
const incarnation = (id: string) => mockGraph.nodes.get(id)?.['incarnation_id'];
const edge = (from: string, to: string) => `${from}|DEPENDS_ON|${to}`;
const TABLE_AWAY = 'ALTER TABLE relationship_evidence_receipts RENAME TO relationship_evidence_receipts_away';
const TABLE_BACK = 'ALTER TABLE relationship_evidence_receipts_away RENAME TO relationship_evidence_receipts';
const expireLeases = (ids: string[]) => rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute'
  WHERE ci_id = ANY($1::text[])`, [ids]);
const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['audit_log', 'cmdb.dim_ci', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts',
    'reconciliation_rules', 'source_authority', 'ci_change_history'];
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...tables.map(table =>
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]),
  ...['drift_detection_results (ci_id', 'baseline_snapshots (ci_id', 'impact_analyses (source_ci_id', 'ci_criticality_scores (ci_id']
    .map(table => `CREATE TABLE ${table} text, organization_id uuid, ci_incarnation_id uuid);`)].join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) {
    await mockSql(readFileSync(join(migrations, file), 'utf8'), [], 'exec');
  }
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
    CHECK (organization_id IS NOT NULL) NOT VALID`, [], 'exec'); // 025, 036 (S4a)
  await mockSql(receiptTableSql(), [], 'exec');
});
afterAll(() => { host.kill(); });
afterEach(() => setJournalSeam(undefined));

// Runs first: the journal caches its schema readiness, so this is the cold gate.
it('schema gate: without the receipt table a relationship write is 503 before T1 and writes no edge; CI writes do not need it', async () => {
  const [from, to] = [seed(A), seed(A)];
  await rows(TABLE_AWAY);
  try {
    const res = await create('a', from, to);
    expect([res.status, res.body.correlation_id]).toEqual([503, undefined]); // no group id: refused before T1
    expect([await rows('SELECT id FROM ci_reconciliation_operations WHERE ci_id = ANY($1::text[])', [[from, to]]),
      mockGraph.edges.size, mockGraph.writes]).toEqual([[], 0, []]);
    const id = (await request(app).post('/api/v1/cis').set(headers('a')).send({ name: 'n', type: 'server' })).body.data.id as string;
    expect([(await request(app).put(`/api/v1/cis/${id}`).set(headers('a')).send({ name: 'renamed' })).status,
      (await request(app).delete(`/api/v1/cis/${id}`).set(headers('a'))).status]).toEqual([200, 204]);
  } finally {
    await rows(TABLE_BACK);
  }
  expect((await create('a', from, to)).status).toBe(201);
});

describe('receipt append (T2)', () => {
  it('REST create writes one receipt stamped from the verified principal, bound to both incarnations, joined to the audit rows', async () => {
    const [from, to] = [seed(A), seed(A)];
    const res = await create('a', from, to);
    expect(res.status).toBe(201);
    const [receipt, ...more] = await receipts(from, to);
    expect(more).toEqual([]);
    expect(receipt).toMatchObject({ organization_id: A, from_ci_id: from, to_ci_id: to, from_incarnation_id: incarnation(from),
      to_incarnation_id: incarnation(to), relationship_type: 'DEPENDS_ON', evidence_class: 'declared', polarity: 'supports',
      source_name: 'api', source_id: null, source_version: null, method: 'api', rationale_code: null,
      observer: 'actor-a', observer_type: 'user' });
    expect(new Date(receipt!['observed_at'] as Date).getFullYear()).toBeGreaterThanOrEqual(2026);
    expect([(await addAudit(from)).map(row => row['metadata'].correlation_id), (await addAudit(to)).map(row => row['metadata'].correlation_id)])
      .toEqual([[receipt!['correlation_id']], [receipt!['correlation_id']]]);
  });

  it('GraphQL createRelationship and deleteRelationship write the same declared receipts by the verified user', async () => {
    const [from, to] = [seed(A), seed(A)];
    const loader = { clear: () => undefined };
    const context = { _neo4jClient: getNeo4jClient(), user: { _userId: 'actor-a', _username: 'alice', _role: 'admin', _type: 'access' as const,
      _organizationId: A }, _loaders: { _ciLoader: loader, _relationshipLoader: loader, _dependentLoader: loader } };
    const mutation = resolvers.Mutation as Record<string, (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>>;
    await mutation['createRelationship']!(null, { input: { _fromId: from, _toId: to, _type: 'DEPENDS_ON' } }, context);
    await mutation['deleteRelationship']!(null, { fromId: from, toId: to, type: 'DEPENDS_ON' }, context);
    expect((await receipts(from, to)).map(row => [row['polarity'], row['evidence_class'], row['source_name'], row['method'], row['observer'],
      row['observer_type'], row['from_incarnation_id'], row['to_incarnation_id']])).toEqual([
      ['supports', 'declared', 'api', 'api', 'actor-a', 'user', incarnation(from), incarnation(to)],
      ['contradicts', 'declared', 'api', 'api', 'actor-a', 'user', incarnation(from), incarnation(to)]]);
  });

  it('DELETE appends a contradicts receipt and leaves the earlier supports row untouched; a repeated create is another supports row', async () => {
    const [from, to] = [seed(A), seed(A)];
    await create('a', from, to);
    const [supports] = await receipts(from, to);
    expect((await remove('a', from, to)).status).toBe(200);
    expect((await create('a', from, to)).status).toBe(201);
    const all = await receipts(from, to);
    expect(all.map(row => row['polarity'])).toEqual(['supports', 'contradicts', 'supports']);
    expect(all[0]).toEqual(supports);
    expect(new Set(all.map(row => row['correlation_id'])).size).toBe(3);
    expect(all[1]).toMatchObject({ evidence_class: 'declared', source_name: 'api', method: 'api', observer: 'actor-a', observer_type: 'user' });
  });

  it('a DELETE of an edge that does not exist answers 404 and writes no receipt', async () => {
    const [from, to] = [seed(A), seed(A)];
    const res = await remove('a', from, to);
    expect([res.status, res.body.message, await receipts(from, to)]).toEqual([404, 'Relationship not found', []]);
  });

  it('a refused or failed write (foreign endpoint, missing endpoint, invalid type, reserved key) writes no receipt', async () => {
    const [own, foreign, missing] = [seed(A), seed(B), randomUUID()];
    const attempts = [await create('a', own, foreign), await create('a', own, missing), await create('a', missing, own),
      await create('a', own, foreign, { type: 'NOT_A_TYPE' }), await create('a', own, seed(A), { organization_id: B })];
    expect(attempts.map(res => res.status)).toEqual([404, 404, 404, 400, 400]);
    expect(await rows('SELECT receipt_id FROM relationship_evidence_receipts WHERE from_ci_id = ANY($1::text[]) OR to_ci_id = ANY($1::text[])',
      [[own, foreign, missing]])).toEqual([]);
  });

  it('forgery: request properties and extra body keys never reach the descriptor, the class, the time or the organization', async () => {
    const [from, to] = [seed(A), seed(A)];
    const forged = { evidence_class: 'runtime_observed', source_name: 'forged', source_id: 'forged', source_version: '9', polarity: 'contradicts',
      method: 'forged', rationale_code: 'forged', observed_at: '2000-01-01T00:00:00Z', observer: 'mallory', correlation_id: randomUUID() };
    const res = await create('a', from, to, { properties: forged, ...forged });
    expect(res.status).toBe(201);
    expect(mockGraph.edges.get(edge(from, to))).toEqual(forged); // stored on the edge, never read for evidence
    const [receipt, ...more] = await receipts(from, to);
    expect(more).toEqual([]);
    expect(receipt).toMatchObject({ organization_id: A, evidence_class: 'declared', polarity: 'supports', source_name: 'api',
      source_id: null, source_version: null, method: 'api', rationale_code: null, observer: 'actor-a', observer_type: 'user' });
    expect(receipt!['correlation_id']).not.toBe(forged.correlation_id);
    expect((receipt!['observed_at'] as Date).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('a legacy CI without incarnation_id is assigned one by the write and the receipt carries it', async () => {
    const [from, to] = [seed(A, false), seed(A)];
    expect(incarnation(from)).toBeUndefined();
    expect((await create('a', from, to)).status).toBe(201);
    const [receipt] = await receipts(from, to);
    expect([typeof incarnation(from), receipt!['from_incarnation_id'], receipt!['to_incarnation_id']])
      .toEqual(['string', incarnation(from), incarnation(to)]);
  });

  it('an endpoint that disappears before the plan reads it is the 404 with no receipt, no edge and an aborted group', async () => {
    const [from, to, graph] = [seed(A, false), seed(A), getNeo4jClient()];
    const original = graph.getCIProperties.bind(graph);
    const spy = jest.spyOn(graph, 'getCIProperties').mockImplementationOnce(async (...args) => { // after admitOwned, inside the plan
      mockGraph.nodes.delete(from);
      return original(...args);
    });
    const res = await create('a', from, to);
    spy.mockRestore();
    expect([res.status, res.body.message, await receipts(from, to), mockGraph.edges.size > 0 && mockGraph.edges.has(edge(from, to)),
      (await rows('SELECT state FROM ci_reconciliation_operations WHERE ci_id = $1', [from])).map(row => row['state'])])
      .toEqual([404, 'CI not found', [], false, ['aborted']]);
  });
});

describe('atomicity and replay', () => {
  it('a T2 that never ran leaves the group pending and no receipt; the sweep writes exactly one, and a second sweep no more', async () => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    setJournalSeam(async point => { if (point === 'beforeT2') throw new Error('crash before T2'); });
    const lost = await create('a', from, to);
    setJournalSeam(undefined);
    expect([lost.status, typeof lost.body.correlation_id, await receipts(from, to)]).toEqual([503, 'string', []]);
    await expireLeases([from, to]);
    await graph.journal.sweep();
    await graph.journal.sweep();
    const all = await receipts(from, to);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ organization_id: A, polarity: 'supports', observer: 'actor-a', observer_type: 'user',
      correlation_id: lost.body.correlation_id, from_incarnation_id: incarnation(from), to_incarnation_id: incarnation(to) });
    expect((await rows('SELECT state, plan FROM ci_reconciliation_operations WHERE ci_id = $1', [from]))[0])
      .toEqual({ state: 'committed', plan: null });
  });

  it('a stored plan whose identical earlier attempt is already present replays to that one row (T2 replay is a no-op)', async () => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    setJournalSeam(async point => { if (point === 'afterW') throw new Error('reply lost'); });
    const lost = await create('a', from, to);
    setJournalSeam(undefined);
    expect(lost.status).toBe(503);
    const group = lost.body.correlation_id as string;
    const [stored] = await rows('SELECT plan->\'receipt\' AS receipt FROM ci_reconciliation_operations WHERE group_id = $1 LIMIT 1', [group]);
    expect(stored!['receipt']).toEqual({ from, to, fromIncarnationId: incarnation(from), toIncarnationId: incarnation(to), type: 'DEPENDS_ON',
      evidenceClass: 'declared', polarity: 'supports', sourceName: 'api', sourceId: null, sourceVersion: null, method: 'api', rationaleCode: null,
      observerType: 'user' });
    // The same content under the same key, stamped earlier: a crashed first T2 whose commit was lost.
    await rows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id, to_incarnation_id,
      relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type, correlation_id)
      VALUES ($1, $2, $3, $4, $5, 'DEPENDS_ON', 'declared', 'supports', 'api', 'api', now() - interval '1 day', 'actor-a', 'user', $6)`,
    [A, from, to, incarnation(from), incarnation(to), group]);
    const [earlier] = await receipts(from, to);
    await expireLeases([from, to]);
    await graph.journal.sweep();
    expect([await receipts(from, to), (await rows('SELECT state FROM ci_reconciliation_operations WHERE group_id = $1', [group])).map(row => row['state'])])
      .toEqual([[earlier], ['committed', 'committed']]); // one row, still the earlier receipt_id and observed_at
  });

  it('a T2 whose receipt insert fails leaves the group pending with no receipt; the sweep later writes exactly one', async () => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    await rows(TABLE_AWAY); // after the cold gate has cached readiness: W applies, then T2 cannot insert
    let failed;
    try {
      failed = await create('a', from, to);
    } finally {
      await rows(TABLE_BACK);
    }
    expect([failed.status, typeof failed.body.correlation_id, mockGraph.edges.has(edge(from, to)), await receipts(from, to),
      (await rows('SELECT state FROM ci_reconciliation_operations WHERE ci_id = $1', [from])).map(row => row['state'])])
      .toEqual([503, 'string', true, [], ['pending']]);
    await expireLeases([from, to]);
    await graph.journal.sweep();
    expect([(await receipts(from, to)).length, (await rows('SELECT state FROM ci_reconciliation_operations WHERE ci_id = $1', [from]))[0]!['state']])
      .toEqual([1, 'committed']);
  });
});

describe('GET /relationships/evidence', () => {
  it('answers a foreign, a NULL-owner and a missing endpoint with the same 404 body, whichever endpoint it is', async () => {
    const [own, foreign, orphan] = [seed(A), seed(B), seed(undefined)];
    const answers = [await read('a', own, foreign), await read('a', foreign, own), await read('a', own, orphan), await read('a', orphan, own),
      await read('a', own, randomUUID()), await read('a', randomUUID(), own), await read('b', own, foreign)];
    expect(answers.map(res => [res.status, res.body])).toEqual(answers.map(() => [404, NOT_FOUND]));
  });

  it("never lists another organization's receipt row, even one that names this edge's ids and incarnations", async () => {
    const [from, to] = [seed(A), seed(A)];
    await create('a', from, to);
    await rows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id, to_incarnation_id,
      relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type, correlation_id)
      VALUES ($1, $2, $3, $4, $5, 'DEPENDS_ON', 'declared', 'supports', 'planted', 'api', now(), 'planted-by-b', 'user', $6)`,
    [B, from, to, incarnation(from), incarnation(to), randomUUID()]);
    const res = await read('a', from, to);
    expect([res.status, res.body.data.receipts.map((receipt: Record<string, unknown>) => receipt['observer']), res.body.pagination.total])
      .toEqual([200, ['actor-a'], 1]);
    expect((await read('b', from, to)).status).toBe(404);
  });

  it("does not hand a re-created CI the old CI's receipts; its own new receipts are returned", async () => {
    const [from, to] = [seed(A), seed(A)];
    await create('a', from, to);
    expect((await read('a', from, to)).body.data.receipts).toHaveLength(1);
    const oldIncarnation = incarnation(from);
    mockGraph.nodes.set(from, { ...mockGraph.nodes.get(from)!, incarnation_id: randomUUID() }); // delete and re-create under the same id
    mockGraph.edges.delete(edge(from, to));
    expect(incarnation(from)).not.toBe(oldIncarnation);
    expect(await read('a', from, to)).toMatchObject({ status: 200, body: { data: { receipts: [] }, pagination: { total: 0, count: 0 } } });
    await create('a', from, to);
    const res = await read('a', from, to);
    expect([res.body.data.receipts.length, (await receipts(from, to)).length]).toEqual([1, 2]);
    expect((await receipts(from, to))[1]!['from_incarnation_id']).toBe(incarnation(from));
  });

  it('is newest first, paginates with total/count/offset/limit and never returns the organization or incarnation ids', async () => {
    const [from, to] = [seed(A), seed(A)];
    await create('a', from, to);
    await remove('a', from, to);
    await create('a', from, to, { properties: { note: 'again' } });
    const all = await receipts(from, to);
    const res = await read('viewer', from, to); // a viewer reads like any relationship read
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ from_id: from, to_id: to, type: 'DEPENDS_ON' });
    expect(res.body.data.receipts.map((receipt: Record<string, unknown>) => receipt['receipt_id']))
      .toEqual([all[2]!['receipt_id'], all[1]!['receipt_id'], all[0]!['receipt_id']]);
    expect(res.body.data.receipts[0]).toEqual({ receipt_id: all[2]!['receipt_id'], evidence_class: 'declared', polarity: 'supports',
      source_name: 'api', source_id: null, source_version: null, method: 'api', rationale_code: null,
      observed_at: (all[2]!['observed_at'] as Date).toISOString(), observer: 'actor-a', observer_type: 'user',
      correlation_id: all[2]!['correlation_id'] });
    const text = JSON.stringify(res.body);
    for (const secret of [A, 'organization_id', 'incarnation', incarnation(from), incarnation(to)]) expect(text).not.toContain(secret);
    const page = await read('a', from, to, { limit: 1, offset: 1 });
    expect([page.body.data.receipts.map((receipt: Record<string, unknown>) => receipt['polarity']), page.body.pagination])
      .toEqual([['contradicts'], { total: 3, count: 1, offset: 1, limit: 1 }]);
    expect((await read('a', from, to, { offset: 3 })).body).toMatchObject({ data: { receipts: [] }, pagination: { total: 3, count: 0 } });
    expect((await read('a', from, to)).body.pagination).toEqual({ total: 3, count: 3, offset: 0, limit: 50 });
  });

  it('owned CIs with no receipt are 200 with none, and a read assigns no incarnation to a legacy CI', async () => {
    const [from, to, legacy] = [seed(A), seed(A), seed(A, false)];
    expect(await read('a', from, to)).toMatchObject({ status: 200, body: { success: true, data: { receipts: [] },
      pagination: { total: 0, count: 0, offset: 0, limit: 50 } } });
    expect(await read('a', legacy, to)).toMatchObject({ status: 200, body: { data: { receipts: [] } } });
    expect(incarnation(legacy)).toBeUndefined();
  });

  it('refuses a missing or invalid type, limit above 200 and bad ids with 400; limit 200 is accepted', async () => {
    const [from, to] = [seed(A), seed(A)];
    const statuses = [await evidence('a', { from_id: from, to_id: to }), await read('a', from, to, { type: 'NOT_A_TYPE' }),
      await read('a', from, to, { limit: 201 }), await read('a', from, to, { limit: 0 }), await read('a', from, to, { offset: -1 }),
      await evidence('a', { to_id: to, type: 'DEPENDS_ON' }), await evidence('a', { from_id: from, type: 'DEPENDS_ON' }),
      await read('a', 'x'.repeat(256), to), await read('a', from, to, { limit: 200 })];
    expect(statuses.map(res => res.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 200]);
  });
});

describe('trusted descriptor', () => {
  it('is validated before T1: runtime_observed, inferred, bad tokens and oversize text throw with no journal row, graph write or receipt', async () => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    const write = (evidence: object) => graph.writeRelationship('relationship_create', from, to, 'DEPENDS_ON', A, 'actor-a', {}, undefined,
      'user', undefined, evidence as never);
    const bad = [{ evidenceClass: 'runtime_observed', sourceName: 'x', method: 'x' }, { evidenceClass: 'inferred', sourceName: 'x', method: 'x' },
      { evidenceClass: 'declared', sourceName: '', method: 'x' }, { evidenceClass: 'declared', sourceName: 'x', method: 'Not A Token' },
      { evidenceClass: 'declared', sourceName: 'x'.repeat(101), method: 'x' }, { evidenceClass: 'declared', sourceName: 'x', method: 'x', sourceId: 'x'.repeat(256) },
      { evidenceClass: 'declared', sourceName: 'x', method: 'x', rationaleCode: 'a b' }];
    const [outcomes, writesBefore] = [[] as string[], mockGraph.writes.length];
    for (const evidence of bad) outcomes.push(await write(evidence).then(() => 'written', (error: Error) => error.message));
    expect(outcomes).toEqual(bad.map(() => 'Invalid relationship evidence descriptor'));
    expect([mockGraph.writes.length - writesBefore, mockGraph.edges.has(edge(from, to)), await receipts(from, to),
      await rows('SELECT id FROM ci_reconciliation_operations WHERE ci_id = ANY($1::text[])', [[from, to]])]).toEqual([0, false, [], []]);
  });

  it('carries a static_observed descriptor with its source, version and rationale onto the receipt', async () => {
    const [from, to] = [seed(A), seed(A)];
    await getNeo4jClient().writeRelationship('relationship_create', from, to, 'USES', A, 'sync:c4_releases', {}, undefined, 'system', undefined,
      { evidenceClass: 'static_observed', sourceName: 'ai_sync', sourceId: 'c4_releases', sourceVersion: 'v2', method: 'ai_sync', rationaleCode: 'release_pin' });
    expect((await rows('SELECT * FROM relationship_evidence_receipts WHERE from_ci_id = $1', [from]))[0]).toMatchObject({
      evidence_class: 'static_observed', polarity: 'supports', source_name: 'ai_sync', source_id: 'c4_releases', source_version: 'v2',
      method: 'ai_sync', rationale_code: 'release_pin', observer: 'sync:c4_releases', observer_type: 'system' });
  });
});

// HAP-2126 L2: ensureCIIncarnation returns an existing malformed value untouched; the fallback is validated like the first read.
describe('malformed stored incarnation id', () => {
  const MALFORMED = ['not-a-uuid', '', '00000000-0000-0000-0000-000000000000', 'ZZZZZZZZ-ZZZZ-4ZZZ-8ZZZ-ZZZZZZZZZZZZ'];
  const cases = MALFORMED.flatMap(bad => (['from', 'to'] as const).map(end => [bad, end] as const));

  it.each(cases)('a stored incarnation %j on the %s endpoint is the 404 before any write, and is not repaired', async (bad, end) => {
    const [from, to] = [seed(A), seed(A)];
    const broken = end === 'from' ? from : to;
    mockGraph.nodes.get(broken)!['incarnation_id'] = bad;
    const writes = mockGraph.writes.length;
    const res = await create('a', from, to);
    expect([res.status, res.body]).toEqual([404, NOT_FOUND]);
    expect([mockGraph.writes.length, mockGraph.edges.has(edge(from, to)), await receipts(from, to), await addAudit(from), await addAudit(to),
      (await rows('SELECT state FROM ci_reconciliation_operations WHERE ci_id = ANY($1::text[])', [[from, to]])).map(row => row['state']),
      incarnation(broken)]).toEqual([writes, false, [], [], [], ['aborted', 'aborted'], bad]);
  });

  it.each(cases)('DELETE of an existing edge with a stored incarnation %j on the %s endpoint is the 404 and keeps the edge', async (bad, end) => {
    const [from, to] = [seed(A), seed(A)];
    expect((await create('a', from, to)).status).toBe(201);
    mockGraph.nodes.get(end === 'from' ? from : to)!['incarnation_id'] = bad;
    const res = await remove('a', from, to);
    // The DELETE route answers every `false` (missing edge or endpoint) with its one 404.
    expect([res.status, res.body.message, mockGraph.edges.has(edge(from, to)), (await receipts(from, to)).map(row => row['polarity'])])
      .toEqual([404, 'Relationship not found', true, ['supports']]);
  });

  it('reobserveRelationship answers missing for such an endpoint and appends nothing', async () => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    mockGraph.nodes.get(to)!['incarnation_id'] = 'not-a-uuid';
    // The graph fake has no OPTIONAL MATCH, so the edge-exists read is answered here; the endpoint read is the real one.
    const exists = jest.spyOn(graph, 'relationshipExists').mockResolvedValue(true);
    try {
      const outcome = await graph.reobserveRelationship(from, to, 'DEPENDS_ON', A, 'sync', undefined,
        { evidenceClass: 'static_observed', sourceName: 'sync', method: 'static_analysis' });
      expect([outcome, await receipts(from, to)]).toEqual(['missing', []]);
    } finally {
      exists.mockRestore();
    }
  });

  it('controls: a well-formed uppercase UUID is accepted and recorded, and a legacy CI with none is still assigned one', async () => {
    const [from, to, legacy] = [seed(A), seed(A), seed(A, false)];
    const upper = randomUUID().toUpperCase();
    mockGraph.nodes.get(from)!['incarnation_id'] = upper;
    expect((await create('a', from, to)).status).toBe(201);
    expect((await receipts(from, to))[0]!['from_incarnation_id']).toBe(upper.toLowerCase());
    expect((await create('a', legacy, to)).status).toBe(201);
    expect(typeof incarnation(legacy)).toBe('string');
  });
});

// HAP-2126 L3: a row already under T2's key with different content must fail the write, never commit as if recorded.
describe('receipt conflict compare (T2)', () => {
  const base = (from: string, to: string, polarity = 'supports'): Record<string, unknown> => ({ from_incarnation_id: incarnation(from),
    to_incarnation_id: incarnation(to), evidence_class: 'declared', polarity, source_name: 'api', source_id: null, source_version: null,
    method: 'api', rationale_code: null, observer: 'actor-a', observer_type: 'user' });
  /** Seeds, as the superuser harness, a row with the group's key and T2's content except `override`; stamped a day earlier. */
  const plant = (from: string, to: string, group: string, content: Record<string, unknown>) => {
    const columns = Object.keys(content);
    return rows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, relationship_type, correlation_id,
      observed_at, ${columns.join(', ')}) VALUES ($1, $2, $3, 'DEPENDS_ON', $4, now() - interval '1 day',
      ${columns.map((_, i) => `$${i + 5}`).join(', ')})`, [A, from, to, group, ...columns.map(column => content[column])]);
  };
  const MISMATCHES: [string, unknown][] = [['from_incarnation_id', randomUUID()], ['to_incarnation_id', randomUUID()],
    ['evidence_class', 'static_observed'], ['polarity', 'contradicts'], ['source_name', 'other'], ['source_id', 'x'],
    ['source_version', '1'], ['method', 'other'], ['rationale_code', 'x'], ['observer', 'someone-else'], ['observer_type', 'system']];

  it.each(MISMATCHES)('a pre-existing row differing in %s is a 503 with the edge applied, the row untouched and the group failed by the sweep', async (column, value) => {
    const [from, to, graph] = [seed(A), seed(A), getNeo4jClient()];
    let seeded: Record<string, unknown>[] = [];
    setJournalSeam(async (point, { groupId, recovery }) => {
      if (point !== 'beforeT2' || recovery) return;
      await plant(from, to, groupId, { ...base(from, to), [column]: value });
      seeded = await receipts(from, to);
    });
    const res = await create('a', from, to);
    setJournalSeam(undefined);
    expect([res.status, typeof res.body.correlation_id]).toEqual([503, 'string']);
    expect(seeded).toHaveLength(1);
    const state = async () => [await receipts(from, to), await addAudit(from), await addAudit(to), mockGraph.edges.has(edge(from, to)),
      (await rows('SELECT state, last_error FROM ci_reconciliation_operations WHERE ci_id = ANY($1::text[])', [[from, to]]))];
    expect(await state()).toEqual([seeded, [], [], true, [{ state: 'pending', last_error: null }, { state: 'pending', last_error: null }]]);
    await expireLeases([from, to]);
    await graph.journal.sweep();
    expect(await state()).toEqual([seeded, [], [], true,
      [{ state: 'failed', last_error: 't2_failed' }, { state: 'failed', last_error: 't2_failed' }]]);
  });

  it('an identical earlier row (NULL source id, version and rationale, earlier observed_at) is a no-op: 201, the earlier row stays the only one', async () => {
    const [from, to] = [seed(A), seed(A)];
    let seeded: Record<string, unknown>[] = [];
    setJournalSeam(async (point, { groupId }) => {
      if (point !== 'beforeT2') return;
      await plant(from, to, groupId, base(from, to));
      seeded = await receipts(from, to);
    });
    const res = await create('a', from, to);
    setJournalSeam(undefined);
    expect(res.status).toBe(201);
    expect([await receipts(from, to), (await addAudit(from)).length, (await addAudit(to)).length]).toEqual([seeded, 1, 1]);
    expect(seeded).toHaveLength(1);
  });

  it('an identical earlier contradicts row is a no-op for DELETE too', async () => {
    const [from, to] = [seed(A), seed(A)];
    expect((await create('a', from, to)).status).toBe(201);
    let seeded: Record<string, unknown>[] = [];
    setJournalSeam(async (point, { groupId }) => {
      if (point !== 'beforeT2') return;
      await plant(from, to, groupId, base(from, to, 'contradicts'));
      seeded = (await receipts(from, to)).filter(row => row['polarity'] === 'contradicts');
    });
    const res = await remove('a', from, to);
    setJournalSeam(undefined);
    const all = await receipts(from, to);
    expect([res.status, all.filter(row => row['polarity'] === 'contradicts'), all.length]).toEqual([200, seeded, 2]);
    expect(seeded).toHaveLength(1);
  });
});
