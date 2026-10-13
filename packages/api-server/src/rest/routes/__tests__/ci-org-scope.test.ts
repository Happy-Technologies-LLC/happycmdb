// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/cis, exercised through the real ciRoutes and
 * CIController behind the real AuthMiddleware/AuthService (JWT verification),
 * with the real Neo4jClient CI methods issuing their Cypher.
 *
 * Neo4j is replaced by an in-memory graph (`graph`) behind a fake driver
 * session. It recognises the statements the controller and Neo4jClient issue
 * and evaluates them over the graph, including each WHERE clause on
 * organization_id that the statement actually contains: a statement without
 * the tenant predicate matches every organization's nodes, exactly as Neo4j
 * would. The real-Neo4j counterpart is tests/integration/ci.api.test.ts.
 *
 * Also runs the backfill packages/database/src/neo4j/migrations/
 * 001_ci_organization_backfill.cypher statement by statement over the graph.
 */

import { randomBytes, randomUUID } from 'crypto';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import {
  Neo4jClient, CITraversalLimitError, createCITraversalWork,
} from '../../../../../database/src/neo4j/client';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// In-memory graph and fake driver
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
interface Edge { type: string; from: string; to: string; properties: Props }
const graph = { nodes: new Map<string, Props>(), edges: [] as Edge[] };
let queryCount = 0;

interface FakeRecord { keys: string[]; get(key: string): unknown }
const node = (props: Props) => ({ labels: ['CI'], properties: props });
const record = (row: Record<string, unknown>): FakeRecord => ({ keys: Object.keys(row), get: (key: string) => row[key] });
const num = (value: unknown): number => (neo4j.isInt(value) ? value.toNumber() : Number(value));

/** Predicates the statement actually contains (absent => matches every organization). */
function tenantPredicate(cypher: string, params: Props, variable: string): (props: Props) => boolean {
  return cypher.includes(`${variable}.organization_id = $organizationId`)
    ? props => props['organization_id'] === params['organizationId']
    : () => true;
}


function run(rawCypher: string, params: Props = {}): FakeRecord[] {
  const cypher = rawCypher.replace(/\s+/g, ' ').trim();
  const ciInScope = tenantPredicate(cypher, params, 'ci');

  if (cypher.startsWith('CREATE INDEX')) return [];

  // Backfill: MATCH (ci:CI) [WHERE <predicate>] SET ci.organization_id = '<uuid>' RETURN count(ci) AS <alias>.
  // Only an absent WHERE (every node) or exactly `ci.organization_id IS NULL` is modelled.
  const backfill = cypher.match(/^MATCH \(ci:CI\) (?:WHERE (.+) )?SET ci\.organization_id = '([^']+)' RETURN count\(ci\) AS (\w+)$/);
  if (backfill) {
    const [, predicate, organizationId, alias] = backfill;
    if (predicate !== undefined && predicate !== 'ci.organization_id IS NULL') {
      throw new Error(`fake Neo4j: unmodelled backfill predicate: ${predicate}`);
    }
    let changed = 0;
    for (const props of graph.nodes.values()) {
      if (predicate !== undefined && props['organization_id'] !== undefined) continue;
      props['organization_id'] = organizationId;
      changed++;
    }
    return [record({ [alias!]: neo4j.int(changed) })];
  }

  if (cypher.startsWith('CREATE (ci:CI')) {
    const id = params['id'] as string;
    if (graph.nodes.has(id)) {
      throw new Error(`Node(1) already exists with label \`CI\` and property \`id\` = '${id}'`);
    }
    const now = new Date().toISOString();
    const props: Props = {
      id, external_id: params['external_id'], name: params['name'], type: params['type'],
      status: params['status'], environment: params['environment'], created_at: now, updated_at: now,
      discovered_at: params['discovered_at'], discovery_provider: params['discovery_provider'],
      metadata: params['metadata'],
      organization_id: cypher.includes('organization_id: $organizationId') ? params['organizationId'] : undefined,
      incarnation_id: cypher.includes('incarnation_id: randomUUID()') ? randomUUID() : undefined,
    };
    // Neo4j does not store null-valued properties.
    for (const key of Object.keys(props)) if (props[key] === null || props[key] === undefined) delete props[key];
    graph.nodes.set(id, props);
    return [record({ ci: node(props) })];
  }

  if (cypher.includes('DETACH DELETE ci')) {
    const id = params['id'] as string;
    const props = graph.nodes.get(id);
    const matched = props !== undefined && ciInScope(props);
    if (matched) {
      graph.nodes.delete(id);
      graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
    }
    return matched ? [record({ deletedIncarnationId: props?.['incarnation_id'] ?? null })] : [];
  }

  if (cypher.includes('SET ci += $updates')) {
    const props = graph.nodes.get(params['id'] as string);
    if (props === undefined || !ciInScope(props)) return [];
    Object.assign(props, params['updates'], { updated_at: new Date().toISOString() });
    return [record({ ci: node(props) })];
  }

  if (cypher.startsWith('CALL db.index.fulltext.queryNodes')) {
    const term = String(params['query']).toLowerCase();
    const inScope = tenantPredicate(cypher, params, 'node');
    return [...graph.nodes.values()]
      .filter(props => String(props['name']).toLowerCase().includes(term) && inScope(props))
      .slice(0, num(params['limit']))
      .map(props => record({ node: node(props), score: 1 }));
  }

  if (cypher.startsWith('UNWIND $frontier AS sourceId')) {
    const sourceInScope = tenantPredicate(cypher, params, 'source');
    const targetInScope = tenantPredicate(cypher, params, 'target');
    const outgoing = cypher.includes('(source)-[relationship');
    const dependencyOnly = cypher.includes('relationship:DEPENDS_ON');
    const rows: FakeRecord[] = [];
    for (const sourceId of params['frontier'] as string[]) {
      const source = graph.nodes.get(sourceId);
      if (!source || !sourceInScope(source)) continue;
      for (const edge of graph.edges) {
        if (dependencyOnly && edge.type !== 'DEPENDS_ON') continue;
        const targetId = outgoing
          ? edge.from === sourceId && edge.to
          : edge.to === sourceId && edge.from;
        if (!targetId) continue;
        const target = graph.nodes.get(targetId);
        if (!target || !targetInScope(target)) continue;
        rows.push(record({
          source: node(source), target: node(target),
          relationship: { type: edge.type, properties: edge.properties },
          startNodeId: edge.from, endNodeId: edge.to,
        }));
      }
    }
    return rows.slice(0, num(params['rowLimit']));
  }

  if (cypher.startsWith('MATCH (ci:CI {id: $id})') && cypher.endsWith('RETURN ci')) {
    const props = graph.nodes.get(params['id'] as string);
    return props !== undefined && ciInScope(props) ? [record({ ci: node(props) })] : [];
  }

  if (cypher.startsWith('MATCH (ci:CI) WHERE') && cypher.includes('AS incarnationId')) {
    return [...graph.nodes.values()].filter(props => ciInScope(props)
      && (params['afterId'] === undefined || (typeof props['organization_id'] === 'string'
        && String(props['id']) > String(params['afterId']))))
      .sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
      .slice(0, num(params['rowLimit']))
      .map(props => record({ ciId: props['id'], incarnationId: props['incarnation_id'],
        ownerId: props['organization_id'], ciType: props['type'] }));
  }
  if (cypher.startsWith('MATCH (ci:CI) WHERE')) {
    const matches = [...graph.nodes.values()].filter(props =>
      ciInScope(props) &&
      ['type', 'status', 'environment'].every(f => params[f] === undefined || props[f] === params[f]) &&
      (params['search'] === undefined || String(props['name']).toLowerCase().includes(String(params['search']).toLowerCase()))
    );
    if (cypher.includes('count(ci) as total')) return [record({ total: neo4j.int(matches.length) })];
    const offset = num(params['offset']);
    return matches
      .sort((x, y) => String(x['name']).localeCompare(String(y['name'])))
      .slice(offset, offset + num(params['limit']))
      .map(props => record({ ci: node(props) }));
  }

  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}

let holdIncarnationRead: (() => Promise<void>) | undefined;
const fakeDriver = {
  session: () => ({
    // Plain functions (not jest.fn): the unit config resets mock implementations.
    run: async (cypher: string, params?: Props) => {
      queryCount++;
      if (cypher.includes('AS incarnationId') && !cypher.includes('ci.id > $afterId')) await holdIncarnationRead?.();
      return { records: run(cypher, params) };
    },
    close: async () => undefined,
  }),
  close: async () => undefined,
};

let auditHistoryReads = 0;
const auditService = {
  getCIAuditHistory: async () => {
    auditHistoryReads++;
    return [];
  },
};

// Real Neo4jClient, its driver swapped for the fake (constructing a driver opens no connection).
const neo4jClient = new Neo4jClient('bolt://127.0.0.1:1', 'unused', 'unused');
// `driver` is private: this unchecked view of the instance is the test seam that swaps it.
const driverSeam = neo4jClient as unknown as { driver: { close(): Promise<void> } };
void driverSeam.driver.close();
driverSeam.driver = fakeDriver;

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let sqlId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
  else reply.resolve(rows);
});
function sql(statement: string, params: unknown[] = []): Promise<unknown[]> {
  const id = sqlId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: 'query', sql: statement, params });
  return promise;
}
const pg = {
  query: async (statement: string, params: unknown[] = []) => ({ rows: await sql(statement, params) }),
  transaction: async <T>(callback: (client: { query: typeof pg.query }) => Promise<T>): Promise<T> => {
    await sql('BEGIN');
    try {
      const result = await callback(pg);
      await sql('COMMIT');
      return result;
    } catch (error) {
      await sql('ROLLBACK');
      throw error;
    }
  },
};
jest.mock('../../../../../database/src/postgres/client', () => ({ getPostgresClient: () => pg }));
jest.mock('@cmdb/database', () => ({
  CITraversalLimitError,
  createCITraversalWork,
  getNeo4jClient: () => neo4jClient,
  getPostgresClient: () => ({ ...pg, pool: pg }),
  getAuditService: () => auditService,
}));

// bcrypt's native binding is only used for password hashing/login, which the
// token verification path exercised here never calls.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';
import { createGraphQLServer } from '../../../graphql/server';

const BACKFILL = join(__dirname, '../../../../../database/src/neo4j/migrations/001_ci_organization_backfill.cypher');
const NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };
const derivedTables = [
  'baseline_snapshots', 'drift_detection_results', 'impact_analyses',
  'ci_criticality_scores', 'ci_change_history',
];
beforeAll(async () => {
  const ddl = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  for (const table of derivedTables) {
    const definition = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    if (!definition) throw new Error(`Missing production table ${table}`);
    await sql(definition[0]);
  }
  for (const statement of readFileSync(
    join(__dirname, '../../../../../database/src/postgres/migrations/025_ci_derived_incarnation.sql'), 'utf8'
  ).split(';').map(part => part.trim()).filter(Boolean)) await sql(statement);
});
afterAll(() => { host.kill(); });

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, 'operator', organizationId)}`,
});
const AS_A = bearer('user-a', ORG_A);
const AS_B = bearer('user-b', ORG_B);
const NO_ORG = bearer('user-none');

// Mirrors server.ts: authenticate once on /api/v1, then the router.
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);

function seedCI(id: string, organizationId: string | undefined, extra: Props = {}): void {
  const props: Props = {
    id, name: id, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    discovered_at: '2026-01-01T00:00:00.000Z', metadata: '{}', ...extra,
  };
  if (organizationId !== undefined) props['organization_id'] = organizationId;
  graph.nodes.set(id, props);
}
const dependsOn = (from: string, to: string) => graph.edges.push({ type: 'DEPENDS_ON', from, to, properties: {} });

beforeEach(() => {
  graph.nodes.clear();
  graph.edges = [];
  // a-app -> a-db, b-app -> b-db, plus a legacy org-less CI.
  seedCI('ci-a-app', ORG_A);
  seedCI('ci-a-db', ORG_A, { name: 'a-database' });
  seedCI('ci-b-app', ORG_B);
  seedCI('ci-b-db', ORG_B, { name: 'b-database' });
  seedCI('ci-legacy', undefined, { name: 'legacy-database' });
  dependsOn('ci-a-app', 'ci-a-db');
  dependsOn('ci-b-app', 'ci-b-db');
  queryCount = 0;
  auditHistoryReads = 0;
  holdIncarnationRead = undefined;
});

it('caps graph incarnation enumeration before JSON/SQL analytics, including legacy unmarked nodes', async () => {
  const incarnationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (let i = 0; i < 510; i++) seedCI(`ci-analytics-${i}`, ORG_A, { incarnation_id: incarnationId });
  const before = queryCount;
  expect((await neo4jClient.listCIIncarnations(ORG_A)).length).toBe(510);
  expect(queryCount).toBe(before + 1);
  seedCI('ci-analytics-over', ORG_A);
  await expect(neo4jClient.listCIIncarnations(ORG_A)).rejects.toMatchObject({ name: 'CIAnalyticsLimitError' });
  expect(queryCount).toBe(before + 2);
});

it('bounds simultaneous incarnation reads independently of incoming request concurrency', async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  holdIncarnationRead = () => promise;
  try {
    const reads = Array.from({ length: 8 }, () => neo4jClient.listCIIncarnations(ORG_A));
    await expect(neo4jClient.listCIIncarnations(ORG_A)).rejects.toMatchObject({ name: 'CIAnalyticsLimitError' });
    expect(queryCount).toBe(8);
    resolve();
    await Promise.all(reads);
    await neo4jClient.listCIIncarnations(ORG_A);
    expect(queryCount).toBe(9);
  } finally {
    resolve();
    holdIncarnationRead = undefined;
  }
});

it('pages all organizations beyond 512 graph CIs without request admission or an unbounded result', async () => {
  graph.nodes.clear();
  for (let i = 0; i < 513; i++) seedCI(`ci-page-${String(i).padStart(4, '0')}`,
    i % 2 ? ORG_A : ORG_B, { incarnation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const pages: string[][] = [];
  for await (const page of neo4jClient.iterateUnscopedCIIncarnationPages()) {
    pages.push(page.map(ci => ci.ciId));
  }
  expect(pages.map(page => page.length)).toEqual([512, 1]);
  expect(new Set(pages.flat()).size).toBe(513);
  expect(queryCount).toBe(2);
  await expect(neo4jClient.listCIIncarnations(ORG_B)).resolves.toHaveLength(257);
});

it('does not let eight concurrent tenant analytics reads starve the background graph scan', async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  holdIncarnationRead = () => promise;
  try {
    const requests = Array.from({ length: 8 }, () => neo4jClient.listCIIncarnations(ORG_A));
    const pages = [];
    for await (const page of neo4jClient.iterateUnscopedCIIncarnationPages()) pages.push(page);
    expect(pages.flat()).toEqual([]);
    expect(queryCount).toBe(9);
    resolve();
    await Promise.all(requests);
  } finally {
    resolve();
    holdIncarnationRead = undefined;
  }
});

it('deletes all five persisted CI-derived families on the owning REST deletion path', async () => {
  const id = 'ci-reused';
  seedCI(id, ORG_A);
  await sql(`INSERT INTO baseline_snapshots
    (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved)
    VALUES ('11111111-1111-4111-8111-111111111111', $1, 'configuration', '{"owner":"A"}', NOW(), 'A', true)`, [id]);
  await sql(`INSERT INTO drift_detection_results
    (ci_id, has_drift, detected_at, baseline_snapshot_id)
    VALUES ($1, true, NOW(), '11111111-1111-4111-8111-111111111111')`, [id]);
  await sql(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at)
    VALUES ('22222222-2222-4222-8222-222222222222', $1, 'UPDATE', 'high', NOW())`, [id]);
  await sql(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at) VALUES ($1, '{"owner":"A"}', NOW())`, [id]);
  await sql(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata)
    VALUES ($1, 'UPDATE', 'test', '{"organization_id":"${ORG_A}"}')`, [id]);
  expect((await request(app).delete(`/api/v1/cis/${id}`).set(AS_B)).status).toBe(404);
  for (const table of derivedTables) {
    const column = table === 'impact_analyses' ? 'source_ci_id' : 'ci_id';
    expect(await sql(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id])).toHaveLength(1);
  }
  expect((await request(app).delete(`/api/v1/cis/${id}`).set(AS_A)).status).toBe(204);
  seedCI(id, ORG_B, { created_at: new Date().toISOString() });
  expect((await request(app).get(`/api/v1/cis/${id}`).set(AS_B)).status).toBe(200);
  for (const table of derivedTables) {
    const column = table === 'impact_analyses' ? 'source_ci_id' : 'ci_id';
    expect(await sql(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id])).toEqual([]);
  }
});

it('preserves every fresh B derivative when B reuses an ID between A graph deletion and SQL purge', async () => {
  const id = 'ci-delete-race';
  const aInc = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const bInc = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  seedCI(id, ORG_A, { incarnation_id: aInc });
  await sql(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id)
    VALUES ($1, 'A', 'test', '{}', $2)`, [id, aInc]);

  const original = pg.transaction;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  pg.transaction = async callback => {
    expect(graph.nodes.has(id)).toBe(false);
    entered.resolve();
    await release.promise;
    return original(callback);
  };
  try {
    const deleting = request(app).delete(`/api/v1/cis/${id}`).set(AS_A).then(response => response);
    await entered.promise;
    seedCI(id, ORG_B, { incarnation_id: bInc });
    await sql(`INSERT INTO baseline_snapshots
      (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, ci_incarnation_id)
      VALUES ('11111111-1111-4111-8111-111111111111', $1, 'configuration', '{}', NOW(), 'b', $2)`, [id, bInc]);
    await sql(`INSERT INTO drift_detection_results (ci_id, has_drift, detected_at, ci_incarnation_id)
      VALUES ($1, false, NOW(), $2)`, [id, bInc]);
    await sql(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id)
      VALUES ('22222222-2222-4222-8222-222222222222', $1, 'UPDATE', 'low', NOW(), $2)`, [id, bInc]);
    await sql(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at, ci_incarnation_id)
      VALUES ($1, '{}', NOW(), $2)`, [id, bInc]);
    await sql(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id)
      VALUES ($1, 'B', 'test', '{}', $2)`, [id, bInc]);
    release.resolve();
    expect((await deleting).status).toBe(204);
    for (const table of derivedTables) {
      const column = table === 'impact_analyses' ? 'source_ci_id' : 'ci_id';
      expect(await sql(`SELECT ci_incarnation_id FROM ${table} WHERE ${column} = $1`, [id]))
        .toEqual([{ ci_incarnation_id: bInc }]);
    }
    expect((await request(app).get(`/api/v1/cis/${id}`).set(AS_B)).status).toBe(200);
  } finally {
    release.resolve();
    pg.transaction = original;
  }
});

it('reports a committed graph deletion as successful if SQL defense-in-depth cleanup fails', async () => {
  const id = 'ci-delete-sql-down';
  seedCI(id, ORG_A, { incarnation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const original = pg.transaction;
  pg.transaction = async () => { throw new Error('PostgreSQL unavailable'); };
  try {
    expect((await request(app).delete(`/api/v1/cis/${id}`).set(AS_A)).status).toBe(204);
    expect((await request(app).delete(`/api/v1/cis/${id}`).set(AS_A)).status).toBe(404);
    expect(graph.nodes.has(id)).toBe(false);
  } finally {
    pg.transaction = original;
  }
});

it('GraphQL CI deletion shares cleanup and foreign/missing not-found behavior', async () => {
  const id = 'ci-graphql-deleted';
  seedCI(id, ORG_A);
  await sql(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata)
    VALUES ($1, 'UPDATE', 'test', '{"organization_id":"${ORG_A}"}')`, [id]);
  const gql = express();
  const { server } = await createGraphQLServer(gql);
  try {
    const del = (who: typeof AS_A) => request(gql).post('/graphql').set(who)
      .send({ query: `mutation { deleteCI(id: "${id}") }` });
    const foreign = await del(AS_B);
    const missing = await request(gql).post('/graphql').set(AS_B)
      .send({ query: 'mutation { deleteCI(id: "ci-absent") }' });
    expect(foreign.body.errors?.[0].extensions.code).toBe('NOT_FOUND');
    expect(missing.body.errors?.[0].extensions.code).toBe('NOT_FOUND');
    expect(await sql('SELECT 1 FROM ci_change_history WHERE ci_id = $1', [id])).toHaveLength(1);
    expect((await del(AS_A)).body.data).toEqual({ deleteCI: true });
    expect(await sql('SELECT 1 FROM ci_change_history WHERE ci_id = $1', [id])).toEqual([]);
  } finally {
    await server.stop();
  }
});

describe('/api/v1/cis tenant scoping', () => {
  it("GET /cis lists only the caller org's CIs", async () => {
    const res = await request(app).get('/api/v1/cis').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body.data.map((ci: { id: string }) => ci.id).sort()).toEqual(['ci-a-app', 'ci-a-db']);
    expect(res.body.pagination.total).toBe(2);
  });

  it("POST /cis/search returns only the caller org's matches", async () => {
    const res = await request(app).post('/api/v1/cis/search').set(AS_A).send({ query: 'database' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((hit: { ci: { id: string } }) => hit.ci.id)).toEqual(['ci-a-db']);
  });

  it('GET /cis/:id returns the same 404 for a foreign CI as for a missing one', async () => {
    const own = await request(app).get('/api/v1/cis/ci-a-app').set(AS_A);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe('ci-a-app');

    for (const suffix of ['', '/relationships', '/dependencies', '/impact', '/audit']) {
      const foreign = await request(app).get(`/api/v1/cis/ci-b-app${suffix}`).set(AS_A);
      const missing = await request(app).get(`/api/v1/cis/ci-nope${suffix}`).set(AS_A);
      expect([foreign.status, foreign.body]).toEqual([404, NOT_FOUND]);
      expect([missing.status, missing.body]).toEqual([404, NOT_FOUND]);
    }
    // The audit log is never read for a CI outside the caller's organization.
    expect(auditHistoryReads).toBe(0);
  });

  it('POST /cis assigns a tenant-scoped server ID and rejects chosen IDs and external IDs', async () => {
    const body = { name: 'new-server', type: 'server' };
    for (const id of ['ci-b-app', 'ci-nope']) {
      const refused = await request(app).post('/api/v1/cis').set(AS_A).send({ ...body, id });
      expect(refused.status).toBe(400);
    }
    for (const external_id of ['external-existing', 'external-missing']) {
      const refused = await request(app).post('/api/v1/cis').set(AS_A).send({ ...body, external_id });
      expect(refused.status).toBe(400);
    }
    const created = await request(app).post('/api/v1/cis').set(AS_A).send(body);
    const other = await request(app).post('/api/v1/cis').set(AS_B).send(body);
    expect([created.status, other.status]).toEqual([201, 201]);
    const id = created.body.data.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(other.body.data.id).not.toBe(id);
    expect(graph.nodes.get(id)!['organization_id']).toBe(ORG_A);
    expect((await request(app).get(`/api/v1/cis/${id}`).set(AS_B)).status).toBe(404);

    const smuggled = await request(app).post('/api/v1/cis').set(AS_A).send({ ...body, organization_id: ORG_B });
    expect(smuggled.status).toBe(400);
    const moved = await request(app).put(`/api/v1/cis/${id}`).set(AS_A).send({ organization_id: ORG_B });
    expect(moved.status).toBe(400);
    expect(graph.nodes.get(id)!['organization_id']).toBe(ORG_A);
  });

  it('PUT and DELETE on a foreign CI are 404 and change nothing', async () => {
    const before = JSON.stringify([[...graph.nodes.entries()], graph.edges]);

    const put = await request(app).put('/api/v1/cis/ci-b-app').set(AS_A).send({ name: 'renamed-by-a' });
    expect([put.status, put.body]).toEqual([404, NOT_FOUND]);
    const del = await request(app).delete('/api/v1/cis/ci-b-app').set(AS_A);
    expect([del.status, del.body]).toEqual([404, NOT_FOUND]);

    expect(JSON.stringify([[...graph.nodes.entries()], graph.edges])).toBe(before);

    // The owner can still update and delete it.
    expect((await request(app).put('/api/v1/cis/ci-b-app').set(AS_B).send({ name: 'renamed-by-b' })).status).toBe(200);
    expect((await request(app).delete('/api/v1/cis/ci-b-app').set(AS_B)).status).toBe(204);
    expect(graph.nodes.has('ci-b-app')).toBe(false);
  });

  it("GET /cis/:id/impact excludes other orgs' nodes", async () => {
    // Cross-org edges (as unscoped writers can create them):
    //   ci-b-app -> ci-a-db           (B depends on A's db: downstream of ci-a-db)
    //   ci-a-db -> ci-b-db -> ci-a-far (upstream of ci-a-db only through a B node)
    seedCI('ci-a-far', ORG_A);
    dependsOn('ci-b-app', 'ci-a-db');
    dependsOn('ci-a-db', 'ci-b-db');
    dependsOn('ci-b-db', 'ci-a-far');

    const res = await request(app).get('/api/v1/cis/ci-a-db/impact').set(AS_A);
    expect(res.status).toBe(200);
    expect(res.body.data.downstream.map((ci: { id: string }) => ci.id)).toEqual(['ci-a-app']);
    expect(res.body.data.upstream).toEqual([]);
    expect(res.body.totalImpacted).toBe(1);
  });

  it('GET /cis/:id/dependencies and /relationships never hop through another org', async () => {
    seedCI('ci-a-far', ORG_A);
    dependsOn('ci-a-app', 'ci-b-db');
    dependsOn('ci-b-db', 'ci-a-far');

    const deps = await request(app).get('/api/v1/cis/ci-a-app/dependencies').set(AS_A);
    expect(deps.status).toBe(200);
    const depNodes = deps.body.data.flatMap((p: { segments: Array<{ end: { properties: { id: string } } }> }) =>
      p.segments.map(s => s.end.properties.id));
    expect(depNodes).toEqual(['ci-a-db']);

    const rels = await request(app).get('/api/v1/cis/ci-a-app/relationships?direction=out').set(AS_A);
    expect(rels.status).toBe(200);
    expect(rels.body.data.map((r: { target_ci_id: string }) => r.target_ci_id)).toEqual(['ci-a-db']);

    const deep = await request(app).get('/api/v1/cis/ci-a-app/relationships?direction=out&depth=3').set(AS_A);
    expect(deep.status).toBe(200);
    expect(deep.body.data.map((r: { source_ci_id: string; target_ci_id: string }) =>
      `${r.source_ci_id}->${r.target_ci_id}`)).toEqual(['ci-a-app->ci-a-db']);
  });

  it('reports actual owned endpoints and objects for each two-hop relationship', async () => {
    seedCI('ci-a-cache', ORG_A);
    seedCI('ci-a-child', ORG_A);
    seedCI('ci-a-grandchild', ORG_A);
    dependsOn('ci-a-db', 'ci-a-cache');
    dependsOn('ci-a-child', 'ci-a-app');
    dependsOn('ci-a-grandchild', 'ci-a-child');
    dependsOn('ci-b-app', 'ci-a-cache');

    for (const [direction, expected] of [
      ['out', [['ci-a-app', 'ci-a-db'], ['ci-a-db', 'ci-a-cache']]],
      ['in', [['ci-a-child', 'ci-a-app'], ['ci-a-grandchild', 'ci-a-child']]],
    ] as const) {
      const response = await request(app)
        .get(`/api/v1/cis/ci-a-app/relationships?direction=${direction}&depth=2`).set(AS_A);
      expect(response.status).toBe(200);
      expect(response.body.data.map((edge: {
        id: string; source_ci_id: string; target_ci_id: string;
        source_ci: { id: string }; target_ci: { id: string };
      }) => [edge.id, edge.source_ci_id, edge.target_ci_id, edge.source_ci.id, edge.target_ci.id]))
        .toEqual(expected.map(([source, target]) =>
          [`${source}-DEPENDS_ON-${target}`, source, target, source, target]));
    }
  });

  it('403 with zero queries without an org claim', async () => {
    const routes: Array<[string, string, object | null]> = [
      ['get', '/api/v1/cis', null],
      ['post', '/api/v1/cis/search', { query: 'database' }],
      ['get', '/api/v1/cis/ci-legacy', null],
      ['post', '/api/v1/cis', { id: 'ci-x', name: 'x', type: 'server' }],
      ['put', '/api/v1/cis/ci-legacy', { name: 'y' }],
      ['delete', '/api/v1/cis/ci-legacy', null],
      ['get', '/api/v1/cis/ci-legacy/relationships', null],
      ['get', '/api/v1/cis/ci-legacy/dependencies', null],
      ['get', '/api/v1/cis/ci-legacy/impact', null],
      ['get', '/api/v1/cis/ci-legacy/audit', null],
    ];
    for (const [method, path, body] of routes) {
      const req = request(app)[method as 'get'](path).set(NO_ORG);
      const res = await (body === null ? req : req.send(body));
      expect([method, path, res.status, res.body]).toEqual([
        method, path, 403, { _error: 'Forbidden', _message: 'Organization claim required' },
      ]);
    }
    expect(queryCount).toBe(0);
    expect(auditHistoryReads).toBe(0);
    expect(graph.nodes.has('ci-legacy')).toBe(true);
  });
});

describe('backfill 001_ci_organization_backfill.cypher', () => {
  // Statements split the way cypher-shell -f reads them: on ';', comment lines dropped.
  const statements = () => readFileSync(BACKFILL, 'utf8')
    .split(';')
    .map(s => s.split('\n').filter(line => !line.trim().startsWith('//')).join('\n').trim())
    .filter(s => s.length > 0);
  const backfill = () => statements().flatMap(s => run(s)).map(r => num(r.get('backfilled')));
  const orgs = () => Object.fromEntries([...graph.nodes].map(([id, props]) => [id, props['organization_id']]));

  it('assigns org-less CIs to the internal org; nodes that already have an org are untouched', () => {
    expect(backfill()).toEqual([1]);
    expect(orgs()).toEqual({
      'ci-a-app': ORG_A, 'ci-a-db': ORG_A, 'ci-b-app': ORG_B, 'ci-b-db': ORG_B, 'ci-legacy': INTERNAL_ORG,
    });
  });

  it('second run changes nothing', () => {
    backfill();
    const after = JSON.stringify([...graph.nodes]);
    expect(backfill()).toEqual([0]);
    expect(JSON.stringify([...graph.nodes])).toBe(after);
  });
});

describe('infrastructure/scripts/init-neo4j.cypher sample data (scripts/db-init.sh)', () => {
  const INIT_SCRIPT = join(__dirname, '../../../../../../infrastructure/scripts/init-neo4j.cypher');

  /** Statements as cypher-shell reads them: comment lines dropped, split on ';' outside '…' literals. */
  function statements(): string[] {
    const script = readFileSync(INIT_SCRIPT, 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const out: string[] = [];
    let current = '';
    let inString = false;
    for (let i = 0; i < script.length; i++) {
      const ch = script[i]!;
      if (ch === "'" && script[i - 1] !== '\\') inString = !inString;
      if (ch === ';' && !inString) {
        out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current.trim());
    return out.filter(s => s.length > 0);
  }

  it("puts every seeded :CI in the seeded admin's (internal) organization and assigns no other CI", () => {
    const all = statements();
    const admin = all.find(s => s.startsWith("MERGE (u:User {email: 'admin@happycmdb.local'})"));
    expect(admin).toContain(`u.organizationId = '${INTERNAL_ORG}'`);

    // Any MERGE/CREATE of a node pattern whose labels include CI, wherever it sits in the statement.
    const ciVariable = (s: string): string | null => {
      for (const m of s.matchAll(/\b(?:MERGE|CREATE)\s*\((\w+)((?::\w+)+)/g)) {
        if (m[2]!.split(':').includes('CI')) return m[1]!;
      }
      return null;
    };
    const seeded = all.flatMap(s => {
      const variable = ciVariable(s);
      return variable === null ? [] : [{ variable, statement: s }];
    });
    expect(seeded).toHaveLength(32);

    // Each seed assigns the org exactly once, in its unconditional SET (not ON CREATE/ON MATCH,
    // which would leave pre-tenancy sample CIs without an org on a re-run), and nothing else.
    const badSeeds = seeded
      .filter(({ variable, statement }) =>
        /\bON (CREATE|MATCH)\b/.test(statement) ||
        (statement.match(/organization_id/g) ?? []).length !== 1 ||
        !new RegExp(`^\\s*${variable}\\.organization_id = '${INTERNAL_ORG}',?$`, 'm').test(statement))
      .map(({ statement }) => statement.split('\n')[0]);
    expect(badSeeds).toEqual([]);

    // Apart from the index, no other statement touches organization_id: a re-run of
    // db-init must not claim CIs written by discovery, connectors, ETL or the API.
    const otherWriters = all
      .filter(s => s.includes('organization_id') && !seeded.some(({ statement }) => statement === s))
      .filter(s => !/^CREATE INDEX ci_organization_id_idx IF NOT EXISTS\s+FOR \(ci:CI\) ON \(ci\.organization_id\)$/.test(s))
      .map(s => s.split('\n')[0]);
    expect(otherWriters).toEqual([]);
  });
});
