// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2030: GET /cis/:id/dependencies and GET /cis/:id/impact qualify every edge they followed with evidence and a
 * DERIVED currentness (current, stale, contradicted, unsupported) read from the append-only receipts of HAP-2029.
 *
 * Real ciRoutes and relationshipRoutes behind the real JWT middleware, the production journal, Neo4jClient (its real
 * traversal, incarnation and write Cypher), PostgresClient.transaction and edge-evidence module, on PGlite. Every statement a
 * route sends runs as the app login `cmdb_user` (a NOSUPERUSER role that owns nothing, with 054's SELECT, INSERT grant on the
 * receipts); fixtures run as the NOSUPERUSER table owner. Neo4j is an in-memory node and edge map behind a fake driver that
 * evaluates each statement the way Neo4j would, honouring the `organization_id = $organizationId` predicates that the
 * statement text actually contains.
 *
 * Receipts are planted by the owner with explicit observed_at offsets; nothing is ever TRUNCATEd, every organization id is
 * random per run, and the one removal (the negative control) disables the append-only trigger as the owner.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const A = randomUUID();
const B = randomUUID();
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
type SqlResult = { rows: Record<string, any>[]; rowCount: number };
const pending = new Map<number, PromiseWithResolvers<SqlResult>>();
host.on('message', ({ id, rows, rowCount, error, code }: { id: number; rows: Record<string, any>[]; rowCount?: number;
  error?: string; code?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(Object.assign(new Error(error), { code }));
  else call.resolve({ rows, rowCount: rowCount || rows.length });
});
function mockSql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<SqlResult>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}

/** What reached PostgreSQL through the application's pool (the app login), and the knobs that make it slow or fail. */
interface Checkout { statements: string[]; timeouts: number[]; releases: number }
const mockPg = {
  statements: [] as string[], checkouts: [] as Checkout[], statementTimeoutMs: 0,
  /** PGlite does not enforce statement_timeout: a receipts read that outlasts the transaction's timeout fails 57014 after it. */
  stallMs: 0,
  /** Injected failure of the receipts read (a connection error, say). */
  failReceiptsRead: undefined as Error | undefined,
};
const mockIsReceiptsRead = (text: string) => text.includes('relationship_evidence_receipts') && /^\s*(WITH|SELECT)\b/i.test(text);
const mockSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function mockAppSql(text: string, params: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./fixtures/app-login').assertAppStatement(text);
  mockPg.statements.push(text);
  if (text.startsWith(`SELECT set_config('statement_timeout'`)) mockPg.statementTimeoutMs = Number(params[0]);
  if (mockIsReceiptsRead(text)) {
    if (mockPg.failReceiptsRead) throw mockPg.failReceiptsRead;
    if (mockPg.stallMs > 0) {
      if (mockPg.statementTimeoutMs > 0 && mockPg.statementTimeoutMs < mockPg.stallMs) {
        await mockSleep(mockPg.statementTimeoutMs);
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      }
      await mockSleep(mockPg.stallMs);
    }
  }
  return mockSql(text, params);
}
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { return mockAppSql(text, params); }
    async connect() {
      const checkout: Checkout = { statements: [], timeouts: [], releases: 0 };
      mockPg.checkouts.push(checkout);
      return {
        query: (text: string, params?: unknown[]) => {
          checkout.statements.push(text);
          if (text.startsWith(`SELECT set_config('statement_timeout'`)) checkout.timeouts.push(Number((params ?? [])[0]));
          return mockAppSql(text, params);
        },
        release: () => { checkout.releases++; mockPg.statementTimeoutMs = 0; }, // SET LOCAL ends with the transaction
      };
    }
    async end() { return undefined; }
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});

const mockGraph = { nodes: new Map<string, Record<string, unknown>>(), fences: new Map<string, Record<string, unknown>>(),
  writes: [] as string[], edges: new Map<string, Record<string, unknown>>() };
const mockNeo = {
  statements: [] as string[], incarnationTimeouts: [] as unknown[],
  /** Runs inside the batched incarnation read, before it is evaluated: a race, a timeout or a failure. */
  onIncarnationRead: undefined as undefined | (() => void | Promise<void>),
};
jest.mock('neo4j-driver', () => {
  const actual = jest.requireActual('neo4j-driver');
  const { randomUUID: uuid } = jest.requireActual('crypto');
  const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], toObject: () => values });
  const owner = (id: unknown) => mockGraph.nodes.get(id as string)?.['organization_id'];
  const edgeKey = (query: string, params: Record<string, any>) => `${params['from']}|${/\[r:(\w+)\]/.exec(query)![1]}|${params['to']}`;
  const node = (props: Record<string, unknown>) => ({ labels: ['CI'], properties: props });
  const run = async (rawQuery: string, params: Record<string, any> = {}, config?: { timeout?: number }) => {
    const query = rawQuery.replace(/\s+/g, ' ').trim();
    mockNeo.statements.push(query);
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
    if (query.startsWith('UNWIND $frontier AS sourceId')) { // the bounded traversal hop, evaluated over the edge map
      const sourceScoped = query.includes('source.organization_id = $organizationId');
      const targetScoped = query.includes('target.organization_id = $organizationId');
      const outgoing = query.includes('(source)-[relationship');
      const dependencyOnly = query.includes('relationship:DEPENDS_ON');
      const rows: ReturnType<typeof record>[] = [];
      for (const sourceId of params['frontier'] as string[]) {
        const source = mockGraph.nodes.get(sourceId);
        if (!source || (sourceScoped && source['organization_id'] !== params['organizationId'])) continue;
        for (const [key, properties] of mockGraph.edges) {
          const [from, type, to] = key.split('|') as [string, string, string];
          if (dependencyOnly && type !== 'DEPENDS_ON') continue;
          const targetId = outgoing ? from === sourceId && to : to === sourceId && from;
          if (!targetId) continue;
          const target = mockGraph.nodes.get(targetId);
          if (!target || (targetScoped && target['organization_id'] !== params['organizationId'])) continue;
          rows.push(record({ source: node(source), target: node(target), relationship: { type, properties },
            startNodeId: from, endNodeId: to }));
        }
      }
      return { records: rows.slice(0, Number(params['rowLimit']?.toNumber?.() ?? params['rowLimit'])) };
    }
    if (query.includes('AS incarnationId') && query.includes('ci.id IN $ids')) { // getCIIncarnations
      mockNeo.incarnationTimeouts.push(config?.timeout);
      await mockNeo.onIncarnationRead?.();
      const scoped = query.includes('ci.organization_id = $organizationId');
      return { records: (params['ids'] as string[]).flatMap(id => {
        const props = mockGraph.nodes.get(id);
        if (!props || (scoped && props['organization_id'] !== params['organizationId'])) return [];
        return [record({ ciId: id, incarnationId: props['incarnation_id'] ?? null })];
      }) };
    }
    const found = owner(params['id']) === params['organizationId'] ? mockGraph.nodes.get(params['id']) : undefined;
    if (query.includes('SET ci.incarnation_id = coalesce')) { // ensureCIIncarnation
      if (found) found['incarnation_id'] ??= uuid();
      return { records: found ? [record({ incarnationId: found['incarnation_id'] })] : [] };
    }
    if (query.includes('properties(ci) AS props')) return { records: found ? [record({ props: { ...found } })] : [] };
    if (query.endsWith('RETURN ci')) return { records: found ? [record({ ci: node(found) })] : [] };
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
import { CITraversalLimitError, CI_TRAVERSAL_QUERY_TIMEOUT_MS } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';
import { relationshipRoutes } from '../relationship.routes';
import {
  EDGE_EVIDENCE_SCAN_CAP, IMPACT_EVIDENCE_TIMEOUT_MS, MAX_EDGE_EVIDENCE_EDGES, impactEvidenceTimeoutMs, loadEdgeEvidence,
} from '../../edge-evidence';
import { MAX_IMPACT_LINEAGE_TIMEOUT_MS } from '../../impact-envelope';
import {
  APP_GRANTS_SQL, assertAppLogin, asTableOwner, createLoginRolesSql, journalReadAclSql, lineageReadAclSql,
  migrationSql, receiptTableSql,
} from './fixtures/app-login';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const headers = (user: string) => ({ authorization: `Bearer ${jwt.generateAccessToken(
  users[user]!._id, users[user]!._username, users[user]!._role, users[user]!._organizationId, 0, Math.floor(Date.now() / 1000))}` });
const get = (user: string, path: string) => request(app).get(path).set(headers(user));
const create = (user: string, from: string, to: string) =>
  request(app).post('/api/v1/relationships').set(headers(user)).send({ from_id: from, to_id: to, type: 'DEPENDS_ON' });

// Fixture SQL runs as the table owner, then the session returns to the app login for the routes.
const owner = <T>(work: () => Promise<T>) => asTableOwner(text => mockSql(text, [], 'exec'), work);
const ownerRows = (text: string, params: unknown[] = []) => owner(async () => (await mockSql(text, params)).rows);
const ownerExec = (text: string) => owner(() => mockSql(text, [], 'exec'));

const NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };
const TIMED_OUT = { success: false, error: 'CI traversal timed out' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TABLE_AWAY = 'ALTER TABLE relationship_evidence_receipts RENAME TO relationship_evidence_receipts_away';
const TABLE_BACK = 'ALTER TABLE relationship_evidence_receipts_away RENAME TO relationship_evidence_receipts';

beforeAll(async () => {
  const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  const tables = ['audit_log', 'cmdb.dim_ci', 'ci_source_lineage', 'ci_field_sources', 'reconciliation_conflicts',
    'reconciliation_rules', 'source_authority', 'ci_change_history', 'dim_business_services'];
  const [{ db: database }] = (await mockSql('SELECT current_database() AS db')).rows as Array<{ db: string }>;
  await mockSql(createLoginRolesSql(database), [], 'exec'); // from here the session is the NOSUPERUSER table owner
  await mockSql(['CREATE SCHEMA cmdb;', ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ...tables.map(table =>
    schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`))![0]),
  ...['drift_detection_results (ci_id', 'baseline_snapshots (ci_id', 'impact_analyses (source_ci_id', 'ci_criticality_scores (ci_id']
    .map(table => `CREATE TABLE ${table} text, organization_id uuid, ci_incarnation_id uuid);`)].join('\n'), [], 'exec');
  for (const file of ['003_audit_hash_chain.sql', '011_ci_organization_scope.sql', '028_change_history_reconciliation_org_provenance.sql',
    '029_reconciliation_conflict_identity_rules.sql', '037_reconciliation_org_contract.sql']) {
    await mockSql(migrationSql(file), [], 'exec');
  }
  await mockSql(`ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID;
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
    CHECK (organization_id IS NOT NULL) NOT VALID`, [], 'exec'); // 025, 036 (S4a)
  // The app login's table grants on everything the journal and the audit chain touch, then 044, 053 and 054 verbatim. 054
  // runs last: its own grant (SELECT, INSERT, no UPDATE or DELETE) is the privilege set the receipts have in a deployment.
  await mockSql(`GRANT USAGE ON SCHEMA public, cmdb TO cmdb_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cmdb_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cmdb TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public, cmdb TO cmdb_user;`, [], 'exec');
  await mockSql(`${APP_GRANTS_SQL}\n${journalReadAclSql()}\n${lineageReadAclSql()}`, [], 'exec');
  await mockSql(receiptTableSql(), [], 'exec');
  await mockSql('RESET ROLE; SET SESSION AUTHORIZATION cmdb_user;', [], 'exec');
});
afterAll(() => { host.kill(); });
beforeEach(async () => {
  await assertAppLogin(async text => (await mockSql(text)).rows);
  mockPg.statements.length = 0;
  mockPg.checkouts.length = 0;
  mockPg.stallMs = 0;
  mockPg.failReceiptsRead = undefined;
  mockNeo.statements.length = 0;
  mockNeo.incarnationTimeouts.length = 0;
  mockNeo.onIncarnationRead = undefined;
});
const TIMEOUT_ENV = 'IMPACT_EVIDENCE_TIMEOUT_MS';
const priorTimeout = process.env[TIMEOUT_ENV];
afterEach(() => {
  if (priorTimeout === undefined) delete process.env[TIMEOUT_ENV];
  else process.env[TIMEOUT_ENV] = priorTimeout;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An owned CI already in the graph; `incarnation: false` is a legacy CI that predates incarnation ids. */
function seed(org: string, incarnation = true): string {
  const id = randomUUID();
  mockGraph.nodes.set(id, { id, organization_id: org, name: `ci-${id.slice(0, 8)}`, type: 'server', status: 'active',
    environment: 'production', ...(incarnation ? { incarnation_id: randomUUID() } : {}) });
  return id;
}
const incarnation = (id: string) => mockGraph.nodes.get(id)?.['incarnation_id'] as string | undefined;
const edgeKey = (from: string, to: string, type = 'DEPENDS_ON') => `${from}|${type}|${to}`;
const dependsOn = (from: string, to: string, type = 'DEPENDS_ON') => { mockGraph.edges.set(edgeKey(from, to, type), {}); };
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Planted { cls?: string; polarity?: 'supports' | 'contradicts'; ageMs: number }
interface PlantedOptions { org?: string; type?: string; fromInc?: string; toInc?: string }
const at = (ageMs: number) => new Date(Date.now() - ageMs);
/** Receipts inserted as the table owner with explicit observed_at offsets, newest-first order irrelevant. */
async function plant(from: string, to: string, planted: Planted[], options: PlantedOptions = {}): Promise<void> {
  await ownerRows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id,
      to_incarnation_id, relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type,
      correlation_id)
    SELECT $1, $2, $3, $4, $5, $6, s.cls, s.pol, 'planted', 'api', s.at, 'planted-observer', 'user', gen_random_uuid()
    FROM unnest($7::text[], $8::text[], $9::timestamptz[]) AS s(cls, pol, at)`,
  [options.org ?? mockGraph.nodes.get(from)?.['organization_id'] ?? A, from, to, options.fromInc ?? incarnation(from) ?? randomUUID(),
    options.toInc ?? incarnation(to) ?? randomUUID(), options.type ?? 'DEPENDS_ON', planted.map(p => p.cls ?? 'declared'),
    planted.map(p => p.polarity ?? 'supports'), planted.map(p => at(p.ageMs).toISOString())]);
}
const countReceipts = async () => Number((await ownerRows('SELECT count(*) AS n FROM relationship_evidence_receipts'))[0]!['n']);

const href = (from: string, to: string) => `/api/v1/relationships/evidence?from_id=${from}&to_id=${to}&type=DEPENDS_ON`;
const expected = (from: string, to: string, currentness: string, evidence: object) => ({ from, to, type: 'DEPENDS_ON', currentness,
  evidence: { receipts_href: href(from, to), ...evidence } });

const ENDPOINTS: Array<[string, (id: string) => string]> = [
  ['dependencies', id => `/api/v1/cis/${id}/dependencies`],
  ['impact', id => `/api/v1/cis/${id}/impact`],
];
const EDGE_WORDS = /"(?:edges|currentness|evidence)"/;
const FAILURES: Record<string, object> = {
  dependencies: { success: false, error: 'Failed to retrieve dependencies', message: 'Internal error' },
  impact: { success: false, error: 'Failed to perform impact analysis', message: 'Internal error' },
};

/**
 * The design's acceptance case: one root, five DEPENDS_ON edges, one per kind of state, plus a CI the graph has no edge to.
 * Times are explicit offsets from now; the read's `now()` is the database clock, so the 7-day window is never near a boundary.
 */
async function scenario() {
  const root = seed(A);
  const [declared, reobserved, aged, contradicted, none, absent] = [seed(A), seed(A), seed(A), seed(A), seed(A), seed(A)];
  for (const to of [declared, reobserved, aged, contradicted, none]) dependsOn(root, to);
  const t = { declared: 2 * HOUR, reobservedFirst: 40 * DAY, reobserved: 2 * DAY, aged: 30 * DAY, supported: 10 * DAY, contradicts: DAY };
  await plant(root, declared, [{ ageMs: t.declared }]);
  await plant(root, reobserved, [{ cls: 'static_observed', ageMs: t.reobservedFirst }, { cls: 'static_observed', ageMs: t.reobserved }]);
  await plant(root, aged, [{ cls: 'static_observed', ageMs: t.aged }]);
  await plant(root, contradicted, [{ ageMs: t.supported }, { polarity: 'contradicts', ageMs: t.contradicts }]);
  return { root, declared, reobserved, aged, contradicted, none, absent, t };
}

describe.each(ENDPOINTS)('GET /cis/:id/%s', (name, path) => {
  describe('the acceptance scenario', () => {
    it('qualifies each recorded edge: declared fresh current, re-observed static current, aged static stale, contradicted, no receipt unsupported', async () => {
      const s = await scenario();
      const res = await get('a', path(s.root));
      expect(res.status).toBe(200);
      const near = (value: string | null, ageMs: number) => expect(Math.abs(Date.parse(value!) - at(ageMs).getTime())).toBeLessThan(60_000);
      const byTo = new Map<string, any>(res.body.edges.map((edge: { to: string }) => [edge.to, edge]));
      expect(byTo.size).toBe(5);
      expect(byTo.has(s.absent)).toBe(false); // a dependency the graph does not record is never invented

      const row = (to: string, currentness: string) => {
        const edge = byTo.get(to)!;
        expect([edge.from, edge.to, edge.type, edge.currentness]).toEqual([s.root, to, 'DEPENDS_ON', currentness]);
        expect(edge.evidence.receipts_href).toBe(href(s.root, to));
        expect(edge.evidence.receipts_truncated).toBe(false);
        return edge.evidence;
      };
      let evidence = row(s.declared, 'current');
      expect(evidence).toMatchObject({ classes: ['declared'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 });
      near(evidence.last_supported_at, s.t.declared);
      evidence = row(s.reobserved, 'current');
      expect(evidence).toMatchObject({ classes: ['static_observed'], support: { supports: 2, contradicts: 0 }, receipt_count: 2 });
      near(evidence.last_supported_at, s.t.reobserved); // the newest of the two supports, not the first observation
      evidence = row(s.aged, 'stale');
      expect(evidence).toMatchObject({ classes: ['static_observed'], support: { supports: 1, contradicts: 0 }, receipt_count: 1 });
      near(evidence.last_supported_at, s.t.aged);
      evidence = row(s.contradicted, 'contradicted');
      expect(evidence).toMatchObject({ classes: ['declared'], support: { supports: 1, contradicts: 1 }, receipt_count: 2 });
      near(evidence.last_supported_at, s.t.supported); // the contradiction is not a support
      evidence = row(s.none, 'unsupported');
      expect(evidence).toEqual({ classes: [], support: { supports: 0, contradicts: 0 }, receipt_count: 0, receipts_truncated: false,
        last_supported_at: null, receipts_href: href(s.root, s.none) });

      // The unchanged envelope: reachability only, runtime blast radius not established, no runtime receipts in scope.
      expect(res.body).toMatchObject({ basis: 'declared_graph_reachability', runtime_blast_radius: 'not_established',
        coverage: { runtime_observed_receipts_in_scope: false } });
      expect(res.body.coverage.note).toMatch(/missing edge is not evidence of no dependency/i);
      expect(JSON.stringify(res.body)).not.toContain(s.absent);
    });

    it('lists the followed edges only, sorted by (from, to, type) and deduplicated; the pre-change members and keys are unchanged', async () => {
      const s = await scenario();
      const res = await get('a', path(s.root));
      const tos = [s.declared, s.reobserved, s.aged, s.contradicted, s.none].sort(order);
      expect(res.body.edges.map((edge: { from: string; to: string; type: string }) => [edge.from, edge.to, edge.type]))
        .toEqual(tos.map(to => [s.root, to, 'DEPENDS_ON']));
      for (const edge of res.body.edges) expect(Object.keys(edge).sort()).toEqual(['currentness', 'evidence', 'from', 'to', 'type']);
      for (const edge of res.body.edges) {
        expect(Object.keys(edge.evidence).sort()).toEqual(
          ['classes', 'last_supported_at', 'receipt_count', 'receipts_href', 'receipts_truncated', 'support']);
      }
      if (name === 'dependencies') {
        // Pre-change: success, data (Path[]), count, depth and the HAP-2028 envelope; `edges` is the only addition.
        expect(Object.keys(res.body).sort()).toEqual(['basis', 'count', 'coverage', 'data', 'depth', 'edges', 'runtime_blast_radius', 'success']);
        expect(res.body.data).toHaveLength(5);
        expect(res.body.count).toBe(5);
        for (const member of res.body.data) expect(Object.keys(member).sort()).toEqual(['end', 'length', 'segments', 'start']);
      } else {
        expect(Object.keys(res.body).sort()).toEqual(['basis', 'coverage', 'data', 'depth', 'edges', 'runtime_blast_radius', 'success', 'totalImpacted']);
        expect(Object.keys(res.body.data).sort()).toEqual(['affected_environments', 'ci', 'downstream', 'impact_score', 'upstream']);
        expect([res.body.data.upstream.length, res.body.data.downstream.length, res.body.totalImpacted]).toEqual([5, 0, 5]);
      }
    });

    it('NEGATIVE CONTROL: removing the current edge\'s receipt as the table owner makes that edge unsupported with no receipts', async () => {
      const s = await scenario();
      const before = await get('a', path(s.root));
      expect(before.body.edges.find((edge: { to: string }) => edge.to === s.declared)).toMatchObject({ currentness: 'current',
        evidence: { receipt_count: 1 } });
      // Append-only for every role: the app login cannot do this; only the owner, with the trigger disabled, in this disposable database.
      await expect(owner(() => mockSql(`DELETE FROM relationship_evidence_receipts WHERE from_ci_id = '${s.root}'`, [], 'exec')))
        .rejects.toMatchObject({ code: '55000' });
      await ownerExec(`ALTER TABLE relationship_evidence_receipts DISABLE TRIGGER USER;
        DELETE FROM relationship_evidence_receipts WHERE from_ci_id = '${s.root}' AND to_ci_id = '${s.declared}';
        ALTER TABLE relationship_evidence_receipts ENABLE TRIGGER USER;`);
      const after = await get('a', path(s.root));
      expect(after.body.edges.find((edge: { to: string }) => edge.to === s.declared)).toMatchObject({ currentness: 'unsupported',
        evidence: { classes: [], receipt_count: 0, support: { supports: 0, contradicts: 0 }, last_supported_at: null } });
      expect(after.body.edges.find((edge: { to: string }) => edge.to === s.reobserved)).toMatchObject({ currentness: 'current' });
    });

    it('currentness is derived at read time: a newer supporting receipt turns a stale edge current with no write to the edge', async () => {
      const s = await scenario();
      const stateOf = async () => (await get('a', path(s.root))).body.edges.find((edge: { to: string }) => edge.to === s.aged).currentness;
      expect(await stateOf()).toBe('stale');
      await plant(s.root, s.aged, [{ cls: 'static_observed', ageMs: HOUR }]);
      expect(await stateOf()).toBe('current');
      expect(mockGraph.edges.get(edgeKey(s.root, s.aged))).toEqual({});
    });
  });

  describe('rules of the derivation', () => {
    const only = async (planted: Planted[], options: PlantedOptions = {}) => {
      const [from, to] = [seed(A), seed(A)];
      dependsOn(from, to);
      await plant(from, to, planted, options);
      const res = await get('a', path(from));
      expect(res.status).toBe(200);
      return res.body.edges[0] as { currentness: string; evidence: Record<string, any> };
    };

    it('a contradiction and a support with the same observed_at is contradicted (a tie never reads current)', async () => {
      const tie = at(HOUR).toISOString();
      const [from, to] = [seed(A), seed(A)];
      dependsOn(from, to);
      await ownerRows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id,
          to_incarnation_id, relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type, correlation_id)
        SELECT $1, $2, $3, $4, $5, 'DEPENDS_ON', 'declared', p, 'planted', 'api', $6::timestamptz, 'planted', 'user', gen_random_uuid()
        FROM unnest(ARRAY['supports', 'contradicts']) AS p`, [A, from, to, incarnation(from), incarnation(to), tie]);
      expect((await get('a', path(from))).body.edges[0]).toMatchObject({ currentness: 'contradicted', evidence: { receipt_count: 2 } });
    });

    it('a support strictly newer than the contradiction supersedes it; a contradiction newer than a support wins', async () => {
      expect((await only([{ polarity: 'contradicts', ageMs: 3 * DAY }, { ageMs: DAY }])).currentness).toBe('current');
      expect((await only([{ ageMs: 3 * DAY }, { polarity: 'contradicts', ageMs: DAY }])).currentness).toBe('contradicted');
    });

    it('only inferred supports never makes an edge current or supersedes a contradiction; a contradiction alone is contradicted', async () => {
      expect((await only([{ cls: 'inferred', ageMs: HOUR }])).currentness).toBe('stale');
      expect((await only([{ polarity: 'contradicts', ageMs: 5 * DAY }, { cls: 'inferred', ageMs: HOUR }])).currentness).toBe('contradicted');
      expect((await only([{ polarity: 'contradicts', ageMs: DAY }])).currentness).toBe('contradicted');
    });

    it('each class has its own window: declared 180 days, static_observed 7 days, runtime_observed 1 day; a fresh class keeps the edge current', async () => {
      expect((await only([{ ageMs: 170 * DAY }])).currentness).toBe('current');
      expect((await only([{ ageMs: 190 * DAY }])).currentness).toBe('stale');
      expect((await only([{ cls: 'static_observed', ageMs: 6 * DAY }])).currentness).toBe('current');
      expect((await only([{ cls: 'static_observed', ageMs: 8 * DAY }])).currentness).toBe('stale');
      expect((await only([{ cls: 'runtime_observed', ageMs: 20 * HOUR }])).currentness).toBe('current');
      expect((await only([{ cls: 'runtime_observed', ageMs: 26 * HOUR }])).currentness).toBe('stale');
      expect((await only([{ cls: 'static_observed', ageMs: 30 * DAY }, { ageMs: 100 * DAY }])).currentness).toBe('current');
      const mixed = await only([{ cls: 'inferred', ageMs: HOUR }, { cls: 'static_observed', ageMs: 2 * DAY }, { ageMs: 3 * DAY }]);
      expect(mixed.evidence['classes']).toEqual(['declared', 'static_observed', 'inferred']); // fixed order, supporting classes
    });
  });

  describe('organization isolation', () => {
    it('another organization\'s receipt that carries this edge\'s ids AND incarnations never counts: A stays current', async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, [{ ageMs: 2 * DAY }]);
      const before = (await get('a', path(x))).body.edges[0];
      expect(before).toMatchObject({ currentness: 'current', evidence: { receipt_count: 1, support: { supports: 1, contradicts: 0 } } });
      await plant(x, y, [{ polarity: 'contradicts', ageMs: HOUR }, { polarity: 'contradicts', cls: 'runtime_observed', ageMs: 10 * 60_000 }], { org: B });
      const after = (await get('a', path(x))).body.edges[0];
      expect(after).toEqual(before);
    });

    it('reverse: org B\'s own edge with no receipts stays unsupported though org A planted supports that carry B\'s ids and incarnations', async () => {
      const [x, y] = [seed(B), seed(B)];
      dependsOn(x, y);
      await plant(x, y, [{ ageMs: HOUR }, { cls: 'static_observed', ageMs: HOUR }], { org: A });
      const res = await get('b', path(x));
      expect(res.status).toBe(200);
      expect(res.body.edges).toEqual([expected(x, y, 'unsupported', { classes: [], support: { supports: 0, contradicts: 0 },
        receipt_count: 0, receipts_truncated: false, last_supported_at: null })]);
    });

    it('a CI of another organization is the same 404 as a missing CI and nothing is read from receipts', async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, [{ ageMs: HOUR }]);
      mockPg.statements.length = 0;
      const foreign = await get('b', path(x));
      const missing = await get('b', path(randomUUID()));
      expect([foreign.status, foreign.body, missing.status, missing.body]).toEqual([404, NOT_FOUND, 404, NOT_FOUND]);
      expect(mockPg.statements.filter(text => text.includes('relationship_evidence_receipts'))).toEqual([]);
    });
  });

  describe('incarnation fence', () => {
    it.each(['to', 'from'] as const)('a receipt of the old incarnation of the %s endpoint is not counted after the CI is re-created under the same id', async end => {
      const [x, y] = [seed(A), seed(A)];
      expect((await create('a', x, y)).status).toBe(201); // the real write path: a genuine receipt
      const read = async () => (await get('a', path(x))).body.edges[0];
      expect(await read()).toMatchObject({ from: x, to: y, currentness: 'current', evidence: { receipt_count: 1, classes: ['declared'] } });

      const recreated = end === 'to' ? y : x;
      const oldIncarnation = incarnation(recreated);
      mockGraph.nodes.set(recreated, { ...mockGraph.nodes.get(recreated)!, incarnation_id: randomUUID() }); // deleted and created again
      expect(incarnation(recreated)).not.toBe(oldIncarnation);
      mockGraph.edges.set(edgeKey(x, y), {}); // the edge is re-seeded WITHOUT a relationship write: no new receipt exists
      expect(await read()).toMatchObject({ currentness: 'unsupported',
        evidence: { classes: [], receipt_count: 0, support: { supports: 0, contradicts: 0 }, last_supported_at: null } });
      expect(await countReceipts()).toBeGreaterThanOrEqual(1); // the old receipt is still there, simply not this edge's

      // A new relationship write after the re-creation reads current from the NEW receipt only.
      mockGraph.edges.delete(edgeKey(x, y));
      expect((await create('a', x, y)).status).toBe(201);
      expect(await read()).toMatchObject({ currentness: 'current', evidence: { receipt_count: 1, support: { supports: 1, contradicts: 0 } } });
    });

    it.each(['to', 'from'] as const)('a legacy %s endpoint with no incarnation_id reads unsupported, and the read assigns it none', async end => {
      const [x, y] = [seed(A, end !== 'from'), seed(A, end !== 'to')];
      dependsOn(x, y);
      // Receipts exist, bound to some incarnation of that endpoint; the legacy CI has no incarnation, so none can match.
      await plant(x, y, [{ ageMs: HOUR }], end === 'from' ? { fromInc: randomUUID() } : { toInc: randomUUID() });
      const legacy = end === 'from' ? x : y;
      const snapshot = JSON.stringify(mockGraph.nodes.get(legacy));
      const res = await get('a', path(x));
      expect(res.status).toBe(200);
      expect(res.body.edges[0]).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0, classes: [] } });
      expect(mockGraph.nodes.get(legacy)).not.toHaveProperty('incarnation_id');
      expect(JSON.stringify(mockGraph.nodes.get(legacy))).toBe(snapshot);
      expect(mockNeo.statements.filter(text => text.includes('SET ci.incarnation_id'))).toEqual([]);
      expect(mockPg.statements.filter(text => text.includes('relationship_evidence_receipts'))).toEqual([]); // never reached PostgreSQL
    });

    it.each(['reassigned to another organization', 'deleted'])('an endpoint that is %s between the traversal and the incarnation read reads unsupported', async change => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, [{ ageMs: HOUR }]);
      expect((await get('a', path(x))).body.edges[0].currentness).toBe('current');
      mockNeo.onIncarnationRead = () => {
        if (change === 'deleted') mockGraph.nodes.delete(y);
        else mockGraph.nodes.set(y, { ...mockGraph.nodes.get(y)!, organization_id: B }); // incarnation id unchanged
      };
      const res = await get('a', path(x));
      expect(res.status).toBe(200);
      expect(res.body.edges[0]).toMatchObject({ from: x, to: y, currentness: 'unsupported', evidence: { receipt_count: 0, classes: [] } });
    });
  });

  describe('direction and type', () => {
    it('a receipt for B->A or for another relationship type never qualifies A->B', async () => {
      const [a, b] = [seed(A), seed(A)];
      dependsOn(a, b);
      await plant(b, a, [{ ageMs: HOUR }, { cls: 'static_observed', ageMs: HOUR }]); // the reverse direction
      await plant(a, b, [{ ageMs: HOUR }, { polarity: 'contradicts', ageMs: 10 * 60_000 }], { type: 'CONNECTS_TO' }); // another type
      expect((await get('a', path(a))).body.edges).toEqual([expected(a, b, 'unsupported', { classes: [], support: { supports: 0, contradicts: 0 },
        receipt_count: 0, receipts_truncated: false, last_supported_at: null })]);
      await plant(a, b, [{ ageMs: HOUR }]); // the genuine receipt: alone it counts, the decoys still do not
      expect((await get('a', path(a))).body.edges[0]).toMatchObject({ currentness: 'current',
        evidence: { receipt_count: 1, support: { supports: 1, contradicts: 0 }, classes: ['declared'] } });
    });

    it('both directions of a cycle are listed as stored; only the one with a receipt is current (no from/to normalisation)', async () => {
      const [a, b] = [seed(A), seed(A)];
      dependsOn(a, b);
      dependsOn(b, a);
      await plant(a, b, [{ ageMs: HOUR }]);
      const res = await get('a', path(a));
      expect(res.body.edges.map((edge: { from: string; to: string; currentness: string }) => [edge.from, edge.to, edge.currentness]))
        .toEqual([[a, b, 'current'], [b, a, 'unsupported']].sort((x, y) => order(x[0]!, y[0]!)));
      expect(res.body.edges).toHaveLength(2); // the same edge reached by both traversals is listed once
    });

    it('edges are oriented as stored for both a downstream (in) and an upstream (out) traversal', async () => {
      const [dependent, root, dependency] = [seed(A), seed(A), seed(A)];
      dependsOn(dependent, root);
      dependsOn(root, dependency);
      await plant(dependent, root, [{ ageMs: HOUR }]);
      await plant(root, dependency, [{ polarity: 'contradicts', ageMs: HOUR }]);
      const res = await get('a', path(root));
      const states = res.body.edges.map((edge: { from: string; to: string; currentness: string }) => [edge.from, edge.to, edge.currentness]);
      if (name === 'impact') {
        expect(states).toEqual([[dependent, root, 'current'], [root, dependency, 'contradicted']].sort((x, y) => order(x[0]!, y[0]!)));
      } else {
        expect(states).toEqual([[root, dependency, 'contradicted']]); // an upstream-only read follows outgoing edges
      }
    });
  });

  describe('cost bound', () => {
    const receiptReads = () => mockPg.statements.filter(text => text.includes('relationship_evidence_receipts'));
    const incarnationReads = () => mockNeo.statements.filter(text => text.includes('AS incarnationId'));

    it.each([1, 40])('%i edge(s): exactly one statement against the receipts table and one Neo4j incarnation read, never one per edge', async count => {
      const root = seed(A);
      for (let i = 0; i < count; i++) {
        const to = seed(A);
        dependsOn(root, to);
        await plant(root, to, [{ ageMs: HOUR }]);
      }
      mockPg.statements.length = 0;
      mockNeo.statements.length = 0;
      mockNeo.incarnationTimeouts.length = 0;
      const res = await get('a', path(root));
      expect(res.status).toBe(200);
      expect(res.body.edges).toHaveLength(count);
      expect(res.body.edges.every((edge: { currentness: string }) => edge.currentness === 'current')).toBe(true);
      expect(receiptReads()).toHaveLength(1);
      expect(incarnationReads()).toHaveLength(1);
      expect(mockNeo.incarnationTimeouts).toEqual([CI_TRAVERSAL_QUERY_TIMEOUT_MS]);
    });

    it('0 edges: no receipts statement and no incarnation read at all', async () => {
      const root = seed(A);
      const res = await get('a', path(root));
      expect(res.status).toBe(200);
      expect(res.body.edges).toEqual([]);
      expect([receiptReads(), incarnationReads()]).toEqual([[], []]);
    });

    it('edges whose endpoints have no incarnation never reach PostgreSQL', async () => {
      const [x, y] = [seed(A, false), seed(A, false)];
      dependsOn(x, y);
      expect((await get('a', path(x))).body.edges[0].currentness).toBe('unsupported');
      expect([receiptReads(), incarnationReads().length]).toEqual([[], 1]);
    });
  });

  describe('failure behaviour (fails closed, never an optimistic body)', () => {
    const receiptCheckouts = () => mockPg.checkouts.filter(({ statements }) => statements.some(text => text.includes('relationship_evidence_receipts')));
    const settled = ({ statements, releases }: Checkout) => ({
      statements: statements.map(text => (text.startsWith('SELECT set_config') ? 'set_config' : text.includes('relationship_evidence_receipts') ? 'receipts' : text)),
      releases,
    });
    const withEdge = async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, [{ ageMs: HOUR }]);
      return x;
    };

    it('a receipts read that outlasts its statement_timeout is the fixed 504 with no edges, rolled back, connection released once', async () => {
      const x = await withEdge();
      process.env[TIMEOUT_ENV] = '50';
      mockPg.stallMs = 2000;
      const started = Date.now();
      const res = await get('a', path(x));
      expect([res.status, res.body]).toEqual([504, TIMED_OUT]);
      expect(res.text).not.toMatch(EDGE_WORDS);
      expect(res.text).not.toMatch(/unsupported|current|stale/);
      expect(Date.now() - started).toBeLessThan(1500); // bounded by the timeout, not by the slow query
      expect(receiptCheckouts().map(settled)).toEqual([{ statements: ['BEGIN', 'set_config', 'receipts', 'ROLLBACK'], releases: 1 }]);
      expect(receiptCheckouts()[0]!.timeouts).toEqual([50]);
    });

    it('a slow receipts read under its timeout is unchanged: the edges, committed', async () => {
      const x = await withEdge();
      process.env[TIMEOUT_ENV] = '2000';
      mockPg.stallMs = 100;
      const res = await get('a', path(x));
      expect([res.status, res.body.edges[0].currentness]).toEqual([200, 'current']);
      expect(receiptCheckouts().map(settled)).toEqual([{ statements: ['BEGIN', 'set_config', 'receipts', 'COMMIT'], releases: 1 }]);
    });

    it('a Neo4j incarnation read that times out (TransactionTimedOut) is the same fixed 504; no receipts transaction is opened', async () => {
      const x = await withEdge();
      mockNeo.onIncarnationRead = () => {
        throw Object.assign(new Error('The transaction has not completed within the specified timeout'),
          { code: 'Neo.ClientError.Transaction.TransactionTimedOut' });
      };
      const res = await get('a', path(x));
      expect([res.status, res.body]).toEqual([504, TIMED_OUT]);
      expect(res.text).not.toMatch(EDGE_WORDS);
      expect(receiptCheckouts()).toEqual([]);
    });

    it('a non-timeout incarnation read failure is the endpoint\'s existing 500 with no members', async () => {
      const x = await withEdge();
      mockNeo.onIncarnationRead = () => { throw Object.assign(new Error('boom'), { code: 'Neo.DatabaseError.General.UnknownError' }); };
      const res = await get('a', path(x));
      expect([res.status, res.body]).toEqual([500, FAILURES[name]]);
      expect(res.text).not.toMatch(EDGE_WORDS);
    });

    it('the receipts table missing (42P01) is the endpoint\'s existing 500 with no members, never every edge unsupported', async () => {
      const x = await withEdge();
      await ownerExec(TABLE_AWAY);
      let res;
      try {
        res = await get('a', path(x));
      } finally {
        await ownerExec(TABLE_BACK);
      }
      expect([res.status, res.body]).toEqual([500, FAILURES[name]]);
      expect(res.text).not.toMatch(EDGE_WORDS);
      expect(res.text).not.toContain('unsupported');
      expect(receiptCheckouts().map(settled)).toEqual([{ statements: ['BEGIN', 'set_config', 'receipts', 'ROLLBACK'], releases: 1 }]);
    });

    it('a connection error on the receipts read is the same 500 with no members', async () => {
      const x = await withEdge();
      mockPg.failReceiptsRead = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      const res = await get('a', path(x));
      expect([res.status, res.body]).toEqual([500, FAILURES[name]]);
      expect(res.text).not.toMatch(EDGE_WORDS);
      expect(receiptCheckouts().map(settled)).toEqual([{ statements: ['BEGIN', 'set_config', 'receipts', 'ROLLBACK'], releases: 1 }]);
    });

    it('IMPACT_EVIDENCE_TIMEOUT_MS: 750 is honoured, and the 3 s default applies to 0, negative, fractional, NaN and over-int4 values with a normal answer', async () => {
      const x = await withEdge();
      process.env[TIMEOUT_ENV] = '750';
      expect((await get('a', path(x))).status).toBe(200);
      expect(receiptCheckouts().map(({ timeouts }) => timeouts)).toEqual([[750]]);
      for (const bad of ['0', '-5', '1.5', 'NaN', 'abc', '', '2147483648', '99999999999']) {
        mockPg.checkouts.length = 0;
        process.env[TIMEOUT_ENV] = bad;
        const res = await get('a', path(x));
        expect([bad, res.status]).toEqual([bad, 200]); // an over-max value is not a 500
        expect([bad, receiptCheckouts().map(({ timeouts }) => timeouts)]).toEqual([bad, [[IMPACT_EVIDENCE_TIMEOUT_MS]]]);
      }
      mockPg.checkouts.length = 0;
      process.env[TIMEOUT_ENV] = String(MAX_IMPACT_LINEAGE_TIMEOUT_MS);
      expect((await get('a', path(x))).status).toBe(200);
      expect(receiptCheckouts().map(({ timeouts }) => timeouts)).toEqual([[MAX_IMPACT_LINEAGE_TIMEOUT_MS]]);
    });
  });

  describe('truncation', () => {
    it('reads the NEWEST 200 receipts: an old support beyond the cap never lifts a newer contradiction; count 200, truncated', async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      // Newest: one contradiction (10 minutes). Then 199 declared supports (2..200 hours). 50 more supports a month old fall beyond the cap.
      await plant(x, y, [{ polarity: 'contradicts', ageMs: 10 * 60_000 },
        ...Array.from({ length: 199 }, (_, i) => ({ ageMs: (2 + i) * HOUR })),
        ...Array.from({ length: 50 }, (_, i) => ({ ageMs: 30 * DAY + i * HOUR }))]);
      const edge = (await get('a', path(x))).body.edges[0];
      expect(edge).toMatchObject({ currentness: 'contradicted', evidence: { receipt_count: EDGE_EVIDENCE_SCAN_CAP, receipts_truncated: true,
        support: { supports: 199, contradicts: 1 }, classes: ['declared'] } });
      expect(Date.now() - Date.parse(edge.evidence.last_supported_at)).toBeLessThan(3 * DAY); // never the month-old receipts
    });

    it('250 mixed receipts whose newest 200 are all contradictions: contradicted with no support counted, though older supports exist', async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, [...Array.from({ length: 200 }, (_, i) => ({ polarity: 'contradicts' as const, ageMs: (1 + i) * HOUR })),
        ...Array.from({ length: 50 }, (_, i) => ({ ageMs: 20 * DAY + i * HOUR }))]);
      expect((await get('a', path(x))).body.edges[0]).toMatchObject({ currentness: 'contradicted', evidence: {
        receipt_count: 200, receipts_truncated: true, support: { supports: 0, contradicts: 200 }, classes: [], last_supported_at: null } });
    });

    it('fewer than the cap is not truncated, exactly the cap is', async () => {
      const [x, y, z] = [seed(A), seed(A), seed(A)];
      dependsOn(x, y);
      dependsOn(x, z);
      await plant(x, y, Array.from({ length: EDGE_EVIDENCE_SCAN_CAP - 1 }, (_, i) => ({ ageMs: (1 + i) * HOUR })));
      await plant(x, z, Array.from({ length: EDGE_EVIDENCE_SCAN_CAP }, (_, i) => ({ ageMs: (1 + i) * HOUR })));
      const res = await get('a', path(x));
      const evidenceOf = (to: string) => res.body.edges.find((edge: { to: string }) => edge.to === to).evidence;
      expect([evidenceOf(y).receipt_count, evidenceOf(y).receipts_truncated]).toEqual([EDGE_EVIDENCE_SCAN_CAP - 1, false]);
      expect([evidenceOf(z).receipt_count, evidenceOf(z).receipts_truncated]).toEqual([EDGE_EVIDENCE_SCAN_CAP, true]);
    });
  });

  describe('links', () => {
    it('receipts_href returns Story 2\'s receipts for the same caller: total equals receipt_count when not truncated, same classes; org B gets the missing-CI 404', async () => {
      const s = await scenario();
      const res = await get('a', path(s.root));
      for (const edge of res.body.edges as Array<{ currentness: string; evidence: { receipts_href: string; receipt_count: number;
        classes: string[]; receipts_truncated: boolean } }>) {
        const receipts = await get('a', `${edge.evidence.receipts_href}&limit=200`);
        expect(receipts.status).toBe(200);
        expect(receipts.body.pagination.total).toBeGreaterThanOrEqual(edge.evidence.receipt_count);
        if (!edge.evidence.receipts_truncated) expect(receipts.body.pagination.total).toBe(edge.evidence.receipt_count);
        const supporting = new Set(receipts.body.data.receipts.filter((r: { polarity: string }) => r.polarity === 'supports')
          .map((r: { evidence_class: string }) => r.evidence_class));
        expect(['declared', 'static_observed', 'runtime_observed', 'inferred'].filter(cls => supporting.has(cls))).toEqual(edge.evidence.classes);
        const foreign = await get('b', edge.evidence.receipts_href);
        expect([foreign.status, foreign.body]).toEqual([404, NOT_FOUND]);
      }
      const missing = await get('b', `/api/v1/relationships/evidence?from_id=${randomUUID()}&to_id=${randomUUID()}&type=DEPENDS_ON`);
      expect([missing.status, missing.body]).toEqual([404, NOT_FOUND]);
    });

    it('for a truncated edge the receipts route reports the full total, above the 200 the edge summarised', async () => {
      const [x, y] = [seed(A), seed(A)];
      dependsOn(x, y);
      await plant(x, y, Array.from({ length: 230 }, (_, i) => ({ ageMs: (1 + i) * HOUR })));
      const edge = (await get('a', path(x))).body.edges[0];
      expect(edge.evidence.receipt_count).toBe(200);
      expect((await get('a', edge.evidence.receipts_href)).body.pagination.total).toBe(230);
    });
  });

  describe('response hygiene and access', () => {
    const FORBIDDEN = ['organization_id', 'incarnation', 'source_name', 'observer', 'correlation_id'];
    const walk = (value: unknown, found: string[] = [], where = '$'): string[] => {
      if (typeof value === 'string') {
        for (const word of FORBIDDEN) if (value.includes(word)) found.push(`${where}=${value}`);
      } else if (Array.isArray(value)) value.forEach((item, i) => walk(item, found, `${where}[${i}]`));
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          for (const word of FORBIDDEN) if (key.includes(word)) found.push(`${where}.${key}`);
          walk(item, found, `${where}.${key}`);
        }
      }
      return found;
    };

    it('carries no organization, incarnation, source, observer or correlation id in anything the change added (every key and value is walked)', async () => {
      const s = await scenario();
      // Receipts with every identifying field set, so a leak of any one of them would show.
      await ownerRows(`INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id,
          to_incarnation_id, relationship_type, evidence_class, polarity, source_name, source_id, source_version, method, rationale_code,
          observed_at, observer, observer_type, correlation_id)
        VALUES ($1, $2, $3, $4, $5, 'DEPENDS_ON', 'static_observed', 'supports', 'leaky_source', 'leaky_source_id', 'v9', 'leaky_method',
          'leaky_rationale', now(), 'leaky-observer', 'system', gen_random_uuid())`,
      [A, s.root, s.declared, incarnation(s.root), incarnation(s.declared)]);
      const res = await get('a', path(s.root));
      expect(res.status).toBe(200);
      // `data` is the pre-change member payload: it carries whatever the node properties carry and is unchanged by this story.
      const { data: _members, ...added } = res.body;
      expect(walk(added)).toEqual([]);
      const text = JSON.stringify(res.body.edges);
      for (const secret of [A, incarnation(s.root)!, incarnation(s.declared)!, 'leaky_source', 'leaky_source_id', 'leaky_method',
        'leaky_rationale', 'leaky-observer', 'planted-observer', 'planted']) expect(text).not.toContain(secret);
    });

    it('is 401 without a token; a viewer may read; the existing members are unchanged', async () => {
      const s = await scenario();
      expect((await request(app).get(path(s.root))).status).toBe(401);
      const viewer = await get('viewer', path(s.root));
      const operator = await get('a', path(s.root));
      expect([viewer.status, viewer.body.edges]).toEqual([200, operator.body.edges]);
      expect(viewer.body.depth).toBe(5);
      if (name === 'dependencies') expect(viewer.body.count).toBe(viewer.body.data.length);
      else expect(viewer.body.totalImpacted).toBe(5);
    });
  });

  describe('nothing is stored', () => {
    it('a read issues no INSERT, UPDATE or DELETE to PostgreSQL and changes no graph node or edge property', async () => {
      const s = await scenario();
      const graph = () => JSON.stringify([[...mockGraph.nodes], [...mockGraph.edges]]);
      const table = async () => JSON.stringify(await ownerRows('SELECT * FROM relationship_evidence_receipts ORDER BY receipt_id'));
      const [graphBefore, tableBefore] = [graph(), await table()];
      mockPg.statements.length = 0;
      mockNeo.statements.length = 0;
      const res = await get('a', path(s.root));
      expect(res.status).toBe(200);
      expect(res.body.edges.map((edge: { currentness: string }) => edge.currentness).sort())
        .toEqual(['contradicted', 'current', 'current', 'stale', 'unsupported']);
      expect(mockPg.statements.filter(text => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|MERGE|COPY)\b/i.test(text))).toEqual([]);
      expect(mockNeo.statements.filter(text => /\b(SET|MERGE|CREATE|DELETE|REMOVE)\b/.test(text))).toEqual([]);
      expect(graph()).toBe(graphBefore);
      expect(await table()).toBe(tableBefore);
      expect(JSON.stringify([...mockGraph.edges.values()])).not.toMatch(/currentness|evidence/);
    });
  });
});

describe('loadEdgeEvidence', () => {
  const edges = (count: number) => Array.from({ length: count }, (_, i) => ({ from: `f-${i}`, to: `t-${i}`, type: 'DEPENDS_ON' }));

  it('refuses more than 1000 edges with CITraversalLimitError and issues nothing, to Neo4j or PostgreSQL', async () => {
    await expect(loadEdgeEvidence(A, edges(MAX_EDGE_EVIDENCE_EDGES + 1), { timeoutMs: 1000 })).rejects.toBeInstanceOf(CITraversalLimitError);
    expect([mockPg.statements, mockNeo.statements]).toEqual([[], []]);
  });

  it('accepts exactly 1000 edges: one incarnation read, and edges whose endpoints are not owned never reach PostgreSQL', async () => {
    const result = await loadEdgeEvidence(A, edges(MAX_EDGE_EVIDENCE_EDGES), { timeoutMs: 1000 });
    expect(result.size).toBe(MAX_EDGE_EVIDENCE_EDGES);
    expect([...result.values()].every(qualified => qualified.currentness === 'unsupported')).toBe(true);
    expect(mockNeo.statements.filter(text => text.includes('AS incarnationId'))).toHaveLength(1);
    expect(mockPg.statements).toEqual([]);
  });

  it('issues nothing for no edges', async () => {
    expect((await loadEdgeEvidence(A, [], { timeoutMs: 1000 })).size).toBe(0);
    expect([mockPg.statements, mockNeo.statements]).toEqual([[], []]);
  });
});

describe('IMPACT_EVIDENCE_TIMEOUT_MS', () => {
  it('is a positive integer up to the PostgreSQL maximum; anything else is the 3 s default', () => {
    expect(impactEvidenceTimeoutMs({ IMPACT_EVIDENCE_TIMEOUT_MS: '750' })).toBe(750);
    expect(impactEvidenceTimeoutMs({ IMPACT_EVIDENCE_TIMEOUT_MS: '2147483647' })).toBe(MAX_IMPACT_LINEAGE_TIMEOUT_MS);
    for (const bad of [undefined, '', '0', '-5', '1.5', 'abc', 'NaN', '1e3x', 'Infinity', '2147483648', '99999999999']) {
      expect(impactEvidenceTimeoutMs({ IMPACT_EVIDENCE_TIMEOUT_MS: bad })).toBe(IMPACT_EVIDENCE_TIMEOUT_MS);
    }
    expect(IMPACT_EVIDENCE_TIMEOUT_MS).toBe(3000);
  });
});
