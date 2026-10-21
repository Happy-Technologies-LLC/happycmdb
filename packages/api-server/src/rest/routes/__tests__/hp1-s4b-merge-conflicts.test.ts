// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S4b acceptance (v16 §7, §8; §15 R44-M2, C-1..13, X-8, H-5/6, N-5/6/10): mounted REST/GraphQL, the real
 * engine, journal and PostgreSQL (PGlite, migrations 011/028/029/037). Neo4j is an in-memory node map that
 * records every statement, so "no graph statement or fence" is observable.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
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
// The production PostgresClient and journal run on one PGlite session (requests are sequential).
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { mockGraph.sql.push(text); return mockSql(text, params); }
    async connect() { return { query: (text: string, params?: unknown[]) => (mockGraph.sql.push(text), mockSql(text, params)), release: () => undefined }; }
    async end() { return undefined; }
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});
const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), statements: [] as string[], sql: [] as string[] };
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const run = async (query: string, params: Record<string, any> = {}) => {
    mockGraph.statements.push(query);
    const owned = (id: string, org: string) => {
      const node = mockGraph.nodes.get(id);
      return node?.['organization_id'] === org ? node : undefined;
    };
    if (query.includes('SHOW CONSTRAINTS')) return { records: [record({ present: 1 })] };
    if (query.includes('SET ci += $props')) {
      const node = owned(params['id'], params['org']);
      if (node) Object.assign(node, params['props']);
      return { records: [record({ fences_created: node ? params['fences'].length : 0 })] };
    }
    const node = owned(params['id'], params['organizationId']);
    if (query.includes('properties(ci) AS props')) return { records: node ? [record({ props: { ...node } })] : [] };
    if (query.trim().endsWith('RETURN ci')) return { records: node ? [record({ ci: { properties: node } })] : [] };
    const attribute = /ci\.(\w+) = \$value/.exec(query)?.[1];
    if (!attribute) throw new Error(`unexpected statement: ${query}`);
    const hit = [...mockGraph.nodes.values()].find(candidate =>
      candidate['organization_id'] === params['organizationId'] && candidate[attribute] === params['value']);
    return { records: hit ? [record({ ci_id: hit['id'] })] : [] };
  };
  const driver = () => ({ session: () => ({ run, close: async () => undefined }), close: async () => undefined });
  return { __esModule: true, ...actual, default: { ...actual.default, driver }, driver };
});
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
const mockEmit = jest.fn(async () => []);
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual('@cmdb/event-processor'), getEventProducer: () => ({ emit: mockEmit }),
}));
const users: Record<string, { _id: string; _username: string; _role: 'admin' | 'operator'; _enabled: boolean; _organizationId: string }> = {
  a: { _id: 'actor-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  b: { _id: 'actor-b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: B },
  op: { _id: 'actor-op', _username: 'olga', _role: 'operator', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next() }));

import { loadConfig } from '@cmdb/common';
import { getNeo4jClient, setJournalSeam } from '@cmdb/database';
import { conflictHash } from '@cmdb/identity-resolution/engine/identity-reconciliation-engine';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import type { TokenPayload } from '../../../auth/types';
import { reconciliationRoutes } from '../reconciliation.routes';
import { reconciliationResolvers } from '../../../graphql/resolvers/reconciliation.resolvers';
import { reconciliationTypeDefs } from '../../../graphql/schema/reconciliation.schema';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);
let server: ApolloServer;
const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (user: string) => `Bearer ${jwt.generateAccessToken(users[user]!._id, users[user]!._username, users[user]!._role, users[user]!._organizationId)}`;
const api = (user: string) => ({
  get: (path: string) => request(app).get(`/api/v1/reconciliation/${path}`).set('authorization', bearer(user)),
  post: (path: string, body: object) => request(app).post(`/api/v1/reconciliation/${path}`).set('authorization', bearer(user)).send(body),
  put: (path: string, body: object) => request(app).put(`/api/v1/reconciliation/${path}`).set('authorization', bearer(user)).send(body),
  delete: (path: string) => request(app).delete(`/api/v1/reconciliation/${path}`).set('authorization', bearer(user)),
  gql: (query: string) => request(app).post('/graphql').set('authorization', bearer(user)).send({ query }),
});
const rows = async (text: string, params: unknown[] = []) => (await mockSql(text, params)).rows;
const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const REUSED = `s4b-reused-${randomUUID()}`;
/** An owned CI in the graph and the current CI dimension. */
async function ci(org: string, id = `s4b-${randomUUID()}`, props: Record<string, unknown> = {}): Promise<string> {
  mockGraph.nodes.set(id, { id, organization_id: org, name: id, serial_number: id, incarnation_id: randomUUID(), ...props });
  await rows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES ($1, $1, 'server', 'active', $2)`, [id, org]);
  return id;
}
const stored = (org: string | null, ciId: string, field: string, value: unknown, source: string) => rows(`INSERT INTO ci_field_sources
  (organization_id, ci_id, field_name, field_value, value_json, source_name) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
[org, ciId, field, String(value), JSON.stringify(value), source]);
const merge = (user: string, ciId: string, source: string, attributes: Record<string, unknown>) =>
  api(user).post('merge', { name: ciId, ci_type: 'server', source, source_id: `${source}-1`, identifiers: { serial_number: ciId }, attributes });
const journal = (ciId: string) => rows(`SELECT operation, graph_effect, state, actor, last_error, group_id
  FROM ci_reconciliation_operations WHERE ci_id = $1 ORDER BY created_at, id`, [ciId]);
const conflict = async (id: string) => (await rows('SELECT * FROM reconciliation_conflicts WHERE id = $1', [id]))[0]!;
const resolve = (user: string, id: string, body: object) => api(user).post(`conflicts/${id}/resolve`, body);
const graphWrites = () => mockGraph.statements.filter(statement => /SET ci \+=|ReconciliationOp/.test(statement));

beforeAll(async () => {
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['cmdb.dim_ci', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts', 'reconciliation_rules',
    'source_authority', 'ci_change_history'];
  await mockSql('CREATE SCHEMA cmdb; CREATE TABLE audit_log (id uuid);\n' + tables.map(table =>
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]).join('\n'), [], 'exec');
  await mockSql(readFileSync(join(migrations, '011_ci_organization_scope.sql'), 'utf8'), [], 'exec');
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID`, [], 'exec');
  // 037 is absent on the pre-S4b base, which is how this file is run fail-first. The legacy
  // NULL-org field source predates the 037 contract.
  for (const file of ['028_change_history_reconciliation_org_provenance.sql', '029_reconciliation_conflict_identity_rules.sql',
    '037_reconciliation_org_contract.sql'].filter(name => existsSync(join(migrations, name)))) {
    await mockSql(readFileSync(join(migrations, file), 'utf8'), [], 'exec');
    if (file.startsWith('029')) await stored(null, REUSED, 'owner', 'NULL_FIELD_SECRET', 'legacy');
  }
  await mockSql(`ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
    CHECK (organization_id IS NOT NULL) NOT VALID`, [], 'exec'); // 036 (S4a)
  server = new ApolloServer({
    typeDefs: [`scalar JSON\ntype Query { health: String }\ntype Mutation { health: String }`, reconciliationTypeDefs],
    resolvers: reconciliationResolvers,
  });
  await server.start();
  app.use('/graphql', express.json(), getAuthMiddleware().authenticate(), expressMiddleware(server, {
    context: async ({ req }) => ({ user: (req as Request & { user: TokenPayload }).user, _neo4jClient: getNeo4jClient() }),
  }));
});
afterAll(async () => { await server?.stop(); host.kill(); });
beforeEach(() => { mockEmit.mockClear(); });

// First in the file: the journal caches a passing §3.2 gate per process.
it('v16 §3.2: before 037 or 029/028 resolve, merge, match, the conflict list, the per-org policy routes and the lineage/field-source readers are 503 before any HP1 data query', async () => {
  // HAP-822: an owned CI with evidence, so an ungated reader would read Neo4j and PostgreSQL.
  const owned = await ci(A);
  await stored(A, owned, 'name', 'GATED_FIELD_SECRET', 'gate');
  for (const [down, up] of [
    ['ALTER TABLE ci_field_sources DROP CONSTRAINT ci_field_sources_organization_required',
      'ALTER TABLE ci_field_sources ADD CONSTRAINT ci_field_sources_organization_required CHECK (organization_id IS NOT NULL) NOT VALID'],
    ['ALTER TABLE ci_reconciliation_operations RENAME TO hp1_hidden; ALTER TABLE reconciliation_conflicts RENAME COLUMN organization_id TO hp1_org; ALTER TABLE ci_source_lineage RENAME COLUMN organization_id TO hp1_org; ALTER TABLE reconciliation_conflicts RENAME COLUMN field_name TO hp1_field',
      'ALTER TABLE hp1_hidden RENAME TO ci_reconciliation_operations; ALTER TABLE reconciliation_conflicts RENAME COLUMN hp1_org TO organization_id; ALTER TABLE ci_source_lineage RENAME COLUMN hp1_org TO organization_id; ALTER TABLE reconciliation_conflicts RENAME COLUMN hp1_field TO field_name'],
  ]) {
    await mockSql(down, [], 'exec');
    [mockGraph.sql.length, mockGraph.statements.length] = [0, 0];
    const rest = await resolve('a', randomUUID(), { resolution: 'accept_target', expected_revision: 'a'.repeat(64) });
    const gql = await api('a').gql(`mutation { _reconciliation { resolveConflict(_id: "${randomUUID()}",
      _resolution: "accept_target", _expectedRevision: "${'a'.repeat(64)}") { _status } } }`);
    const merged = await api('a').post('merge', { name: 'gate', ci_type: 'server', source: 'gate', source_id: 'gate-1', identifiers: { external_id: 'gate-1' } });
    const [rule, ruleId] = [{ name: 'gate', identification_rules: [] }, randomUUID()];
    const policy = [await api('a').get('conflicts'), await api('a').get('rules'), await api('a').post('rules', rule), await api('a').put(`rules/${ruleId}`, rule),
      await api('a').delete(`rules/${ruleId}`), await api('a').get('source-authorities'), await api('a').put('source-authorities/gate', { authority_score: 5 }),
      await api('a').post('match', { identifiers: { external_id: 'gate-1' } })];
    const reads = await api('a').gql('{ _reconciliation { findMatches(_identifiers: { _externalId: "gate-1" }) { _ciId } listConflicts { _id } } }');
    const evidence = [await api('a').get(`lineage/${owned}`), await api('a').get(`field-sources/${owned}`)];
    const evidenceGraph = await api('a').gql(`{ _reconciliation { getCILineage(_ciId: "${owned}") { _ciId }
      getCIFieldSources(_ciId: "${owned}") { _ciId } } }`);
    await mockSql(up, [], 'exec');
    expect([rest.status, gql.body.errors?.[0]?.extensions?.code, merged.status, ...policy.map(response => response.status)])
      .toEqual([503, 'SERVICE_UNAVAILABLE', 503, 503, 503, 503, 503, 503, 503, 503, 503]);
    expect(reads.body.errors?.map((error: { extensions: object }) => error.extensions)).toEqual([{ code: 'SERVICE_UNAVAILABLE' }, { code: 'SERVICE_UNAVAILABLE' }]);
    expect(evidence.map(response => [response.status, response.body])).toEqual([0, 1].map(() =>
      [503, { success: false, error: 'Service Unavailable', message: 'CI write temporarily unavailable' }]));
    expect(evidenceGraph.body.errors?.map((error: { message: string; extensions: object }) => [error.message, error.extensions]))
      .toEqual([0, 1].map(() => ['CI write temporarily unavailable', { code: 'SERVICE_UNAVAILABLE' }]));
    expect([mockGraph.sql.filter(text => !text.includes('to_regclass')), mockGraph.statements.filter(text => !text.startsWith('SHOW CONSTRAINTS'))])
      .toEqual([[], []]); // only the gate ran
  }
});

it('R44-M2: after B-delete/A-reuse of one CI id, A sees only its own field sources and lineage; B and legacy rows stay keyed', async () => {
  const X = REUSED;
  // Former owner B's retained evidence (plus the legacy row); X is now A's (B deleted it, A reused the id).
  await stored(B, X, 'name', 'B_FIELD_SECRET', 'b-source');
  await rows(`INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id, confidence_score)
    VALUES ($1, $2, 'b-source', 'B_LINEAGE_SECRET', 90)`, [B, X]);
  await rows(`INSERT INTO reconciliation_conflicts (organization_id, ci_id, conflict_type, source_data, status, detected_by)
    VALUES ($1, $2, 'field_conflict', '{"secret":"B_CONFLICT_SECRET"}', 'pending', 'actor-b')`, [B, X]);
  await ci(A, X);

  const merged = await merge('a', X, 'a-source', { name: 'a-only-value' });
  expect([merged.status, merged.body.data.ci_id, merged.body.data.action]).toEqual([200, X, 'updated']);
  const fields = await api('a').get(`field-sources/${X}`);
  expect(fields.body.data.fields).toEqual([expect.objectContaining({ field_name: 'name', field_value: 'a-only-value', source_name: 'a-source' })]);
  const lineage = await api('a').get(`lineage/${X}`);
  expect(lineage.body.data.sources).toEqual([expect.objectContaining({ source_name: 'a-source', source_id: 'a-source-1' })]);
  const graph = await api('a').gql(`{ _reconciliation { getCIFieldSources(_ciId: "${X}") { _fields { _fieldName _fieldValue _sourceName } }
    getCILineage(_ciId: "${X}") { _sources { _sourceId } } listConflicts { _id } } }`);
  expect(graph.body.data._reconciliation).toEqual({
    getCIFieldSources: { _fields: [{ _fieldName: 'name', _fieldValue: 'a-only-value', _sourceName: 'a-source' }] },
    getCILineage: { _sources: [{ _sourceId: 'a-source-1' }] }, listConflicts: [] });
  const conflicts = await api('a').get('conflicts');
  for (const body of [fields.body, lineage.body, graph.body, conflicts.body]) expect(JSON.stringify(body)).not.toMatch(/SECRET/);
  expect(conflicts.body.pagination.total).toBe(0);
  // Storage stays keyed by (organization, CI, field): B's and the legacy row are untouched.
  const [op] = await journal(X);
  expect(await rows(`SELECT organization_id, field_name, field_value, source_name, last_correlation_id FROM ci_field_sources
    WHERE ci_id = $1 ORDER BY organization_id NULLS LAST`, [X])).toEqual([
    { organization_id: A, field_name: 'name', field_value: 'a-only-value', source_name: 'a-source', last_correlation_id: op!.group_id },
    { organization_id: B, field_name: 'name', field_value: 'B_FIELD_SECRET', source_name: 'b-source', last_correlation_id: null },
    { organization_id: null, field_name: 'owner', field_value: 'NULL_FIELD_SECRET', source_name: 'legacy', last_correlation_id: null }]);
  expect(await rows(`SELECT organization_id, count(*)::int AS n FROM ci_source_lineage WHERE ci_id = $1 GROUP BY 1 ORDER BY 1`, [X]))
    .toEqual([{ organization_id: A, n: 1 }, { organization_id: B, n: 1 }]);
});

it('F6 C-2/C-3/C-4/C-13/X-8/H-5: a manual-review field holds the whole merge with stable ids; changed content is refused', async () => {
  const X = await ci(A, undefined, { name: 'stored', owner: 'kept' });
  await stored(A, X, 'name', 'stored', 'cmdb');
  await rows(`INSERT INTO reconciliation_rules (organization_id, name, identification_rules, merge_strategies)
    VALUES ($1, $2, '[]', '[{"field_name":"name","strategy":"manual_review"}]')`, [A, `review-${X}`]);
  const before = { ...mockGraph.nodes.get(X) };
  mockGraph.statements.length = 0;

  const held = await merge('op', X, 'scanner', { name: 'incoming', owner: 'scanner-owner' });
  expect(held.status).toBe(202);
  expect(held.body.data).toEqual({ ci_id: X, status: 'pending_review', conflict_ids: [expect.any(String)],
    correlation_id: expect.any(String) });
  const [id] = held.body.data.conflict_ids;
  // No graph statement, fence, field/lineage/history row or event: the node is byte-identical.
  expect(graphWrites()).toEqual([]);
  expect(mockGraph.nodes.get(X)).toEqual(before);
  expect(mockEmit).not.toHaveBeenCalled();
  expect(await rows('SELECT field_name, field_value FROM ci_field_sources WHERE ci_id = $1', [X])).toEqual([{ field_name: 'name', field_value: 'stored' }]);
  expect(await rows('SELECT 1 FROM ci_source_lineage WHERE ci_id = $1 UNION ALL SELECT 1 FROM ci_change_history WHERE ci_id = $1', [X])).toEqual([]);
  expect(await conflict(id)).toMatchObject({ organization_id: A, field_name: 'name', source_name: 'scanner', source_id: 'scanner-1',
    incoming_json: 'incoming', target_json: 'stored', target_source_name: 'cmdb', detected_by: 'actor-op', status: 'pending',
    correlation_id: held.body.data.correlation_id,
    content_hash: conflictHash('name', { value: 'stored' }, { value: 'incoming' }, 'scanner', 'scanner-1') });

  const again = await merge('op', X, 'scanner', { name: 'incoming' });
  expect([again.status, again.body.data.conflict_ids]).toEqual([202, [id]]);
  const original = await conflict(id);
  const changed = await merge('op', X, 'scanner', { name: 'changed' });
  expect([changed.status, changed.body]).toEqual([409, { success: false, error: 'Conflict', message: 'pending_content' }]);
  expect(await conflict(id)).toEqual(original);
  expect((await journal(X)).map(row => [row.operation, row.graph_effect, row.state, row.actor, row.last_error])).toEqual([
    ['hold', false, 'committed', 'actor-op', null], ['hold', false, 'committed', 'actor-op', null],
    ['update', true, 'aborted', 'actor-op', 'pending_content']]);
  await expect(rows(`UPDATE reconciliation_conflicts SET incoming_json = '"forged"' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '55000' });
  await expect(rows('DELETE FROM reconciliation_conflicts WHERE id = $1', [id])).rejects.toMatchObject({ code: '55000' });
});

it('X-1/v16 §4.3: a hold whose T2 is lost stays gated, then the sweep commits it from its plan without any fence', async () => {
  const X = await ci(A, undefined, { name: 'stored' });
  await stored(A, X, 'name', 'stored', 'cmdb');
  await rows(`INSERT INTO reconciliation_rules (organization_id, name, identification_rules, merge_strategies)
    VALUES ($1, $2, '[]', '[{"field_name":"name","strategy":"manual_review"}]')`, [A, `review-${X}`]);
  setJournalSeam(async (point, context) => {
    setJournalSeam(undefined);
    if (point === 'beforeT2' && !context.recovery) throw new Error('T2 acknowledgement lost');
  });
  const held = await merge('a', X, 'late-source', { name: 'late' });
  expect([held.status, held.body.correlation_id]).toEqual([503, expect.any(String)]);
  expect((await journal(X)).map(row => [row.operation, row.graph_effect, row.state])).toEqual([['hold', false, 'pending']]);
  expect((await api('a').get(`field-sources/${X}`)).status).toBe(409);
  mockGraph.statements.length = 0;
  await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute' WHERE ci_id = $1`, [X]);
  expect(await getNeo4jClient().journal.sweep()).toBe(1);
  expect(mockGraph.statements).toEqual([]);
  expect((await journal(X)).map(row => row.state)).toEqual(['committed']);
  expect(await rows('SELECT incoming_json, detected_by FROM reconciliation_conflicts WHERE ci_id = $1', [X]))
    .toEqual([{ incoming_json: 'late', detected_by: 'actor-a' }]);
});

it('F6 C-9: conflict hashes keep JSON types and part boundaries distinct', () => {
  const hash = (old: unknown, next: unknown, field = 'f', source = 's') => conflictHash(field, { value: old }, { value: next }, source, 'i');
  for (const [text, typed] of [['1', 1], ['[1,2]', [1, 2]], ['null', null], ['true', true]]) expect(hash(text, 'x')).not.toBe(hash(typed, 'x'));
  expect(hash('a\u001fb', 'c')).not.toBe(hash('a', 'b\u001fc'));
  expect(hash('a","b', 'c')).not.toBe(hash('a', 'b","c'));
  expect(conflictHash('f', null, { value: 'x' }, 's', 'i')).not.toBe(hash(null, 'x'));
});

it('F6 C-5/C-6/C-7/C-11/H-6: resolve needs the current revision of an owned conflict; every outcome writes its evidence', async () => {
  const X = await ci(A, undefined, { name: 'stored' });
  await stored(A, X, 'name', 'stored', 'cmdb');
  await rows(`INSERT INTO reconciliation_rules (organization_id, name, identification_rules, merge_strategies)
    VALUES ($1, $2, '[]', '[{"field_name":"name","strategy":"manual_review"}]')`, [A, `review-${X}`]);
  const hold = async (source: string, value: unknown) => (await merge('a', X, source, { name: value })).body.data.conflict_ids[0] as string;
  const [c1, c2] = [await hold('s1', 'v1'), await hold('s2', 'v2')];
  const revision = (await conflict(c1)).content_hash;

  expect((await resolve('a', c1, { resolution: 'accept_target' })).status).toBe(400);
  const wrong = await resolve('a', c1, { resolution: 'accept_target', expected_revision: 'f'.repeat(64) });
  expect([wrong.status, wrong.body.message]).toEqual([409, 'revision_mismatch']);
  const foreign = await resolve('b', c1, { resolution: 'accept_target', expected_revision: revision });
  const missing = await resolve('b', randomUUID(), { resolution: 'accept_target', expected_revision: revision });
  expect([foreign.status, foreign.text]).toEqual([404, missing.text]);
  mockGraph.statements.length = 0;
  const target = await api('a').gql(`mutation { _reconciliation { resolveConflict(_id: "${c1}", _resolution: "accept_target",
    _expectedRevision: "${revision}") { _status } } }`);
  expect(target.body.data._reconciliation.resolveConflict._status).toBe('RESOLVED');
  expect(graphWrites()).toEqual([]);
  expect(await conflict(c1)).toMatchObject({ status: 'resolved', resolution_action: 'accept_target', suppression_hash: revision, resolved_by: 'actor-a' });
  // C-6: the decided replay stays held at the target value.
  expect((await merge('a', X, 's1', { name: 'v1' })).status).toBe(200);
  expect(mockGraph.nodes.get(X)!['name']).toBe('stored');

  const source = await resolve('a', c2, { resolution: 'accept_source', expected_revision: (await conflict(c2)).content_hash });
  expect([source.status, source.body.data.status]).toEqual([200, 'resolved']);
  expect(mockGraph.nodes.get(X)!['name']).toBe('v2');
  const c3 = await hold('s3', 'v3');
  expect((await resolve('a', c3, { resolution: 'merge', merged_data: 'm', expected_revision: (await conflict(c3)).content_hash })).status).toBe(200);
  expect(mockGraph.nodes.get(X)!['name']).toBe('m');
  expect(await rows('SELECT field_value, source_name FROM ci_field_sources WHERE ci_id = $1 AND organization_id = $2', [X, A]))
    .toEqual([{ field_value: 'm', source_name: 'manual_resolution' }]);

  // C-11: the stored value moves on, so c4 is stale: only dismiss_stale applies; a new hold gets a new id.
  const c4 = await hold('s4', 'v4');
  const c4Revision = (await conflict(c4)).content_hash;
  expect((await resolve('a', c4, { resolution: 'dismiss_stale', expected_revision: c4Revision })).body.message).toBe('not_stale');
  expect((await merge('a', X, 'manual_resolution', { name: 'm2' })).status).toBe(200);
  const stale = await resolve('a', c4, { resolution: 'accept_target', expected_revision: c4Revision });
  expect([stale.status, stale.body.message]).toEqual([409, 'stale_conflict']);
  const dismissed = await resolve('a', c4, { resolution: 'dismiss_stale', expected_revision: c4Revision });
  expect([dismissed.status, dismissed.body.data.status]).toEqual([200, 'superseded']);
  expect(await conflict(c4)).toMatchObject({ status: 'superseded', incoming_json: 'v4', target_json: 'm' });
  expect(await rows(`SELECT change_type, organization_id, changed_by FROM ci_change_history WHERE ci_id = $1
    AND change_type = 'conflict_superseded'`, [X])).toEqual([{ change_type: 'conflict_superseded', organization_id: A, changed_by: 'actor-a' }]);
  expect(await hold('s4', 'v4')).not.toBe(c4);
});

it('N-5/N-6/N-10: rules and authorities are per organization; foreign, missing and legacy rules are one 404', async () => {
  await rows('DELETE FROM reconciliation_rules WHERE organization_id = $1', [A]);
  const [XA, XB] = [await ci(A), await ci(B)];
  for (const [org, X] of [[A, XA], [B, XB]] as const) {
    await stored(org, X, 'name', 'stored', 'cmdb');
    await stored(org, X, 'status', 'snow', 'servicenow');
  }
  await rows(`INSERT INTO reconciliation_rules (name, identification_rules, merge_strategies)
    VALUES ($1, '[]', '[{"field_name":"status","strategy":"manual_review"}]')`, [`legacy-${XA}`]);
  await rows(`INSERT INTO source_authority (source_name, authority_score) VALUES ('evilsrc', 10)`);
  const [legacy] = await rows('SELECT id FROM reconciliation_rules WHERE name = $1', [`legacy-${XA}`]);

  const rule = { name: 'review-name', identification_rules: [], merge_strategies: [{ field_name: 'name', strategy: 'manual_review' }] };
  expect((await api('op').post('rules', rule)).status).toBe(403);
  const created = await api('a').post('rules', rule);
  expect(created.status).toBe(201);
  expect((await api('a').put('source-authorities/scanner', { authority_score: 1 })).status).toBe(200);
  expect((await api('b').get('rules')).body.data).toEqual([]);
  expect((await api('a').get('rules')).body.data.map((row: { id: string }) => row.id)).toEqual([created.body.data.id]);
  expect((await api('a').get('rules?scope=global')).status).toBe(403);
  const missing = await api('b').put(`rules/${randomUUID()}`, rule);
  for (const response of [await api('b').put(`rules/${created.body.data.id}`, rule), await api('b').delete(`rules/${created.body.data.id}`),
    await api('a').put(`rules/${legacy!.id}`, rule), await api('a').delete(`rules/${legacy!.id}`)]) {
    expect([response.status, response.text]).toEqual([404, missing.text]);
  }

  // A's rule and authority, and the legacy rule/authority, have zero effect on B; legacy rows none on A.
  expect((await merge('b', XB, 'scanner', { name: 'b-new' })).status).toBe(200);
  expect((await merge('b', XB, 'evilsrc', { status: 'evil' })).status).toBe(200);
  expect([mockGraph.nodes.get(XB)!['name'], mockGraph.nodes.get(XB)!['status']]).toEqual(['b-new', undefined]);
  expect((await merge('a', XA, 'scanner', { name: 'a-new' })).status).toBe(202);
  expect((await merge('a', XA, 'evilsrc', { status: 'evil' })).status).toBe(200);
  expect(mockGraph.nodes.get(XA)!['status']).toBeUndefined();
  expect((await api('a').delete(`rules/${created.body.data.id}`)).status).toBe(204);
  await rows('DELETE FROM source_authority WHERE organization_id IS NULL');
});
