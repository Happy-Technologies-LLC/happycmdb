// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2126 L1b: the journal's receipts schema gate also needs INSERT privilege on relationship_evidence_receipts for the
 * connected login. A relationship write by a login without it is a 503 before T1 (no group id, no journal row, no graph write),
 * never an edge without evidence; CI writes and the evidence read do not need INSERT and are unaffected.
 *
 * Real ciRoutes and relationshipRoutes behind the real JWT middleware, the production journal and Neo4jClient on PGlite; every
 * statement a route sends runs as the NOSUPERUSER app login `cmdb_user` (054's SELECT, INSERT grant on the receipts), fixtures
 * and grant changes run as the table owner. The journal caches readiness per process, so the tests run in order: G1 is the
 * cold gate, G2 the recovery, G3 the warm cache and its 42501 reset.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const A = randomUUID();
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
/** Every statement the application's pool sends runs as the app login; a statement that changes the role is refused. */
async function mockAppSql(text: string, params: unknown[] = []) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./fixtures/app-login').assertAppStatement(text);
  return mockSql(text, params);
}
jest.mock('pg', () => {
  const actual = jest.requireActual('pg');
  class Pool {
    options = {};
    on() { return this; }
    query(text: string, params?: unknown[]) { return mockAppSql(text, params); }
    async connect() { return { query: (text: string, params?: unknown[]) => mockAppSql(text, params), release: () => undefined }; }
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
// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.// The real @cmdb/database opens the BullMQ Redis connection at import; nothing here queues jobs.
jest.mock('@cmdb/database/bullmq/queue-manager', () => ({}));
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));
const users: Record<string, { _id: string; _username: string; _role: 'admin' | 'viewer'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'actor-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
    findApiKeyByKey: async () => null,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { getNeo4jClient } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { ciRoutes } from '../ci.routes';
import { relationshipRoutes } from '../relationship.routes';
import { APP_GRANTS_SQL, assertAppLogin, asTableOwner, createLoginRolesSql, migrationSql, receiptTableSql } from './fixtures/app-login';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);
const headers = () => ({ authorization: `Bearer ${jwt.generateAccessToken(
  users['a']!._id, users['a']!._username, users['a']!._role, users['a']!._organizationId, 0, Math.floor(Date.now() / 1000))}` });
const create = (from: string, to: string) =>
  request(app).post('/api/v1/relationships').set(headers()).send({ from_id: from, to_id: to, type: 'DEPENDS_ON' });
const remove = (from: string, to: string) =>
  request(app).delete('/api/v1/relationships').query({ from_id: from, to_id: to, type: 'DEPENDS_ON' }).set(headers());
const evidence = (from: string, to: string) =>
  request(app).get('/api/v1/relationships/evidence').query({ from_id: from, to_id: to, type: 'DEPENDS_ON' }).set(headers());

const owner = <T>(work: () => Promise<T>) => asTableOwner(text => mockSql(text, [], 'exec'), work);
const ownerExec = (text: string) => owner(() => mockSql(text, [], 'exec'));
const ownerRows = (text: string, params: unknown[] = []) => owner(async () => (await mockSql(text, params)).rows);
const REVOKE_INSERT = 'REVOKE INSERT ON relationship_evidence_receipts FROM cmdb_user';
const GRANT_INSERT = 'GRANT INSERT ON relationship_evidence_receipts TO cmdb_user';
const receipts = (from: string, to: string) => ownerRows(
  'SELECT receipt_id, polarity FROM relationship_evidence_receipts WHERE from_ci_id = $1 AND to_ci_id = $2', [from, to]);
const operations = (ids: string[]) => ownerRows('SELECT state FROM ci_reconciliation_operations WHERE ci_id = ANY($1::text[]) ORDER BY ci_id', [ids]);
const seed = (): string => {
  const id = randomUUID();
  mockGraph.nodes.set(id, { id, organization_id: A, name: 'seeded', type: 'server', incarnation_id: randomUUID() });
  return id;
};
const edge = (from: string, to: string) => `${from}|DEPENDS_ON|${to}`;

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
    CHECK (organization_id IS NOT NULL) NOT VALID`, [], 'exec');
  await mockSql(`GRANT USAGE ON SCHEMA public, cmdb TO cmdb_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cmdb_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cmdb TO cmdb_user;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public, cmdb TO cmdb_user;`, [], 'exec');
  await mockSql(APP_GRANTS_SQL, [], 'exec');
  await mockSql(receiptTableSql(), [], 'exec'); // last: its SELECT, INSERT grant is the privilege set the app login has
  await mockSql('RESET ROLE; SET SESSION AUTHORIZATION cmdb_user;', [], 'exec');
  await assertAppLogin(async text => (await mockSql(text)).rows);
});
afterAll(() => { host.kill(); });
afterEach(() => ownerExec(GRANT_INSERT)); // never leaves a revocation behind

// G1, runs first: the journal caches its readiness, so this is the cold gate.
it('G1 cold: INSERT revoked, a relationship write is 503 before T1 with no edge, journal row or receipt; CI writes and the evidence read are unaffected', async () => {
  const [from, to, existing] = [seed(), seed(), seed()];
  mockGraph.edges.set(edge(from, existing), {});
  await ownerExec(REVOKE_INSERT);
  const created = await create(from, to);
  expect([created.status, created.body.correlation_id]).toEqual([503, undefined]); // no group id: refused before T1
  const removed = await remove(from, existing);
  expect([removed.status, removed.body.correlation_id]).toEqual([503, undefined]);
  expect([await operations([from, to, existing]), mockGraph.writes, mockGraph.edges.has(edge(from, to)), mockGraph.edges.has(edge(from, existing)),
    await receipts(from, to), await receipts(from, existing)]).toEqual([[], [], false, true, [], []]);
  const id = (await request(app).post('/api/v1/cis').set(headers()).send({ name: 'n', type: 'server' })).body.data.id as string;
  expect([(await request(app).put(`/api/v1/cis/${id}`).set(headers()).send({ name: 'renamed' })).status,
    (await request(app).delete(`/api/v1/cis/${id}`).set(headers())).status, (await evidence(from, to)).status]).toEqual([200, 204, 200]);
});

it('G2 recovery: the same write is 201 with one receipt once INSERT is granted again (a failed probe is never cached)', async () => {
  const [from, to] = [seed(), seed()];
  await ownerExec(REVOKE_INSERT);
  expect((await create(from, to)).status).toBe(503);
  await ownerExec(GRANT_INSERT);
  expect((await create(from, to)).status).toBe(201);
  expect((await receipts(from, to)).map(row => row['polarity'])).toEqual(['supports']);
});

it('G3 warm cache, then a revocation: the next write fails in T2 (documented window), the one after is refused before T1, a re-grant heals the first', async () => {
  const [lostFrom, lostTo, refusedFrom, refusedTo, healedFrom, healedTo] = [seed(), seed(), seed(), seed(), seed(), seed()];
  await ownerExec(REVOKE_INSERT);
  const window = await create(lostFrom, lostTo); // readiness cached by G2: W applies, T2 cannot insert (42501)
  expect([window.status, typeof window.body.correlation_id, mockGraph.edges.has(edge(lostFrom, lostTo)), await receipts(lostFrom, lostTo),
    (await operations([lostFrom, lostTo])).map(row => row['state'])]).toEqual([503, 'string', true, [], ['pending', 'pending']]);
  const refused = await create(refusedFrom, refusedTo); // 42501 reset the cache: re-probed
  expect([refused.status, refused.body.correlation_id, mockGraph.edges.has(edge(refusedFrom, refusedTo)), await operations([refusedFrom, refusedTo])])
    .toEqual([503, undefined, false, []]);
  await ownerExec(GRANT_INSERT);
  expect((await create(healedFrom, healedTo)).status).toBe(201);
  await ownerRows('UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval \'1 minute\' WHERE ci_id = ANY($1::text[])',
    [[lostFrom, lostTo]]);
  await getNeo4jClient().journal.sweep();
  expect([(await receipts(lostFrom, lostTo)).length, (await operations([lostFrom, lostTo])).map(row => row['state'])])
    .toEqual([1, ['committed', 'committed']]);
});
