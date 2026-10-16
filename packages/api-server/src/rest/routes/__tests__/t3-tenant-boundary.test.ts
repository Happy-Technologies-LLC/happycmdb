// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Authenticated routes with real migrated PostgreSQL DDL and an instrumented graph. */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { CIAnalyticsLimitError, MAX_CI_ANALYTICS_NODES } from '@cmdb/common';

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
const A_INC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_INC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nodes = new Map<string, { id: string; name: string; organization_id: string; incarnation_id?: string; created_at?: string; itil_audit_status?: string }>();
let sqlCount = 0;
let graphCount = 0;
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const integer = (n: number) => ({ toNumber: () => n });
const graph = {
  getCI: async (id: string, org: string) => {
    graphCount++;
    const ci = nodes.get(id);
    return ci?.organization_id === org ? { ...ci, _created_at: ci.created_at, _incarnation_id: ci.incarnation_id } : null;
  },
  ensureCIIncarnation: async (id: string, org: string) => {
    graphCount++;
    const ci = nodes.get(id);
    if (!ci || ci.organization_id !== org) return null;
    ci.incarnation_id ??= randomUUID();
    return ci.incarnation_id;
  },
  listCIIncarnations: async (org: string) => {
    graphCount++;
    const matches = [...nodes.values()].filter(ci => ci.organization_id === org);
    if (matches.length > MAX_CI_ANALYTICS_NODES) throw new CIAnalyticsLimitError();
    return matches.filter(ci => ci.incarnation_id)
      .map(ci => ({ ciId: ci.id, incarnationId: ci.incarnation_id!, organizationId: ci.organization_id, ciType: 'server' }));
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
      const scopedNodes = (statement.match(/organization_id: \$organizationId/g) ?? []).length >= 2;
      if (typeof org !== 'string'
        || (!statement.includes('organization_id = $organizationId') && !scopedNodes)) {
        throw new Error('Unscoped Neo4j statement');
      }
      const visible = [...nodes.values()].filter(ci => ci.organization_id === org);
      const ungapped = visible.filter(ci =>
        !Array.isArray(params['pending']) || !(params['pending'] as string[]).includes(ci.id));
      if (statement.includes('collect(ci)') && ungapped.length > 100) {
        throw new Error('Unbounded CI materialization');
      }
      if (statement.includes('AS page')) {
        const offset = Number((params['offset'] as { toNumber?: () => number })?.toNumber?.() ?? 0);
        const end = Number((params['end'] as { toNumber?: () => number })?.toNumber?.() ?? 50);
        return { records: [record({
          total: integer(ungapped.length),
          page: ungapped.slice(offset, end).map(ci => ({ properties: { ...ci, type: 'server', status: 'active' } })),
        })] };
      }
      const id = params['id'] ?? params['ciId'] ?? params['rootCiId'];
      if (statement.includes('RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId')) {
        return { records: visible.map(row => record({ ciId: row.id, incarnationId: row.incarnation_id })) };
      }
      const ci = visible.find(row => row.id === id);
      if (/RETURN count\(ci\) (as|AS) total/.test(statement)) {
        return { records: [record({ total: integer(ungapped.length) })] };
      }
      if (statement.includes('compliantCount')) {
        return { records: [record({ compliantCount: integer(ungapped.filter(row => row.itil_audit_status === 'COMPLIANT').length), totalAudited: integer(ungapped.filter(row => row.itil_audit_status).length) })] };
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
      if (statement.includes('WITH dependent, min(parent.id) as parent_id')) {
        return { records: [] };
      }
      if (statement.includes('RETURN elementId(rel) as rel_id')) {
        return { records: [] };
      }
      if (statement.includes('RETURN node.id as id')) {
        const requested = params['nodeIds'] as string[];
        return { records: visible.filter(row => requested.includes(row.id))
          .map(row => record({ id: row.id, name: row.name, ci_type: 'server',
            dependents_count: integer(0), dependencies_count: integer(0) })) };
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
      if (statement.includes('RETURN ci') && statement.includes('LIMIT $limit')) {
        const query = params['query'];
        const matching = typeof query === 'string'
          ? ungapped.filter(row => row.name.includes(query) || row.id.includes(query))
          : ungapped;
        const sorted = [...matching].sort((left, right) => {
          if (statement.includes('ci.created_at DESC')) {
            const byDate = String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''));
            if (byDate) return byDate;
          } else {
            const byName = left.name.localeCompare(right.name);
            if (byName) return byName;
          }
          return left.id.localeCompare(right.id);
        });
        const offset = (params['offset'] as { toNumber?: () => number })?.toNumber?.() ?? 0;
        const limit = (params['limit'] as { toNumber: () => number }).toNumber();
        return { records: sorted.slice(offset, offset + limit)
          .map(row => record({ ci: { properties: { ...row, type: 'server', status: 'active' } } })) };
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
  getClient: async () => ({
    query: async (sql: string, params: unknown[] = []) =>
      sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.startsWith('SELECT set_config(')
        ? { rows: [] }
        : pg.query(sql, params),
    release: () => undefined,
  }),
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
  aa: { _id: 'aa', _username: 'alice-history', _role: 'admin', _enabled: true, _organizationId: A },
  bb: { _id: 'bb', _username: 'bob-history', _role: 'admin', _enabled: true, _organizationId: B },
  bc: { _id: 'bc', _username: 'bob-reuse', _role: 'admin', _enabled: true, _organizationId: B },
  bd: { _id: 'bd', _username: 'bob-future', _role: 'admin', _enabled: true, _organizationId: B },
  be: { _id: 'be', _username: 'bob-skew', _role: 'admin', _enabled: true, _organizationId: B },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => USERS[id] ?? null })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { itilRoutes } from '../itil.routes';
import { driftRoutes, impactRoutes } from '../drift-impact.routes';
import { analyticsRoutes } from '../analytics.routes';
import { createGraphQLServer } from '../../../graphql/server';
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/drift', driftRoutes);
app.use('/api/v1/impact', impactRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
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
  await db.exec(readFileSync(join(migrations, '025_ci_derived_incarnation.sql'), 'utf8'));
  const provenance = readFileSync(join(migrations, '028_change_history_reconciliation_org_provenance.sql'), 'utf8');
  const historyColumns = provenance.match(/ALTER TABLE ci_change_history\s+ADD COLUMN[\s\S]*?;/);
  if (!historyColumns) throw new Error('Missing S1 history org columns');
  await db.exec(historyColumns[0]);
  for (const name of ['ci_reconciliation_operations', 'ci_reconciliation_epochs']) {
    const definition = provenance.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
    if (!definition) throw new Error(`Missing S1 journal table ${name}`);
    await db.exec(definition[0]);
  }
  await db.exec(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES
    ('ci-a', 'A', 'server', 'active', '${A}'), ('ci-b', 'B', 'server', 'active', '${B}');`);
  await db.exec(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id) VALUES
    ('ci-a', 'UPDATE', 'test', '{"organization_id":"${A}"}', '${A_INC}', '${A}'),
    ('ci-b', 'UPDATE', 'test', '{"organization_id":"${B}"}', '${B_INC}', '${B}');`);
  nodes.set('ci-a', { id: 'ci-a', name: 'A', organization_id: A, incarnation_id: A_INC, created_at: '2020-01-01T00:00:00Z', itil_audit_status: 'COMPLIANT' });
  nodes.set('ci-b', { id: 'ci-b', name: 'B', organization_id: B, incarnation_id: B_INC, created_at: '2020-01-01T00:00:00Z', itil_audit_status: 'FAILED' });
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
  nodes.set('ci-fresh', { id: 'ci-fresh', name: 'Fresh', organization_id: A, created_at: '2020-01-01T00:00:00Z' });
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

it('shows only current graph-incarnation history after deletion and re-creation', async () => {
  nodes.set('ci-fresh', { id: 'ci-fresh', name: 'Former A', organization_id: A, incarnation_id: A_INC });
  await db.rows(
    `INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id) VALUES
      ('ci-fresh', 'A_EVENT', 'reconciliation', $1::jsonb, $2, '${A}'),
      ('ci-fresh', 'LEGACY', 'unknown', NULL, NULL, NULL)`,
    [JSON.stringify({ organization_id: A, event_id: 'a-1' }), A_INC]
  );
  const gqlApp = express();
  const { server } = await createGraphQLServer(gqlApp);
  const rest = (user: string) => request(app).get('/api/v1/itil/configuration-items/ci-fresh/history').set(auth(user));
  const gql = (user: string) => request(gqlApp).post('/graphql').set(auth(user))
    .send({ query: '{ ciHistory(id: "ci-fresh") { changeType } }' });
  try {
    expect((await rest('aa')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['A_EVENT']);
    expect((await gql('aa')).body.data?.ciHistory).toEqual([{ changeType: 'A_EVENT' }]);
    expect((await rest('bb')).status).toBe(404);
    nodes.delete('ci-fresh');
    nodes.set('ci-fresh', { id: 'ci-fresh', name: 'New B', organization_id: B, incarnation_id: B_INC });
    await db.rows(
      "INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id) VALUES ('ci-fresh', 'B_EVENT', 'reconciliation', $1::jsonb, $2, $3)",
      [JSON.stringify({ organization_id: B, event_id: 'b-1' }), B_INC, B]
    );
    expect((await rest('aa')).status).toBe(404);
    expect((await gql('aa')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
    expect((await rest('bb')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['B_EVENT']);
    expect((await gql('bb')).body.data?.ciHistory).toEqual([{ changeType: 'B_EVENT' }]);
  } finally {
    await server.stop();
  }
});

it('fences legacy SQL derivatives across a deleted and re-created CI ID, but reads fresh B rows', async () => {
  const id = 'ci-fresh';
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const birth = new Date(Date.now() - 60 * 60 * 1000);
  nodes.set(id, { id, name: 'Former A', organization_id: A, incarnation_id: A_INC, created_at: new Date(old.getTime() - 1000).toISOString() });
  // A legacy graph writer may reuse an ID during the REST cutover. Model rows
  // surviving an incomplete cross-store delete, not a fake atomic commit.
  await db.rows(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved)
    VALUES ('11111111-1111-4111-8111-111111111111', $1, 'configuration', '{"secret":"A"}', $2, 'a', true)`, [id, old]);
  await db.rows(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at)
    VALUES ($1, true, 99, $2)`, [id, old]);
  await db.rows(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at)
    VALUES ('22222222-2222-4222-8222-222222222222', $1, 'RESTART', 'high', $2)`, [id, old]);
  await db.rows(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at)
    VALUES ($1, '{"secret":"A"}', $2)`, [id, old]);
  await db.rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, changed_at)
    VALUES ($1, 'FORMER', 'test', $2::jsonb, $3)`, [id, JSON.stringify({ organization_id: B }), old]);

  nodes.delete(id);
  nodes.set(id, { id, name: 'New B', organization_id: B, incarnation_id: B_INC, created_at: birth.toISOString() });
  const get = (path: string) => request(app).get(path).set(auth('bc'));
  const oldApproval = await request(app).post('/api/v1/drift/baseline/11111111-1111-4111-8111-111111111111/approve').set(auth('bc'));
  const missingApproval = await request(app).post('/api/v1/drift/baseline/99999999-9999-4999-8999-999999999999/approve').set(auth('bc'));
  expect(oldApproval.status).toBe(404);
  expect(missingApproval.status).toBe(404);
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data).toBeNull();
  expect((await get(`/api/v1/drift/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data).toEqual([]);
  const criticality = await get(`/api/v1/impact/criticality/${id}`);
  expect(criticality.status).toBe(200);
  expect(JSON.stringify(criticality.body)).not.toContain('secret');

  // A legacy graph node without a marker cannot prove ownership of any row.
  nodes.get(id)!.incarnation_id = undefined;
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data).toBeNull();
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data).toEqual([]);
  nodes.get(id)!.incarnation_id = B_INC;
  await db.rows(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id)
    VALUES ('33333333-3333-4333-8333-333333333333', $1, 'configuration', '{"owner":"B"}', NOW(), 'b', true, $2)`, [id, B_INC]);
  await db.rows(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at, ci_incarnation_id)
    VALUES ($1, false, 0, NOW(), $2)`, [id, B_INC]);
  await db.rows(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id)
    VALUES ('44444444-4444-4444-8444-444444444444', $1, 'RESTART', 'low', NOW(), $2)`, [id, B_INC]);
  await db.rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, changed_at, ci_incarnation_id, organization_id)
    VALUES ($1, 'FRESH_B', 'test', $2::jsonb, NOW(), $3, $4)`, [id, JSON.stringify({ organization_id: B }), B_INC, B]);
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data.snapshot_data).toEqual({ owner: 'B' });
  expect((await get(`/api/v1/drift/history/${id}`)).body.data).toMatchObject([{ drift_score: 0 }]);
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toMatchObject([{ risk_level: 'low' }]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data)
    .toMatchObject([{ change_type: 'FRESH_B' }]);
  await db.rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id)
    VALUES ($1, 'updated', 'test', $2::jsonb, $3, $5), ($1, 'updated', 'test', $2::jsonb, $4, $5)`,
    [id, JSON.stringify({ organization_id: B }), A_INC, B_INC, B]);
  const analyticsHistory = await get(`/api/v1/analytics/change-history?ci_id=${id}`);
  expect(analyticsHistory.status).toBe(200);
  expect(analyticsHistory.body.data.map((row: { change_type: string }) => row.change_type))
    .toEqual(['updated', 'FRESH_B']);
  const timeline = await get('/api/v1/analytics/change-timeline');
  expect(timeline.status).toBe(200);
  expect(timeline.body.data).toMatchObject([{ updated: 1 }]);
  const gqlApp = express();
  const { server } = await createGraphQLServer(gqlApp);
  try {
    const frequency = await request(gqlApp).post('/graphql').set(auth('bc')).send({
      query: '{ analytics { getChangeFrequencyByType { _ciType _changeCount } } }',
    });
    expect(frequency.body.errors).toBeUndefined();
    expect(frequency.body.data?.analytics.getChangeFrequencyByType).toEqual([{ _ciType: 'server', _changeCount: 3 }]);
  } finally {
    await server.stop();
  }
});

it('never gives B future-dated A derivatives after CI ID reuse, even with A history claiming B', async () => {
  const id = 'ci-fresh';
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  nodes.set(id, { id, name: 'Former A', organization_id: A, incarnation_id: A_INC, created_at: '2020-01-01T00:00:00Z' });
  await db.rows(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id)
    VALUES ('11111111-1111-4111-8111-111111111111', $1, 'configuration', '{"secret":"A"}', $2, 'a', true, $3)`, [id, future, A_INC]);
  await db.rows(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at, ci_incarnation_id)
    VALUES ($1, true, 99, $2, $3)`, [id, future, A_INC]);
  await db.rows(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id)
    VALUES ('22222222-2222-4222-8222-222222222222', $1, 'RESTART', 'high', $2, $3)`, [id, future, A_INC]);
  await db.rows(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at, ci_incarnation_id)
    VALUES ($1, '{"secret":"A"}', $2, $3)`, [id, future, A_INC]);
  await db.rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, changed_at, ci_incarnation_id)
    VALUES ($1, 'FORMER', 'test', $2::jsonb, $3, $4)`, [id, JSON.stringify({ organization_id: B }), future, A_INC]);
  nodes.delete(id);
  nodes.set(id, { id, name: 'New B', organization_id: B, incarnation_id: B_INC, created_at: new Date().toISOString() });
  const get = (path: string) => request(app).get(path).set(auth('bd'));
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data).toBeNull();
  expect((await get(`/api/v1/drift/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data).toEqual([]);
  expect(JSON.stringify((await get(`/api/v1/impact/criticality/${id}`)).body)).not.toContain('secret');
});

it('reads freshly written B derivatives when the graph clock is ahead of PostgreSQL', async () => {
  const id = 'ci-fresh';
  nodes.set(id, { id, name: 'New B', organization_id: B, incarnation_id: B_INC,
    created_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  await db.rows(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id)
    VALUES ('33333333-3333-4333-8333-333333333333', $1, 'configuration', '{"owner":"B"}', NOW(), 'b', true, $2)`, [id, B_INC]);
  const result = await request(app).get(`/api/v1/drift/baseline/${id}`).set(auth('be'));
  expect(result.status).toBe(200);
  expect(result.body.data.snapshot_data).toEqual({ owner: 'B' });
});

it('rejects oversized tenant analytics without serializing all graph CIs into SQL, including GraphQL aliases', async () => {
  const ids = Array.from({ length: 513 }, (_, i) => `ci-bulk-${i}`);
  for (const id of ids) nodes.set(id, { id, name: id, organization_id: B, incarnation_id: B_INC });
  try {
    const beforeSQL = sqlCount;
    const timeline = await request(app).get('/api/v1/analytics/change-timeline').set(auth('bb'));
    expect(timeline.status).toBe(503);
    expect(timeline.body.error).toBe('Analytics resource limit exceeded');
    expect(sqlCount).toBe(beforeSQL);
    const gqlApp = express();
    const { server } = await createGraphQLServer(gqlApp);
    try {
      const single = await request(gqlApp).post('/graphql').set(auth('bc')).send({
        query: '{ analytics { getChangeFrequencyByType { _changeCount } } }',
      });
      expect(single.body.errors?.[0].extensions.code).toBe('SERVICE_UNAVAILABLE');
      expect(sqlCount).toBe(beforeSQL);
      const aliases = await request(gqlApp).post('/graphql').set(auth('bc')).send({
        query: '{ analytics { first:getChangeFrequencyByType { _changeCount } second:getChangeFrequencyByType { _changeCount } } }',
      });
      expect(aliases.body.errors?.[0].extensions.code).toBe('GRAPHQL_REQUEST_LIMIT_EXCEEDED');
      expect(sqlCount).toBe(beforeSQL);
    } finally {
      await server.stop();
    }
  } finally {
    for (const id of ids) nodes.delete(id);
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
    for (const field of ['incidents', 'changes']) {
      const nestedRecords = await call('a', `{ configurationItem(id: "ci-a") { ${field} { id } } }`);
      expect(nestedRecords.body.errors?.[0]).toMatchObject({
        message: 'ITIL records unavailable', extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
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

it('bounds all four mounted CI GraphQL lists for both tenants with broad limit-one matches', async () => {
  const ids: string[] = [];
  for (const [user, organization_id] of [['a', A], ['b', B]] as const) {
    for (let index = 0; index < 140; index++) {
      const id = `ci-${user}-bulk-${String(index).padStart(3, '0')}`;
      nodes.set(id, { id, name: `bulk-${String(index).padStart(3, '0')}`, organization_id,
        created_at: '2026-10-16T00:00:00Z' });
      ids.push(id);
    }
  }
  const gqlApp = express();
  const { server } = await createGraphQLServer(gqlApp);
  try {
    for (const user of ['a', 'b'] as const) {
      const fields = [
        'getCIs(limit:1, offset:1) { _id }',
        'searchCIs(query:"bulk", limit:1) { _id }',
        'configurationItems(page:2, limit:1) { total page pages items { _id } }',
        'cisDueForAudit(limit:1) { _id }',
      ];
      const bodies = await Promise.all(fields.map(field =>
        request(gqlApp).post('/graphql').set(auth(user)).send({ query: `{ ${field} }` })
          .then(response => response.body)));
      expect(bodies.map(body => body.errors?.[0]?.message ?? null)).toEqual([null, null, null, null]);
      expect(bodies[0].data.getCIs).toEqual([{ _id: `ci-${user}-bulk-001` }]);
      expect(bodies[1].data.searchCIs).toEqual([{ _id: `ci-${user}-bulk-000` }]);
      expect(bodies[2].data.configurationItems).toMatchObject({
        total: 141, page: 2, pages: 141, items: [{ _id: `ci-${user}-bulk-000` }],
      });
      expect(bodies[3].data.cisDueForAudit).toEqual([{ _id: `ci-${user}` }]);
    }
  } finally {
    await server.stop();
    for (const id of ids) nodes.delete(id);
  }
});
