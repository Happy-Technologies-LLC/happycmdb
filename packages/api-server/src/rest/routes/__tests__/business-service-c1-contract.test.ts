// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite Contracts v2 C1 (service reference), CO-1 S2 / HAP-1408 scenarios 1-3:
 *   GET /api/v1/business-services/{service_id}          the C1 service read
 *   GET /api/v1/business-services/{service_id}/context  the bounded dependency and impact subgraph
 * exercised through the real businessServiceRoutes behind the real
 * AuthMiddleware (JWT verification, organization claim from the token), the
 * real Neo4jClient traversal code and the real migration 042 seed.
 *
 * SQL runs on PGlite (fixtures/pglite-host.cjs) as the application role
 * `cmdb_user`, a NOSUPERUSER role that owns the schema it migrated: the
 * CREATE TABLE blocks of 001, then 008, 011, the 028 journal tables and 042
 * verbatim, all applied after SET ROLE cmdb_user. Every request statement
 * runs in that session as that role (asserted before any test).
 *
 * Neo4j is an in-memory graph behind a fake driver session that evaluates
 * the two statements these reads issue (the owned-CI filter and the one-hop
 * traversal frontier), honouring each organization_id predicate the
 * statement actually contains.
 */

import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import {
  Neo4jClient, CITraversalLimitError, createCITraversalWork,
  MAX_CI_TRAVERSAL_NODES, MAX_CI_TRAVERSAL_WORK, CI_TRAVERSAL_QUERY_TIMEOUT_MS,
} from '../../../../../database/src/neo4j/client';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const TENANT_T = '00000000-0000-0000-0000-000000000000'; // migration 042 seeds the internal organization
const TENANT_T2 = '22222222-2222-4222-8222-222222222222';
const SEEDED_S = 'bs-11ab0f28-85c8-4494-b220-e90758c6219a';
const SEEDED_DEPENDENCY = 'bs-ea0cc18a-823a-429b-9846-470882fbdfa3';
const NOT_FOUND = { success: false, error: 'Business service not found' };

// ---------------------------------------------------------------- PostgreSQL (PGlite, app role)

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
const pgClient = {
  query: async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) }),
};

// ---------------------------------------------------------------- Neo4j (in-memory graph)

type Props = Record<string, unknown>;
type FakeRecord = { get(key: string): unknown };
const graph: { nodes: Map<string, Props>; edges: Array<{ from: string; to: string; type: string }> } = {
  nodes: new Map(), edges: [],
};
const record = (values: Props): FakeRecord => ({ get: (key: string) => values[key] });
const node = (props: Props) => ({ properties: props });
const scoped = (cypher: string, variable: string, params: Props) =>
  cypher.includes(`${variable}.organization_id = $organizationId`)
    ? (props: Props) => props['organization_id'] === params['organizationId']
    : () => true;

function runCypher(raw: string, params: Props): FakeRecord[] {
  const cypher = raw.replace(/\s+/g, ' ').trim();
  if (cypher.startsWith('MATCH (ci:CI) WHERE ci.id IN $ids')) {
    const inScope = scoped(cypher, 'ci', params);
    return (params['ids'] as string[]).filter(id => graph.nodes.has(id) && inScope(graph.nodes.get(id)!))
      .map(id => record({ id }));
  }
  if (cypher.startsWith('UNWIND $frontier AS sourceId')) {
    const sourceInScope = scoped(cypher, 'source', params);
    const targetInScope = scoped(cypher, 'target', params);
    const outgoing = cypher.includes('(source)-[relationship');
    const dependencyOnly = cypher.includes('relationship:DEPENDS_ON');
    const rows: FakeRecord[] = [];
    for (const sourceId of params['frontier'] as string[]) {
      const source = graph.nodes.get(sourceId);
      if (!source || !sourceInScope(source)) continue;
      for (const edge of graph.edges) {
        if (dependencyOnly && edge.type !== 'DEPENDS_ON') continue;
        const targetId = outgoing ? edge.from === sourceId && edge.to : edge.to === sourceId && edge.from;
        if (!targetId) continue;
        const target = graph.nodes.get(targetId);
        if (!target || !targetInScope(target)) continue;
        rows.push(record({
          source: node(source), target: node(target), relationship: { type: edge.type, properties: {} },
          startNodeId: edge.from, endNodeId: edge.to,
        }));
      }
    }
    const limit = params['rowLimit'];
    return rows.slice(0, neo4j.isInt(limit) ? limit.toNumber() : Number(limit));
  }
  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}
const neo4jClient = new Neo4jClient('bolt://127.0.0.1:1', 'unused', 'unused');
// `driver` is private: this unchecked view of the instance is the test seam that swaps it.
const driverSeam = neo4jClient as unknown as { driver: { close(): Promise<void> } };
void driverSeam.driver.close();
driverSeam.driver = {
  session: () => ({
    run: async (cypher: string, params: Props = {}) => ({ records: runCypher(cypher, params) }),
    close: async () => undefined,
  }),
  close: async () => undefined,
} as unknown as { close(): Promise<void> };

jest.mock('@cmdb/database', () => ({
  ...jest.requireActual<object>('@cmdb/database/journal/journal'),
  CITraversalLimitError, createCITraversalWork, MAX_CI_TRAVERSAL_NODES, MAX_CI_TRAVERSAL_WORK, CI_TRAVERSAL_QUERY_TIMEOUT_MS,
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => neo4jClient,
  getAuditService: () => ({}),
}));
// bcrypt's native binding is only used for password hashing/login, which token verification never calls.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the organization is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId: string }> = {
  'user-t': { _id: 'user-t', _username: 'tess', _role: 'viewer', _enabled: true, _organizationId: TENANT_T },
  'user-t2': { _id: 'user-t2', _username: 'tom', _role: 'viewer', _enabled: true, _organizationId: TENANT_T2 },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const migration = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
function tableDdl(source: string, tables: string[]): string {
  return tables.map(table => {
    const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found`);
    return match[0];
  }).join('\n');
}

// Tenant T: S (seeded by 042) depends on the seeded dependency; T's portal depends on S.
// S maps two T CIs (the workflow engine under two mapping types) that share a
// dependency on T's directory database; T's portal CI depends on the workflow engine.
// Tenant T2: its own service, dependency and CI, plus rows pointing at or from S that
// only a direct database write can create (S depending on a T2 service, a T2 service
// depending on S, S mapping T2's CI, T's CI depending on T2's CI in the graph): none
// of them may surface to T.
const TEST_SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
  operational_status, owned_by, organization_id) VALUES
  ('bs-t-portal', 'Employee portal', 'application', 'application', 'medium', 'active', 'Internal IT', '${TENANT_T}'),
  ('bs-b-payroll', 'T2 Secret Payroll', 'application', 'application', 'critical', 'active', 'T2 Finance', '${TENANT_T2}'),
  ('bs-b-ledger', 'T2 Secret Ledger', 'data', 'data', 'critical', 'active', 'T2 Finance', '${TENANT_T2}');
INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES
  ('bs-t-portal', '${SEEDED_S}', 'application'),
  ('${SEEDED_S}', 'bs-b-ledger', 'platform'),
  ('bs-b-payroll', 'bs-b-ledger', 'platform'),
  ('bs-b-payroll', '${SEEDED_S}', 'application');
INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
  ('ci-t-workflow', '${SEEDED_S}', 'hosts'),
  ('ci-t-workflow', '${SEEDED_S}', 'supports'),
  ('ci-t-forms', '${SEEDED_S}', 'supports'),
  ('ci-b-payroll-db', '${SEEDED_S}', 'hosts'),
  ('ci-b-payroll-db', 'bs-b-payroll', 'hosts');
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current, organization_id) VALUES
  ('ci-t-workflow', 'Access workflow engine', 'application', 'active', TRUE, '${TENANT_T}'),
  ('ci-t-forms', 'Access request forms', 'application', 'active', TRUE, '${TENANT_T}'),
  ('ci-b-payroll-db', 'T2 Secret Payroll DB', 'database', 'active', TRUE, '${TENANT_T2}');`;

function seedGraph(): void {
  graph.nodes = new Map<string, Props>([
    ['ci-t-workflow', { id: 'ci-t-workflow', name: 'Access workflow engine', type: 'application', status: 'active', organization_id: TENANT_T }],
    ['ci-t-forms', { id: 'ci-t-forms', name: 'Access request forms', type: 'application', status: 'active', organization_id: TENANT_T }],
    ['ci-t-directory', { id: 'ci-t-directory', name: 'Directory database', type: 'database', status: 'active', organization_id: TENANT_T }],
    ['ci-t-portal-web', { id: 'ci-t-portal-web', name: 'Portal web tier', type: 'server', status: 'active', organization_id: TENANT_T }],
    ['ci-b-payroll-db', { id: 'ci-b-payroll-db', name: 'T2 Secret Payroll DB', type: 'database', status: 'active', organization_id: TENANT_T2 }],
  ]);
  graph.edges = [
    { from: 'ci-t-workflow', to: 'ci-t-directory', type: 'DEPENDS_ON' },
    { from: 'ci-t-forms', to: 'ci-t-directory', type: 'DEPENDS_ON' },
    { from: 'ci-t-portal-web', to: 'ci-t-workflow', type: 'DEPENDS_ON' },
    { from: 'ci-t-workflow', to: 'ci-b-payroll-db', type: 'DEPENDS_ON' },
    { from: 'ci-b-payroll-db', to: 'ci-t-workflow', type: 'DEPENDS_ON' },
  ];
}

// Every string naming a T2 row; none may reach a T caller or the logs of a T request.
const T2_STRINGS = [TENANT_T2, 'bs-b-ledger', 'T2 Secret', 'T2 Finance', 'ci-b-payroll-db'];

const jwt = new JWTService(loadConfig().auth.jwt);
const asUser = (userId: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, USERS[userId]!._role, USERS[userId]!._organizationId)}`,
});
const AS_T = asUser('user-t');

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/business-services', businessServiceRoutes);

const read = (serviceId: string) => request(app).get(`/api/v1/business-services/${serviceId}`).set(AS_T);
const readContext = (serviceId: string) => request(app).get(`/api/v1/business-services/${serviceId}/context`).set(AS_T);

let logged: unknown[] = [];
const LOG_METHODS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;

beforeAll(async () => {
  const [{ db }] = await send('query', 'SELECT current_database() AS db') as Array<{ db: string }>;
  await send('exec', `CREATE ROLE cmdb_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT CREATE ON DATABASE "${db}" TO cmdb_user;
    GRANT CREATE ON SCHEMA public TO cmdb_user;
    SET ROLE cmdb_user;`);
  const base = migration('001_complete_schema.sql');
  await send('exec', 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + tableDdl(base,
    ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings', 'cmdb.dim_ci']));
  for (const name of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await send('exec', `BEGIN;\n${migration(name)}\nCOMMIT;`);
  }
  await send('exec', tableDdl(migration('028_change_history_reconciliation_org_provenance.sql'),
    ['ci_reconciliation_operations', 'ci_reconciliation_epochs']));
  await send('exec', `BEGIN;\n${migration('042_co1_access_request_fulfilment_seed.sql')}\nCOMMIT;`);
  await send('exec', TEST_SEED);
  // Every request below runs in this session; refuse to test anything as a superuser.
  const [role] = await pgClient.query(
    'SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user').then(r => r.rows) as
    Array<{ name: string; rolsuper: boolean }>;
  if (role?.name !== 'cmdb_user' || role.rolsuper !== false) throw new Error(`requests would not run as the app role: ${JSON.stringify(role)}`);
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  seedGraph();
  logged = [];
  for (const method of LOG_METHODS) {
    jest.spyOn(logger, method).mockImplementation(((...args: unknown[]) => { logged.push(args); return logger; }) as never);
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('C1 S1 happy path: the seeded service in tenant T', () => {
  it('serves the C1 service record with tenant_id = T', async () => {
    const res = await read(SEEDED_S);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      service_id: SEEDED_S,
      name: 'Access request fulfilment',
      owner: { principal_id: null, display_name: 'Internal IT' },
      criticality: 'high',
      lifecycle: 'live',
      tenant_id: TENANT_T,
      dependencies: [{
        service_id: SEEDED_DEPENDENCY, name: 'Identity and access management',
        criticality: 'critical', lifecycle: 'live', dependency_type: 'platform',
      }],
    });
    expect(res.body.data.service_id).toMatch(/^bs-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(res.body.data.updated_at))).toBe(false);
    // Additive: the fields this read served before C1 keep their meaning.
    expect(res.body.data).toMatchObject({
      organization_id: TENANT_T, business_criticality: 'high', operational_status: 'active', owned_by: 'Internal IT',
    });
  });

  it('serves the dependency and impact subgraph under the CI traversal bounds', async () => {
    const res = await readContext(SEEDED_S);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      service_id: SEEDED_S,
      tenant_id: TENANT_T,
      bounds: {
        max_depth: 5, max_nodes: MAX_CI_TRAVERSAL_NODES, max_adjacency_rows: MAX_CI_TRAVERSAL_WORK,
        statement_timeout_ms: CI_TRAVERSAL_QUERY_TIMEOUT_MS, service_hops: 1,
      },
    });
    const ids = (entries: Array<{ kind: string; id: string; distance: number }>) =>
      entries.map(e => `${e.kind}:${e.id}@${e.distance}`).sort();
    expect(ids(data.dependencies)).toEqual([
      `business_service:${SEEDED_DEPENDENCY}@1`, 'ci:ci-t-directory@2', 'ci:ci-t-forms@1', 'ci:ci-t-workflow@1',
    ]);
    expect(ids(data.impact)).toEqual(['business_service:bs-t-portal@1', 'ci:ci-t-portal-web@2']);
    expect(data.edges.map((e: { from: string; to: string; type: string; mapping_type?: string }) =>
      `${e.from}>${e.to}:${e.type}${e.mapping_type ? `/${e.mapping_type}` : ''}`).sort()).toEqual([
      `${SEEDED_S}>${SEEDED_DEPENDENCY}:DEPENDS_ON`,
      `${SEEDED_S}>ci-t-forms:MAPPED_CI/supports`,
      `${SEEDED_S}>ci-t-workflow:MAPPED_CI/hosts`,
      `${SEEDED_S}>ci-t-workflow:MAPPED_CI/supports`,
      `bs-t-portal>${SEEDED_S}:DEPENDS_ON`,
      'ci-t-forms>ci-t-directory:DEPENDS_ON',
      'ci-t-portal-web>ci-t-workflow:DEPENDS_ON',
      'ci-t-workflow>ci-t-directory:DEPENDS_ON',
    ]);
    expect(data.nodes.length).toBeLessThanOrEqual(MAX_CI_TRAVERSAL_NODES);
  });

  it('refuses a subgraph over the node bound with 503, never a truncated graph', async () => {
    for (let i = 0; i < MAX_CI_TRAVERSAL_NODES; i++) {
      graph.nodes.set(`ci-t-dep-${i}`, { id: `ci-t-dep-${i}`, name: `Dependent ${i}`, type: 'server', status: 'active', organization_id: TENANT_T });
      graph.edges.push({ from: `ci-t-dep-${i}`, to: 'ci-t-workflow', type: 'DEPENDS_ON' });
    }

    const res = await readContext(SEEDED_S);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'CI traversal resource limit exceeded' });
  });
});

describe('C1 S2 nonexistent service_id', () => {
  it('answers 404 on both reads, never an empty 200', async () => {
    const missing = `bs-${randomUUID()}`;

    const [service, context] = await Promise.all([read(missing), readContext(missing)]);

    expect([service.status, service.body]).toEqual([404, NOT_FOUND]);
    expect([context.status, context.body]).toEqual([404, NOT_FOUND]);
  });
});

describe('C1 S3 service_id of tenant T2 read with T credentials', () => {
  it('answers the missing-service 404 on both reads and leaks no T2 row', async () => {
    const missing = `bs-${randomUUID()}`;
    const [foreign, foreignContext, absent, absentContext] =
      await Promise.all([read('bs-b-payroll'), readContext('bs-b-payroll'), read(missing), readContext(missing)]);

    expect([foreign.status, foreign.text]).toEqual([absent.status, absent.text]);
    expect([foreignContext.status, foreignContext.text]).toEqual([absentContext.status, absentContext.text]);
    expect([foreign.status, foreign.body]).toEqual([404, NOT_FOUND]);
    // T's own reads of S never surface the T2 rows that point at S.
    const own = [await read(SEEDED_S), await readContext(SEEDED_S)];
    expect(own.map(r => r.status)).toEqual([200, 200]);
    const seen = [foreign, foreignContext, ...own].map(r => r.text).join('\n') + JSON.stringify(logged);
    for (const t2 of T2_STRINGS) expect(seen).not.toContain(t2);
  });
});
