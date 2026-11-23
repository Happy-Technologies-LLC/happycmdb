// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite Contracts v2 C1 (service reference), CO-1 S2 / HAP-1408 scenarios 1-3:
 *   GET /api/v1/business-services/{service_id}          the C1 service read
 *   GET /api/v1/business-services/{service_id}/context  the bounded dependency and impact subgraph
 * exercised through the real businessServiceRoutes behind the real
 * AuthMiddleware (JWT verification, organization claim from the token), the
 * real Neo4jClient traversal code and the real migration 042 seed. HAP-1423:
 * migration 043 runs after the test seed, so every C1 field below is the
 * stored, backfilled record (lifecycle live for active rows, version 1).
 *
 * SQL runs on PGlite (fixtures/pglite-host.cjs). The NOSUPERUSER owner `cmdb_owner` applies the CREATE TABLE blocks
 * of 001, then 008, 011, the 028 journal tables, 042 and 043 verbatim, plus the app grants and 044
 * (fixtures/app-login.ts). Every request statement then runs as the app login `cmdb_user`, which is not a superuser
 * and owns no table (HAP-1422; refused by assertAppLogin otherwise).
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

import { PostgresClient } from '../../../../../database/src/postgres/client';
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
// The /context service walk runs in a transaction that sets its own statement_timeout:
// the seam records that setting as the walk saw it, and can fail the walk statement.
let walkStatementTimeouts: string[] = [];
let walkFailure: Error | null = null;
// HAP-2030 evidence seams: every statement that reached PostgreSQL, how each transaction ended, the pooled connections
// taken and released, and an optional failure the evidence statement throws (PGlite does not enforce statement_timeout,
// so a stall is the 57014 PostgreSQL would raise, thrown only after recording the statement_timeout the transaction had
// set for it).
let pgStatements: string[] = [];
let transactions = { begun: 0, committed: 0, rolledBack: 0 };
let connections = { acquired: 0, released: 0 };
let evidenceFailure: Error | null = null;
let evidenceStatementTimeouts: string[] = [];
const EVIDENCE_TABLE = 'relationship_evidence_receipts';
async function appStatement(sql: string, params: unknown[] = []) {
  assertAppStatement(sql);
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
    if (sql === 'BEGIN') transactions.begun++;
    if (sql === 'COMMIT') transactions.committed++;
    if (sql === 'ROLLBACK') transactions.rolledBack++;
    await send('exec', sql);
    return { rows: [] };
  }
  pgStatements.push(sql);
  if (sql.includes('WITH RECURSIVE')) {
    const [setting] = await send('query', `SELECT current_setting('statement_timeout') AS value`) as Array<{ value: string }>;
    walkStatementTimeouts.push(setting!.value);
    if (walkFailure) throw walkFailure;
  }
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

// Every batched incarnation statement the evidence loader issued (statement text and parameters).
let incarnationReads: Array<{ cypher: string; params: Props }> = [];
// An optional failure only the incarnation read throws (a Neo4j transaction timeout on that statement).
let incarnationFailure: Error | null = null;

function runCypher(raw: string, params: Props): FakeRecord[] {
  const cypher = raw.replace(/\s+/g, ' ').trim();
  // HAP-2030's one batched incarnation read of the evidence loader: org-scoped like the real statement, and a node that
  // exists in the organization without `incarnation_id` is returned with a null incarnation (a legacy CI).
  if (cypher.includes('RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId')) {
    incarnationReads.push({ cypher, params });
    if (incarnationFailure) throw incarnationFailure;
    const inScope = scoped(cypher, 'ci', params);
    return (params['ids'] as string[]).filter(id => graph.nodes.has(id) && inScope(graph.nodes.get(id)!))
      .map(id => record({ ciId: id, incarnationId: graph.nodes.get(id)!['incarnation_id'] ?? null }));
  }
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
// Every graph statement's timeout (the read advertises bounds.statement_timeout_ms),
// and an optional failure every statement throws (a Neo4j transaction timeout).
let statementTimeouts: Array<number | undefined> = [];
let graphFailure: Error | null = null;
driverSeam.driver = {
  session: () => ({
    run: async (cypher: string, params: Props = {}, config?: { timeout?: number }) => {
      statementTimeouts.push(config?.timeout);
      if (graphFailure) throw graphFailure;
      return { records: runCypher(cypher, params) };
    },
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
import {
  APP_GRANTS_SQL, assertAppLogin, assertAppStatement, asTableOwner, createLoginRolesSql, ENTER_APP_LOGIN_SQL,
  journalReadAclSql, lineageReadAclSql, lineageTableSql, receiptTableSql,
} from './fixtures/app-login';

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
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, USERS[userId]!._role, USERS[userId]!._organizationId, 0, Math.floor(Date.now() / 1000))}`,
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
  await send('exec', createLoginRolesSql(db));
  const base = migration('001_complete_schema.sql');
  await send('exec', 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + tableDdl(base,
    ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings', 'cmdb.dim_ci']));
  for (const name of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await send('exec', `BEGIN;\n${migration(name)}\nCOMMIT;`);
  }
  await send('exec', tableDdl(migration('028_change_history_reconciliation_org_provenance.sql'),
    ['ci_reconciliation_operations', 'ci_reconciliation_epochs']));
  await send('exec', lineageTableSql());
  await send('exec', receiptTableSql());
  await send('exec', `BEGIN;\n${migration('042_co1_access_request_fulfilment_seed.sql')}\nCOMMIT;`);
  await send('exec', TEST_SEED);
  for (const name of ['043_business_service_record_c1.sql', '046_service_offerings.sql']) {
    await send('exec', `BEGIN;\n${migration(name)}\nCOMMIT;`);
  }
  await send('exec', APP_GRANTS_SQL + journalReadAclSql() + lineageReadAclSql() + ENTER_APP_LOGIN_SQL);
  // Every request below runs in this session; refuse to test anything as a superuser or the table owner.
  await assertAppLogin(sql => send('query', sql));
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  seedGraph();
  statementTimeouts = [];
  graphFailure = null;
  walkStatementTimeouts = [];
  pgStatements = [];
  transactions = { begun: 0, committed: 0, rolledBack: 0 };
  connections = { acquired: 0, released: 0 };
  evidenceFailure = null;
  evidenceStatementTimeouts = [];
  incarnationReads = [];
  incarnationFailure = null;
  walkFailure = null;
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
      owner_group: null,
      criticality: 'high',
      lifecycle: 'live',
      version: 1,
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
        statement_timeout_ms: CI_TRAVERSAL_QUERY_TIMEOUT_MS,
      },
    });
    const ids = (entries: Array<{ kind: string; id: string; distance: number }>) =>
      entries.map(e => `${e.kind}:${e.id}@${e.distance}`).sort();
    expect(ids(data.dependencies)).toEqual([
      `business_service:${SEEDED_DEPENDENCY}@1`, 'ci:ci-t-directory@2', 'ci:ci-t-forms@1', 'ci:ci-t-workflow@1',
    ]);
    expect(ids(data.impact)).toEqual(['business_service:bs-t-portal@1', 'ci:ci-t-portal-web@2']);
    // HAP-1423: each service node carries the stored lifecycle.
    expect(data.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'business_service', id: SEEDED_S, lifecycle: 'live' }),
      expect.objectContaining({ kind: 'business_service', id: SEEDED_DEPENDENCY, lifecycle: 'live' }),
    ]));
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
    // Every graph statement of the read, the ownership filter included, ran under the advertised timeout.
    expect(statementTimeouts.length).toBeGreaterThan(0);
    expect(new Set(statementTimeouts)).toEqual(new Set([CI_TRAVERSAL_QUERY_TIMEOUT_MS]));
    // The service walk statement ran under the same timeout, set for its own transaction only.
    expect(walkStatementTimeouts).toEqual(['5s']);
    const [after] = await send('query', `SELECT current_setting('statement_timeout') AS value`) as Array<{ value: string }>;
    expect(after!.value).toBe('0');
  });

  describe('HAP-2028 impact envelope', () => {
    const lineage = (ciId: string, org: string | null) =>
      `INSERT INTO ci_source_lineage (ci_id, source_name, source_id, organization_id) VALUES ('${ciId}', 'disc', '${ciId}', ${org ? `'${org}'` : 'NULL'});`;
    const withLineage = async (rows: string[], run: () => Promise<void>) => {
      await asTableOwner(statement => send('exec', statement), () => send('exec', rows.join('\n')));
      try { await run(); } finally {
        await asTableOwner(statement => send('exec', statement), () => send('exec', 'DELETE FROM ci_source_lineage'));
      }
    };

    it('declares declared-graph reachability and lists exactly the in-scope CIs this organization has no lineage for', async () => {
      // T reports workflow and forms. Directory is reported only by T2 (same ci_id, other organization) and the
      // portal web tier only by a legacy NULL-organization row: neither is a report to T.
      await withLineage([
        lineage('ci-t-workflow', TENANT_T), lineage('ci-t-forms', TENANT_T),
        lineage('ci-t-directory', TENANT_T2), lineage('ci-t-portal-web', null),
      ], async () => {
        const res = await readContext(SEEDED_S);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          success: true,
          basis: 'declared_graph_reachability',
          runtime_blast_radius: 'not_established',
          coverage: {
            ci_nodes_in_scope: 4,
            unreported_ci_ids: ['ci-t-directory', 'ci-t-portal-web'],
            runtime_observed_receipts_in_scope: false,
          },
        });
        expect(res.body.coverage.note).toMatch(/missing edge is not evidence of no dependency/i);
        for (const foreign of T2_STRINGS) expect(JSON.stringify(res.body.coverage)).not.toContain(foreign);
        // Additive: the subgraph itself is unchanged.
        expect(res.body.data.nodes.filter((n: { kind: string }) => n.kind === 'ci')).toHaveLength(4);
      });
    });

    it('lists no CI when every in-scope CI has lineage, and the envelope stays on a service with no CIs', async () => {
      await withLineage(['ci-t-workflow', 'ci-t-forms', 'ci-t-directory', 'ci-t-portal-web'].map(id => lineage(id, TENANT_T)), async () => {
        expect((await readContext(SEEDED_S)).body.coverage).toMatchObject({ ci_nodes_in_scope: 4, unreported_ci_ids: [] });
      });
      const bare = await readContext('bs-t-portal');
      expect(bare.status).toBe(200);
      expect(bare.body).toMatchObject({
        basis: 'declared_graph_reachability', runtime_blast_radius: 'not_established',
        coverage: { ci_nodes_in_scope: 0, unreported_ci_ids: [], runtime_observed_receipts_in_scope: false },
      });
    });
  });

  it('reads lifecycle from the stored record, not from operational_status (HAP-1423)', async () => {
    await send('exec', `UPDATE dim_business_services SET lifecycle = 'retiring' WHERE service_id = 'bs-t-portal'`);
    try {
      const res = await readContext(SEEDED_S);
      expect(res.body.data.nodes).toContainEqual(expect.objectContaining({ id: 'bs-t-portal', lifecycle: 'retiring' }));
      expect((await read('bs-t-portal')).body.data).toMatchObject({ operational_status: 'active', lifecycle: 'retiring' });
    } finally {
      await send('exec', `UPDATE dim_business_services SET lifecycle = 'live' WHERE service_id = 'bs-t-portal'`);
    }
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

describe('C1 S1 service walk: services are reached transitively in both directions, within the tenant and the bounds', () => {
  const LIMIT_BODY = { success: false, error: 'CI traversal resource limit exceeded' };
  const ids = (entries: Array<{ kind: string; id: string; distance: number }>) =>
    entries.filter(e => e.kind === 'business_service').map(e => `${e.id}@${e.distance}`).sort();
  /** Seed services (id -> organization) and dependency edges [from, to] for `run`, removed again afterwards. */
  async function withServices(services: Record<string, string>, deps: Array<[string, string]>, run: () => Promise<void>): Promise<void> {
    const created = Object.keys(services);
    await send('exec', `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
        business_criticality, operational_status, organization_id) VALUES
      ${Object.entries(services).map(([id, org]) => `('${id}', 'Service ${id}', 'application', 'application', 'medium', 'active', '${org}')`).join(',\n')};
      INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES
      ${deps.map(([from, to]) => `('${from}', '${to}', 'application')`).join(',\n')};`);
    try {
      await run();
    } finally {
      await send('exec', `DELETE FROM dim_business_services WHERE service_id = ANY(ARRAY[${created.map(id => `'${id}'`).join(',')}])`);
    }
  }

  it('reaches a two-hop dependent and a two-hop dependency, at their distances, with every edge', async () => {
    // bs-t-x -> bs-t-portal -> S (impact) and S -> IAM -> bs-t-y (dependencies).
    await withServices({ 'bs-t-x': TENANT_T, 'bs-t-y': TENANT_T }, [['bs-t-x', 'bs-t-portal'], [SEEDED_DEPENDENCY, 'bs-t-y']], async () => {
      const res = await readContext(SEEDED_S);

      expect(res.status).toBe(200);
      expect(ids(res.body.data.dependencies)).toEqual([`${SEEDED_DEPENDENCY}@1`, 'bs-t-y@2']);
      expect(ids(res.body.data.impact)).toEqual(['bs-t-portal@1', 'bs-t-x@2']);
      const edges = res.body.data.edges.map((e: { from: string; to: string; type: string }) => `${e.from}>${e.to}:${e.type}`);
      expect(edges).toEqual(expect.arrayContaining([`${SEEDED_DEPENDENCY}>bs-t-y:DEPENDS_ON`, 'bs-t-x>bs-t-portal:DEPENDS_ON']));
      expect(res.body.data.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'business_service', id: 'bs-t-x' }), expect.objectContaining({ kind: 'business_service', id: 'bs-t-y' }),
      ]));
    });
  });

  it('refuses a service chain that continues past max_depth, including a back edge from the last hop', async () => {
    // S -> IAM (1) -> c2 (2) -> c3 (3) -> c4 (4) -> c5 (5 = max_depth).
    const chain = ['bs-t-c2', 'bs-t-c3', 'bs-t-c4', 'bs-t-c5'];
    const steps: Array<[string, string]> = [[SEEDED_DEPENDENCY, 'bs-t-c2'], ['bs-t-c2', 'bs-t-c3'], ['bs-t-c3', 'bs-t-c4'], ['bs-t-c4', 'bs-t-c5']];
    await withServices({ ...Object.fromEntries(chain.map(id => [id, TENANT_T])), 'bs-t-c6': TENANT_T }, steps, async () => {
      const ending = await readContext(SEEDED_S);
      expect(ending.status).toBe(200);
      expect(ids(ending.body.data.dependencies)).toContain('bs-t-c5@5');

      await send('exec', `INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES ('bs-t-c5', 'bs-t-c3', 'application')`);
      const withBackEdge = await readContext(SEEDED_S);
      await send('exec', `DELETE FROM business_service_dependencies WHERE service_id = 'bs-t-c5'`);
      await send('exec', `INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES ('bs-t-c5', 'bs-t-c6', 'application')`);
      const deeper = await readContext(SEEDED_S);

      expect([withBackEdge.status, withBackEdge.body]).toEqual([503, LIMIT_BODY]);
      expect([deeper.status, deeper.body]).toEqual([503, LIMIT_BODY]);
    });
  });

  it('ends the walk at another tenant\'s service: neither it nor what lies past it appears, and nothing is refused', async () => {
    // S -> IAM -> bs-t-y (T, appears at 2); IAM -> bs-b-mid (T2) -> bs-t-after (T) -> ... a long T-only tail past depth 5.
    const tail = ['bs-t-after', 'bs-t-tail1', 'bs-t-tail2', 'bs-t-tail3', 'bs-t-tail4', 'bs-t-tail5'];
    await withServices(
      { 'bs-t-y': TENANT_T, 'bs-b-mid': TENANT_T2, ...Object.fromEntries(tail.map(id => [id, TENANT_T])) },
      [[SEEDED_DEPENDENCY, 'bs-t-y'], [SEEDED_DEPENDENCY, 'bs-b-mid'], ['bs-b-mid', 'bs-t-after'],
        ...tail.slice(1).map((id, i): [string, string] => [tail[i]!, id]), ['bs-b-mid', SEEDED_S]],
      async () => {
        const res = await readContext(SEEDED_S);

        expect(res.status).toBe(200);
        expect(ids(res.body.data.dependencies)).toEqual([`${SEEDED_DEPENDENCY}@1`, 'bs-t-y@2']);
        expect(ids(res.body.data.impact)).toEqual(['bs-t-portal@1']);
        for (const hidden of ['bs-b-mid', ...tail]) expect(res.text).not.toContain(hidden);
      },
    );
  });

  it('refuses a service walk over the adjacency-row budget even when its nodes fit the node bound', async () => {
    // IAM -> 4 layers of 6 services, every service depending on all 6 of the next layer:
    // 25 services, but 6 + 36 + 216 + 1296 walk rows (paths) > 400.
    const layers = [0, 1, 2, 3].map(l => [0, 1, 2, 3, 4, 5].map(i => `bs-t-l${l}-${i}`));
    const steps: Array<[string, string]> = [
      ...layers[0]!.map((id): [string, string] => [SEEDED_DEPENDENCY, id]),
      ...layers.slice(1).flatMap((layer, l) => layers[l]!.flatMap(from => layer.map((to): [string, string] => [from, to]))),
    ];
    await withServices(Object.fromEntries(layers.flat().map(id => [id, TENANT_T])), steps, async () => {
      const res = await readContext(SEEDED_S);

      expect([res.status, res.body]).toEqual([503, LIMIT_BODY]);
    });
  });

  it('maps a service walk statement timeout to the fixed 504', async () => {
    walkFailure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

    const res = await readContext(SEEDED_S);

    expect([res.status, res.body]).toEqual([504, { success: false, error: 'CI traversal timed out' }]);
  });
});

describe('C1 S1 bounds: the context read refuses a subgraph over any bound, never cuts it', () => {
  const LIMIT_BODY = { success: false, error: 'CI traversal resource limit exceeded' };
  const ciNode = (id: string) => ({ id, name: `CI ${id}`, type: 'server', status: 'active', organization_id: TENANT_T });
  /** Seed T CIs mapped to S (dimension row, graph node and mapping rows), removed again after `run`. */
  async function withMappedCIs(ids: string[], mappingTypes: string[], run: () => Promise<void>): Promise<void> {
    await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current, organization_id) VALUES
      ${ids.map(id => `('${id}', 'CI ${id}', 'server', 'active', TRUE, '${TENANT_T}')`).join(',\n')};
      INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
      ${ids.flatMap(id => mappingTypes.map(type => `('${id}', '${SEEDED_S}', '${type}')`)).join(',\n')};`);
    for (const id of ids) graph.nodes.set(id, ciNode(id));
    try {
      await run();
    } finally {
      // The app login may insert CIs (034) but not delete them: clean up as the owner.
      await asTableOwner(sql => send('exec', sql), () => send('exec', `
        DELETE FROM ci_business_service_mappings WHERE ci_id = ANY(ARRAY[${ids.map(id => `'${id}'`).join(',')}]);
        DELETE FROM cmdb.dim_ci WHERE ci_id = ANY(ARRAY[${ids.map(id => `'${id}'`).join(',')}]);`));
    }
  }

  it('refuses a CI chain that continues past max_depth, including a back edge from the last hop', async () => {
    // Mapped CI (hop 0) > ci-t-directory (1) > d1 (2) > d2 (3) > d3 (4) > d4 (5 = max_depth).
    for (const id of ['ci-t-d1', 'ci-t-d2', 'ci-t-d3', 'ci-t-d4', 'ci-t-d5']) graph.nodes.set(id, ciNode(id));
    graph.edges.push(
      { from: 'ci-t-directory', to: 'ci-t-d1', type: 'DEPENDS_ON' }, { from: 'ci-t-d1', to: 'ci-t-d2', type: 'DEPENDS_ON' },
      { from: 'ci-t-d2', to: 'ci-t-d3', type: 'DEPENDS_ON' }, { from: 'ci-t-d3', to: 'ci-t-d4', type: 'DEPENDS_ON' });
    const ending = await readContext(SEEDED_S);
    expect(ending.status).toBe(200);
    expect(ending.body.data.dependencies).toContainEqual({ kind: 'ci', id: 'ci-t-d4', distance: 6 });

    const backEdge = { from: 'ci-t-d4', to: 'ci-t-directory', type: 'DEPENDS_ON' };
    graph.edges.push(backEdge);
    const withBackEdge = await readContext(SEEDED_S);
    graph.edges = graph.edges.filter(edge => edge !== backEdge);
    graph.edges.push({ from: 'ci-t-d4', to: 'ci-t-d5', type: 'DEPENDS_ON' });
    const deeper = await readContext(SEEDED_S);

    expect([withBackEdge.status, withBackEdge.body]).toEqual([503, LIMIT_BODY]);
    expect([deeper.status, deeper.body]).toEqual([503, LIMIT_BODY]);
  });

  it('refuses more mapping rows than the adjacency-row budget', async () => {
    // 81 CIs under 5 mapping types: 405 rows, 81 + 7 nodes.
    const ids = Array.from({ length: 81 }, (_, i) => `ci-t-many-${i}`);
    await withMappedCIs(ids, ['hosts', 'supports', 'consumes', 'depends_on', 'monitors'], async () => {
      const res = await readContext(SEEDED_S);
      expect([res.status, res.body]).toEqual([503, LIMIT_BODY]);
    });
  });

  it('refuses more services and CIs together than the node bound', async () => {
    // 7 seeded nodes + 60 dependent services + 41 mapped CIs = 108 > 100; only 45 of them are CIs.
    const services = Array.from({ length: 60 }, (_, i) => `bs-t-dependent-${i}`);
    await send('exec', `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
        business_criticality, operational_status, organization_id) VALUES
      ${services.map(id => `('${id}', 'Dependent ${id}', 'application', 'application', 'low', 'active', '${TENANT_T}')`).join(',\n')};
      INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES
      ${services.map(id => `('${id}', '${SEEDED_S}', 'application')`).join(',\n')};`);
    try {
      await withMappedCIs(Array.from({ length: 41 }, (_, i) => `ci-t-mapped-${i}`), ['hosts'], async () => {
        const res = await readContext(SEEDED_S);
        expect([res.status, res.body]).toEqual([503, LIMIT_BODY]);
      });
    } finally {
      await send('exec', `DELETE FROM dim_business_services WHERE service_id LIKE 'bs-t-dependent-%'`);
    }
  });

  it('refuses a hop over the adjacency-row budget (parallel relationships count)', async () => {
    for (let i = 0; i < MAX_CI_TRAVERSAL_WORK; i++) graph.edges.push({ from: 'ci-t-workflow', to: 'ci-t-directory', type: 'DEPENDS_ON' });

    const res = await readContext(SEEDED_S);

    expect([res.status, res.body]).toEqual([503, LIMIT_BODY]);
  });

  it('maps a graph statement timeout to the fixed 504', async () => {
    graphFailure = Object.assign(new Error('timed out'), { code: 'Neo.ClientError.Transaction.TransactionTimedOut' });

    const res = await readContext(SEEDED_S);

    expect([res.status, res.body]).toEqual([504, { success: false, error: 'CI traversal timed out' }]);
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

// ---------------------------------------------------------------- HAP-2030: per-edge evidence and derived currentness
//
// The real routes, the real controller and the real evidence loader over the real 054 table in PGlite, read as the app login
// cmdb_user. Fixtures (services, CIs, receipts) are written as the table owner, with explicit observed_at offsets from the
// database clock and random organization and CI ids per test: the append-only table is never truncated.

describe('HAP-2030 /context edge evidence and derived currentness', () => {
  type EdgeBody = {
    from: string; to: string; type: string; dependency_type?: string; mapping_type?: string;
    currentness?: string; evidence?: { last_supported_at: string | null } & Record<string, unknown>;
  };
  type EvidenceClass = 'declared' | 'static_observed' | 'runtime_observed' | 'inferred';
  const DAY_MS = 86_400_000;
  const LIMIT_AND_TIMEOUT_BODY = { success: false, error: 'CI traversal timed out' };
  // Strings that must never appear inside an edge object.
  const BANNED_IN_EDGES = ['organization_id', 'incarnation', 'source_name', 'observer', 'correlation_id'];
  const SECRET_SOURCE = 'secret-source-name';
  const SECRET_OBSERVER = 'secret-observer-token';

  const owner = (sql: string, params: unknown[] = []) =>
    asTableOwner(statement => send('exec', statement), () => send('query', sql, params));

  interface World { org: string; service: string; auth: { Authorization: string } }
  async function newWorld(): Promise<World> {
    const org = randomUUID();
    const user = `user-${org}`;
    USERS[user] = { _id: user, _username: `viewer-${org.slice(0, 8)}`, _role: 'viewer', _enabled: true, _organizationId: org };
    const service = `bs-${randomUUID()}`;
    await addService(service, org);
    return { org, service, auth: asUser(user) };
  }
  const addService = (service: string, org: string) => owner(
    `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
       operational_status, owned_by, organization_id) VALUES ($1, 'Evidence service', 'application', 'application', 'medium',
       'active', 'Internal IT', $2)`, [service, org]);
  async function mapCi(world: World, ciId: string): Promise<void> {
    await owner(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ($1, $2, 'hosts')`,
      [ciId, world.service]);
    await owner(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current, organization_id)
      VALUES ($1, $1, 'application', 'active', TRUE, $2)`, [ciId, world.org]);
  }
  /** A CI of the world's organization in the fake graph; `null` incarnation is a legacy CI that never got one. */
  function addCi(world: World, id: string, incarnation: string | null = randomUUID(), org = world.org): string {
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

  const getContext = (world: World) =>
    request(app).get(`/api/v1/business-services/${world.service}/context`).set(world.auth);
  const ciEdges = (body: { data: { edges: EdgeBody[] } }, from: string, to: string) =>
    body.data.edges.filter(e => e.from === from && e.to === to && e.type === 'DEPENDS_ON' && e.dependency_type === undefined);
  const ciEdge = (body: { data: { edges: EdgeBody[] } }, from: string, to: string): EdgeBody => {
    const found = ciEdges(body, from, to);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const href = (from: string, to: string) => `/api/v1/relationships/evidence?from_id=${from}&to_id=${to}&type=DEPENDS_ON`;
  const receiptStatements = () => pgStatements.filter(sql => sql.includes(EVIDENCE_TABLE));
  const nearAgeDays = (iso: string | null, days: number) => {
    expect(iso).not.toBeNull();
    expect(Math.abs(Date.parse(iso!) - (Date.now() - days * DAY_MS))).toBeLessThan(10 * 60_000);
  };

  /** The five-edge scenario: four edges out of the mapped root, one in; the last has no receipt at all. */
  async function fiveEdgeScenario() {
    const world = await newWorld();
    const tag = randomUUID().slice(0, 8);
    const ids = {
      root: `root-${tag}`, declaredFresh: `declared-fresh-${tag}`, staticRecent: `static-recent-${tag}`,
      staticOld: `static-old-${tag}`, contradicted: `contradicted-${tag}`, noReceipt: `no-receipt-${tag}`,
    };
    for (const id of Object.values(ids)) addCi(world, id);
    await mapCi(world, ids.root);
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

  it('qualifies each CI edge: current, current, stale, contradicted and unsupported, beside the unchanged envelope', async () => {
    const { world, ids } = await fiveEdgeScenario();

    const res = await getContext(world);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, basis: 'declared_graph_reachability', runtime_blast_radius: 'not_established',
      coverage: { runtime_observed_receipts_in_scope: false },
    });
    const fresh = ciEdge(res.body, ids.root, ids.declaredFresh);
    expect(fresh).toMatchObject({
      currentness: 'current',
      evidence: {
        classes: ['declared'], support: { supports: 1, contradicts: 0 }, receipt_count: 1, receipts_truncated: false,
        receipts_href: href(ids.root, ids.declaredFresh),
      },
    });
    nearAgeDays(fresh.evidence!.last_supported_at, 1);
    const recent = ciEdge(res.body, ids.root, ids.staticRecent);
    expect(recent).toMatchObject({
      currentness: 'current',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
    });
    nearAgeDays(recent.evidence!.last_supported_at, 2);
    const old = ciEdge(res.body, ids.root, ids.staticOld);
    expect(old).toMatchObject({
      currentness: 'stale',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
    });
    nearAgeDays(old.evidence!.last_supported_at, 30);
    const contradicted = ciEdge(res.body, ids.root, ids.contradicted);
    expect(contradicted).toMatchObject({
      currentness: 'contradicted',
      evidence: { classes: ['static_observed'], support: { supports: 1, contradicts: 1 }, receipt_count: 2 },
    });
    expect(ciEdge(res.body, ids.noReceipt, ids.root)).toMatchObject({
      currentness: 'unsupported',
      evidence: {
        classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0, receipts_truncated: false,
        last_supported_at: null, receipts_href: href(ids.noReceipt, ids.root),
      },
    });
  });

  it('applies each class its own freshness window: runtime 1 day, static 7 days, declared 180 days, inferred never', async () => {
    const world = await newWorld();
    const tag = randomUUID().slice(0, 8);
    const root = addCi(world, `root-${tag}`);
    await mapCi(world, root);
    const cases: Array<[string, EvidenceClass, number, string]> = [
      ['runtime-fresh', 'runtime_observed', 0.5, 'current'], ['runtime-late', 'runtime_observed', 2, 'stale'],
      ['static-fresh', 'static_observed', 6, 'current'], ['static-late', 'static_observed', 8, 'stale'],
      ['declared-old', 'declared', 170, 'current'], ['declared-late', 'declared', 190, 'stale'],
      ['inferred-only', 'inferred', 0.1, 'stale'],
    ];
    for (const [name, cls, ageDays] of cases) {
      const target = addCi(world, `${name}-${tag}`);
      link(root, target);
      await receipt({ org: world.org, from: root, to: target, cls, ageDays });
    }

    const res = await getContext(world);

    expect(res.status).toBe(200);
    for (const [name, , , expected] of cases) expect([name, ciEdge(res.body, root, `${name}-${tag}`).currentness]).toEqual([name, expected]);
    // An inferred support is reported as evidence but never makes an edge current.
    expect(ciEdge(res.body, root, `inferred-only-${tag}`).evidence).toMatchObject({ classes: ['inferred'], receipt_count: 1 });
  });

  it('gives a service-to-service DEPENDS_ON edge and a MAPPED_CI edge neither member, beside a CI edge with the same ids', async () => {
    // The CI ids spell the service ids: the service edge S>Y DEPENDS_ON, the mapping edge S>Y MAPPED_CI and the CI edge S>Y
    // DEPENDS_ON (with receipts) share every id string, and only the CI edge is a relationship of the graph.
    const world = await newWorld();
    const serviceY = `bs-${randomUUID()}`;
    await addService(serviceY, world.org);
    await owner(`INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ($1, $2, 'application')`, [world.service, serviceY]);
    addCi(world, world.service); addCi(world, serviceY);
    await mapCi(world, serviceY);
    link(world.service, serviceY);
    await receipt({ org: world.org, from: world.service, to: serviceY, cls: 'static_observed', ageDays: 1 });

    const res = await getContext(world);

    expect(res.status).toBe(200);
    const shared = res.body.data.edges.filter((e: EdgeBody) => e.from === world.service && e.to === serviceY);
    expect(shared).toHaveLength(3);
    const serviceEdge = shared.find((e: EdgeBody) => e.dependency_type !== undefined);
    const mappedEdge = shared.find((e: EdgeBody) => e.type === 'MAPPED_CI');
    const edge = shared.find((e: EdgeBody) => e.type === 'DEPENDS_ON' && e.dependency_type === undefined);
    // Keys absent, not null.
    expect(Object.keys(serviceEdge).sort()).toEqual(['dependency_type', 'from', 'to', 'type']);
    expect(Object.keys(mappedEdge).sort()).toEqual(['from', 'mapping_type', 'to', 'type']);
    expect(Object.keys(edge).sort()).toEqual(['currentness', 'evidence', 'from', 'to', 'type']);
    expect(edge).toMatchObject({ currentness: 'current', evidence: { classes: ['static_observed'], receipt_count: 1 } });
  });

  describe('organization and incarnation isolation', () => {
    it("never lets another organization's receipts, carrying this organization's ids and incarnations, change a read", async () => {
      const world = await newWorld();
      const tag = randomUUID().slice(0, 8);
      const [root, withOwn, onlyForeign] = [`root-${tag}`, `own-${tag}`, `foreign-${tag}`].map(id => addCi(world, id));
      await mapCi(world, root!);
      link(root!, withOwn!); link(root!, onlyForeign!);
      await receipt({ org: world.org, from: root!, to: withOwn!, cls: 'static_observed', ageDays: 1 });
      const otherOrg = randomUUID();
      // Newer contradiction and a fresh support, written by another organization against the same ids and incarnations.
      await receipt({ org: otherOrg, from: root!, to: withOwn!, cls: 'static_observed', polarity: 'contradicts', ageDays: 0.1 });
      await receipt({ org: otherOrg, from: root!, to: onlyForeign!, cls: 'declared', ageDays: 0.1 });

      const res = await getContext(world);

      expect(res.status).toBe(200);
      expect(ciEdge(res.body, root!, withOwn!)).toMatchObject({
        currentness: 'current', evidence: { support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
      });
      expect(ciEdge(res.body, root!, onlyForeign!)).toMatchObject({
        currentness: 'unsupported', evidence: { classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0 },
      });
    });

    it('fences by incarnation: a receipt of a re-created CI, on either end, is inert, and legacy CIs are never assigned one', async () => {
      const world = await newWorld();
      const tag = randomUUID().slice(0, 8);
      const [root, reTo, reFrom, both] = ['root', 'recreated-to', 'recreated-from', 'both']
        .map(name => addCi(world, `${name}-${tag}`));
      const legacy = addCi(world, `legacy-${tag}`, null);
      await mapCi(world, root!);
      for (const target of [reTo!, reFrom!, both!, legacy!]) link(root!, target);
      const org = world.org;
      // The old incarnation's receipts: the CI was deleted and re-created since (the graph holds the new incarnation).
      await receipt({ org, from: root!, to: reTo!, cls: 'static_observed', ageDays: 1, toInc: randomUUID() });
      await receipt({ org, from: root!, to: reFrom!, cls: 'static_observed', ageDays: 1, fromInc: randomUUID() });
      await receipt({ org, from: root!, to: both!, cls: 'static_observed', polarity: 'contradicts', ageDays: 0.1, toInc: randomUUID() });
      await receipt({ org, from: root!, to: both!, cls: 'static_observed', ageDays: 1 });
      await receipt({ org, from: root!, to: legacy!, cls: 'static_observed', ageDays: 1, toInc: randomUUID() });

      const res = await getContext(world);

      expect(res.status).toBe(200);
      expect(ciEdge(res.body, root!, reTo!)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      expect(ciEdge(res.body, root!, reFrom!)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      // Only the current incarnation's receipt counts; the old incarnation's newer contradiction is inert.
      expect(ciEdge(res.body, root!, both!)).toMatchObject({
        currentness: 'current', evidence: { support: { supports: 1, contradicts: 0 }, receipt_count: 1 },
      });
      expect(ciEdge(res.body, root!, legacy!)).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0 } });
      // A read assigns no incarnation: the legacy CI still has none, and the graph saw no write statement
      // (the fake refuses any statement it does not know).
      expect(graph.nodes.get(legacy!)!['incarnation_id']).toBeUndefined();
    });
  });

  describe('cost bound', () => {
    const readWithEdges = async (outgoing: number, incoming: number) => {
      const world = await newWorld();
      const tag = randomUUID().slice(0, 8);
      const root = addCi(world, `root-${tag}`);
      await mapCi(world, root);
      for (let i = 0; i < outgoing; i++) { const to = addCi(world, `out-${i}-${tag}`); link(root, to); }
      for (let i = 0; i < incoming; i++) { const from = addCi(world, `in-${i}-${tag}`); link(from, root); }
      if (outgoing > 0) await receipt({ org: world.org, from: root, to: `out-0-${tag}`, cls: 'declared', ageDays: 1 });
      return { world, root, res: await getContext(world) };
    };

    it('issues exactly one receipts statement and one incarnation statement for 1 CI edge and for 40, both directions in one call', async () => {
      const small = await readWithEdges(1, 0);
      expect(small.res.status).toBe(200);
      expect([receiptStatements().length, incarnationReads.length]).toEqual([1, 1]);

      pgStatements = []; incarnationReads = [];
      const large = await readWithEdges(20, 20);
      expect(large.res.status).toBe(200);
      expect(large.res.body.data.edges.filter((e: EdgeBody) => e.currentness !== undefined)).toHaveLength(40);
      expect([receiptStatements().length, incarnationReads.length]).toEqual([1, 1]);
      const [read] = incarnationReads;
      expect(Object.keys(read!.params).sort()).toEqual(['ids', 'organizationId']);
      expect(read!.params['organizationId']).toBe(large.world.org);
      expect((read!.params['ids'] as string[]).length).toBe(41);
    });

    it('issues neither statement when the traversal has no CI edge', async () => {
      const none = await readWithEdges(0, 0);

      expect(none.res.status).toBe(200);
      expect(none.res.body.data.edges.filter((e: EdgeBody) => e.currentness !== undefined)).toHaveLength(0);
      expect([receiptStatements().length, incarnationReads.length]).toEqual([0, 0]);
    });
  });

  describe('an evidence failure fails the whole read, never a partial or optimistic body', () => {
    const stalledStatement = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const NO_MEMBERS = ['"edges"', '"nodes"', 'currentness', 'evidence', 'unsupported', 'coverage'];

    it('answers the fixed 504 when the receipts statement stalls past its statement_timeout, rolled back and released', async () => {
      const { world } = await fiveEdgeScenario();
      evidenceFailure = stalledStatement();

      const res = await getContext(world);

      expect([res.status, res.body]).toEqual([504, LIMIT_AND_TIMEOUT_BODY]);
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

      const res = await getContext(world);

      expect([res.status, res.body]).toEqual([504, LIMIT_AND_TIMEOUT_BODY]);
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

      const res = await getContext(world);

      expect([res.status, res.body]).toEqual([500, { success: false, error: 'Failed to get business service context' }]);
      for (const member of NO_MEMBERS) expect(res.text).not.toContain(member);
      expect(transactions.rolledBack).toBe(1);
      expect(connections.released).toBe(connections.acquired);
    });
  });

  describe('response hygiene', () => {
    it('keeps every pre-existing member, adds members only to CI edges and exposes no organization, incarnation, source or observer', async () => {
      const { world, ids } = await fiveEdgeScenario();

      const res = await getContext(world);

      expect(res.status).toBe(200);
      // The key sets of the body before HAP-2030: nothing removed or renamed.
      expect(Object.keys(res.body).sort()).toEqual(['basis', 'coverage', 'data', 'runtime_blast_radius', 'success']);
      expect(Object.keys(res.body.data).sort())
        .toEqual(['bounds', 'dependencies', 'edges', 'impact', 'nodes', 'service_id', 'tenant_id']);
      expect(Object.keys(res.body.coverage).sort())
        .toEqual(['ci_nodes_in_scope', 'note', 'runtime_observed_receipts_in_scope', 'unreported_ci_ids']);
      for (const node of res.body.data.nodes) {
        expect(Object.keys(node).sort()).toEqual(
          node.kind === 'ci' ? ['id', 'kind', 'name', 'status', 'type'] : ['criticality', 'id', 'kind', 'lifecycle', 'name']);
      }
      const mapped = res.body.data.edges.filter((e: EdgeBody) => e.type === 'MAPPED_CI');
      expect(mapped).toEqual([{ from: world.service, to: ids.root, type: 'MAPPED_CI', mapping_type: 'hosts' }]);
      const ciOnly = res.body.data.edges.filter((e: EdgeBody) => e.type !== 'MAPPED_CI');
      expect(ciOnly).toHaveLength(5);
      for (const edge of ciOnly) {
        expect(Object.keys(edge).sort()).toEqual(['currentness', 'evidence', 'from', 'to', 'type']);
        expect(Object.keys(edge.evidence).sort()).toEqual(
          ['classes', 'last_supported_at', 'receipt_count', 'receipts_href', 'receipts_truncated', 'support']);
        const text = JSON.stringify(edge);
        for (const banned of BANNED_IN_EDGES) expect(text).not.toContain(banned);
      }
      // Nothing from the receipts rows or the graph's incarnations leaks anywhere in the body.
      expect(res.text).not.toContain('organization_id');
      expect(res.text).not.toContain(SECRET_SOURCE);
      expect(res.text).not.toContain(SECRET_OBSERVER);
      for (const node of graph.nodes.values()) {
        if (node['incarnation_id']) expect(res.text).not.toContain(node['incarnation_id'] as string);
      }
      // The organization appears only as the documented tenant_id of the body.
      expect(res.text.replace(`"tenant_id":"${world.org}"`, '')).not.toContain(world.org);
    });

    it('refuses an unauthenticated read with 401 before any statement, and serves a viewer', async () => {
      const { world } = await fiveEdgeScenario();

      const anonymous = await request(app).get(`/api/v1/business-services/${world.service}/context`);

      expect(anonymous.status).toBe(401);
      expect([pgStatements.length, incarnationReads.length]).toEqual([0, 0]);
      expect(USERS[`user-${world.org}`]!._role).toBe('viewer');
      expect((await getContext(world)).status).toBe(200);
    });

    it('derives currentness on every read and writes nothing: SELECT-only statements, receipts and graph unchanged', async () => {
      const { world, ids } = await fiveEdgeScenario();
      const count = async () => (await owner(
        `SELECT count(*)::int AS n FROM relationship_evidence_receipts WHERE organization_id = $1`, [world.org]) as Array<{ n: number }>)[0]!.n;
      const nodesBefore = JSON.stringify([...graph.nodes]);
      const before = await count();

      const first = await getContext(world);
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
      const second = await getContext(world);

      expect(ciEdge(first.body, ids.root, ids.declaredFresh).currentness).toBe('current');
      expect(ciEdge(second.body, ids.root, ids.declaredFresh).currentness).toBe('stale');
      for (const sql of [...firstStatements, ...pgStatements]) expect(sql).toMatch(/^\s*(SELECT|WITH)\b/i);
      expect(await count()).toBe(before);
      expect(JSON.stringify([...graph.nodes])).toBe(nodesBefore);
    });
  });
});
