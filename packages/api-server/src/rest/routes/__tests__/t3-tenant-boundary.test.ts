// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Authenticated routes with real migrated PostgreSQL DDL and an instrumented graph. */
import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
  else reply.resolve(rows);
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}
const db = {
  exec: (sql: string) => send('exec', sql),
  rows: <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>,
};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const nodes = new Map<string, { id: string; name: string; organization_id: string; itil_audit_status?: string }>();
let sqlCount = 0;
let graphCount = 0;
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const integer = (n: number) => ({ toNumber: () => n });
const graph = {
  getCI: async (id: string, org: string) => {
    graphCount++;
    const ci = nodes.get(id);
    return ci?.organization_id === org ? { ...ci } : null;
  },
  getSession: () => ({
    run: async (statement: string, params: Record<string, unknown> = {}) => {
      graphCount++;
      if (Array.isArray(params['keys']) && statement.includes('ci.organization_id = key.organizationId')) {
        return { records: (params['keys'] as Array<{ id: string; organizationId: string }>).map(key => {
          const node = nodes.get(key.id);
          return record({ ciId: key.id, organizationId: key.organizationId,
            ci: node?.organization_id === key.organizationId ? { properties: { ...node, type: 'server', status: 'active' } } : null });
        }) };
      }
      const org = params['organizationId'];
      if (typeof org !== 'string' || !statement.includes('organization_id = $organizationId')) {
        throw new Error('Unscoped Neo4j statement');
      }
      const visible = [...nodes.values()].filter(ci => ci.organization_id === org);
      const id = params['id'] ?? params['ciId'] ?? params['rootCiId'];
      const ci = visible.find(row => row.id === id);
      if (/RETURN count\(ci\) (as|AS) total/.test(statement)) {
        return { records: [record({ total: integer(visible.length) })] };
      }
      if (statement.includes('compliantCount')) {
        return { records: [record({ compliantCount: integer(visible.filter(row => row.itil_audit_status === 'COMPLIANT').length), totalAudited: integer(visible.filter(row => row.itil_audit_status).length) })] };
      }
      if (statement.includes('RETURN ci.id as id')) {
        return { records: ci ? [record({ id: ci.id, name: ci.name, ci_type: 'server' })] : [] };
      }
      if (statement.includes('dependent_count')) {
        const scopedEndpoints = statement.includes('dependent.organization_id = $organizationId')
          && statement.includes('dependency.organization_id = $organizationId');
        return { records: ci ? [record({ ci_id: ci.id, ci_name: ci.name,
          dependent_count: integer(scopedEndpoints ? 0 : 1), dependency_count: integer(0),
          dependent_ids: scopedEndpoints ? [] : ['ci-b'] })] : [] };
      }
      if (statement.includes('MATCH path')) {
        const scopedPath = statement.includes('ALL(n IN nodes(path) WHERE n.organization_id = $organizationId)');
        const foreign = nodes.get('ci-b')!;
        if (statement.includes('RETURN DISTINCT')) {
          return { records: scopedPath ? [] : [record({ ci_id: foreign.id, ci_name: foreign.name,
            ci_type: 'server', hop_count: integer(1), path_ids: ['ci-a', foreign.id] })] };
        }
        if (statement.includes('RETURN node.id as id')) {
          const paths = ci ? [ci, ...(!scopedPath ? [foreign] : [])] : [];
          return { records: paths.map(row => record({ id: row.id, name: row.name, ci_type: 'server',
            dependents_count: integer(0), dependencies_count: integer(0) })) };
        }
        if (statement.includes('RETURN source.id as source_id')) {
          return { records: scopedPath ? [] : [record({ source_id: 'ci-a', target_id: 'ci-b', rel_type: 'DEPENDS_ON' })] };
        }
        return { records: [] };
      }
      if (statement.includes('SET ci += $updates') && ci) {
        Object.assign(ci, params['updates'] as Record<string, unknown>);
        return { records: [record({ ci: { properties: { ...ci, type: 'server', status: 'active' } } })] };
      }
      if (statement.includes('RETURN ci') && statement.includes('MATCH (ci:CI {id: $ciId})')) {
        return { records: ci ? [record({ ci: { properties: { ...ci } } })] : [] };
      }
      if (statement.includes('SET ci.itil_') && ci) {
        ci.itil_audit_status = String(params['auditStatus'] ?? ci.itil_audit_status ?? '');
        return { records: [record({ ci: { properties: { ...ci } } })] };
      }
      if (id !== undefined && statement.includes('RETURN ci')) {
        return { records: ci ? [record({ ci: { properties: { ...ci } } })] : [] };
      }
      if (statement.includes('RETURN ci')) return { records: visible.map(row => record({ ci: { properties: { ...row } } })) };
      throw new Error(`Unmodelled scoped graph statement: ${statement}`);
    },
    close: async () => undefined,
  }),
};
const pg = {
  query: async (sql: string, params: unknown[] = []) => {
    sqlCount++;
    return { rows: await db.rows(sql, params) };
  },
};
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => graph,
  getPostgresClient: () => ({ ...pg, pool: pg }),
  getAuditService: () => ({}),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: () => ({ emit: jest.fn() }), EventType: { RECONCILIATION_CONFLICT: 'reconciliation.conflict' },
}));
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  b: { _id: 'b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: B },
  noorg: { _id: 'noorg', _username: 'none', _role: 'admin', _enabled: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => USERS[id] ?? null })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { itilRoutes } from '../itil.routes';
import { driftRoutes, impactRoutes } from '../drift-impact.routes';
import { createGraphQLServer } from '../../../graphql/server';
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/drift', driftRoutes);
app.use('/api/v1/impact', impactRoutes);
const auth = (id: string) => {
  const user = USERS[id]!;
  return { Authorization: `Bearer ${jwt.generateAccessToken(id, user._username, user._role, user._organizationId)}` };
};
const migrations = join(__dirname, '../../../../../database/src/postgres/migrations');
const ddl = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
const table = (name: string) => {
  const match = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replace('.', '\\.') } \\([\\s\\S]*?\\n\\);`));
  if (!match) throw new Error(`Missing production schema: ${name}`);
  return match[0];
};

beforeAll(async () => {
  await db.exec(`CREATE SCHEMA cmdb; ${table('cmdb.dim_ci')} ${table('ci_change_history')}
    ${table('baseline_snapshots')} ${table('drift_detection_results')}
    ${table('impact_analyses')} ${table('ci_criticality_scores')}`);
  await db.exec(readFileSync(join(migrations, '011_ci_organization_scope.sql'), 'utf8'));
  await db.exec(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES
    ('ci-a', 'A', 'server', 'active', '${A}'), ('ci-b', 'B', 'server', 'active', '${B}');`);
  await db.exec(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata) VALUES
    ('ci-a', 'UPDATE', 'test', '{"organization_id":"${A}"}'),
    ('ci-b', 'UPDATE', 'test', '{"organization_id":"${B}"}');`);
  nodes.set('ci-a', { id: 'ci-a', name: 'A', organization_id: A, itil_audit_status: 'COMPLIANT' });
  nodes.set('ci-b', { id: 'ci-b', name: 'B', organization_id: B, itil_audit_status: 'FAILED' });
});
afterAll(() => { host.kill(); });
beforeEach(() => { sqlCount = 0; graphCount = 0; });
afterEach(async () => {
  nodes.delete('ci-fresh');
  await db.rows("DELETE FROM drift_detection_results WHERE ci_id = 'ci-fresh'");
  await db.rows("DELETE FROM baseline_snapshots WHERE ci_id = 'ci-fresh'");
  await db.rows("DELETE FROM impact_analyses WHERE source_ci_id = 'ci-fresh'");
  await db.rows("DELETE FROM ci_criticality_scores WHERE ci_id = 'ci-fresh'");
  await db.rows("DELETE FROM ci_change_history WHERE ci_id = 'ci-fresh'");
});

it('scopes ITIL CI lists, audit metrics and CI detail/write paths across two tenants', async () => {
  const list = await request(app).get('/api/v1/itil/configuration-items').set(auth('a'));
  expect(list.status).toBe(200);
  expect(list.body.pagination.total).toBe(1);
  expect(list.body.data.map((ci: { id: string }) => ci.id)).toEqual(['ci-a']);
  const accuracy = await request(app).get('/api/v1/itil/metrics/configuration-accuracy').set(auth('a'));
  expect(accuracy.body.data).toMatchObject({ compliantCount: 1, totalAudited: 1 });
  const ownHistory = await request(app).get('/api/v1/itil/configuration-items/ci-a/history').set(auth('a'));
  const foreignHistory = await request(app).get('/api/v1/itil/configuration-items/ci-b/history').set(auth('a'));
  expect(ownHistory.body.data).toMatchObject([{ ci_id: 'ci-a' }]);
  expect(foreignHistory.status).toBe(404);
  const invalidLifecycle = await request(app).patch('/api/v1/itil/configuration-items/ci-a/lifecycle')
    .set(auth('a')).send({ stage: 'INVALID_STAGE' });
  expect(invalidLifecycle.status).toBe(400);
  const foreign = await request(app).patch('/api/v1/itil/configuration-items/ci-b/lifecycle').set(auth('a')).send({ stage: 'BUILD' });
  const missing = await request(app).patch('/api/v1/itil/configuration-items/missing/lifecycle').set(auth('a')).send({ stage: 'BUILD' });
  expect(foreign.status).toBe(404);
  expect(foreign.body.error).toBe(missing.body.error);
  expect(nodes.get('ci-b')?.organization_id).toBe(B);
  expect((await request(app).get('/api/v1/itil/configuration-items/ci-a').set(auth('b'))).status).toBe(404);
  expect((await request(app).get('/api/v1/itil/configuration-items/ci-b').set(auth('b'))).status).toBe(200);
});

it('persists fresh graph-owned CI derivatives before the reporting dimension syncs', async () => {
  nodes.set('ci-fresh', { id: 'ci-fresh', name: 'Fresh', organization_id: A });
  const baseline = await request(app).post('/api/v1/drift/baseline')
    .set(auth('a')).send({ ci_id: 'ci-fresh', snapshot_type: 'configuration' });
  expect(baseline.status).toBe(201);
  expect((await request(app).post(`/api/v1/drift/baseline/${baseline.body.data.id}/approve`).set(auth('b'))).status).toBe(404);
  expect((await request(app).post(`/api/v1/drift/baseline/${baseline.body.data.id}/approve`).set(auth('a'))).status).toBe(200);
  expect((await request(app).post('/api/v1/drift/detect/ci-fresh').set(auth('a'))).status).toBe(200);
  const impact = await request(app).post('/api/v1/impact/predict')
    .set(auth('a')).send({ ci_id: 'ci-fresh', change_type: 'RESTART' });
  expect(impact.status).toBe(201);
  expect((await request(app).get('/api/v1/impact/history/ci-fresh').set(auth('a'))).body.data)
    .toMatchObject([{ source_ci_id: 'ci-fresh' }]);
  expect((await request(app).get('/api/v1/impact/history/ci-fresh').set(auth('b'))).status).toBe(404);
  expect(await db.rows('SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = $1', ['ci-fresh'])).toEqual([]);
});

it('shows only proven CI history for a fresh graph CI and denies prior-owner rows after ID reuse', async () => {
  nodes.set('ci-fresh', { id: 'ci-fresh', name: 'Fresh', organization_id: A });
  await db.rows(
    `INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata) VALUES
      ('ci-fresh', 'A_EVENT', 'reconciliation', $1::jsonb),
      ('ci-fresh', 'LEGACY', 'unknown', NULL)`,
    [JSON.stringify({ organization_id: A, event_id: 'a-1' })]
  );
  const gqlApp = express();
  const { server } = await createGraphQLServer(gqlApp);
  const rest = (user: string) => request(app).get('/api/v1/itil/configuration-items/ci-fresh/history').set(auth(user));
  const gql = (user: string) => request(gqlApp).post('/graphql').set(auth(user))
    .send({ query: '{ ciHistory(id: "ci-fresh") { changeType } }' });
  try {
    expect((await rest('a')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['A_EVENT']);
    expect((await gql('a')).body.data?.ciHistory).toEqual([{ changeType: 'A_EVENT' }]);
    expect((await rest('b')).status).toBe(404);
    expect((await gql('b')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');

    nodes.get('ci-fresh')!.organization_id = B;
    await db.rows(
      "INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata) VALUES ('ci-fresh', 'B_EVENT', 'reconciliation', $1::jsonb)",
      [JSON.stringify({ organization_id: B, event_id: 'b-1' })]
    );
    expect((await rest('a')).status).toBe(404);
    expect((await gql('a')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
    expect((await rest('b')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['B_EVENT']);
    expect((await gql('b')).body.data?.ciHistory).toEqual([{ changeType: 'B_EVENT' }]);
    expect(await db.rows('SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = $1', ['ci-fresh'])).toEqual([]);
  } finally {
    await server.stop();
  }
});

it('refuses org-less calls before graph or SQL for both families', async () => {
  const routes = [
    request(app).get('/api/v1/itil/configuration-items'),
    request(app).get('/api/v1/itil/metrics/configuration-accuracy'),
    request(app).post('/api/v1/drift/baseline').send({ ci_id: 'ci-a', snapshot_type: 'configuration' }),
    request(app).post('/api/v1/drift/detect/ci-a'),
    request(app).get('/api/v1/impact/graph/ci-a'),
    request(app).get('/api/v1/impact/history/ci-a'),
  ];
  for (const route of routes) expect((await route.set(auth('noorg'))).status).toBe(403);
  expect(sqlCount).toBe(0);
  expect(graphCount).toBe(0);
});

it('isolates drift/impact foreign reads and writes, and persists own derived records in PostgreSQL', async () => {
  const foreignBaseline = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 'ci-b', snapshot_type: 'configuration' });
  const missingBaseline = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 'missing', snapshot_type: 'configuration' });
  expect(foreignBaseline.status).toBe(404);
  expect(foreignBaseline.body.error).toBe(missingBaseline.body.error);
  const ownBaseline = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 'ci-a', snapshot_type: 'configuration' });
  expect([ownBaseline.status, ownBaseline.body]).toEqual([201, expect.objectContaining({ success: true })]);
  expect(ownBaseline.body.data.created_by).toBe('a');
  const baselineId = ownBaseline.body.data.id as string;
  const deniedApproval = await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('b'));
  const missingApproval = await request(app).post('/api/v1/drift/baseline/missing/approve').set(auth('b'));
  expect(deniedApproval.status).toBe(404);
  expect(deniedApproval.body.error).toBe(missingApproval.body.error);
  const ownApproval = await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('a'));
  expect(ownApproval.status).toBe(200);
  expect(ownApproval.body.data.approved_by).toBe('a');
  const ownDrift = await request(app).post('/api/v1/drift/detect/ci-a').set(auth('a'));
  expect(ownDrift.status).toBe(200);
  expect((await db.rows<{ ci_id: string }>('SELECT ci_id FROM drift_detection_results')).map(row => row.ci_id)).toEqual(['ci-a']);
  expect((await db.rows<{ ci_id: string }>('SELECT ci_id FROM baseline_snapshots')).map(row => row.ci_id)).toEqual(['ci-a']);
  expect((await request(app).get('/api/v1/drift/baseline/ci-a?snapshot_type=configuration').set(auth('b'))).status).toBe(404);
  expect((await request(app).get('/api/v1/drift/history/ci-a').set(auth('b'))).status).toBe(404);
  const foreignImpact = await request(app).post('/api/v1/impact/predict').set(auth('b')).send({ ci_id: 'ci-a', change_type: 'RESTART' });
  const missingImpact = await request(app).post('/api/v1/impact/predict').set(auth('b')).send({ ci_id: 'missing', change_type: 'RESTART' });
  expect(foreignImpact.status).toBe(404);
  expect(foreignImpact.body.error).toBe(missingImpact.body.error);
  const ownImpact = await request(app).post('/api/v1/impact/predict').set(auth('a')).send({ ci_id: 'ci-a', change_type: 'RESTART' });
  expect(ownImpact.body.data.blast_radius).toBe(0);
  expect(ownImpact.body.data.affected_cis).toEqual([]);
  expect(ownImpact.body.data.critical_path).not.toContain('ci-b');
  const ownGraph = await request(app).get('/api/v1/impact/graph/ci-a').set(auth('a'));
  expect(ownGraph.status).toBe(200);
  expect(ownGraph.body.data.nodes.map((node: { ci_id: string }) => node.ci_id)).toEqual(['ci-a']);
  expect(ownGraph.body.data.edges).toEqual([]);
  expect(ownGraph.body.data.nodes[0].dependents_count).toBe(0);
  expect((await request(app).get('/api/v1/impact/criticality/ci-a').set(auth('b'))).status).toBe(404);
  expect(ownImpact.status).toBe(201);
  expect((await db.rows<{ source_ci_id: string }>('SELECT source_ci_id FROM impact_analyses')).map(row => row.source_ci_id)).toEqual(['ci-a']);
  expect((await request(app).get('/api/v1/impact/history/ci-a').set(auth('b'))).status).toBe(404);
});

it('executes ITIL CI GraphQL views and mutations under authenticated two-org scope', async () => {
  const gqlApp = express();
  const { server } = await createGraphQLServer(gqlApp);
  const call = (user: string, query: string) => request(gqlApp).post('/graphql').set(auth(user)).send({ query });
  try {
    const aList = await call('a', '{ configurationItems { total items { _id } } }');
    expect(aList.body.data?.configurationItems).toMatchObject({ total: 1, items: [{ _id: 'ci-a' }] });
    const bList = await call('b', '{ configurationItems { total items { _id } } }');
    expect(bList.body.data?.configurationItems).toMatchObject({ total: 1, items: [{ _id: 'ci-b' }] });
    const ownHistory = await call('a', '{ ciHistory(id: "ci-a") { ciId } }');
    expect(ownHistory.body.data?.ciHistory).toEqual([{ ciId: 'ci-a' }]);
    const foreignHistory = await call('a', '{ ciHistory(id: "ci-b") { ciId } }');
    expect(foreignHistory.body.errors?.[0].extensions.code).toBe('NOT_FOUND');
    sqlCount = 0;
    for (const field of ['incidents', 'changes']) {
      const nestedRecords = await call('a', `{ configurationItem(id: "ci-a") { ${field} { id } } }`);
      expect(nestedRecords.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    }
    expect(sqlCount).toBe(0);
    const foreign = await call('a', 'mutation { updateLifecycleStage(id: \"ci-b\", stage: BUILD) { _id } }');
    const missing = await call('a', 'mutation { updateLifecycleStage(id: \"missing\", stage: BUILD) { _id } }');
    expect(foreign.body.errors?.[0]).toMatchObject({ message: 'CI not found', extensions: { code: 'NOT_FOUND' } });
    expect(foreign.body.errors?.[0].message).toBe(missing.body.errors?.[0].message);
    const own = await call('a', 'mutation { updateLifecycleStage(id: "ci-a", stage: BUILD) { _id } }');
    expect(own.body.data?.updateLifecycleStage._id).toBe('ci-a');
    expect(nodes.get('ci-a')).toMatchObject({ itil_lifecycle: 'BUILD' });
    expect(nodes.get('ci-b')).not.toHaveProperty('itil_lifecycle');
    graphCount = 0; sqlCount = 0;
    const noorg = await call('noorg', '{ configurationItems { total } }');
    expect(noorg.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(graphCount).toBe(0);
    expect(sqlCount).toBe(0);
  } finally {
    await server.stop();
  }
});
