// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted, authenticated routes against the shared integration Neo4j and PostgreSQL. */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const users: Record<string, { _id: string; _username: string; _role: 'operator'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A },
  b: { _id: 'b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: B },
  none: { _id: 'none', _username: 'nora', _role: 'operator', _enabled: true },
};
// Only the identity directory is substituted: authenticate(), JWT verification,
// org rehydration, Neo4j graph queries and business-service SQL are real.
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => users[id] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));
jest.mock('../../src/middleware/audit.middleware', () => ({
  auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { relationshipRoutes } from '../../src/rest/routes/relationship.routes';
import { searchRoutes } from '../../src/rest/routes/search.routes';
import { reconciliationRoutes } from '../../src/rest/routes/reconciliation.routes';
import { architectureRoutes } from '../../src/rest/routes/architecture.routes';
import { tbmRoutes } from '../../src/rest/routes/tbm.routes';
import { createGraphQLServer } from '../../src/graphql/server';
import { tbmResolvers } from '../../src/graphql/resolvers/tbm.resolvers';
import type { GraphQLContext } from '../../src/graphql/resolvers';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/reconciliation', reconciliationRoutes);
app.use('/api/v1/architecture', architectureRoutes);
app.use('/api/v1/tbm', tbmRoutes);
let gql: { server: { stop(): Promise<void> } };
const bearer = (id: keyof typeof users) => `Bearer ${jwt.generateAccessToken(id, users[id]._username, 'operator', A)}`;
const auth = (id: keyof typeof users) => ({ authorization: bearer(id) });
const run = async (cypher: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return await session.run(cypher, params); } finally { await session.close(); }
};
const search = (id: keyof typeof users, path: string, body: Record<string, unknown>) =>
  request(app).post(`/api/v1/search/${path}`).set(auth(id)).send(body);
const match = (id: keyof typeof users, serial: string) =>
  request(app).post('/api/v1/reconciliation/match').set(auth(id)).send({ identifiers: { serial_number: serial } });
const findMatches = (id: keyof typeof users, serial: string) => request(app).post('/graphql').set(auth(id)).send({
  query: `{ _reconciliation { findMatches(_identifiers: { _serialNumber: "${serial}" }) { _ciId _confidence _matchStrategy } } }`,
});

beforeAll(async () => {
  gql = await createGraphQLServer(app);
  await sql.query(`INSERT INTO dim_business_services
    (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id)
    VALUES ('t2-a', 'A', 'application', 'application', 'high', 'active', $1),
           ('t2-b', 'B', 'application', 'application', 'high', 'active', $2)`, [A, B]);
  await run(`CREATE (a:CI {id:'t2-a', name:'tenant hit', type:'server', status:'active', serial_number:'shared', organization_id:$a, created_at:'2026'})
    CREATE (a2:CI {id:'t2-a2', name:'tenant second', type:'server', status:'active', organization_id:$a, created_at:'2026'})
    CREATE (b:CI {id:'t2-b', name:'tenant foreign', type:'server', status:'active', serial_number:'foreign-only', organization_id:$b, created_at:'2026'})
    CREATE (n:CI {id:'t2-null', name:'tenant legacy', type:'server', serial_number:'null-only', created_at:'2026'})
    CREATE (a)-[:DEPENDS_ON]->(a2) CREATE (a)-[:DEPENDS_ON]->(b) CREATE (a)-[:USES]->(n)
    CREATE (bs:BusinessService {id:'t2-a', name:'A', organization_id:$a})
    CREATE (bsB:BusinessService {id:'t2-b', name:'B', organization_id:$b})
    CREATE (cap:BusinessCapability {id:'t2-cap', name:'cap'})
    CREATE (bs)-[:SUPPORTED_BY]->(app:ApplicationService {id:'t2-app'})
    CREATE (cap)-[:REALIZES]->(bs) CREATE (cap)-[:REALIZES]->(bsB)
    CREATE (app)-[:DEPENDS_ON]->(c1:CI {id:'t2-cost1', organization_id:$a, tbm_monthly_cost:100, tbm_resource_tower:'compute'})
    CREATE (app)-[:DEPENDS_ON]->(c2:CI {id:'t2-cost2', organization_id:$a, tbm_monthly_cost:100, tbm_resource_tower:'compute'})
    CREATE (app)-[:DEPENDS_ON]->(fb:CI {id:'t2-foreign-cost', organization_id:$b, tbm_monthly_cost:999, tbm_resource_tower:'data'})
    CREATE (app)-[:DEPENDS_ON]->(nl:CI {id:'t2-null-cost', tbm_monthly_cost:999, tbm_resource_tower:'data'})
    CREATE (app)-[:RUNS_ON]->(mid:CI {id:'t2-mid', organization_id:$a})
    CREATE (mid)-[:RUNS_ON]->(c1)
    CREATE (app)-[:RUNS_ON]->(foreignMid:CI {id:'t2-foreign-mid', organization_id:$b})
    CREATE (foreignMid)-[:RUNS_ON]->(:CI {id:'t2-through-foreign', organization_id:$a, tbm_monthly_cost:700})
    CREATE (app)-[:RUNS_ON]->(nullMid:CI {id:'t2-null-mid'})
    CREATE (nullMid)-[:RUNS_ON]->(:CI {id:'t2-through-null', organization_id:$a, tbm_monthly_cost:700})`, { a: A, b: B });
});
afterAll(async () => {
  await gql?.server.stop();
  await run('MATCH (n) WHERE n.id STARTS WITH "t2-" DETACH DELETE n');
  await sql.query("DELETE FROM dim_business_services WHERE service_id IN ('t2-a', 't2-b')");
});

it('relationships fence both endpoints for lists, type counts, create and atomic delete', async () => {
  for (const [path, type] of [
    ['/api/v1/relationships', null],
    ['/api/v1/relationships/type/DEPENDS_ON', 'DEPENDS_ON'],
  ] as const) {
    const expected = await run(`
      MATCH (from:CI)-[r]->(to:CI)
      WHERE from.organization_id = $organizationId AND to.organization_id = $organizationId
        AND ($type IS NULL OR type(r) = $type)
      RETURN count(r) AS total
    `, { organizationId: A, type });
    const response = await request(app).get(path).set(auth('a'));
    expect(response.status).toBe(200);
    expect(response.body.pagination.total).toBe(expected.records[0].get('total').toNumber());
    expect(response.body.data.some((edge: { to_id: string }) => ['t2-b', 't2-null'].includes(edge.to_id))).toBe(false);
  }
  for (const filter of ['from_id=t2-a', 'ci_id=t2-a']) {
    const response = await request(app).get(`/api/v1/relationships?${filter}`).set(auth('a'));
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.data.map((edge: { to_id: string }) => edge.to_id)).toEqual(['t2-a2']);
  }
  const filtered = await request(app).get('/api/v1/relationships?from_id=t2-b').set(auth('a'));
  expect(filtered.body.pagination.total).toBe(0);
  const missing = await request(app).post('/api/v1/relationships').set(auth('a')).send({ from_id: 't2-a', to_id: 't2-missing', type: 'DEPENDS_ON' });
  for (const id of ['t2-b', 't2-null']) {
    const denied = await request(app).post('/api/v1/relationships').set(auth('a')).send({ from_id: 't2-a', to_id: id, type: 'DEPENDS_ON' });
    expect(denied.body).toEqual(missing.body);
  }
  for (const id of ['t2-b', 't2-null', 't2-missing']) {
    const denied = await request(app).delete(`/api/v1/relationships?from_id=t2-a&to_id=${id}&type=DEPENDS_ON`).set(auth('a'));
    expect(denied.status).toBe(404);
  }
  const edges = await run("MATCH (:CI {id:'t2-a'})-[r]->(n:CI) RETURN collect(n.id) AS ids");
  expect(edges.records[0].get('ids').sort()).toEqual(['t2-a2', 't2-b', 't2-null']);
  const created = await request(app).post('/api/v1/relationships').set(auth('a'))
    .send({ from_id: 't2-a2', to_id: 't2-a', type: 'HOSTS' });
  expect(created.status).toBe(201);
  expect((await request(app).delete('/api/v1/relationships?from_id=t2-a2&to_id=t2-a&type=HOSTS').set(auth('a'))).status).toBe(200);
});

it('all search paths filter before count, ordering and LIMIT, including NULL legacy nodes', async () => {
  const advanced = await search('a', 'advanced', { query: 'tenant', limit: 1 });
  expect(advanced.body.pagination.total).toBe(2);
  expect(['t2-a', 't2-a2']).toContain(advanced.body.data[0].id);
  const otherTenant = await search('b', 'advanced', { query: 'tenant' });
  expect(otherTenant.body.pagination.total).toBe(1);
  expect(otherTenant.body.data.map((ci: { id: string }) => ci.id)).toEqual(['t2-b']);
  const fulltext = await search('a', 'fulltext', { query: 'tenant', limit: 2 });
  expect(fulltext.body.data.map((hit: { ci: { id: string } }) => hit.ci.id).sort()).toEqual(['t2-a', 't2-a2']);
  const related = await search('a', 'relationships', { ci_type: 'server', relationship_type: 'DEPENDS_ON', related_ci_type: 'server' });
  expect(related.body.data.map((ci: { id: string }) => ci.id)).toEqual(['t2-a']);
  const orphans = await request(app).get('/api/v1/search/orphaned').set(auth('a'));
  expect(orphans.body.data.map((ci: { id: string }) => ci.id).sort()).toEqual([
    't2-cost2', 't2-through-foreign', 't2-through-null',
  ]);
  expect(orphans.body.pagination.total).toBe(3);
});

it('REST and production GraphQL findMatches give foreign-only and NULL-only the same no-match response', async () => {
  for (const serial of ['foreign-only', 'null-only', 'missing-only']) {
    const rest = await match('a', serial);
    const graphResult = await findMatches('a', serial);
    expect(rest.body.data).toBeNull();
    expect(graphResult.body.errors).toBeUndefined();
    expect(graphResult.body.data._reconciliation.findMatches).toBeNull();
  }
  expect((await match('a', 'shared')).body.data).toMatchObject({ ci_id: 't2-a', confidence: 95, match_strategy: 'serial_number' });
  expect((await findMatches('a', 'shared')).body.data._reconciliation.findMatches._ciId).toBe('t2-a');
  expect((await match('b', 'foreign-only')).body.data.ci_id).toBe('t2-b');
});

it('architecture denies any foreign, missing or NULL input before writing an analysis', async () => {
  const before = await sql.query('SELECT count(*)::integer AS total FROM architecture_analyses');
  for (const id of ['t2-b', 't2-null', 't2-missing']) {
    const result = await request(app).post('/api/v1/architecture/analyze').set(auth('a')).send({ ci_ids: ['t2-a', id] });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ success: false, error: 'CI not found' });
  }
  const after = await sql.query('SELECT count(*)::integer AS total FROM architecture_analyses');
  expect(after.rows[0].total).toBe(before.rows[0].total);
});

it('architecture POST and business-service GET ignore cross-org cycles, database apps, fan-out and stale mappings', async () => {
  const ciIds = ['t2-arch-db', 't2-arch-cycle', 't2-arch-owned-cycle', 't2-arch-fan'];
  const post = () => request(app).post('/api/v1/architecture/analyze').set(auth('a')).send({ ci_ids: ciIds });
  const service = () => request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(auth('a'));
  const visible = (analysis: any) => ({
    health: analysis.health_metrics,
    summary: analysis.dependency_graph_summary,
    issues: analysis.issues.map((issue: any) => ({
      type: issue.issue_type,
      description: issue.description,
      affected: issue.affected_cis,
      metrics: issue.metrics,
    })).sort((left: any, right: any) => left.type.localeCompare(right.type)),
  });
  try {
    await run(`
      CREATE (db:CI {id:'t2-arch-db', name:'architecture database', ci_type:'database', organization_id:$a})
      CREATE (app1:CI {id:'t2-arch-app1', ci_type:'application', organization_id:$a})
      CREATE (app2:CI {id:'t2-arch-app2', ci_type:'application', organization_id:$a})
      CREATE (app3:CI {id:'t2-arch-app3', ci_type:'application', organization_id:$a})
      CREATE (app1)-[:USES]->(db) CREATE (app2)-[:USES]->(db) CREATE (app3)-[:USES]->(db)
      CREATE (cycle:CI {id:'t2-arch-cycle', organization_id:$a})
      CREATE (ownCycle:CI {id:'t2-arch-owned-cycle', organization_id:$a})
      CREATE (ownNext:CI {id:'t2-arch-owned-next', organization_id:$a})
      CREATE (ownCycle)-[:DEPENDS_ON]->(ownNext) CREATE (ownNext)-[:DEPENDS_ON]->(ownCycle)
      CREATE (fan:CI {id:'t2-arch-fan', organization_id:$a})
      CREATE (leaf:CI {id:'t2-arch-owned-leaf', organization_id:$a})
      CREATE (fan)-[:DEPENDS_ON]->(leaf)
    `, { a: A });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       SELECT ci_id, 't2-a', 'supports' FROM unnest($1::text[]) AS ci_id`,
      [ciIds]
    );
    const beforePost = await post();
    const beforeGet = await service();
    for (const result of [beforePost, beforeGet]) {
      expect(result.status).toBe(200);
      expect(result.body.analysis.issues.some((issue: { issue_type: string }) =>
        issue.issue_type === 'circular_dependency')).toBe(true);
      const shared = result.body.analysis.issues.find((issue: { issue_type: string }) =>
        issue.issue_type === 'shared_database');
      expect(shared).toMatchObject({
        affected_cis: ['t2-arch-db', 't2-arch-app1', 't2-arch-app2', 't2-arch-app3'],
        metrics: { shared_by_count: 3 },
      });
    }
    await run(`
      MATCH (db:CI {id:'t2-arch-db'}), (cycle:CI {id:'t2-arch-cycle'}), (fan:CI {id:'t2-arch-fan'})
      CREATE (foreignApp:CI {id:'t2-arch-foreign-app', ci_type:'application', organization_id:$b})
      CREATE (foreignCycle:CI {id:'t2-arch-foreign-cycle', organization_id:$b})
      CREATE (foreignLeaf:CI {id:'t2-arch-foreign-leaf', organization_id:$b})
      CREATE (foreignApp)-[:USES]->(db)
      CREATE (cycle)-[:DEPENDS_ON]->(foreignCycle)
      CREATE (foreignCycle)-[:DEPENDS_ON]->(cycle)
      CREATE (fan)-[:DEPENDS_ON]->(foreignLeaf)
    `, { b: B });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       VALUES ('t2-arch-foreign-app', 't2-a', 'supports')`
    );
    for (const [route, baseline] of [[post, beforePost], [service, beforeGet]] as const) {
      const result = await route();
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body.analysis)).not.toContain('t2-arch-foreign');
      expect(visible(result.body.analysis)).toEqual(visible(baseline.body.analysis));
    }
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-arch-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-arch-' DETACH DELETE ci");
  }
});

it('TBM sums two same-cost CIs once each despite multipath, excluding foreign and NULL costs', async () => {
  for (const path of ['by-service/t2-a', 'by-capability/t2-cap']) {
    const result = await request(app).get(`/api/v1/tbm/costs/${path}`).set(auth('a'));
    expect(result.status).toBe(200);
    expect(result.body.data.totalMonthlyCost).toBe(200);
    expect(result.body.data.ciCount).toBe(2);
  }
  const foreign = await request(app).get('/api/v1/tbm/costs/by-service/t2-b').set(auth('a'));
  const missing = await request(app).get('/api/v1/tbm/costs/by-service/t2-missing').set(auth('a'));
  expect(foreign.body).toEqual(missing.body);
  // This source resolver is intentionally not mounted in production.
  const context: GraphQLContext = {
    _neo4jClient: graph,
    _loaders: { _ciLoader: null, _relationshipLoader: null, _dependentLoader: null },
    user: { _userId: 'a', _username: 'alice', _role: 'operator', _type: 'access', _organizationId: A },
  };
  const service = await tbmResolvers.Query.costsByBusinessService(null, { id: 't2-a' }, context);
  const capability = await tbmResolvers.Query.costsByCapability(null, { id: 't2-cap' }, context);
  expect(service).toMatchObject({ totalMonthlyCost: 200, ciCount: 2, towers: ['compute'] });
  expect(capability).toMatchObject({
    totalMonthlyCost: 200, ciCount: 2,
    costByTower: [{ tower: 'compute', totalCost: 200, ciCount: 2 }],
  });
});

it('org-less authenticated callers fail before any graph or SQL work on all T2 paths', async () => {
  const sessionSpy = jest.spyOn(graph, 'getSession');
  const sqlSpy = jest.spyOn(sql, 'query');
  for (const response of [
    await request(app).get('/api/v1/relationships').set(auth('none')),
    await request(app).get('/api/v1/relationships/type/DEPENDS_ON').set(auth('none')),
    await request(app).post('/api/v1/relationships').set(auth('none'))
      .send({ from_id: 't2-a', to_id: 't2-a2', type: 'DEPENDS_ON' }),
    await request(app).delete('/api/v1/relationships?from_id=t2-a&to_id=t2-a2&type=DEPENDS_ON').set(auth('none')),
    await search('none', 'advanced', { query: 'tenant' }),
    await search('none', 'relationships', { ci_type: 'server', relationship_type: 'DEPENDS_ON', related_ci_type: 'server' }),
    await request(app).get('/api/v1/search/orphaned').set(auth('none')),
    await search('none', 'fulltext', { query: 'tenant' }),
    await match('none', 'shared'),
    await request(app).post('/api/v1/architecture/analyze').set(auth('none')).send({ ci_ids: ['t2-a'] }),
    await request(app).get('/api/v1/tbm/costs/by-service/t2-a').set(auth('none')),
    await request(app).get('/api/v1/tbm/costs/by-capability/t2-cap').set(auth('none')),
  ]) expect(response.status).toBe(403);
  const graphql = await findMatches('none', 'shared');
  expect(graphql.body.errors[0].extensions.code).toBe('FORBIDDEN');
  expect(sessionSpy).not.toHaveBeenCalled();
  expect(sqlSpy).not.toHaveBeenCalled();
});
