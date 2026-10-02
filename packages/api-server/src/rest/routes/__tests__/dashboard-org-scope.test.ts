// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/dashboards/*, exercised through the real
 * dashboardRoutes, DashboardController and DashboardService behind the real
 * AuthMiddleware / AuthService (JWT verification), mounted at the production path.
 *
 * Business-service ownership SQL runs on PGlite hosted in a forked child
 * process (fixtures/pglite-host.cjs) with the dim_business_services DDL read
 * verbatim from 001_complete_schema.sql plus
 * 008_business_service_organization_scope.sql.
 *
 * Neo4j is a recording session over an in-memory graph of :CI nodes from two
 * organizations plus one with no organization, and :BusinessService nodes
 * (one of them owned by org A in Postgres but org B's in Neo4j, one with no
 * organization). It honours exactly the tenant predicates the statement
 * contains: a statement without `ci.organization_id = $organizationId` /
 * `bs.organization_id = $organizationId` (or the path-wide
 * `all(n IN nodes(path) WHERE n.organization_id = $organizationId)`) matches
 * every organization's nodes, as Neo4j would.
 */

import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
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

// Every data access is counted: Postgres through the client or its pool, Neo4j per Cypher run.
let pgQueries = 0;
const pgQuery = async (sql: string, params: unknown[] = []) => {
  pgQueries++;
  return { rows: await send('query', sql, params) };
};
// Plain functions (not jest.fn): the unit config resets mock implementations.
const pgClient = { query: pgQuery, pool: { query: pgQuery } };

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// In-memory graph and recording Neo4j session
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
interface FakeCI { id: string; organizationId?: string; cost: number; provider: string; status: string }
const FAKE_CIS: FakeCI[] = [
  // Org A: the CI behind its owned business service, plus three more.
  { id: 'bs-a-app', organizationId: ORG_A, cost: 100, provider: 'aws', status: 'active' },
  { id: 'a-web', organizationId: ORG_A, cost: 50, provider: 'azure', status: 'active' },
  { id: 'a-hidden', organizationId: ORG_A, cost: 0, provider: 'aws', status: 'active' },
  { id: 'a-retired', organizationId: ORG_A, cost: 1, provider: 'gcp', status: 'retired' },
  // Org B, including the CI behind B's business service.
  { id: 'bs-b-app', organizationId: ORG_B, cost: 7000, provider: 'aws', status: 'active' },
  { id: 'b-secret', organizationId: ORG_B, cost: 9000, provider: 'gcp', status: 'active' },
  // Not yet backfilled: belongs to no organization.
  { id: 'no-org', cost: 3000, provider: 'aws', status: 'active' },
];
// Node properties as Neo4j stores them (no organization_id property when unset).
const CIS: Props[] = FAKE_CIS.map(c => ({
  id: c.id, name: `${c.id} name`, type: 'server', status: c.status, environment: 'production',
  discovery_provider: c.provider,
  tbm_attributes: { monthly_cost: c.cost, capability_tower: 'compute' },
  bsm_attributes: { business_criticality: 'tier_1', customer_facing: true },
  itil_attributes: { lifecycle: 'operate' },
  ...(c.organizationId === undefined ? {} : { organization_id: c.organizationId }),
}));
// bs-a-app - a-web (same org); bs-a-app - b-secret - a-hidden (A, reachable only through B).
const EDGES: Array<{ from: string; to: string }> = [
  { from: 'bs-a-app', to: 'a-web' },
  { from: 'bs-a-app', to: 'b-secret' },
  { from: 'b-secret', to: 'a-hidden' },
];
const A_ACTIVE = FAKE_CIS.filter(c => c.organizationId === ORG_A && c.status === 'active');
const A_ACTIVE_COST = A_ACTIVE.reduce((sum, c) => sum + c.cost, 0);
// :BusinessService nodes (FD-16 c). Org A owns bs-hijack, bs-orphan and bs-a-nodeless in
// Postgres, but bs-hijack's node is org B's, bs-orphan's node has no organization and
// bs-a-nodeless has no node at all.
const BUSINESS_SERVICE_NODES: Props[] = [
  { id: 'bs-a-app', organization_id: ORG_A },
  { id: 'bs-b-app', organization_id: ORG_B },
  { id: 'bs-hijack', organization_id: ORG_B },
  { id: 'bs-orphan' },
];

type Params = Record<string, unknown>;
interface FakeRecord { get(key: string): unknown }
const cypherRuns: Array<{ query: string; params: Params }> = [];
const int = (n: number) => ({ toNumber: () => n });
const record = (fields: Record<string, unknown>): FakeRecord => ({ get: (key: string) => fields[key] });
const node = (props: Props) => ({ labels: ['CI'], properties: props });
const byId = (id: string) => CIS.find(c => c['id'] === id);

const PATH_SCOPE = 'all(n IN nodes(path) WHERE n.organization_id = $organizationId)';

/** Undirected expansion of up to `depth` hops with relationship uniqueness, like `-[r*0..depth]-`. */
function paths(startId: string, depth: number): string[][] {
  const out: string[][] = [];
  const walk = (nodes: string[], used: Set<number>) => {
    out.push(nodes);
    if (used.size >= depth) return;
    const at = nodes[nodes.length - 1];
    EDGES.forEach((edge, i) => {
      if (used.has(i)) return;
      const next = edge.from === at ? edge.to : edge.to === at ? edge.from : null;
      if (next !== null) walk([...nodes, next], new Set([...used, i]));
    });
  };
  if (byId(startId) !== undefined) walk([startId], new Set());
  return out;
}

function run(rawQuery: string, params: Params): FakeRecord[] {
  const query = rawQuery.replace(/\s+/g, ' ').trim();
  const sameOrg = (props: Props) => props['organization_id'] === params['organizationId'];

  if (query.startsWith('OPTIONAL MATCH (bs:BusinessService {id: $serviceId})')) {
    // `WITH collect(bs) AS nodes RETURN all(b IN nodes WHERE b.organization_id = $organizationId)`;
    // without the node-org predicate, any existing node is allowed whoever owns it.
    const props = BUSINESS_SERVICE_NODES.find(p => p['id'] === params['serviceId']);
    const checksOrg = query.includes('RETURN all(b IN nodes WHERE b.organization_id = $organizationId) AS allowed');
    return [record({ allowed: props === undefined || !checksOrg || sameOrg(props) })];
  }
  if (query.startsWith('MATCH path = (ci:CI {id: $serviceId})-[r*0..3]-(related:CI)')) {
    const kept = paths(params['serviceId'] as string, 3)
      .filter(p => !query.includes(PATH_SCOPE) || p.every(id => sameOrg(byId(id)!)));
    const nodeIds = [...new Set(kept.map(p => p[p.length - 1]!))];
    return [record({
      nodes: nodeIds.map(id => ({ id, label: byId(id)!['name'] })),
      edges: kept.filter(p => p.length > 1).map(p => ({ from: p[0], to: p[1] })),
    })];
  }

  if (!query.startsWith('MATCH (ci:CI)')) throw new Error(`fake Neo4j: unmodelled statement: ${query}`);
  const matched = CIS.filter(props =>
    (!query.includes('ci.organization_id = $organizationId') || sameOrg(props)) &&
    (!query.includes("ci.status = 'active'") || props['status'] === 'active') &&
    (!query.includes('ci.id = $serviceId') || props['id'] === params['serviceId'])
  );

  if (query.includes('WITH ci.status as status')) {
    const statuses = [...new Set(matched.map(props => props['status'] as string))];
    return statuses.map(status => {
      const group = matched.filter(props => props['status'] === status);
      return record({ status, count: int(group.length), sampleCIs: group.slice(0, 5).map(node) });
    });
  }
  if (query.includes('collect(ci) as cis')) {
    return [record({ cis: matched.map(node) })];
  }
  // The projected collect({id, name, type, tbm, bsm, itil, provider}) shape.
  return [record({
    totalCIs: int(matched.length),
    cis: matched.map(props => ({
      id: props['id'], name: props['name'], type: props['type'],
      tbm: props['tbm_attributes'], bsm: props['bsm_attributes'], itil: props['itil_attributes'],
      provider: props['discovery_provider'],
    })),
  })];
}

const neo4jSession = {
  run: async (query: string, params: Params = {}) => {
    cypherRuns.push({ query, params });
    return { records: run(query, params) };
  },
  close: async () => undefined,
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({ getSession: () => neo4jSession }),
  getAuditService: () => ({}),
}));

// bcrypt's native binding is only used for password hashing/login, never on token verification.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: ORG_A },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
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
import type { UserRole } from '../../../auth/types';
import { dashboardRoutes } from '../dashboard.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');

function baseDdl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const match = sql.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/);
  if (!match) throw new Error('DDL for dim_business_services not found in 001_complete_schema.sql');
  return match[0];
}

const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-hijack', 'A Claims B Node', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-orphan', 'A Claims Orphan Node', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-a-nodeless', 'A Without Node', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-b-app', 'B Secret App', 'application', 'application', 'medium', 'active', '${ORG_B}');`;

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => {
  const user = USERS[userId]!;
  return {
    Authorization: `Bearer ${jwt.generateAccessToken(userId, user._username, user._role as UserRole, organizationId)}`,
  };
};
const AS_A = bearer('user-a', ORG_A);

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/dashboards', dashboardRoutes);

// Request-supplied org hints that must never reach a query.
const SPOOF = `organization_id=${ORG_B}&organizationId=${ORG_B}`;

/**
 * Every (x:CI) pattern of every recorded statement is bound to the token org:
 * by `x.organization_id = $organizationId` or by the path-wide predicate; the
 * parameter is the token org. Returns the offending (statement, variable) pairs.
 */
function unscopedCIMatches(): string[] {
  return cypherRuns.flatMap(({ query, params }) => {
    const variables = [...query.matchAll(/\((\w+):CI\b/g)].map(m => m[1]!);
    const unscoped = variables.filter(v => !query.includes(PATH_SCOPE) && !query.includes(`${v}.organization_id = $organizationId`));
    if (variables.length > 0 && params['organizationId'] !== ORG_A) unscoped.push('$organizationId param');
    return unscoped.map(v => `${v} in: ${query.replace(/\s+/g, ' ').trim()}`);
  });
}

beforeAll(async () => {
  await send('exec', baseDdl());
  await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8')}\nCOMMIT;`);
  await send('exec', SEED);
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  pgQueries = 0;
  cypherRuns.length = 0;
});

describe('GET /api/v1/dashboards/business-service/:serviceId', () => {
  it('business-service dashboard for a foreign service is 404 and runs no Cypher', async () => {
    const foreign = await request(app).get('/api/v1/dashboards/business-service/bs-b-app').set(AS_A);
    const foreignQuery = await request(app).get('/api/v1/dashboards/business-service?serviceId=bs-b-app').set(AS_A);
    const repeated = await request(app).get('/api/v1/dashboards/business-service?serviceId=bs-a-app&serviceId=bs-b-app').set(AS_A);
    // A CI of org A that is not a business service it owns in Postgres.
    const graphOnly = await request(app).get('/api/v1/dashboards/business-service/a-web').set(AS_A);
    const missing = await request(app).get('/api/v1/dashboards/business-service/bs-missing').set(AS_A);

    expect(missing.status).toBe(404);
    for (const res of [foreign, foreignQuery, repeated, graphOnly]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(missing.text);
    }
    expect(foreign.text).not.toContain('bs-b-app');
    expect(cypherRuns).toEqual([]);
  });

  it('business-service dashboard is 404 for a foreign-org node', async () => {
    // Postgres ownership passes for bs-hijack and bs-orphan; their nodes are not org A's.
    const hijack = await request(app).get('/api/v1/dashboards/business-service/bs-hijack').set(AS_A);
    const hijackQuery = await request(app).get('/api/v1/dashboards/business-service?serviceId=bs-hijack').set(AS_A);
    const orphan = await request(app).get('/api/v1/dashboards/business-service/bs-orphan').set(AS_A);
    const missing = await request(app).get('/api/v1/dashboards/business-service/bs-missing').set(AS_A);

    for (const res of [hijack, hijackQuery, orphan]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(missing.text);
    }
    // Each owned id ran only the node gate, bound to the token org; no CI was read.
    expect(cypherRuns.map(run => run.params)).toEqual([
      { serviceId: 'bs-hijack', organizationId: ORG_A },
      { serviceId: 'bs-hijack', organizationId: ORG_A },
      { serviceId: 'bs-orphan', organizationId: ORG_A },
    ]);

    // An owned service with no :BusinessService node keeps its CI-only dashboard.
    const nodeless = await request(app).get('/api/v1/dashboards/business-service/bs-a-nodeless').set(AS_A);
    expect(nodeless.status).toBe(200);
  });

  it("business-service dashboard Cypher and dependency traversal stay inside the caller org", async () => {
    const own = await request(app).get(`/api/v1/dashboards/business-service/bs-a-app?${SPOOF}`).set(AS_A);
    const all = await request(app).get('/api/v1/dashboards/business-service').set(AS_A);

    expect(own.status).toBe(200);
    expect(all.status).toBe(200);
    // a-hidden is in org A but only reachable through org B's b-secret.
    expect(own.body.data.serviceDependencies.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['a-web', 'bs-a-app']);
    expect(own.body.data.serviceDependencies.edges).toEqual([{ from: 'bs-a-app', to: 'a-web' }]);
    expect(unscopedCIMatches()).toEqual([]);
  });
});

describe('global dashboards', () => {
  it("executive dashboard aggregates only the caller org's CIs", async () => {
    const res = await request(app).get(`/api/v1/dashboards/executive?${SPOOF}`).set(AS_A);

    expect(res.status).toBe(200);
    expect(res.body.data.totalITSpend).toBe(A_ACTIVE_COST);
    const reported = [
      ...res.body.data.topCostDrivers.map((d: { serviceId: string }) => d.serviceId),
      ...res.body.data.riskMatrix.services.map((s: { id: string }) => s.id),
      ...res.body.data.valueScorecard.map((v: { serviceId: string }) => v.serviceId),
    ];
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.filter(id => byId(id)!['organization_id'] !== ORG_A)).toEqual([]);
    expect(unscopedCIMatches()).toEqual([]);
  });

  it('finops dashboard Cypher carries the token org on every CI match', async () => {
    const res = await request(app).get(`/api/v1/dashboards/finops?${SPOOF}`).set(AS_A);

    expect(res.status).toBe(200);
    expect(cypherRuns.length).toBeGreaterThan(0);
    expect(unscopedCIMatches()).toEqual([]);
    expect(res.body.data.onPremVsCloud.totalCost).toBe(A_ACTIVE_COST);
  });

  it('itsm and cio dashboards carry the token org', async () => {
    const itsm = await request(app).get(`/api/v1/dashboards/itsm?${SPOOF}`).set(AS_A);
    const cio = await request(app).get(`/api/v1/dashboards/cio?${SPOOF}`).set(AS_A);

    expect(itsm.status).toBe(200);
    expect(cio.status).toBe(200);
    expect(cypherRuns.length).toBe(2);
    expect(unscopedCIMatches()).toEqual([]);

    const statusCIs = itsm.body.data.ciStatus.flatMap((s: { cis: Array<{ ci_id: string }> }) => s.cis.map(c => c.ci_id));
    expect(statusCIs.sort()).toEqual(FAKE_CIS.filter(c => c.organizationId === ORG_A).map(c => c.id).sort());
    expect(cio.body.data.configurationAccuracy.totalCIs).toBe(A_ACTIVE.length);
  });
});

describe('fail closed without an organization claim', () => {
  it.each([
    '/api/v1/dashboards/executive',
    '/api/v1/dashboards/cio',
    '/api/v1/dashboards/itsm',
    '/api/v1/dashboards/finops',
    '/api/v1/dashboards/business-service',
    '/api/v1/dashboards/business-service/bs-a-app',
  ])('403 with zero queries without an org claim: %s', async path => {
    for (const headers of [bearer('user-none'), bearer('user-bad', 'not-a-uuid')]) {
      const res = await request(app).get(`${path}?organizationId=${ORG_A}`).set(headers);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ _error: 'Forbidden', _message: 'Organization claim required' });
    }
    expect(pgQueries + cypherRuns.length).toBe(0);
  });
});
