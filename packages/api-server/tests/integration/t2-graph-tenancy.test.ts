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
import { dashboardRoutes } from '../../src/rest/routes/dashboard.routes';
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
app.use('/api/v1/dashboards', dashboardRoutes);
let gql: { server: { stop(): Promise<void> } };
const bearer = (id: keyof typeof users) => `Bearer ${jwt.generateAccessToken(id, users[id]._username, 'operator', A)}`;
const auth = (id: keyof typeof users) => ({ authorization: bearer(id) });
// Architecture admission is principal-scoped; tenant graph tests use distinct
// authorized principals so a long suite does not exhaust one user's window.
let architecturePrincipal = 0;
const architectureAuth = () => {
  const id = `architecture-${++architecturePrincipal}`;
  users[id] = { _id: id, _username: id, _role: 'operator', _enabled: true, _organizationId: A };
  return auth(id);
};
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
    CREATE (bs)-[:SUPPORTED_BY]->(app:ApplicationService {id:'t2-app', organization_id:$a})
    CREATE (cap)-[:REALIZES]->(bs) CREATE (cap)-[:REALIZES]->(bsB)
    CREATE (app)-[:DEPENDS_ON]->(c1:CI {id:'t2-cost1', organization_id:$a, tbm_monthly_cost:100, tbm_resource_tower:'compute'})
    CREATE (app)-[:DEPENDS_ON]->(c2:CI {id:'t2-cost2', organization_id:$a, tbm_monthly_cost:100, tbm_resource_tower:'compute'})
    CREATE (app)-[:DEPENDS_ON]->(fb:CI {id:'t2-foreign-cost', organization_id:$b, tbm_monthly_cost:999, tbm_resource_tower:'data'})
    CREATE (app)-[:DEPENDS_ON]->(nl:CI {id:'t2-null-cost', tbm_monthly_cost:999, tbm_resource_tower:'data'})
    CREATE (app)-[:RUNS_ON]->(mid:CI {id:'t2-mid', organization_id:$a})
    CREATE (mid)-[:RUNS_ON]->(c1)
    CREATE (app)-[:RUNS_ON]->(foreignMid:CI {id:'t2-foreign-mid', organization_id:$b})
    CREATE (foreignMid)-[:RUNS_ON]->(:CI {id:'t2-through-foreign', organization_id:$a, tbm_monthly_cost:700, created_at:'2026'})
    CREATE (app)-[:RUNS_ON]->(nullMid:CI {id:'t2-null-mid'})
    CREATE (nullMid)-[:RUNS_ON]->(:CI {id:'t2-through-null', organization_id:$a, tbm_monthly_cost:700, created_at:'2026'})`, { a: A, b: B });
  await run(`MATCH (bs:BusinessService {id:'t2-a'}), (foreign:BusinessService {id:'t2-b'})
    CREATE (own:CI {id:'t2-own-support', name:'owned support', organization_id:$a})
    CREATE (own)-[:SUPPORTS]->(bs)
    CREATE (foreignLink:CI {id:'t2-foreign-link', name:'foreign link', organization_id:$a, created_at:'2099-01-02'})
    CREATE (foreignLink)-[:SUPPORTS]->(foreign)
    CREATE (legacy:BusinessService {id:'t2-legacy-service'})
    CREATE (nullLink:CI {id:'t2-null-link', name:'null link', organization_id:$a, created_at:'2099-01-01'})
    CREATE (nullLink)-[:SUPPORTS]->(legacy)`, { a: A });
});
afterAll(async () => {
  await gql?.server.stop();
  await run('MATCH (n) WHERE n.id STARTS WITH "t2-" DETACH DELETE n');
  await sql.query("DELETE FROM dim_business_services WHERE service_id IN ('t2-a', 't2-b')");
});

it('bounds mounted dashboard parallel-edge and fan-out graphs before path expansion', async () => {
  const small = await request(app).get('/api/v1/dashboards/business-service/t2-a').set(auth('a'));
  expect(small.status).toBe(200);
  expect(small.body.data.serviceDependencies.nodes.map((ci: { id: string }) => ci.id).sort())
    .toEqual(['t2-a', 't2-a2']);
  expect(small.body.data.serviceDependencies.edges.map((edge: { from: string; to: string }) =>
    [edge.from, edge.to])).toEqual([['t2-a', 't2-a2']]);

  await run(`MATCH (root:CI {id:'t2-a'}), (neighbor:CI {id:'t2-a2'})
    UNWIND range(1,401) AS ordinal CREATE (root)-[:DASHBOARD_DENSE {ordinal:ordinal}]->(neighbor)`);
  await run(`MATCH (root:CI {id:'t2-a'})
    UNWIND range(1,10) AS leafNumber
    CREATE (leaf:CI {id:'t2-dashboard-leaf-'+toString(leafNumber), name:'leaf',
      type:'server', organization_id:$organizationId})
    WITH root, leaf UNWIND range(1,50) AS ordinal
    CREATE (root)-[:DASHBOARD_DENSE {ordinal:ordinal}]->(leaf)`, { organizationId: A });
  let statements = 0;
  let adjacencyRows = 0;
  const original = graph.getSession.bind(graph);
  const spy = jest.spyOn(graph, 'getSession').mockImplementation(() => {
    const session = original();
    const originalRun = session.run.bind(session);
    session.run = (async (...args: Parameters<typeof originalRun>) => {
      statements++;
      const result = await originalRun(...args);
      if (String(args[0]).includes('LIMIT $rowLimit')) adjacencyRows += result.records.length;
      return result;
    }) as typeof session.run;
    return session;
  });
  const started = Date.now();
  try {
    const dense = await request(app).get('/api/v1/dashboards/business-service/t2-a').set(auth('a'));
    expect(dense.status).toBe(503);
    expect(dense.body).toEqual({ success: false, error: 'CI traversal resource limit exceeded' });
    expect(statements).toBeLessThanOrEqual(4);
    expect(adjacencyRows).toBeLessThanOrEqual(401);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally {
    spy.mockRestore();
    await run("MATCH (:CI {id:'t2-a'})-[r:DASHBOARD_DENSE]->() DELETE r");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-dashboard-leaf-' DETACH DELETE ci");
  }
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
  expect(orphans.status).toBe(200);
  expect(orphans.body.data.map((ci: { id: string }) => ci.id).sort()).toEqual([
    't2-foreign-link', 't2-null-link', 't2-through-foreign', 't2-through-null',
  ]);
  expect(orphans.body.pagination.total).toBe(4);
  for (const [offset, id] of [[0, 't2-foreign-link'], [1, 't2-null-link']] as const) {
    const page = await request(app).get(`/api/v1/search/orphaned?limit=1&offset=${offset}`).set(auth('a'));
    expect(page.status).toBe(200);
    expect(page.body.pagination).toMatchObject({ total: 4, count: 1, offset, limit: 1 });
    expect(page.body.data.map((ci: { id: string }) => ci.id)).toEqual([id]);
  }
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

it('architecture rejects over-cap POST roots before any ownership lookup or graph work', async () => {
  const lookup = jest.spyOn(graph, 'getCI');
  const session = jest.spyOn(graph, 'getSession');
  try {
    const response = await request(app).post('/api/v1/architecture/analyze').set(architectureAuth())
      .send({ ci_ids: Array.from({ length: 21 }, (_, index) => `t2-excess-${index}`) });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ success: false, error: 'Too many CI IDs (maximum 20)' });
    expect(lookup).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
    session.mockRestore();
  }
});

it('architecture bounds dense owned cycles on both entry points without exposing foreign nodes', async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `t2-load-${index}`);
  try {
    await run(`UNWIND $ids AS id CREATE (:CI {id:id, name:id, organization_id:$a})`, { ids, a: A });
    await run(`MATCH (a:CI), (b:CI)
      WHERE a.id IN $ids AND b.id IN $ids AND a.id <> b.id
      CREATE (a)-[:DEPENDS_ON]->(b)`, { ids });
    await run(`MATCH (a:CI {id:$id}), (b:CI {id:'t2-b'})
      CREATE (a)-[:DEPENDS_ON]->(b)`, { id: ids[0] });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       SELECT id, 't2-a', 'supports' FROM unnest($1::text[]) AS id`, [ids]
    );
    for (const response of [
      await request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: [ids[0]] }),
      await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth()),
    ]) {
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ success: false, error: 'Architecture analysis resource limit exceeded' });
      expect(JSON.stringify(response.body)).not.toContain('t2-b');
    }
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-load-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-load-' DETACH DELETE ci");
  }
});

it.each([6, 10])('architecture retains owned %i-edge cycle detection on POST and GET', async (length) => {
  const ids = Array.from({ length }, (_, index) => `t2-ring-${index}`);
  try {
    await run(`UNWIND $ids AS id CREATE (:CI {id:id, name:id, organization_id:$a})`, { ids, a: A });
    await run(`UNWIND range(0, size($ids)-1) AS index
      MATCH (from:CI {id:$ids[index]}), (to:CI {id:$ids[(index+1) % size($ids)]})
      CREATE (from)-[:DEPENDS_ON]->(to)`, { ids });
    await run(`MATCH (root:CI {id:$id}), (foreign:CI {id:'t2-b'})
      CREATE (root)-[:USES]->(foreign)-[:USES]->(root)`, { id: ids[0] });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       VALUES ($1, 't2-a', 'supports')`, [ids[0]]
    );
    for (const response of [
      await request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: [ids[0]] }),
      await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth()),
    ]) {
      expect(response.status).toBe(200);
      expect(response.body.analysis.dependency_graph_summary.circular_dependencies).toBe(1);
      const cycle = response.body.analysis.issues.find((issue: { issue_type: string }) =>
        issue.issue_type === 'circular_dependency');
      expect(cycle.affected_cis).toEqual([...ids, ids[0]]);
      expect(cycle.metrics.chain_length).toBe(length + 1);
      expect(JSON.stringify(response.body.analysis)).not.toContain('t2-b');
    }
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-ring-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-ring-' DETACH DELETE ci");
  }
});

it('architecture counts each owned neighbour once when two relationship types link every CI in a chain', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `t2-dual-${index}`);
  try {
    await run(`UNWIND $ids AS id CREATE (:CI {id:id, name:id, organization_id:$a})`, { ids, a: A });
    await run(`UNWIND range(0, size($ids)-2) AS index
      MATCH (from:CI {id:$ids[index]}), (to:CI {id:$ids[index+1]})
      CREATE (from)-[:DEPENDS_ON]->(to) CREATE (from)-[:USES]->(to)`, { ids });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       VALUES ($1, 't2-a', 'supports')`, [ids[0]]
    );
    for (const response of [
      await request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: [ids[0]] }),
      await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth()),
    ]) {
      expect(response.status).toBe(200);
      expect(response.body.analysis.dependency_graph_summary.circular_dependencies).toBe(0);
      expect(response.body.analysis.dependency_graph_summary.max_depth).toBe(9);
    }
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-dual-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-dual-' DETACH DELETE ci");
  }
});

it('architecture passes a driver timeout on every statement and stops an 11-edge ring at ten hops', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => `t2-depth-${index}`);
  const incoming = Array.from({ length: 3 }, (_, index) => `t2-depth-in-${index}`);
  try {
    await run(`UNWIND $ids AS id CREATE (:CI {id:id, name:id, organization_id:$a})`, { ids, a: A });
    await run(`UNWIND range(0, size($ids)-1) AS index
      MATCH (from:CI {id:$ids[index]}), (to:CI {id:$ids[(index+1) % size($ids)]})
      CREATE (from)-[:DEPENDS_ON]->(to)`, { ids });
    await run(`UNWIND $incoming AS id
      MATCH (root:CI {id:$root}) CREATE (:CI {id:id, name:id, organization_id:$a})-[:DEPENDS_ON]->(root)`,
      { incoming, root: ids[0], a: A });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       VALUES ($1, 't2-a', 'supports')`, [ids[0]]
    );

    const originalSession = graph.getSession.bind(graph);
    const statements: Array<{ cypher: string; timeout: number | undefined }> = [];
    const getSession = jest.spyOn(graph, 'getSession').mockImplementation(() => {
      const session = originalSession();
      const originalRun = session.run.bind(session);
      jest.spyOn(session, 'run').mockImplementation((cypher, parameters, config) => {
        statements.push({ cypher: cypher as string, timeout: (config as { timeout?: number } | undefined)?.timeout });
        return originalRun(cypher, parameters, config);
      });
      return session;
    });
    try {
      for (const method of ['POST', 'GET']) {
        const response = method === 'POST'
          ? await request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: [ids[0]] })
          : await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth());
        expect(response.status).toBe(200);
        expect(response.body.analysis.dependency_graph_summary.circular_dependencies).toBe(0);
        // POST ownership preflight uses the same client but is not an engine statement.
        const engineStatements = statements.filter(({ cypher }) =>
          !cypher.includes('MATCH (ci:CI {id: $id}) WHERE ci.organization_id'));
        expect(engineStatements).toHaveLength(method === 'POST' ? 16 : 17);
        const walks = engineStatements.filter(({ cypher }) => cypher.includes('UNWIND $frontier AS path'));
        expect(walks).toHaveLength(10);
        expect(walks.every(({ cypher }) => !/\*\d+\.\.\d+/.test(cypher))).toBe(true);
        const sites = [
          'RETURN DISTINCT ci.id AS id', 'as fan_in', 'as fan_out', 'ci.ci_type as ci_type',
          'UNWIND $frontier AS path', 'as redundancy_count', 'as db_id', 'as app_id',
        ];
        expect(engineStatements.every(({ cypher, timeout }) =>
          timeout !== undefined && timeout > 0 && timeout <= 5000 && sites.some((site) => cypher.includes(site)))).toBe(true);
        if (method === 'GET') {
          expect(sites.every((site) => engineStatements.some(({ cypher }) => cypher.includes(site)))).toBe(true);
        }
        statements.length = 0;
      }
    } finally {
      getSession.mockRestore();
    }
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-depth-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-depth-' DETACH DELETE ci");
  }
});

it('architecture GET caps distinct mapped CIs rather than repeated mapping types', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => `t2-repeat-${index}`);
  try {
    await run(`UNWIND $ids AS id CREATE (:CI {id:id, name:id, organization_id:$a})`, { ids, a: A });
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       SELECT id, 't2-a', mapping_type
       FROM unnest($1::text[]) AS id CROSS JOIN (VALUES ('hosts'), ('supports')) AS types(mapping_type)`, [ids]
    );
    const response = await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth());
    expect(response.status).toBe(200);
    expect(response.body.analysis.dependency_graph_summary.total_cis).toBe(11);
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-repeat-%'");
    await run("MATCH (ci:CI) WHERE ci.id STARTS WITH 't2-repeat-' DETACH DELETE ci");
  }
});

it('architecture rejects over-cap GET mappings before graph work and preserves foreign-service 404', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `t2-mapped-${index}`);
  try {
    await sql.query(
      `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
       SELECT id, 't2-a', 'supports' FROM unnest($1::text[]) AS id`, [ids]
    );
    const session = jest.spyOn(graph, 'getSession');
    try {
      const response = await request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth());
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ success: false, error: 'Architecture analysis resource limit exceeded' });
      expect(session).not.toHaveBeenCalled();
    } finally {
      session.mockRestore();
    }
    const foreign = await request(app).get('/api/v1/architecture/business-services/t2-b/analysis').set(architectureAuth());
    const missing = await request(app).get('/api/v1/architecture/business-services/t2-missing/analysis').set(architectureAuth());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  } finally {
    await sql.query("DELETE FROM ci_business_service_mappings WHERE service_id = 't2-a' AND ci_id LIKE 't2-mapped-%'");
  }
});

it('architecture denies any foreign, missing or NULL input before writing an analysis', async () => {
  const before = await sql.query('SELECT count(*)::integer AS total FROM architecture_analyses');
  for (const id of ['t2-b', 't2-null', 't2-missing']) {
    const result = await request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: ['t2-a', id] });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ success: false, error: 'CI not found' });
  }
  const after = await sql.query('SELECT count(*)::integer AS total FROM architecture_analyses');
  expect(after.rows[0].total).toBe(before.rows[0].total);
});

it('architecture POST and business-service GET ignore cross-org cycles, database apps, fan-out and stale mappings', async () => {
  const ciIds = ['t2-arch-db', 't2-arch-cycle', 't2-arch-owned-cycle', 't2-arch-fan'];
  const post = () => request(app).post('/api/v1/architecture/analyze').set(architectureAuth()).send({ ci_ids: ciIds });
  const service = () => request(app).get('/api/v1/architecture/business-services/t2-a/analysis').set(architectureAuth());
  const visible = (analysis: any) => ({
    health: analysis.health_metrics,
    summary: analysis.dependency_graph_summary,
    issues: analysis.issues.map((issue: any) => ({
      type: issue.issue_type,
      description: issue.description,
      affected: [...issue.affected_cis].sort(),
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
      expect(Number(shared.metrics.shared_by_count.low ?? shared.metrics.shared_by_count)).toBe(3);
      expect([...shared.affected_cis].sort()).toEqual([
        't2-arch-db', 't2-arch-app1', 't2-arch-app2', 't2-arch-app3',
      ].sort());
    }
    await run(`
      MATCH (db:CI {id:'t2-arch-db'}), (cycle:CI {id:'t2-arch-cycle'}), (fan:CI {id:'t2-arch-fan'})
      CREATE (foreignApp:CI {id:'t2-arch-foreign-app', ci_type:'application', organization_id:$b})
      CREATE (foreignCycle:CI {id:'t2-arch-foreign-cycle', organization_id:$b})
      CREATE (foreignLeaf:CI {id:'t2-arch-foreign-leaf', organization_id:$b})
      CREATE (through:CI {id:'t2-arch-owned-through', organization_id:$a})
      CREATE (foreignApp)-[:USES]->(db)
      CREATE (cycle)-[:DEPENDS_ON]->(foreignCycle)
      CREATE (foreignCycle)-[:DEPENDS_ON]->(cycle)
      CREATE (fan)-[:DEPENDS_ON]->(foreignLeaf)
      CREATE (foreignLeaf)-[:DEPENDS_ON]->(through)
    `, { a: A, b: B });
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
