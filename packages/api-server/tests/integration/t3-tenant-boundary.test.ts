// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Authenticated T3 routes against the integration suite's disposable Neo4j and PostgreSQL. */
import express from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';
import { ChangeEventProcessor, EventType, type CIDiscoveredEvent, type CIUpdatedEvent } from '@cmdb/event-processor';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const users: Record<string, { _id: string; _username: string; _role: 'admin'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 't3-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  b: { _id: 't3-b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: B },
  none: { _id: 't3-none', _username: 'nora', _role: 'admin', _enabled: true },
};
// Only the identity directory is substituted: JWT validation, graph traversal,
// and all persistence use the production clients and canonical migrations.
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { itilRoutes } from '../../src/rest/routes/itil.routes';
import { driftRoutes, impactRoutes } from '../../src/rest/routes/drift-impact.routes';
import { createGraphQLServer } from '../../src/graphql/server';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/drift', driftRoutes);
app.use('/api/v1/impact', impactRoutes);
const auth = (key: keyof typeof users) => {
  const user = users[key];
  return { authorization: `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, user._organizationId)}` };
};
const run = async (cypher: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return await session.run(cypher, params); } finally { await session.close(); }
};
let gql: { server: { stop(): Promise<void> } };

beforeAll(async () => {
  gql = await createGraphQLServer(app);
  await sql.query(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES
    ('t3-a', 'own source', 'server', 'active', $1),
    ('t3-a2', 'own dependent', 'server', 'active', $1),
    ('t3-b', 'foreign dependent', 'server', 'active', $2)`, [A, B]);
  await run(`CREATE (a:CI {id:'t3-a', name:'own source', type:'server', status:'active', organization_id:$a})
    CREATE (a2:CI {id:'t3-a2', name:'own dependent', type:'server', status:'active', organization_id:$a})
    CREATE (b:CI {id:'t3-b', name:'foreign dependent', type:'server', status:'active', organization_id:$b})
    CREATE (legacy:CI {id:'t3-legacy', name:'legacy', type:'server', status:'active'})
    CREATE (a2)-[:DEPENDS_ON]->(a)
    CREATE (b)-[:DEPENDS_ON]->(a)
    CREATE (legacy)-[:DEPENDS_ON]->(a)
    CREATE (a2)-[:USES]->(b)-[:USES]->(a)`, { a: A, b: B });
});
afterAll(async () => {
  await gql?.server.stop();
  await sql.query("DELETE FROM metrics_timeseries WHERE tags->>'ci_id' = 't3-a' AND metric_name = 't3-cpu'");
  await sql.query("DELETE FROM drift_detection_results WHERE ci_id LIKE 't3-%'");
  await sql.query("DELETE FROM baseline_snapshots WHERE ci_id LIKE 't3-%'");
  await sql.query("DELETE FROM ci_change_history WHERE ci_id = 't3-history'");
  await sql.query("DELETE FROM ci_change_statistics WHERE ci_id = 't3-history'");
  await sql.query("DELETE FROM impact_analyses WHERE source_ci_id LIKE 't3-%'");
  await sql.query("DELETE FROM ci_criticality_scores WHERE ci_id LIKE 't3-%'");
  await sql.query("DELETE FROM cmdb.dim_ci WHERE ci_id LIKE 't3-%'");
  await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't3-' DETACH DELETE ci");
});

it('keeps ITIL CI reads and mutations inside the authenticated organization', async () => {
  const list = await request(app).get('/api/v1/itil/configuration-items').set(auth('a'));
  expect(list.status).toBe(200);
  expect(list.body.pagination.total).toBe(2);
  expect(list.body.data.map((ci: { id: string }) => ci.id).sort()).toEqual(['t3-a', 't3-a2']);
  const foreign = await request(app).patch('/api/v1/itil/configuration-items/t3-b/lifecycle').set(auth('a')).send({ stage: 'BUILD' });
  const missing = await request(app).patch('/api/v1/itil/configuration-items/t3-missing/lifecycle').set(auth('a')).send({ stage: 'BUILD' });
  expect(foreign.status).toBe(404);
  expect(foreign.body.error).toBe(missing.body.error);
  const own = await request(app).patch('/api/v1/itil/configuration-items/t3-a/lifecycle').set(auth('a')).send({ stage: 'BUILD' });
  expect(own.status).toBe(200);
  const state = await run("MATCH (a:CI {id:'t3-a'}), (b:CI {id:'t3-b'}) RETURN a.itil_lifecycle AS own, b.itil_lifecycle AS foreign");
  expect(state.records[0].get('own')).toBe('BUILD');
  expect(state.records[0].get('foreign')).toBeNull();
  const graphql = await request(app).post('/graphql').set(auth('a')).send({ query: '{ configurationItems { total items { _id } } }' });
  expect(graphql.body.data?.configurationItems.total).toBe(2);
  expect(graphql.body.data.configurationItems.items.map((ci: { _id: string }) => ci._id).sort()).toEqual(['t3-a', 't3-a2']);
});

it('isolates derived drift and impact SQL plus graph traversal across own, foreign and legacy nodes', async () => {
  const denied = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 't3-b', snapshot_type: 'configuration' });
  const missing = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 't3-missing', snapshot_type: 'configuration' });
  expect(denied.status).toBe(404);
  expect(denied.body.error).toBe(missing.body.error);
  const relationships = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 't3-a', snapshot_type: 'relationships' });
  expect(relationships.status).toBe(201);
  expect(relationships.body.data.snapshot_data.incoming.map((item: { ci_id: string }) => item.ci_id)).toEqual(['t3-a2']);
  await sql.query(
    `INSERT INTO metrics_timeseries (metric_name, value, tags) VALUES
      ('t3-cpu', 10, $1::jsonb), ('t3-cpu', 999, $2::jsonb)`,
    [JSON.stringify({ ci_id: 't3-a', organization_id: A }), JSON.stringify({ ci_id: 't3-a', organization_id: B })]
  );
  const performance = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 't3-a', snapshot_type: 'performance' });
  expect(performance.status).toBe(201);
  expect(performance.body.data.snapshot_data['t3-cpu']).toMatchObject({ average: 10, max: 10 });
  const created = await request(app).post('/api/v1/drift/baseline').set(auth('a')).send({ ci_id: 't3-a', snapshot_type: 'configuration' });
  expect(created.status).toBe(201);
  const baselineId = created.body.data.id as string;
  const foreignApproval = await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('b'));
  const missingApproval = await request(app).post('/api/v1/drift/baseline/33333333-3333-4333-8333-333333333333/approve').set(auth('b'));
  expect(foreignApproval.status).toBe(404);
  expect(foreignApproval.body.error).toBe(missingApproval.body.error);
  expect((await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('a'))).status).toBe(200);
  expect((await request(app).post('/api/v1/drift/detect/t3-a').set(auth('a'))).status).toBe(200);
  const impact = await request(app).post('/api/v1/impact/predict').set(auth('a')).send({ ci_id: 't3-a', change_type: 'RESTART' });
  expect(impact.status).toBe(201);
  expect(impact.body.data.blast_radius).toBe(1);
  expect(impact.body.data.affected_cis.map((ci: { ci_id: string }) => ci.ci_id)).toEqual(['t3-a2']);
  expect(impact.body.data.critical_path).not.toContain('t3-b');
  const dependencyGraph = await request(app).get('/api/v1/impact/graph/t3-a').set(auth('a'));
  expect(dependencyGraph.status).toBe(200);
  expect(dependencyGraph.body.data.nodes.map((node: { ci_id: string }) => node.ci_id).sort()).toEqual(['t3-a', 't3-a2']);
  expect(dependencyGraph.body.data.edges).toMatchObject([{ source_id: 't3-a2', target_id: 't3-a' }]);
  for (const [table, column] of [
    ['baseline_snapshots', 'ci_id'], ['drift_detection_results', 'ci_id'],
    ['impact_analyses', 'source_ci_id'], ['ci_criticality_scores', 'ci_id'],
  ] as const) {
    const rows = await sql.query(`SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE 't3-%'`);
    expect(rows.rows.every(row => row.id === 't3-a' || row.id === 't3-a2')).toBe(true);
    expect(rows.rows.length).toBeGreaterThan(0);
  }
});

it('persists a newly created graph CI before the reporting dimension is populated', async () => {
  await run("CREATE (:CI {id:'t3-fresh', name:'fresh', ci_type:'server', status:'active', organization_id:$organizationId})", { organizationId: A });
  expect((await sql.query("SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = 't3-fresh'")).rows).toEqual([]);
  const baseline = await request(app).post('/api/v1/drift/baseline').set(auth('a'))
    .send({ ci_id: 't3-fresh', snapshot_type: 'configuration' });
  expect(baseline.status).toBe(201);
  const baselineId = baseline.body.data.id as string;
  expect((await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('b'))).status).toBe(404);
  expect((await request(app).post(`/api/v1/drift/baseline/${baselineId}/approve`).set(auth('a'))).status).toBe(200);
  expect((await request(app).post('/api/v1/drift/detect/t3-fresh').set(auth('a'))).status).toBe(200);
  const impact = await request(app).post('/api/v1/impact/predict').set(auth('a'))
    .send({ ci_id: 't3-fresh', change_type: 'RESTART' });
  expect(impact.status).toBe(201);
  expect((await request(app).get('/api/v1/impact/history/t3-fresh').set(auth('a'))).body.data)
    .toMatchObject([{ source_ci_id: 't3-fresh' }]);
  expect((await request(app).get('/api/v1/impact/history/t3-fresh').set(auth('b'))).status).toBe(404);
  for (const [table, column] of [
    ['baseline_snapshots', 'ci_id'], ['drift_detection_results', 'ci_id'],
    ['impact_analyses', 'source_ci_id'], ['ci_criticality_scores', 'ci_id'],
  ] as const) {
    expect((await sql.query(`SELECT ${column} FROM ${table} WHERE ${column} = 't3-fresh'`)).rows.length).toBeGreaterThan(0);
  }
  expect((await sql.query("SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = 't3-fresh'")).rows).toEqual([]);
});

it('returns only event-proven CI history before dimension sync and after cross-tenant ID reuse', async () => {
  await run("CREATE (:CI {id:'t3-history', name:'history', ci_type:'server', organization_id:$organizationId})", { organizationId: A });
  const processor = new ChangeEventProcessor() as unknown as {
    handleCIDiscovered(event: CIDiscoveredEvent): Promise<void>;
    handleCIUpdated(event: CIUpdatedEvent): Promise<void>;
  };
  await sql.query("INSERT INTO ci_change_history (ci_id, change_type, change_source) VALUES ('t3-history', 'LEGACY', 'unknown')");
  await processor.handleCIDiscovered({
    event_id: 't3-history-a', event_type: EventType.CI_DISCOVERED, timestamp: new Date(),
    source: 'identity-reconciliation-engine', ci_id: 't3-history', organization_id: A,
    ci_name: 'history', ci_type: 'server', source_system: 'test',
    identifiers: {}, confidence_score: 1,
  });
  const rest = (user: keyof typeof users) =>
    request(app).get('/api/v1/itil/configuration-items/t3-history/history').set(auth(user));
  const graphql = (user: keyof typeof users) =>
    request(app).post('/graphql').set(auth(user)).send({ query: '{ ciHistory(id: "t3-history") { changeType } }' });
  expect((await sql.query("SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = 't3-history'")).rows).toEqual([]);
  expect((await rest('a')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['discovered']);
  expect((await graphql('a')).body.data?.ciHistory).toEqual([{ changeType: 'discovered' }]);
  expect((await rest('b')).status).toBe(404);
  expect((await graphql('b')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');

  await sql.query("INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES ('t3-history', 'stale', 'server', 'active', $1)", [A]);
  await run("MATCH (ci:CI {id:'t3-history'}) SET ci.organization_id = $organizationId", { organizationId: B });
  await processor.handleCIUpdated({
    event_id: 't3-history-b', event_type: EventType.CI_UPDATED, timestamp: new Date(),
    source: 'identity-reconciliation-engine', ci_id: 't3-history', organization_id: B,
    ci_name: 'history', source_system: 'test', changed_fields: [],
    previous_values: {}, new_values: {},
  });
  expect((await rest('a')).status).toBe(404);
  expect((await graphql('a')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
  expect((await rest('b')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['updated']);
  expect((await graphql('b')).body.data?.ciHistory).toEqual([{ changeType: 'updated' }]);
});

it('rejects an identity without an organization before graph and SQL access', async () => {
  const poolQuery = jest.spyOn(sql.pool, 'query');
  const session = jest.spyOn(graph, 'getSession');
  const responses = [
    await request(app).get('/api/v1/itil/configuration-items').set(auth('none')),
    await request(app).post('/api/v1/drift/baseline').set(auth('none')).send({ ci_id: 't3-a', snapshot_type: 'configuration' }),
    await request(app).post('/api/v1/impact/predict').set(auth('none')).send({ ci_id: 't3-a', change_type: 'RESTART' }),
  ];
  expect(responses.map(response => response.status)).toEqual([403, 403, 403]);
  expect(poolQuery).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});
