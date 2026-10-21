// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Authenticated T3 routes against the integration suite's disposable Neo4j and PostgreSQL. */
import express from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient, setJournalSeam } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';
import { ChangeEventProcessor, EventType, type CIDiscoveredEvent, type CIUpdatedEvent } from '@cmdb/event-processor';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const users: Record<string, { _id: string; _username: string; _role: 'admin'; _enabled: boolean; _organizationId?: string }> = {
  a: { _id: 't3-a', _username: 'alice', _role: 'admin', _enabled: true, _organizationId: A },
  a_degree: { _id: 't3-a-degree', _username: 'degree', _role: 'admin', _enabled: true, _organizationId: A },
  a_fanin: { _id: 't3-a-fanin', _username: 'fanin', _role: 'admin', _enabled: true, _organizationId: A },
  a_rate: { _id: 't3-a-rate', _username: 'rate', _role: 'admin', _enabled: true, _organizationId: A },
  b: { _id: 't3-b', _username: 'bob', _role: 'admin', _enabled: true, _organizationId: B },
  b_reuse: { _id: 't3-b-reuse', _username: 'bob-reuse', _role: 'admin', _enabled: true, _organizationId: B },
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
import { ciRoutes } from '../../src/rest/routes/ci.routes';
import { createGraphQLServer } from '../../src/graphql/server';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/cis', ciRoutes);
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
  await sql.query("DELETE FROM ci_change_history WHERE ci_id LIKE 't3-%'");
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
  expect(dependencyGraph.body.data.nodes.map((node: {
    ci_id: string; dependents_count: number; dependencies_count: number
  }) => [node.ci_id, node.dependents_count, node.dependencies_count]).sort())
    .toEqual([['t3-a', 1, 1], ['t3-a2', 0, 1]]);
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

it('bounds real parallel-edge and fan-out-by-depth impact traversals before path enumeration', async () => {
  await run(`CREATE (root:CI {id:'t3-parallel-root', name:'parallel root', ci_type:'server', organization_id:$organizationId})
    CREATE (leaf:CI {id:'t3-parallel-leaf', name:'parallel leaf', ci_type:'server', organization_id:$organizationId})
    WITH root, leaf UNWIND range(1,20) AS n CREATE (leaf)-[:DEPENDS_ON {ordinal:n}]->(root)`,
    { organizationId: A });
  await run(`CREATE (root:CI {id:'t3-dense-root', name:'dense root', ci_type:'server', organization_id:$organizationId})
    WITH root UNWIND range(0,9) AS i
    CREATE (child:CI {id:'t3-dense-l1-'+toString(i), name:'layer one', ci_type:'server', organization_id:$organizationId})
    CREATE (child)-[:DEPENDS_ON]->(root)
    WITH root, child, i UNWIND range(0,9) AS j
    CREATE (grandchild:CI {id:'t3-dense-l2-'+toString(i)+'-'+toString(j),
      name:'layer two', ci_type:'server', organization_id:$organizationId})
    CREATE (grandchild)-[:DEPENDS_ON]->(child)`, { organizationId: A });
  await run(`MATCH (root:CI {id:'t3-dense-root'}), (child:CI {id:'t3-dense-l1-0'})
    UNWIND range(1,20) AS n CREATE (child)-[:DEPENDS_ON {ordinal:n}]->(root)`);
  await run(`CREATE (root:CI {id:'t3-deep-root', name:'deep root', ci_type:'server', organization_id:$organizationId})
    CREATE (d1:CI {id:'t3-deep-l1', name:'deep layer', ci_type:'server', organization_id:$organizationId})-[:DEPENDS_ON]->(root)
    CREATE (d2:CI {id:'t3-deep-l2', name:'deep layer', ci_type:'server', organization_id:$organizationId})-[:DEPENDS_ON]->(d1)
    CREATE (d3:CI {id:'t3-deep-l3', name:'deep layer', ci_type:'server', organization_id:$organizationId})-[:DEPENDS_ON]->(d2)
    CREATE (d4:CI {id:'t3-deep-l4', name:'deep layer', ci_type:'server', organization_id:$organizationId})-[:DEPENDS_ON]->(d3)
    CREATE (d5:CI {id:'t3-deep-l5', name:'deep layer', ci_type:'server', organization_id:$organizationId})-[:DEPENDS_ON]->(d4)
    WITH d5 UNWIND range(0,99) AS i
    CREATE (leaf:CI {id:'t3-deep-l6-'+toString(i), name:'deep leaf', ci_type:'server', organization_id:$organizationId})
    CREATE (leaf)-[:DEPENDS_ON]->(d5)`, { organizationId: A });
  await run(`MATCH (root:CI {id:'t3-deep-root'}), (child:CI {id:'t3-deep-l1'})
    UNWIND range(1,20) AS n CREATE (child)-[:DEPENDS_ON {ordinal:n}]->(root)`);

  const measured = async (send: () => Promise<request.Response>) => {
    const originalGetSession = graph.getSession.bind(graph);
    let statements = 0;
    const sessions = jest.spyOn(graph, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const originalRun = session.run.bind(session);
      session.run = ((...args: Parameters<typeof originalRun>) => {
        statements++;
        return originalRun(...args);
      }) as typeof session.run;
      return session;
    });
    const pg = jest.spyOn(sql, 'query');
    const started = Date.now();
    try {
      const response = await send();
      return { response, statements, pgQueries: pg.mock.calls.length, ms: Date.now() - started };
    } finally {
      sessions.mockRestore();
      pg.mockRestore();
    }
  };

  const parallel = await measured(() =>
    request(app).get('/api/v1/impact/graph/t3-parallel-root?max_depth=5').set(auth('a')));
  expect(parallel.response.status).toBe(200);
  expect(parallel.response.body.data.nodes.map((node: { ci_id: string }) => node.ci_id).sort())
    .toEqual(['t3-parallel-leaf', 't3-parallel-root']);
  expect(parallel.response.body.data.edges).toHaveLength(20);
  expect(parallel.statements).toBeLessThanOrEqual(12);
  expect(parallel.ms).toBeLessThan(4000);

  const denseGraph = await measured(() =>
    request(app).get('/api/v1/impact/graph/t3-dense-root?max_depth=5').set(auth('a')));
  expect(denseGraph.response.status).toBe(503);
  expect(denseGraph.response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(denseGraph.statements).toBeLessThanOrEqual(5);
  expect(denseGraph.pgQueries).toBe(0);
  expect(denseGraph.ms).toBeLessThan(4000);

  const affected = await measured(() =>
    request(app).post('/api/v1/impact/predict').set(auth('a'))
      .send({ ci_id: 't3-dense-root', change_type: 'RESTART' }));
  expect(affected.response.status).toBe(503);
  expect(affected.response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(affected.statements).toBeLessThanOrEqual(6);
  expect(affected.pgQueries).toBe(1); // only the AP-S own-org gap pre-check (HP1-S4d)
  expect(affected.ms).toBeLessThan(4000);

  const criticalPath = await measured(() =>
    request(app).post('/api/v1/impact/predict').set(auth('a'))
      .send({ ci_id: 't3-deep-root', change_type: 'RESTART' }));
  expect(criticalPath.response.status).toBe(503);
  expect(criticalPath.response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(criticalPath.statements).toBeLessThanOrEqual(15);
  expect(criticalPath.pgQueries).toBe(1);
  expect(criticalPath.ms).toBeLessThan(4000);
});

it('bounds every REST and GraphQL CI traversal on real parallel-edge fan-out', async () => {
  const smallDependencies = await request(app).get('/api/v1/cis/t3-a2/dependencies?depth=2').set(auth('a'));
  expect(smallDependencies.status).toBe(200);
  expect(smallDependencies.body.data.map((path: { end: { properties: { id: string } } }) => path.end.properties.id))
    .toEqual(['t3-a']);
  const smallImpact = await request(app).get('/api/v1/cis/t3-a/impact?depth=2').set(auth('a'));
  expect(smallImpact.status).toBe(200);
  expect(smallImpact.body.data.downstream.map((ci: { id: string }) => ci.id)).toEqual(['t3-a2']);
  expect(smallImpact.body.data.upstream).toEqual([]);
  const smallRelationships = await request(app).get('/api/v1/cis/t3-a/relationships?direction=in&depth=2').set(auth('a'));
  expect(smallRelationships.status).toBe(200);
  expect(smallRelationships.body.data.map((relationship: { source_ci_id: string }) => relationship.source_ci_id))
    .toEqual(['t3-a2']);
  const smallGraphql = await request(app).post('/graphql').set(auth('a')).send({
    query: `{ getCIDependencies(id:"t3-a2", depth:2) { _id }
      getImpactAnalysis(id:"t3-a", depth:2) { _distance _ci { _id } } }`,
  });
  expect(smallGraphql.body.errors).toBeUndefined();
  expect(smallGraphql.body.data).toEqual({
    getCIDependencies: [{ _id: 't3-a' }],
    getImpactAnalysis: [{ _distance: 1, _ci: { _id: 't3-a2' } }],
  });

  await run("CREATE (:CI {id:'t3-h562-root', name:'dense root', type:'server', organization_id:$org})", { org: A });
  for (const direction of ['out', 'in'] as const) {
    await run(`MATCH (root:CI {id:'t3-h562-root'})
      UNWIND range(1,10) AS i
      CREATE (first:CI {id:'t3-h562-${direction}-'+toString(i), name:'first', type:'server', organization_id:$org})
      ${direction === 'out' ? 'CREATE (root)-[:DEPENDS_ON]->(first)' : 'CREATE (first)-[:DEPENDS_ON]->(root)'}
      WITH first, i
      UNWIND range(1,10) AS j
      CREATE (leaf:CI {id:'t3-h562-${direction}-'+toString(i)+'-'+toString(j),
        name:'leaf', type:'server', organization_id:$org})
      ${direction === 'out' ? 'CREATE (first)-[:DEPENDS_ON]->(leaf)' : 'CREATE (leaf)-[:DEPENDS_ON]->(first)'}`,
    { org: A });
    await run(`MATCH (root:CI {id:'t3-h562-root'}), (first:CI {id:'t3-h562-${direction}-1'})
      UNWIND range(1,20) AS ordinal
      ${direction === 'out'
    ? 'CREATE (root)-[:USES {ordinal:ordinal}]->(first)'
    : 'CREATE (first)-[:USES {ordinal:ordinal}]->(root)'}`);
  }

  const checked = async (requestCall: () => Promise<request.Response>): Promise<request.Response> => {
    let statements = 0;
    const original = graph.getSession.bind(graph);
    const spy = jest.spyOn(graph, 'getSession').mockImplementation(() => {
      const session = original();
      const originalRun = session.run.bind(session);
      session.run = ((...args: Parameters<typeof originalRun>) => {
        statements++;
        return originalRun(...args);
      }) as typeof session.run;
      return session;
    });
    const started = Date.now();
    try {
      return await requestCall();
    } finally {
      spy.mockRestore();
      expect(Date.now() - started).toBeLessThan(4000);
      expect(statements).toBeLessThanOrEqual(5);
    }
  };
  for (const route of [
    '/api/v1/cis/t3-h562-root/dependencies?depth=2',
    '/api/v1/cis/t3-h562-root/impact?depth=2',
    '/api/v1/cis/t3-h562-root/relationships?direction=out&depth=2',
    '/api/v1/cis/t3-h562-root/relationships?direction=in&depth=2',
    '/api/v1/cis/t3-h562-root/relationships?depth=2',
  ]) {
    const response = await checked(() => request(app).get(route).set(auth('a')));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ success: false, error: 'CI traversal resource limit exceeded' });
  }
  for (const query of [
    '{ getCIDependencies(id:"t3-h562-root", depth:2) { _id } }',
    '{ getImpactAnalysis(id:"t3-h562-root", depth:2) { _ci { _id } } }',
    '{ getCI(id:"t3-h562-root") { _dependencies { _id } } }',
  ]) {
    const response = await checked(() => request(app).post('/graphql').set(auth('a')).send({ query }));
    expect(response.status).toBe(200);
    expect(response.body.errors?.[0]).toMatchObject({
      message: 'CI traversal resource limit exceeded', extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
  }
  const foreign = await request(app).get('/api/v1/cis/t3-h562-root/dependencies').set(auth('b'));
  const missing = await request(app).get('/api/v1/cis/t3-h562-missing/dependencies').set(auth('b'));
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  expect((await sql.query("SELECT ci_id FROM ci_criticality_scores WHERE ci_id = 't3-h562-root'")).rows).toEqual([]);
  expect((await sql.query("SELECT id FROM impact_analyses WHERE source_ci_id = 't3-h562-root'")).rows).toEqual([]);
});

it('reserves one request budget before parallel GraphQL alias queries hit Neo4j', async () => {
  await run(`CREATE (root:CI {id:'t3-alias-root', name:'alias root', type:'server', organization_id:$org})
    CREATE (leaf:CI {id:'t3-alias-leaf', name:'alias leaf', type:'server', organization_id:$org})
    WITH root, leaf UNWIND range(1,300) AS ordinal
    CREATE (root)-[:DEPENDS_ON {ordinal:ordinal}]->(leaf)`, { org: A });

  let statements = 0;
  let transferredRows = 0;
  const original = graph.getSession.bind(graph);
  const spy = jest.spyOn(graph, 'getSession').mockImplementation(() => {
    const session = original();
    const originalRun = session.run.bind(session);
    session.run = (async (...args: Parameters<typeof originalRun>) => {
      const traversal = String(args[0]).startsWith('UNWIND $frontier AS sourceId');
      if (traversal) statements++;
      const result = await originalRun(...args);
      if (traversal) transferredRows += result.records.length;
      return result;
    }) as typeof session.run;
    return session;
  });
  const started = Date.now();
  try {
    const query = `{ ${['a', 'b'].map(alias =>
    `${alias}: getCIDependencies(id:"t3-alias-root", depth:1) { _id }`).join(' ')} }`;
    const response = await request(app).post('/graphql').set(auth('a')).send({ query });
    expect(response.status).toBe(200);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'CI traversal resource limit exceeded',
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]));
    expect(statements).toBeLessThanOrEqual(2);
    expect(transferredRows).toBeLessThanOrEqual(401);
  } finally {
    spy.mockRestore();
  }
  expect(Date.now() - started).toBeLessThan(4000);
});

it('shares an atomic budget across both one-hop GraphQL DataLoaders in a single mounted request', async () => {
  const small = await request(app).post('/graphql').set(auth('a')).send({
    query: '{ getCI(id:"t3-a2") { _relationships { _ci { _id } } _dependents { _ci { _id } } } }',
  });
  expect(small.body.errors).toBeUndefined();
  expect(small.body.data.getCI).toEqual({
    _relationships: [{ _ci: { _id: 't3-a' } }], _dependents: [],
  });

  await run(`CREATE (first:CI {id:'t3-pre02-first', name:'first', type:'server', organization_id:$org})
    CREATE (second:CI {id:'t3-pre02-second', name:'second', type:'server', organization_id:$org})
    CREATE (shared:CI {id:'t3-pre02-shared', name:'shared', type:'server', organization_id:$org})
    WITH first, second, shared UNWIND range(1,250) AS ordinal
    CREATE (first)-[:DEPENDS_ON {ordinal:ordinal}]->(shared)
    CREATE (shared)-[:USES {ordinal:ordinal}]->(second)`, { org: A });
  let statements = 0;
  let adjacencyRows = 0;
  const original = graph.getSession.bind(graph);
  const spy = jest.spyOn(graph, 'getSession').mockImplementation(() => {
    const session = original();
    const originalRun = session.run.bind(session);
    session.run = (async (...args: Parameters<typeof originalRun>) => {
      const adjacency = String(args[0]).includes('type(r) AS relType');
      if (adjacency) statements++;
      const result = await originalRun(...args);
      if (adjacency) adjacencyRows += result.records.length;
      return result;
    }) as typeof session.run;
    return session;
  });
  const started = Date.now();
  try {
    const response = await request(app).post('/graphql').set(auth('a')).send({
      query: `{ first: getCI(id:"t3-pre02-first") { _relationships { _ci { _id } } }
        second: getCI(id:"t3-pre02-second") { _dependents { _ci { _id } } } }`,
    });
    expect(response.status).toBe(200);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'CI traversal resource limit exceeded',
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]));
    expect(statements).toBeLessThanOrEqual(2);
    expect(adjacencyRows).toBeLessThanOrEqual(401);

    const both = await request(app).post('/graphql').set(auth('a')).send({
      query: '{ getCIRelationships(id:"t3-pre02-shared", direction:"both") { _ci { _id } } }',
    });
    expect(both.status).toBe(200);
    expect(both.body.errors?.[0]).toMatchObject({
      message: 'CI traversal resource limit exceeded', extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
  } finally {
    spy.mockRestore();
  }
  expect(Date.now() - started).toBeLessThan(4000);
});

it('counts 300 owned inbound and outbound relationships without a Cartesian adjacency expansion', async () => {
  await run(`CREATE (root:CI {id:'t3-degree-root', name:'degree root', ci_type:'server', organization_id:$organizationId})
    CREATE (hub:CI {id:'t3-degree-hub', name:'degree hub', ci_type:'server', organization_id:$organizationId})
    CREATE (dependent:CI {id:'t3-degree-dependent', name:'degree dependent', ci_type:'server', organization_id:$organizationId})
    CREATE (dependency:CI {id:'t3-degree-dependency', name:'degree dependency', ci_type:'server', organization_id:$organizationId})
    CREATE (hub)-[:DEPENDS_ON]->(root)
    WITH hub, dependent, dependency UNWIND range(1,300) AS ordinal
    CREATE (dependent)-[:DEPENDS_ON {ordinal:ordinal}]->(hub)
    CREATE (hub)-[:USES {ordinal:ordinal}]->(dependency)`, { organizationId: A });

  const captured = new Map<string, { cypher: string; params: Record<string, unknown> }>();
  const originalGetSession = graph.getSession.bind(graph);
  const sessions = jest.spyOn(graph, 'getSession').mockImplementation(() => {
    const session = originalGetSession();
    const originalRun = session.run.bind(session);
    session.run = ((...args: Parameters<typeof originalRun>) => {
      const cypher = String(args[0]);
      if (cypher.includes('RETURN ci.id as ci_id') && cypher.includes('dependent_count')
        && (args[1] as Record<string, unknown>)?.ciId === 't3-degree-hub') {
        captured.set('criticality', { cypher, params: args[1] as Record<string, unknown> });
      }
      if (cypher.includes('RETURN node.id as id') && cypher.includes('dependencies_count')) {
        captured.set('graph', { cypher, params: args[1] as Record<string, unknown> });
      }
      return originalRun(...args);
    }) as typeof session.run;
    return session;
  });
  let criticalityMs: number;
  let graphMs: number;
  try {
    const criticalityStart = Date.now();
    const criticality = await request(app).get('/api/v1/impact/criticality/t3-degree-hub').set(auth('a_degree'));
    criticalityMs = Date.now() - criticalityStart;
    expect(criticality.status).toBe(200);
    expect(criticality.body.data.factors.dependent_count).toBe(300);

    const graphStart = Date.now();
    const dependencyGraph = await request(app).get('/api/v1/impact/graph/t3-degree-root?max_depth=1').set(auth('a_degree'));
    graphMs = Date.now() - graphStart;
    expect(dependencyGraph.status).toBe(200);
    expect(dependencyGraph.body.data.nodes.map((node: {
      ci_id: string; dependents_count: number; dependencies_count: number
    }) => [node.ci_id, node.dependents_count, node.dependencies_count]).sort())
      .toEqual([['t3-degree-hub', 300, 601], ['t3-degree-root', 1, 1]]);
    expect(dependencyGraph.body.data.edges).toMatchObject([
      { source_id: 't3-degree-hub', target_id: 't3-degree-root' },
    ]);
  } finally {
    sessions.mockRestore();
  }
  expect(criticalityMs!).toBeLessThan(4000);
  expect(graphMs!).toBeLessThan(4000);

  for (const key of ['criticality', 'graph']) {
    const statement = captured.get(key);
    expect(statement).toBeDefined();
    const session = graph.getSession();
    try {
      const profiled = await session.run(`PROFILE ${statement!.cypher}`, statement!.params, { timeout: 5000 });
      if (!profiled.summary.profile) throw new Error('Expected Neo4j PROFILE plan');
      const maxRows = (plan: { rows: number; children: Array<typeof plan> }): number =>
        Math.max(plan.rows, ...plan.children.map(maxRows));
      expect(maxRows(profiled.summary.profile)).toBeLessThan(10000);
    } finally {
      await session.close();
    }
  }
});

it('bounds dependent IDs at the Neo4j producer while retaining exact fan-in and no partial cache writes', async () => {
  await run(`CREATE (root:CI {id:'t3-fanin-root', name:'fan-in root', type:'server', organization_id:$org})
    WITH root UNWIND range(1,130) AS ordinal
    CREATE (dependent:CI {id:'t3-fanin-'+toString(ordinal),
      name:'dependent', type:'server', organization_id:$org})
    CREATE (dependent)-[:DEPENDS_ON]->(root)`, { org: A });
  await run(`MATCH (root:CI {id:'t3-fanin-root'}), (dependent:CI {id:'t3-fanin-1'})
    UNWIND range(1,20) AS ordinal CREATE (dependent)-[:USES {ordinal:ordinal}]->(root)`);
  let observed: { count: number; ids: string[] } | undefined;
  const original = graph.getSession.bind(graph);
  const spy = jest.spyOn(graph, 'getSession').mockImplementation(() => {
    const session = original();
    const originalRun = session.run.bind(session);
    session.run = (async (...args: Parameters<typeof originalRun>) => {
      const result = await originalRun(...args);
      if (String(args[0]).includes('RETURN ci.id as ci_id')
          && (args[1] as Record<string, unknown>)?.ciId === 't3-fanin-root') {
        observed = {
          count: result.records[0].get('dependent_count').toNumber(),
          ids: result.records[0].get('dependent_ids'),
        };
      }
      return result;
    }) as typeof session.run;
    return session;
  });
  const started = Date.now();
  try {
    const response = await request(app).get('/api/v1/impact/criticality/t3-fanin-root').set(auth('a_fanin'));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  } finally {
    spy.mockRestore();
  }
  expect(Date.now() - started).toBeLessThan(4000);
  expect(observed?.count).toBe(150);
  expect(observed?.ids).toHaveLength(101);
  expect((await sql.query("SELECT ci_id FROM ci_criticality_scores WHERE ci_id LIKE 't3-fanin-%'")).rows).toEqual([]);
});

it('limits authenticated impact history across requests before graph and SQL access', async () => {
  const ciLookup = jest.spyOn(graph, 'getCI');
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await request(app).get('/api/v1/impact/history/t3-a?limit=1').set(auth('a_rate'));
      expect(response.status).toBe(200);
    }
    const before = ciLookup.mock.calls.length;
    const blocked = await request(app).get('/api/v1/impact/history/t3-a?limit=1').set(auth('a_rate'));
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ success: false, error: 'Impact analysis rate limit exceeded' });
    expect(ciLookup.mock.calls).toHaveLength(before);
  } finally {
    ciLookup.mockRestore();
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
    const rows = (await sql.query(`SELECT organization_id FROM ${table} WHERE ${column} = 't3-fresh'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.organization_id === A)).toBe(true); // HP1-S4c: stamped with the caller's org
  }
  expect((await sql.query("SELECT ci_id FROM cmdb.dim_ci WHERE ci_id = 't3-fresh'")).rows).toEqual([]);
});

it('H-3/N-8: proven and forged Kafka CI events write no history; reads stay org- and incarnation-scoped', async () => {
  await run("CREATE (:CI {id:'t3-history', name:'history', ci_type:'server', organization_id:$organizationId})", { organizationId: A });
  const aMarker = await graph.ensureCIIncarnation('t3-history', A);
  const processor = new ChangeEventProcessor() as unknown as {
    handleCIDiscovered(event: CIDiscoveredEvent): Promise<void>;
    handleCIUpdated(event: CIUpdatedEvent): Promise<void>;
  };
  await processor.handleCIDiscovered({
    event_id: 't3-history-a', event_type: EventType.CI_DISCOVERED, timestamp: new Date(),
    source: 'identity-reconciliation-engine', ci_id: 't3-history', organization_id: A,
    ci_incarnation_id: aMarker!, ci_name: 'history', ci_type: 'server', source_system: 'test',
    identifiers: {}, confidence_score: 1,
  });
  await processor.handleCIUpdated({
    event_id: 't3-history-forged', event_type: EventType.CI_UPDATED, timestamp: new Date(),
    source: 'identity-reconciliation-engine', ci_id: 't3-history', organization_id: B,
    ci_incarnation_id: aMarker!, ci_name: 'forged', source_system: 'test',
    changed_fields: [], previous_values: {}, new_values: {},
  });
  expect((await sql.query("SELECT 1 FROM ci_change_history WHERE ci_id = 't3-history'")).rows).toEqual([]);
  const rest = (user: keyof typeof users) =>
    request(app).get('/api/v1/itil/configuration-items/t3-history/history').set(auth(user));
  expect((await rest('a')).body.data).toEqual([]);
  expect((await rest('b')).status).toBe(404);
});

it('retains B rows in all derived SQL families when A\'s journaled delete is held before T2', async () => {
  const id = 't3-delete-race';
  const a = await graph.createCI({ _id: id, name: 'former A', _type: 'server' }, A, 't3-a');
  const aMarker = a._incarnation_id;
  await sql.query(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, organization_id)
    VALUES ('55555555-5555-4555-8555-555555555555', $1, 'configuration', '{}', NOW(), 'legacy', $2)`, [id, A]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  setJournalSeam(async (point, context) => {
    if (point === 'beforeT2' && !context.recovery) { entered.resolve(); await release.promise; }
  });
  try {
    const deletion = graph.deleteCI(id, A, 't3-a');
    await entered.promise;
    expect(await graph.getCI(id, A)).toBeNull();
    setJournalSeam(undefined);
    const b = await graph.createCI({ _id: id, name: 'new B', _type: 'server' }, B, 't3-b');
    const bMarker = b._incarnation_id;
    expect(bMarker).not.toBe(aMarker);
    await sql.query(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, ci_incarnation_id, organization_id)
      VALUES ('66666666-6666-4666-8666-666666666666', $1, 'configuration', '{"owner":"B"}', NOW(), 'b', $2, $3)`, [id, bMarker, B]);
    await sql.query(`INSERT INTO drift_detection_results (ci_id, has_drift, detected_at, ci_incarnation_id, organization_id)
      VALUES ($1, false, NOW(), $2, $3)`, [id, bMarker, B]);
    await sql.query(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id, organization_id)
      VALUES ('77777777-7777-4777-8777-777777777777', $1, 'RESTART', 'low', NOW(), $2, $3)`, [id, bMarker, B]);
    await sql.query(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at, ci_incarnation_id, organization_id)
      VALUES ($1, '{"owner":"B"}', NOW(), $2, $3)`, [id, bMarker, B]);
    release.resolve();
    expect(await deletion).toBe(true);
    for (const table of ['baseline_snapshots', 'drift_detection_results', 'impact_analyses', 'ci_criticality_scores']) {
      const column = table === 'impact_analyses' ? 'source_ci_id' : 'ci_id';
      expect((await sql.query(`SELECT ci_incarnation_id FROM ${table} WHERE ${column}=$1`, [id])).rows)
        .toEqual([{ ci_incarnation_id: bMarker }]);
    }
    expect((await sql.query(`SELECT change_type, organization_id, ci_incarnation_id FROM ci_change_history
      WHERE ci_id = $1`, [id])).rows).toEqual([{ change_type: 'deleted', organization_id: A, ci_incarnation_id: aMarker }]);
    expect((await graph.getCI(id, B))?._incarnation_id).toBe(bMarker);
  } finally {
    release.resolve();
    setJournalSeam(undefined);
  }
});

it('fences future-dated A rows across real graph deletion and B ID collision, while reading B rows with clock skew', async () => {
  const issued = await graph.createCI({ _id: 't3-graph-marker', name: 'marker', _type: 'server' }, A, 't3-a');
  expect(issued._incarnation_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect((await graph.getCI('t3-graph-marker', A))?._incarnation_id).toBe(issued._incarnation_id);
  expect(await graph.deleteCI('t3-graph-marker', A, 't3-a')).toBe(true);
  const id = 't3-reincarnated';
  await run('CREATE (:CI {id:$id, name:"former A", type:"server", organization_id:$organizationId, incarnation_id:randomUUID()})',
    { id, organizationId: A });
  const former = await graph.getCI(id, A);
  const aMarker = former?._incarnation_id;
  expect(aMarker).toMatch(/^[0-9a-f-]{36}$/i);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await sql.query(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id, organization_id)
    VALUES ('11111111-1111-4111-8111-111111111111', $1, 'configuration', '{"secret":"A"}', $2, 'a', true, $3, $4)`, [id, future, aMarker, A]);
  await sql.query(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at, ci_incarnation_id, organization_id)
    VALUES ($1, true, 99, $2, $3, $4)`, [id, future, aMarker, A]);
  await sql.query(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id, organization_id)
    VALUES ('22222222-2222-4222-8222-222222222222', $1, 'RESTART', 'high', $2, $3, $4)`, [id, future, aMarker, A]);
  await sql.query(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at, ci_incarnation_id, organization_id)
    VALUES ($1, '{"secret":"A"}', $2, $3, $4)`, [id, future, aMarker, A]);
  await sql.query(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, changed_at, ci_incarnation_id, organization_id)
    VALUES ($1, 'FORMER', 'test', $2::jsonb, $3, $4, $5)`, [id, JSON.stringify({ organization_id: B }), future, aMarker, A]);
  // Model an incomplete cross-store delete. Production graph.deleteCI also purges
  // PostgreSQL; this surviving-row case verifies that purge is not the fence.
  await run('MATCH (ci:CI {id:$id}) DETACH DELETE ci', { id });
  await run(`CREATE (:CI {id:$id, name:'new B', type:'server', organization_id:$organizationId,
    created_at:datetime() + duration({hours:1}), incarnation_id:randomUUID()})`, { id, organizationId: B });
  const current = await graph.getCI(id, B);
  const bMarker = current?._incarnation_id;
  expect(bMarker).toMatch(/^[0-9a-f-]{36}$/i);
  expect(bMarker).not.toBe(aMarker);
  await expect(graph.updateCI(id, { organization_id: A, incarnation_id: aMarker } as any, B, 't3-b'))
    .rejects.toThrow('CI identity and incarnation cannot be updated');
  expect((await graph.getCI(id, B))?._incarnation_id).toBe(bMarker);
  expect(await graph.getCI(id, A)).toBeNull();
  expect(await graph.listCIIncarnations(B)).toContainEqual({
    ciId: id, incarnationId: bMarker, organizationId: B, ciType: 'server',
  });
  const get = (path: string) => request(app).get(path).set(auth('b_reuse'));
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data).toBeNull();
  expect((await get(`/api/v1/drift/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toEqual([]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data).toEqual([]);
  const criticality = await get(`/api/v1/impact/criticality/${id}`);
  expect(criticality.status).toBe(200);
  expect(JSON.stringify(criticality.body)).not.toContain('secret');
  expect((await sql.query('SELECT ci_incarnation_id FROM ci_criticality_scores WHERE ci_id=$1 AND organization_id=$2',
    [id, B])).rows).toEqual([{ ci_incarnation_id: bMarker }]);

  await sql.query(`INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, is_approved, ci_incarnation_id, organization_id)
    VALUES ('33333333-3333-4333-8333-333333333333', $1, 'configuration', '{"owner":"B"}', NOW(), 'b', true, $2, $3)`, [id, bMarker, B]);
  await sql.query(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at, ci_incarnation_id, organization_id)
    VALUES ($1, false, 0, NOW(), $2, $3)`, [id, bMarker, B]);
  await sql.query(`INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at, ci_incarnation_id, organization_id)
    VALUES ('44444444-4444-4444-8444-444444444444', $1, 'RESTART', 'low', NOW(), $2, $3)`, [id, bMarker, B]);
  await sql.query(`INSERT INTO ci_change_history (ci_id, change_type, change_source, metadata, ci_incarnation_id, organization_id)
    VALUES ($1, 'FRESH_B', 'test', $2::jsonb, $3, $4)`,
    [id, JSON.stringify({ organization_id: B }), bMarker, B]);
  expect((await get(`/api/v1/drift/baseline/${id}`)).body.data.snapshot_data).toEqual({ owner: 'B' });
  expect((await get(`/api/v1/drift/history/${id}`)).body.data).toMatchObject([{ drift_score: 0 }]);
  expect((await get(`/api/v1/impact/history/${id}`)).body.data).toMatchObject([{ risk_level: 'low' }]);
  expect((await get(`/api/v1/itil/configuration-items/${id}/history`)).body.data).toMatchObject([{ change_type: 'FRESH_B' }]);
});

it('pages more than 512 real Neo4j CIs across organizations without truncating the system scan', async () => {
  await run(`UNWIND range(0, 512) AS index
    CREATE (:CI {id:'t3-global-page-' + toString(index), name:'page fixture',
      organization_id: CASE WHEN index % 2 = 0 THEN $a ELSE $b END,
      incarnation_id:randomUUID()})`, { a: A, b: B });
  const scanned = new Set<string>();
  let pages = 0;
  for await (const page of graph.iterateUnscopedCIIncarnationPages()) {
    pages++;
    expect(page.length).toBeLessThanOrEqual(512);
    for (const ci of page) {
      if (ci.ciId.startsWith('t3-global-page-')) scanned.add(ci.ciId);
    }
  }
  expect(pages).toBeGreaterThan(1);
  expect(scanned.size).toBe(513);
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
