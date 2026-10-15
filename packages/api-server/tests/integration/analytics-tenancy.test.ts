// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted authenticated analytics against the integration suite's disposable stores. */
import express from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const users = {
  a: { _id: 'analytics-a', _username: 'alice', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 'analytics-b', _username: 'bob', _role: 'admin' as const, _enabled: true, _organizationId: B },
  none: { _id: 'analytics-none', _username: 'none', _role: 'admin' as const, _enabled: true },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { analyticsRoutes } from '../../src/rest/routes/analytics.routes';
import { createGraphQLServer } from '../../src/graphql/server';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/analytics', analyticsRoutes);
const auth = (key: keyof typeof users) => {
  const user = users[key];
  return { authorization: `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, '_organizationId' in user ? user._organizationId : undefined)}` };
};
const cypher = async (query: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return await session.run(query, params); } finally { await session.close(); }
};
const rest = (user: keyof typeof users, path: string) => request(app).get(`/api/v1/analytics${path}`).set(auth(user));
const gql = (user: keyof typeof users, query: string) => request(app).post('/graphql').set(auth(user)).send({ query });
let server: { stop(): Promise<void> };

beforeAll(async () => {
  ({ server } = await createGraphQLServer(app));
  await sql.query(`INSERT INTO cmdb.dim_time (date_key, full_date, year, quarter, month, month_name, week, day_of_month, day_of_week, day_name, is_weekend)
    VALUES (20991231, '2099-12-31', 2099, 4, 12, 'December', 53, 31, 4, 'Thursday', false)
    ON CONFLICT (date_key) DO NOTHING`);
  await sql.query(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, organization_id)
    VALUES ('analytics-a', 'own', 'server', 'active', 'prod', $1),
      ('analytics-a2', 'own dependent', 'server', 'active', 'prod', $1),
      ('analytics-b', 'foreign', 'database', 'inactive', 'secret', $2),
      ('analytics-legacy', 'unproven', 'secret', 'inactive', 'secret', $2)`, [A, B]);
  await sql.query(`INSERT INTO cmdb.fact_ci_relationships (from_ci_key, to_ci_key, date_key, relationship_type, discovered_at)
    SELECT source.ci_key, target.ci_key, 20991231, 'DEPENDS_ON', now()
    FROM cmdb.dim_ci source JOIN cmdb.dim_ci target ON
      (source.ci_id = 'analytics-a' AND target.ci_id = 'analytics-a2') OR
      (source.ci_id = 'analytics-a' AND target.ci_id = 'analytics-b')`);
  await sql.query(`INSERT INTO cmdb.fact_discovery (ci_key, date_key, discovered_at, discovery_job_id, discovery_provider, discovery_method)
    SELECT ci_key, 20991231, now(), 'analytics', 'test', 'test' FROM cmdb.dim_ci WHERE ci_id LIKE 'analytics-%'`);
  await cypher(`CREATE (a:CI {id:'analytics-a', name:'own', type:'server', status:'active', environment:'prod', organization_id:$a})
    CREATE (a2:CI {id:'analytics-a2', name:'own dependent', type:'server', status:'active', environment:'prod', organization_id:$a})
    CREATE (b:CI {id:'analytics-b', name:'foreign', type:'database', status:'inactive', environment:'secret', organization_id:$b})
    CREATE (a)-[:DEPENDS_ON]->(a2) CREATE (a)-[:DEPENDS_ON]->(b)`, { a: A, b: B });
});
afterAll(async () => {
  await server?.stop();
  await sql.query("DELETE FROM cmdb.fact_discovery WHERE discovery_job_id = 'analytics'");
  await sql.query(`DELETE FROM cmdb.fact_ci_relationships WHERE from_ci_key IN
    (SELECT ci_key FROM cmdb.dim_ci WHERE ci_id LIKE 'analytics-%')`);
  await sql.query("DELETE FROM ci_change_history WHERE ci_id LIKE 'analytics-%'");
  await sql.query("DELETE FROM cmdb.dim_ci WHERE ci_id LIKE 'analytics-%'");
  await sql.query("DELETE FROM cmdb.dim_time WHERE date_key = 20991231");
  await cypher("MATCH (ci:CI) WHERE ci.id STARTS WITH 'analytics-' DETACH DELETE ci");
});

it('rejects missing organization before store reads across all analytics entries', async () => {
  for (const path of ['/dashboard', '/ci-counts', '/relationship-matrix', '/change-history?ci_id=analytics-a', '/health-metrics/analytics-a']) {
    expect((await rest('none', path)).status).toBe(403);
  }
  for (const field of ['getCICountsByType { _count }', 'getInventoryReport { _ciId }', 'getChangeHistory(ciId:"analytics-a") { _changeType }']) {
    expect((await gql('none', `{ analytics { ${field} } }`)).body.errors?.[0].extensions.code).toBe('FORBIDDEN');
  }
});

it('keeps every REST aggregate within own dimension and both relationship endpoints', async () => {
  const expectations: Array<[string, string]> = [
    ['/ci-counts', 'secret'], ['/ci-status', 'inactive'], ['/ci-environments', 'secret'],
    ['/top-connected', 'analytics-b'], ['/dependency-depth', 'analytics-b'],
    ['/relationship-matrix', 'database'], ['/dashboard', 'analytics-b'],
  ];
  for (const [path, forbidden] of expectations) {
    const response = await rest('a', path);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(forbidden);
  }
  expect((await rest('a', '/discovery-stats')).body.data.summary.total_cis).toBe('2');
  expect((await rest('a', '/discovery-timeline')).body.data[0].count).toBe('2');
  expect((await rest('a', '/top-connected')).body.data.find((row: { ci_id: string }) => row.ci_id === 'analytics-a').relationship_count).toBe('1');
  expect((await rest('a', '/relationship-counts')).body.data).toEqual([{ relationship_type: 'DEPENDS_ON', count: '1' }]);
  expect((await rest('a', '/dashboard')).body.total_cis).toBe(2);
});

it('scopes GraphQL aggregates and inventory through mounted execution', async () => {
  // The production request-admission budget caps aggregate fanout; exercise
  // each reader as a separate authenticated operation, not one oversized alias query.
  const readAnalytics = async (field: string) => {
    const response = await gql('a', `{ analytics { ${field} } }`);
    expect(response.body.errors).toBeUndefined();
    expect(JSON.stringify(response.body.data)).not.toContain('analytics-b');
    expect(JSON.stringify(response.body.data)).not.toContain('secret');
    return response.body.data.analytics;
  };
  expect((await readAnalytics('getCICountsByType { _ciType _count }')).getCICountsByType)
    .toEqual([{ _ciType: 'server', _count: 2 }]);
  expect((await readAnalytics('getCICountsByStatus { _status _count }')).getCICountsByStatus)
    .toEqual([{ _status: 'active', _count: 2 }]);
  expect((await readAnalytics('getCICountsByEnvironment { _environment _count }')).getCICountsByEnvironment)
    .toEqual([{ _environment: 'prod', _count: 2 }]);
  expect((await readAnalytics('getRelationshipCounts { _relationshipType _count }')).getRelationshipCounts)
    .toEqual([{ _relationshipType: 'DEPENDS_ON', _count: 1 }]);
  expect((await readAnalytics('getDiscoveryStats { _summary { _totalCis } }')).getDiscoveryStats._summary._totalCis).toBe(2);
  expect((await readAnalytics('getDiscoveryTimeline { _count }')).getDiscoveryTimeline[0]._count).toBe(2);
  expect((await readAnalytics('getTopConnectedCIs { _ciId _relationshipCount }')).getTopConnectedCIs
    .find((row: { _ciId: string }) => row._ciId === 'analytics-a')._relationshipCount).toBe(1);
  expect((await readAnalytics('getDependencyDepthStats { _topCis { _ciId } }')).getDependencyDepthStats._topCis
    .map((row: { _ciId: string }) => row._ciId)).toEqual(['analytics-a']);
  expect((await readAnalytics('getDashboardStats { _summary { _totalCis _totalRelationships } }')).getDashboardStats._summary)
    .toMatchObject({ _totalCis: 2, _totalRelationships: 1 });
  expect((await readAnalytics('getInventoryReport { _ciId _relationshipCount }')).getInventoryReport
    .map((row: { _ciId: string }) => row._ciId).sort()).toEqual(['analytics-a', 'analytics-a2']);
});

it('caps dense cyclic dependency work in both APIs and serves a healthy follow-up', async () => {
  await sql.query(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, organization_id)
    SELECT 'analytics-depth-' || n, 'depth', 'server', 'active', 'prod', $1
    FROM generate_series(1, 13) AS n`, [A]);
  const edges = await sql.query(`INSERT INTO cmdb.fact_ci_relationships
    (from_ci_key, to_ci_key, date_key, relationship_type, discovered_at)
    SELECT source.ci_key, target.ci_key, 20991231, 'DEPENDS_ON', now()
    FROM cmdb.dim_ci source CROSS JOIN cmdb.dim_ci target
    WHERE source.ci_id LIKE 'analytics-depth-%' AND target.ci_id LIKE 'analytics-depth-%'
      AND source.ci_key <> target.ci_key
    RETURNING relationship_key`);
  try {
    expect((await rest('a', '/dependency-depth')).status).toBe(503);
    const rejected = await gql('a', '{ analytics { getDependencyDepthStats { _topCis { _ciId } } } }');
    expect(rejected.body.errors?.[0].extensions.code).toBe('RESOURCE_LIMIT_EXCEEDED');
  } finally {
    await sql.query('DELETE FROM cmdb.fact_ci_relationships WHERE relationship_key = ANY($1)', [edges.rows.map(row => row.relationship_key)]);
    await sql.query("DELETE FROM cmdb.dim_ci WHERE ci_id LIKE 'analytics-depth-%'");
  }
  expect((await rest('a', '/dependency-depth')).status).toBe(200);
  const healthy = await gql('a', '{ analytics { getDependencyDepthStats { _topCis { _ciId _maxDepth } } } }');
  expect(healthy.body.data.analytics.getDependencyDepthStats._topCis)
    .toEqual([{ _ciId: 'analytics-a', _maxDepth: 1 }]);
});

it('retains event-proven fresh history and fences reused IDs, NULL provenance and foreign IDs', async () => {
  await cypher("CREATE (:CI {id:'analytics-history', name:'fresh', type:'server', organization_id:$org, incarnation_id:randomUUID()})", { org: A });
  const aMarker = (await graph.getCI('analytics-history', A))?._incarnation_id;
  await sql.query(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id)
    VALUES ('analytics-history', 'OWN', 'test', $1::jsonb, $2, $3),
      ('analytics-history', 'LEGACY', 'test', NULL, $2, NULL),
      ('analytics-history', 'FOREIGN', 'test', $4::jsonb, $2, $5)`,
    [JSON.stringify({ organization_id: A }), aMarker, A, JSON.stringify({ organization_id: B }), B]);
  const history = (user: keyof typeof users) => rest(user, '/change-history?ci_id=analytics-history');
  const graphql = (user: keyof typeof users) => gql(user, '{ analytics { getChangeHistory(ciId:"analytics-history") { _changeType } } }');
  expect((await sql.query("SELECT ci_id FROM cmdb.dim_ci WHERE ci_id='analytics-history'")).rows).toEqual([]);
  expect((await history('a')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['OWN']);
  expect((await graphql('a')).body.data.analytics.getChangeHistory).toEqual([{ _changeType: 'OWN' }]);
  expect((await history('b')).status).toBe((await rest('b', '/change-history?ci_id=analytics-absent')).status);
  expect((await graphql('b')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
  await cypher("MATCH (ci:CI {id:'analytics-history'}) DETACH DELETE ci");
  await cypher("CREATE (:CI {id:'analytics-history', name:'reused', type:'server', organization_id:$org, incarnation_id:randomUUID()})", { org: B });
  const bMarker = (await graph.getCI('analytics-history', B))?._incarnation_id;
  await sql.query(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id)
    VALUES ('analytics-history', 'NEW', 'test', $1::jsonb, $2, $3)`,
    [JSON.stringify({ organization_id: B }), bMarker, B]);
  expect((await history('a')).status).toBe(404);
  expect((await history('b')).body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['NEW']);
  expect((await graphql('a')).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
  expect((await graphql('b')).body.data.analytics.getChangeHistory).toEqual([{ _changeType: 'NEW' }]);
});

it('refuses health readers for every organization while source rows have no incarnation provenance', async () => {
  for (const user of ['a', 'b'] as const) {
    expect((await rest(user, '/health-metrics/analytics-a')).status).toBe(403);
    const result = await gql(user, '{ analytics { getCIHealthMetrics(ciId:"analytics-a", startTime:"2026-01-01", endTime:"2026-01-02") { _avgCpu } } }');
    expect(result.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
  }
});
