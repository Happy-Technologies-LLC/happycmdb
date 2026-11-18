// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2030: GET /api/v1/impact/graph/:rootCiId carries per-edge evidence and DERIVED currentness on every `data.edges[]` item.
 *
 * What is real: the route, the admission runner, the controller, the real ImpactPredictionEngine.buildDependencyGraph
 * (against a fake Neo4j driver that evaluates the engine's own statements over an in-memory graph), the real Neo4jClient
 * (getCI, getCIIncarnations), the real PostgresClient transaction code (over a fake pool), the real evidence loader and the
 * real 054 receipts table plus the lineage table in PGlite, read as the application login `cmdb_user`. Fixtures (receipts)
 * are written as the table owner with explicit observed_at offsets from the database clock, under random per-test
 * organization and CI ids: the append-only table is never truncated. The engine's own criticality SQL (ci_criticality_scores,
 * ci_change_history) is answered by a JS fake that records what the engine persisted.
 */

import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import type { ConfigSchema } from '@cmdb/common';
import { Neo4jClient, CITraversalLimitError } from '../../../../../database/src/neo4j/client';
import { PostgresClient } from '../../../../../database/src/postgres/client';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

Object.assign(process.env, { JWT_SECRET: randomBytes(32).toString('hex') });

// ---------------------------------------------------------------- PostgreSQL (PGlite, app role)

const host = fork(`${__dirname}/fixtures/pglite-host.cjs`, [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}

const EVIDENCE_TABLE = 'relationship_evidence_receipts';
// Every statement PGlite ran for the routes, how each transaction ended, the pooled connections taken and released, and an
// optional failure the evidence statement throws (PGlite does not enforce statement_timeout, so a stall is the 57014
// PostgreSQL would raise, thrown only after recording the statement_timeout the transaction had set for it).
let pgStatements: string[] = [];
let engineStatements: Array<{ sql: string; params: unknown[] }> = [];
let transactions = { begun: 0, committed: 0, rolledBack: 0 };
let connections = { acquired: 0, released: 0 };
let evidenceFailure: Error | null = null;
let evidenceStatementTimeouts: string[] = [];

/** The engine's own criticality SQL: no cached score, no changes; every score the engine persists is kept for inspection. */
function engineSql(sql: string, params: unknown[]): { rows: unknown[] } | null {
  if (sql.includes('ci_criticality_scores s')) return { rows: [] };
  if (sql.includes('change_count')) return { rows: [{ change_count: '0' }] };
  if (sql.includes('INSERT INTO ci_criticality_scores')) return { rows: [{ ci_id: params[0] }] };
  return null;
}
async function appStatement(sql: string, params: unknown[] = []) {
  assertAppStatement(sql);
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
    if (sql === 'BEGIN') transactions.begun++;
    if (sql === 'COMMIT') transactions.committed++;
    if (sql === 'ROLLBACK') transactions.rolledBack++;
    await send('exec', sql);
    return { rows: [] };
  }
  const engine = engineSql(sql, params);
  if (engine) {
    engineStatements.push({ sql, params });
    return engine;
  }
  pgStatements.push(sql);
  if (sql.includes(EVIDENCE_TABLE) && evidenceFailure) {
    const [setting] = await send('query', `SELECT current_setting('statement_timeout') AS value`) as Array<{ value: string }>;
    evidenceStatementTimeouts.push(setting!.value);
    throw evidenceFailure;
  }
  return { rows: await send('query', sql, params) };
}
// The real PostgresClient (its transaction() BEGIN/COMMIT/ROLLBACK/release code runs) over a pool whose connections run
// every statement in this PGlite session as the app login.
const pgClient = new PostgresClient({ _host: '127.0.0.1', _port: 1, _database: 'unused', _user: 'unused', _password: 'unused' });
void pgClient.pool.end();
pgClient.pool = {
  query: appStatement,
  connect: async () => {
    connections.acquired++;
    return { query: appStatement, release: () => { connections.released++; } };
  },
  on: () => undefined,
} as unknown as typeof pgClient.pool;

// ---------------------------------------------------------------- Neo4j (in-memory graph, the engine's statements evaluated)

type Props = Record<string, unknown>;
type FakeRecord = { get(key: string): unknown };
const graph: { nodes: Map<string, Props>; edges: Array<{ from: string; to: string; type: string }> } = {
  nodes: new Map(), edges: [],
};
const record = (values: Props): FakeRecord => ({ get: (key: string) => values[key] });
const int = (n: number) => ({ toNumber: () => n });
const limitOf = (value: unknown) => (neo4j.isInt(value) ? value.toNumber() : Number(value));
const owned = (id: string, org: unknown) => graph.nodes.get(id)?.['organization_id'] === org;
// Every statement of the run, the incarnation reads among them, and the statements that wrote.
let cypherStatements: string[] = [];
let incarnationReads: Array<{ params: Props; position: number }> = [];
let graphWrites: Array<{ position: number }> = [];
let incarnationFailure: Error | null = null;

function runCypher(raw: string, params: Props): FakeRecord[] {
  const cypher = raw.replace(/\s+/g, ' ').trim();
  const org = params['organizationId'];
  // HAP-2030's one batched incarnation read: org-scoped like the real statement; an owned CI without `incarnation_id` is null.
  if (cypher.includes('RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId')) {
    incarnationReads.push({ params, position: cypherStatements.length - 1 });
    if (incarnationFailure) throw incarnationFailure;
    const inScope = cypher.includes('ci.organization_id = $organizationId');
    return (params['ids'] as string[]).filter(id => graph.nodes.has(id) && (!inScope || owned(id, org)))
      .map(id => record({ ciId: id, incarnationId: graph.nodes.get(id)!['incarnation_id'] ?? null }));
  }
  if (cypher.startsWith('MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId SET ci.incarnation_id')) {
    graphWrites.push({ position: cypherStatements.length - 1 });
    const id = params['id'] as string;
    if (!owned(id, org)) return [];
    const props = graph.nodes.get(id)!;
    props['incarnation_id'] = props['incarnation_id'] ?? randomUUID();
    return [record({ incarnationId: props['incarnation_id'] })];
  }
  if (cypher.startsWith('MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId RETURN ci')) {
    const id = params['id'] as string;
    return owned(id, org) ? [record({ ci: { properties: graph.nodes.get(id) } })] : [];
  }
  if (cypher.startsWith('UNWIND $frontier as ciId MATCH (node:CI {id: ciId, organization_id: $organizationId})-[rel]-(neighbor:CI')) {
    const rows: FakeRecord[] = [];
    const seen = new Set<string>();
    for (const id of params['frontier'] as string[]) {
      if (!owned(id, org)) continue;
      graph.edges.forEach((edge, index) => {
        if (edge.from !== id && edge.to !== id) return;
        const neighbor = edge.from === id ? edge.to : edge.from;
        if (!owned(neighbor, org) || seen.has(`${index}|${neighbor}`)) return;
        seen.add(`${index}|${neighbor}`);
        rows.push(record({
          rel_id: `rel-${index}`, source_id: edge.from, target_id: edge.to, rel_type: edge.type, neighbor_id: neighbor,
        }));
      });
    }
    return rows.slice(0, limitOf(params['edgeLimit']));
  }
  if (cypher.startsWith('UNWIND $nodeIds as id MATCH (node:CI {id: id, organization_id: $organizationId})')) {
    return (params['nodeIds'] as string[]).filter(id => owned(id, org)).slice(0, limitOf(params['nodeLimit'])).map(id => {
      const incident = graph.edges.filter(edge => (edge.from === id && owned(edge.to, org)) || (edge.to === id && owned(edge.from, org)));
      return record({
        id, name: graph.nodes.get(id)!['name'], ci_type: graph.nodes.get(id)!['type'],
        dependents_count: int(incident.filter(edge => edge.to === id).length), dependencies_count: int(incident.length),
      });
    });
  }
  if (cypher.startsWith('MATCH (ci:CI {id: $ciId}) WHERE ci.organization_id = $organizationId CALL {')) {
    const id = params['ciId'] as string;
    if (!owned(id, org)) return [];
    const incoming = graph.edges.filter(edge => edge.to === id && owned(edge.from, org));
    return [record({
      ci_id: id, ci_name: graph.nodes.get(id)!['name'], dependent_count: int(incoming.length),
      dependency_count: int(graph.edges.filter(edge => edge.from === id && owned(edge.to, org)).length),
      dependent_ids: [...new Set(incoming.map(edge => edge.from))].slice(0, limitOf(params['dependentLimit'])),
    })];
  }
  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}
const neo4jClient = new Neo4jClient('bolt://127.0.0.1:1', 'unused', 'unused');
// `driver` is private: this unchecked view of the instance is the test seam that swaps it.
const driverSeam = neo4jClient as unknown as { driver: { close(): Promise<void> } };
void driverSeam.driver.close();
driverSeam.driver = {
  session: () => ({
    run: async (cypher: string, params: Props = {}) => {
      cypherStatements.push(cypher);
      return { records: runCypher(cypher, params) };
    },
    close: async () => undefined,
  }),
  close: async () => undefined,
} as unknown as { close(): Promise<void> };

jest.mock('@cmdb/database', () => ({
  ...jest.requireActual<object>('@cmdb/database/journal/journal'),
  CITraversalLimitError,
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => neo4jClient,
}));

// A verified principal per token `role:organization:user`; the organization is a principal attribute, never a request input.
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => {
    const [role, org, user] = token.split(':');
    return { _userId: user, _username: user, _role: role, _organizationId: org, _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});

// Imported after mocks are registered (jest hoists jest.mock).
import { logger } from '@cmdb/common';
import { getImpactPredictionEngine } from '@cmdb/ai-ml-engine';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { impactRoutes } from '../drift-impact.routes';
import {
  APP_GRANTS_SQL, assertAppLogin, assertAppStatement, asTableOwner, createLoginRolesSql, ENTER_APP_LOGIN_SQL,
  lineageReadAclSql, lineageTableSql, receiptTableSql,
} from './fixtures/app-login';

const app = express();
app.use(express.json());
app.use('/api/v1/impact', getAuthMiddleware().authenticate(), impactRoutes);

const LOG_METHODS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;

beforeAll(async () => {
  const [{ db }] = await send('query', 'SELECT current_database() AS db') as Array<{ db: string }>;
  await send('exec', createLoginRolesSql(db));
  await send('exec', lineageTableSql());
  await send('exec', receiptTableSql());
  // The shared app-login guard also probes for the portfolio table; this suite never reads it, so an empty stand-in
  // keeps the guard at full strength for every other check (superuser, owner, RLS bypass, data-role membership).
  await send('exec', `CREATE TABLE public.dim_business_services (id int);`);
  await send('exec', `CREATE SCHEMA IF NOT EXISTS cmdb;\n${APP_GRANTS_SQL}${lineageReadAclSql()}${ENTER_APP_LOGIN_SQL}`);
  // Every request below runs in this session; refuse to test anything as a superuser or the table owner.
  await assertAppLogin(sql => send('query', sql));
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  graph.nodes = new Map();
  graph.edges = [];
  pgStatements = [];
  engineStatements = [];
  transactions = { begun: 0, committed: 0, rolledBack: 0 };
  connections = { acquired: 0, released: 0 };
  evidenceFailure = null;
  evidenceStatementTimeouts = [];
  cypherStatements = [];
  incarnationReads = [];
  graphWrites = [];
  incarnationFailure = null;
  for (const method of LOG_METHODS) jest.spyOn(logger, method).mockImplementation((() => logger) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures

type EvidenceClass = 'declared' | 'static_observed' | 'runtime_observed' | 'inferred';
type GraphEdgeBody = {
  source_id: string; target_id: string; relationship_type: string; weight: number; is_critical: boolean;
  currentness?: string; evidence?: { last_supported_at: string | null } & Record<string, unknown>;
};
const DAY_MS = 86_400_000;
const ENGINE_EDGE_KEYS = ['is_critical', 'relationship_type', 'source_id', 'target_id', 'weight'];
const EVIDENCE_KEYS = ['classes', 'last_supported_at', 'receipt_count', 'receipts_href', 'receipts_truncated', 'support'];
// Strings that must never appear inside an edge object.
const BANNED_IN_EDGES = ['organization_id', 'incarnation', 'source_name', 'observer', 'correlation_id'];
const SECRET_SOURCE = 'secret-source-name';
const SECRET_OBSERVER = 'secret-observer-token';
const TIMED_OUT_BODY = { success: false, error: 'Impact analysis timed out' };

const owner = (sql: string, params: unknown[] = []) =>
  asTableOwner(statement => send('exec', statement), () => send('query', sql, params));

interface World { org: string; tag: string; root: string }
/** A random organization with a root CI; every other CI of the test is made with `addCi`. */
function newWorld(): World {
  const tag = randomUUID().slice(0, 8);
  const world = { org: randomUUID(), tag, root: `root-${tag}` };
  addCi(world, world.root);
  return world;
}
/** A CI of the world's organization in the fake graph; a `null` incarnation is a legacy CI that never got one. */
function addCi(world: { org: string }, id: string, incarnation: string | null = randomUUID(), org = world.org): string {
  graph.nodes.set(id, {
    id, name: id, type: 'server', status: 'active', organization_id: org,
    ...(incarnation === null ? {} : { incarnation_id: incarnation }),
  });
  return id;
}
const link = (from: string, to: string, type = 'DEPENDS_ON') => { graph.edges.push({ from, to, type }); };
const incarnationOf = (id: string) => graph.nodes.get(id)!['incarnation_id'] as string;

interface ReceiptInput {
  org: string; from: string; to: string; cls: EvidenceClass; ageDays: number;
  polarity?: 'supports' | 'contradicts'; type?: string; fromInc?: string; toInc?: string;
}
const receipt = (r: ReceiptInput) => owner(
  `INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id, to_incarnation_id,
     relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type, correlation_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '${SECRET_SOURCE}', 'api', now() - ($9::float8 * interval '1 day'),
     '${SECRET_OBSERVER}', 'user', $10)`,
  [r.org, r.from, r.to, r.fromInc ?? incarnationOf(r.from), r.toInc ?? incarnationOf(r.to), r.type ?? 'DEPENDS_ON',
    r.cls, r.polarity ?? 'supports', r.ageDays, randomUUID()]);

const bearer = (org: string, role = 'viewer') => `Bearer ${role}:${org}:${randomUUID()}`;
const getGraph = (world: World, depth = 3) =>
  request(app).get(`/api/v1/impact/graph/${world.root}?max_depth=${depth}`).set('authorization', bearer(world.org));
const edgeOf = (body: { data: { edges: GraphEdgeBody[] } }, from: string, to: string, type = 'DEPENDS_ON'): GraphEdgeBody => {
  const found = body.data.edges.filter(e => e.source_id === from && e.target_id === to && e.relationship_type === type);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const href = (from: string, to: string) => `/api/v1/relationships/evidence?from_id=${from}&to_id=${to}&type=DEPENDS_ON`;
const receiptStatements = () => pgStatements.filter(sql => sql.includes(EVIDENCE_TABLE));
const nearAgeDays = (iso: string | null, days: number) => {
  expect(iso).not.toBeNull();
  expect(Math.abs(Date.parse(iso!) - (Date.now() - days * DAY_MS))).toBeLessThan(10 * 60_000);
};

/** The five-edge scenario: four edges out of the root, one in; the last has no receipt at all. */
async function fiveEdgeScenario() {
  const world = newWorld();
  const ids = {
    root: world.root, declaredFresh: `declared-fresh-${world.tag}`, staticRecent: `static-recent-${world.tag}`,
    staticOld: `static-old-${world.tag}`, contradicted: `contradicted-${world.tag}`, noReceipt: `no-receipt-${world.tag}`,
  };
  for (const id of Object.values(ids)) if (!graph.nodes.has(id)) addCi(world, id);
  link(ids.root, ids.declaredFresh); link(ids.root, ids.staticRecent); link(ids.root, ids.staticOld);
  link(ids.root, ids.contradicted); link(ids.noReceipt, ids.root);
  const org = world.org;
  await receipt({ org, from: ids.root, to: ids.declaredFresh, cls: 'declared', ageDays: 1 });
  await receipt({ org, from: ids.root, to: ids.staticRecent, cls: 'static_observed', ageDays: 2 });
  await receipt({ org, from: ids.root, to: ids.staticOld, cls: 'static_observed', ageDays: 30 });
  await receipt({ org, from: ids.root, to: ids.contradicted, cls: 'static_observed', ageDays: 3 });
  await receipt({ org, from: ids.root, to: ids.contradicted, cls: 'static_observed', polarity: 'contradicts', ageDays: 1 });
  return { world, ids };
}

// ---------------------------------------------------------------- tests

describe('HAP-2030 /impact/graph edge evidence and derived currentness', () => {
  it('qualifies each edge: current, current, stale, contradicted and unsupported, beside the unchanged engine members', async () => {
    const { world, ids } = await fiveEdgeScenario();

    const res = await getGraph(world);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, basis: 'declared_graph_reachability', runtime_blast_radius: 'not_established',
      coverage: { runtime_observed_receipts_in_scope: false },
    });
    expect(res.body.data.edges).toHaveLength(5);
    const fresh = edgeOf(res.body, ids.root, ids.declaredFresh);
    expect(fresh).toMatchObject({
      source_id: ids.root, target_id: ids.declaredFresh, relationship_type: 'DEPENDS_ON', weight: 1, is_critical: true,
      currentness: 'current',
      evidence: {
        classes: ['declared'], support: { supports: 1, contradicts: 0 }, receipt_count: 1, receipts_truncated: false,
        receipts_href: href(ids.root, ids.declaredFresh),
      },
    });
    nearAgeDays(fresh.evidence!.last_supported_at, 1);
    const recent = edgeOf(res.body, ids.root, ids.staticRecent);
    expect(recent).toMatchObject({
      currentness: 'current',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
    });
    nearAgeDays(recent.evidence!.last_supported_at, 2);
    const old = edgeOf(res.body, ids.root, ids.staticOld);
    expect(old).toMatchObject({
      currentness: 'stale',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
    });
    nearAgeDays(old.evidence!.last_supported_at, 30);
    expect(edgeOf(res.body, ids.root, ids.contradicted)).toMatchObject({
      currentness: 'contradicted',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 1 }, receipt_count: 2 },
    });
    expect(edgeOf(res.body, ids.noReceipt, ids.root)).toMatchObject({
      currentness: 'unsupported',
      evidence: {
        classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0, receipts_truncated: false,
        last_supported_at: null, receipts_href: href(ids.noReceipt, ids.root),
      },
    });
  });

  it('never lets evidence reach the engine or the criticality it persists', async () => {
    const { world, ids } = await fiveEdgeScenario();
    const engine = getImpactPredictionEngine();
    const build = jest.spyOn(engine, 'buildDependencyGraph');

    const res = await getGraph(world);

    expect(res.status).toBe(200);
    // The engine is called with exactly its three arguments and its own result is never decorated.
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]).toEqual([ids.root, 3, world.org]);
    const built = await build.mock.results[0]!.value;
    expect(built.edges).toHaveLength(5);
    for (const edge of built.edges) expect(Object.keys(edge).sort()).toEqual(ENGINE_EDGE_KEYS);
    // Its criticality persistence wrote rows, and none of what it wrote (or read) mentions evidence.
    const inserts = engineStatements.filter(statement => statement.sql.includes('INSERT INTO ci_criticality_scores'));
    expect(inserts.length).toBeGreaterThan(0);
    const engineText = JSON.stringify(engineStatements);
    for (const word of ['currentness', 'evidence', 'receipts_href', 'supports', 'contradicts']) expect(engineText).not.toContain(word);
    // The same edges in the body carry the engine's members unchanged plus the two additions.
    for (const edge of res.body.data.edges as GraphEdgeBody[]) {
      expect(Object.keys(edge).sort()).toEqual([...ENGINE_EDGE_KEYS, 'currentness', 'evidence'].sort());
      expect(edge).toMatchObject({ weight: 1, is_critical: true, relationship_type: 'DEPENDS_ON' });
    }
  });

  it('applies each class its own freshness window: runtime 1 day, static 7 days, declared 180 days, inferred never', async () => {
    const world = newWorld();
    const cases: Array<[string, EvidenceClass, number, string]> = [
      ['runtime-fresh', 'runtime_observed', 0.5, 'current'], ['runtime-late', 'runtime_observed', 2, 'stale'],
      ['static-fresh', 'static_observed', 6, 'current'], ['static-late', 'static_observed', 8, 'stale'],
      ['declared-old', 'declared', 170, 'current'], ['declared-late', 'declared', 190, 'stale'],
      ['inferred-only', 'inferred', 0.1, 'stale'],
    ];
    for (const [name, cls, ageDays] of cases) {
      const target = addCi(world, `${name}-${world.tag}`);
      link(world.root, target);
      await receipt({ org: world.org, from: world.root, to: target, cls, ageDays });
    }

    const res = await getGraph(world);

    expect(res.status).toBe(200);
    for (const [name, , , expected] of cases) {
      expect([name, edgeOf(res.body, world.root, `${name}-${world.tag}`).currentness]).toEqual([name, expected]);
    }
    // An inferred support is reported as evidence but never makes an edge current.
    expect(edgeOf(res.body, world.root, `inferred-only-${world.tag}`).evidence).toMatchObject({ classes: ['inferred'], receipt_count: 1 });
  });

  it('looks an edge up by its stored direction and type: a reversed or re-typed receipt does not qualify it', async () => {
    const world = newWorld();
    const [reversed, retyped, exact] = ['reversed', 'retyped', 'exact'].map(name => addCi(world, `${name}-${world.tag}`));
    link(world.root, reversed!); link(world.root, retyped!, 'HOSTED_ON'); link(world.root, exact!, 'USES');
    await receipt({ org: world.org, from: reversed!, to: world.root, cls: 'declared', ageDays: 1 });
    await receipt({ org: world.org, from: world.root, to: retyped!, cls: 'declared', ageDays: 1, type: 'DEPENDS_ON' });
    await receipt({ org: world.org, from: world.root, to: exact!, cls: 'declared', ageDays: 1, type: 'USES' });

    const res = await getGraph(world);

    expect(res.status).toBe(200);
    expect(edgeOf(res.body, world.root, reversed!).currentness).toBe('unsupported');
    expect(edgeOf(res.body, world.root, retyped!, 'HOSTED_ON').currentness).toBe('unsupported');
    expect(edgeOf(res.body, world.root, exact!, 'USES')).toMatchObject({
      currentness: 'current', is_critical: false,
      evidence: { receipts_href: `/api/v1/relationships/evidence?from_id=${world.root}&to_id=${exact}&type=USES` },
    });
  });

  describe('organization and incarnation isolation', () => {
    it("never lets another organization's receipts, carrying this organization's ids and incarnations, change a read", async () => {
      const world = newWorld();
      const [withOwn, onlyForeign] = [`own-${world.tag}`, `foreign-${world.tag}`].map(id => addCi(world, id));
      link(world.root, withOwn!); link(world.root, onlyForeign!);
      await receipt({ org: world.org, from: world.root, to: withOwn!, cls: 'static_observed', ageDays: 1 });
      const otherOrg = randomUUID();
      // Newer contradiction and a fresh support, written by another organization against the same ids and incarnations.
      await receipt({ org: otherOrg, from: world.root, to: withOwn!, cls: 'static_observed', polarity: 'contradicts', ageDays: 0.1 });
      await receipt({ org: otherOrg, from: world.root, to: onlyForeign!, cls: 'declared', ageDays: 0.1 });

      const res = await getGraph(world);

      expect(res.status).toBe(200);
      expect(edgeOf(res.body, world.root, withOwn!)).toMatchObject({
        currentness: 'current', evidence: { support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
      });
      expect(edgeOf(res.body, world.root, onlyForeign!)).toMatchObject({
        currentness: 'unsupported', evidence: { classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0 },
      });
    });

    it('fences by incarnation: a receipt of a re-created CI, on either end, is inert; a legacy CI is unsupported and the read assigns nothing', async () => {
      const world = newWorld();
      const [reTo, reFrom, both] = ['recreated-to', 'recreated-from', 'both'].map(name => addCi(world, `${name}-${world.tag}`));
      const legacy = addCi(world, `legacy-${world.tag}`, null);
      for (const target of [reTo!, reFrom!, both!, legacy]) link(world.root, target);
      const org = world.org;
      // The old incarnation's receipts: the CI was deleted and re-created since (the graph holds the new incarnation).
      await receipt({ org, from: world.root, to: reTo!, cls: 'static_observed', ageDays: 1, toInc: randomUUID() });
      await receipt({ org, from: world.root, to: reFrom!, cls: 'static_observed', ageDays: 1, fromInc: randomUUID() });
      await receipt({ org, from: world.root, to: both!, cls: 'static_observed', polarity: 'contradicts', ageDays: 0.1, toInc: randomUUID() });
      await receipt({ org, from: world.root, to: both!, cls: 'static_observed', ageDays: 1 });
      await receipt({ org, from: world.root, to: legacy, cls: 'static_observed', ageDays: 1, toInc: randomUUID() });

      const res = await getGraph(world);

      expect(res.status).toBe(200);
      expect(edgeOf(res.body, world.root, reTo!)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      expect(edgeOf(res.body, world.root, reFrom!)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      // Only the current incarnation's receipt counts; the old incarnation's newer contradiction is inert.
      expect(edgeOf(res.body, world.root, both!)).toMatchObject({
        currentness: 'current', evidence: { support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
      });
      expect(edgeOf(res.body, world.root, legacy)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      // The engine's own criticality walk assigns the legacy CI an incarnation (existing behaviour, before the evidence read);
      // the evidence read is a plain read: it wrote nothing and ran after every such write.
      expect(incarnationReads).toHaveLength(1);
      expect(graphWrites.length).toBeGreaterThan(0);
      for (const write of graphWrites) expect(write.position).toBeLessThan(incarnationReads[0]!.position);
      expect(cypherStatements[incarnationReads[0]!.position]).not.toMatch(/\b(SET|CREATE|MERGE|DELETE)\b/);
    });
  });

  describe('cost bound', () => {
    const readWithEdges = async (outgoing: number, incoming: number) => {
      const world = newWorld();
      for (let i = 0; i < outgoing; i++) link(world.root, addCi(world, `out-${i}-${world.tag}`));
      for (let i = 0; i < incoming; i++) link(addCi(world, `in-${i}-${world.tag}`), world.root);
      if (outgoing > 0) await receipt({ org: world.org, from: world.root, to: `out-0-${world.tag}`, cls: 'declared', ageDays: 1 });
      pgStatements = []; incarnationReads = [];
      return { world, res: await getGraph(world) };
    };

    it('issues exactly one receipts statement and one incarnation statement for 1 edge and for 40, in one call', async () => {
      const small = await readWithEdges(1, 0);
      expect(small.res.status).toBe(200);
      expect([receiptStatements().length, incarnationReads.length]).toEqual([1, 1]);

      const large = await readWithEdges(20, 20);
      expect(large.res.status).toBe(200);
      expect(large.res.body.data.edges).toHaveLength(40);
      for (const edge of large.res.body.data.edges as GraphEdgeBody[]) expect(edge.currentness).toBeDefined();
      expect([receiptStatements().length, incarnationReads.length]).toEqual([1, 1]);
      const [read] = incarnationReads;
      expect(Object.keys(read!.params).sort()).toEqual(['ids', 'organizationId']);
      expect(read!.params['organizationId']).toBe(large.world.org);
      expect((read!.params['ids'] as string[]).length).toBe(41);
    });

    it('issues neither statement when the graph has no edge', async () => {
      const none = await readWithEdges(0, 0);

      expect(none.res.status).toBe(200);
      expect(none.res.body.data.edges).toEqual([]);
      expect([receiptStatements().length, incarnationReads.length]).toEqual([0, 0]);
    });
  });

  describe('an evidence failure fails the whole read, never a partial or optimistic body', () => {
    const stalledStatement = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const NO_MEMBERS = ['"edges"', '"nodes"', 'currentness', 'evidence', 'unsupported', 'coverage'];

    it('answers the fixed 504 when the receipts statement stalls past its statement_timeout, rolled back and released', async () => {
      const { world } = await fiveEdgeScenario();
      evidenceFailure = stalledStatement();

      const res = await getGraph(world);

      expect([res.status, res.body]).toEqual([504, TIMED_OUT_BODY]);
      for (const member of NO_MEMBERS) expect(res.text).not.toContain(member);
      // The statement ran under its own bounded statement_timeout, set for its transaction only.
      expect(evidenceStatementTimeouts).toEqual(['3s']);
      expect(transactions.rolledBack).toBe(1);
      expect(transactions.begun).toBe(transactions.committed + transactions.rolledBack);
      expect(connections.released).toBe(connections.acquired);
      expect(connections.acquired).toBeGreaterThan(0);
      const [after] = await send('query', `SELECT current_setting('statement_timeout') AS value`) as Array<{ value: string }>;
      expect(after!.value).toBe('0');
    });

    it('answers the same fixed 504 when the Neo4j incarnation read times out, before any receipts statement', async () => {
      const { world } = await fiveEdgeScenario();
      incarnationFailure = Object.assign(new Error('timed out'), { code: 'Neo.ClientError.Transaction.TransactionTimedOut' });

      const res = await getGraph(world);

      expect([res.status, res.body]).toEqual([504, TIMED_OUT_BODY]);
      for (const member of NO_MEMBERS) expect(res.text).not.toContain(member);
      expect(incarnationReads).toHaveLength(1);
      expect(receiptStatements()).toHaveLength(0);
      expect(connections.released).toBe(connections.acquired);
    });

    it.each([
      ['a missing receipts table (42P01)', () => Object.assign(new Error('relation "relationship_evidence_receipts" does not exist'), { code: '42P01' })],
      ['a lost connection', () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
      ['an error without a code', () => new Error('boom')],
    ])('answers the existing 500 with no members, never "unsupported", on %s', async (_name, failure) => {
      const { world } = await fiveEdgeScenario();
      evidenceFailure = failure();

      const res = await getGraph(world);

      expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to analyze impact' }]);
      for (const member of NO_MEMBERS) expect(res.text).not.toContain(member);
      expect(transactions.rolledBack).toBe(1);
      expect(connections.released).toBe(connections.acquired);
    });
  });

  describe('response hygiene', () => {
    it('keeps every pre-existing member and exposes no organization, incarnation, source, observer or correlation id', async () => {
      const { world, ids } = await fiveEdgeScenario();

      const res = await getGraph(world);

      expect(res.status).toBe(200);
      // The key sets of the body before HAP-2030: nothing removed or renamed.
      expect(Object.keys(res.body).sort()).toEqual(['basis', 'coverage', 'data', 'runtime_blast_radius', 'success']);
      expect(Object.keys(res.body.data).sort()).toEqual(['edges', 'metadata', 'nodes']);
      expect(Object.keys(res.body.data.metadata).sort()).toEqual(['generated_at', 'max_depth', 'total_edges', 'total_nodes']);
      expect(res.body.data.metadata).toMatchObject({ total_nodes: 6, total_edges: 5, max_depth: 3 });
      for (const node of res.body.data.nodes) {
        expect(Object.keys(node).sort()).toEqual(
          ['ci_id', 'ci_name', 'ci_type', 'criticality', 'dependencies_count', 'dependents_count', 'id']);
      }
      for (const edge of res.body.data.edges as GraphEdgeBody[]) {
        expect(Object.keys(edge).sort()).toEqual([...ENGINE_EDGE_KEYS, 'currentness', 'evidence'].sort());
        expect(Object.keys(edge.evidence!).sort()).toEqual(EVIDENCE_KEYS);
        const text = JSON.stringify(edge);
        for (const banned of BANNED_IN_EDGES) expect(text).not.toContain(banned);
      }
      expect(res.body.data.edges.map((e: GraphEdgeBody) => [e.source_id, e.target_id]).flat().sort())
        .toEqual([ids.root, ids.root, ids.root, ids.root, ids.root, ids.declaredFresh, ids.staticRecent, ids.staticOld,
          ids.contradicted, ids.noReceipt].sort());
      // Nothing from the receipts rows, the graph's incarnations or the organization leaks anywhere in the body.
      for (const leak of ['organization_id', SECRET_SOURCE, SECRET_OBSERVER, world.org]) expect(res.text).not.toContain(leak);
      for (const node of graph.nodes.values()) expect(res.text).not.toContain(node['incarnation_id'] as string);
    });

    it('refuses an unauthenticated read with 401 before any statement, and serves a viewer', async () => {
      const { world } = await fiveEdgeScenario();

      const anonymous = await request(app).get(`/api/v1/impact/graph/${world.root}`);

      expect(anonymous.status).toBe(401);
      expect([pgStatements.length, engineStatements.length, cypherStatements.length]).toEqual([0, 0, 0]);
      const viewer = await request(app).get(`/api/v1/impact/graph/${world.root}`).set('authorization', bearer(world.org, 'viewer'));
      expect(viewer.status).toBe(200);
    });

    it('derives currentness on every read and writes nothing but the engine\'s criticality cache', async () => {
      const { world, ids } = await fiveEdgeScenario();
      const count = async () => (await owner(
        `SELECT count(*)::int AS n FROM relationship_evidence_receipts WHERE organization_id = $1`, [world.org]) as Array<{ n: number }>)[0]!.n;
      const before = await count();

      const first = await getGraph(world);
      const firstStatements = pgStatements;
      pgStatements = [];
      // The newest declared receipt ages past its 180 day window between two reads (fixture work as the owner, trigger off
      // in this disposable database only). A stored verdict would still say current; a derived one says stale.
      await owner(`ALTER TABLE relationship_evidence_receipts DISABLE TRIGGER USER`);
      try {
        await owner(`UPDATE relationship_evidence_receipts SET observed_at = observed_at - interval '200 days'
          WHERE organization_id = $1 AND to_ci_id = $2`, [world.org, ids.declaredFresh]);
      } finally {
        await owner(`ALTER TABLE relationship_evidence_receipts ENABLE TRIGGER USER`);
      }
      const second = await getGraph(world);

      expect(edgeOf(first.body, ids.root, ids.declaredFresh).currentness).toBe('current');
      expect(edgeOf(second.body, ids.root, ids.declaredFresh).currentness).toBe('stale');
      // Everything that reached PostgreSQL beyond the engine's own criticality statements is a read.
      for (const sql of [...firstStatements, ...pgStatements]) expect(sql).toMatch(/^\s*(SELECT|WITH)\b/i);
      for (const statement of engineStatements) {
        expect(statement.sql).toMatch(/^\s*(SELECT|INSERT INTO ci_criticality_scores)\b/i);
      }
      expect(await count()).toBe(before);
    });
  });
});
