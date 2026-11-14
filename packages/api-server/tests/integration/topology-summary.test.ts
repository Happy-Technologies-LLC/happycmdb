// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Mounted authenticated GET /analytics/topology-summary against the integration suite's disposable graph. */
import express from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

// Own organizations: no other suite's CIs can leak into the counts.
const A = '10000000-0000-4000-8000-0000000000a1';
const B = '10000000-0000-4000-8000-0000000000b1';
// The route runs under the `analytics` admission scope (10 requests/principal/minute), so org A's callers rotate
// through several principals; the org-wide 40/minute budget still covers the whole file.
const aUsers = Array.from({ length: 6 }, (_, index) => (
  { _id: `topo-user-a${index}`, _username: `alice${index}`, _role: 'viewer' as const, _enabled: true, _organizationId: A }));
const users = {
  a: aUsers[0]!,
  b: { _id: 'topo-user-b', _username: 'bob', _role: 'viewer' as const, _enabled: true, _organizationId: B },
  none: { _id: 'topo-user-none', _username: 'none', _role: 'viewer' as const, _enabled: true },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => [...aUsers, ...Object.values(users)].find(user => user._id === id) ?? null,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { analyticsRoutes } from '../../src/rest/routes/analytics.routes';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/analytics', analyticsRoutes);
let nextA = 0;
const auth = (key: keyof typeof users) => {
  const user = key === 'a' ? aUsers[nextA++ % aUsers.length]! : users[key];
  return { authorization: `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, '_organizationId' in user ? user._organizationId : undefined)}` };
};
const summary = (user: keyof typeof users, query = '') =>
  request(app).get(`/api/v1/analytics/topology-summary${query}`).set(auth(user));
const cypher = async (query: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return await session.run(query, params); } finally { await session.close(); }
};
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

// Org A, active unless noted. Degrees counted over active same-org neighbours:
//   app-1 3, srv-a 3, db-1 2, svc-1 1, srv-b 1, srv-c 1, st-1 1, the rest 0.
// dead-1 (decommissioned) links srv-a; srv-a also links an org B CI.
const ORDER = ['topo-app-1', 'topo-svc-1', 'topo-srv-a', 'topo-db-1', 'topo-srv-b', 'topo-srv-c', 'topo-st-1',
  'topo-mystery-1', 'topo-srv-d', 'topo-vm-1'];

beforeAll(async () => {
  await cypher(`
    CREATE (svc:CI {id:'topo-svc-1', name:'Billing', type:'service', status:'active', bsm_business_criticality:'tier_1', organization_id:$a})
    CREATE (app:CI {id:'topo-app-1', name:'Ledger', type:'application', status:'active', bsm_business_criticality:'tier_2', organization_id:$a})
    CREATE (db:CI {id:'topo-db-1', name:'Ledger DB', type:'database', status:'active', bsm_business_criticality:'tier_3', organization_id:$a})
    CREATE (st:CI {id:'topo-st-1', name:'Vault', type:'storage', status:'active', organization_id:$a})
    CREATE (sa:CI {id:'topo-srv-a', name:'srv-a', type:'server', status:'active', organization_id:$a})
    CREATE (sb:CI {id:'topo-srv-b', name:'srv-b', type:'server', status:'active', organization_id:$a})
    CREATE (sc:CI {id:'topo-srv-c', name:'srv-c', type:'server', status:'active', organization_id:$a})
    CREATE (:CI {id:'topo-srv-d', name:'srv-d', type:'server', status:'active', organization_id:$a})
    CREATE (:CI {id:'topo-mystery-1', name:'Mystery', type:'mystery', status:'active', organization_id:$a})
    CREATE (:CI {id:'topo-vm-1', name:'vm-1', type:'virtual-machine', status:'maintenance', organization_id:$a})
    CREATE (dead:CI {id:'topo-dead-1', name:'dead', type:'server', status:'decommissioned', organization_id:$a})
    CREATE (b1:CI {id:'topo-b-1', name:'foreign', type:'server', status:'active', bsm_business_criticality:'tier_1', organization_id:$b})
    CREATE (b2:CI {id:'topo-b-2', name:'foreign db', type:'database', status:'active', organization_id:$b})
    CREATE (svc)-[:DEPENDS_ON]->(app)
    CREATE (app)-[:USES]->(db)
    CREATE (app)-[:HOSTED_ON]->(sa)
    CREATE (sa)-[:CONNECTS_TO]->(sb)
    CREATE (sa)-[:CONNECTS_TO]->(sc)
    CREATE (db)-[:USES]->(st)
    CREATE (dead)-[:DEPENDS_ON]->(sa)
    CREATE (sa)-[:CONNECTS_TO]->(b1)
    CREATE (b1)-[:USES]->(b2)`, { a: A, b: B });
});
afterAll(async () => {
  await cypher("MATCH (ci:CI) WHERE ci.id STARTS WITH 'topo-' DETACH DELETE ci");
});

it('counts the caller\'s active CIs per category, with critical, unmapped types and totals', async () => {
  const response = await summary('a');
  expect(response.status).toBe(200);
  expect(response.body.categories).toEqual({ services: 1, apps: 1, data: 2, infra: 6, critical: 2 });
  expect(response.body.unmapped_types).toEqual(['mystery']);
  expect(response.body.totals).toEqual({
    cis: 10, relationships: 6, nodes_returned: 10, edges_returned: 6, truncated: false,
  });
});

it('returns every node critical first, then by degree, then id, with the stable node shape', async () => {
  const { body } = await summary('a');
  expect(ids(body.nodes)).toEqual(ORDER);
  expect(body.nodes[0]).toEqual({
    id: 'topo-app-1', name: 'Ledger', type: 'application', category: 'apps', status: 'active', critical: true, health: null,
  });
  expect(body.nodes.find((n: { id: string }) => n.id === 'topo-mystery-1'))
    .toMatchObject({ category: 'infra', critical: false });
  expect(body.nodes.filter((n: { critical: boolean }) => n.critical).map((n: { id: string }) => n.id))
    .toEqual(['topo-app-1', 'topo-svc-1']);
  expect(ids((await summary('a')).body.nodes)).toEqual(ORDER);
});

it('returns edges in a deterministic order and only between returned nodes', async () => {
  const { body } = await summary('a');
  expect(body.edges).toEqual([
    { source: 'topo-app-1', target: 'topo-db-1', type: 'USES' },
    { source: 'topo-app-1', target: 'topo-srv-a', type: 'HOSTED_ON' },
    { source: 'topo-db-1', target: 'topo-st-1', type: 'USES' },
    { source: 'topo-srv-a', target: 'topo-srv-b', type: 'CONNECTS_TO' },
    { source: 'topo-srv-a', target: 'topo-srv-c', type: 'CONNECTS_TO' },
    { source: 'topo-svc-1', target: 'topo-app-1', type: 'DEPENDS_ON' },
  ]);
});

it('caps the node sample, keeps edges inside it and reports truncation', async () => {
  const { body } = await summary('a', '?limit=3');
  expect(ids(body.nodes)).toEqual(['topo-app-1', 'topo-svc-1', 'topo-srv-a']);
  expect(body.edges).toEqual([
    { source: 'topo-app-1', target: 'topo-srv-a', type: 'HOSTED_ON' },
    { source: 'topo-svc-1', target: 'topo-app-1', type: 'DEPENDS_ON' },
  ]);
  const returned = new Set(ids(body.nodes));
  for (const edge of body.edges) expect([returned.has(edge.source), returned.has(edge.target)]).toEqual([true, true]);
  // Counts describe the whole estate, not the sample.
  expect(body.categories).toEqual({ services: 1, apps: 1, data: 2, infra: 6, critical: 2 });
  expect(body.totals).toEqual({ cis: 10, relationships: 6, nodes_returned: 3, edges_returned: 2, truncated: true });
});

it('caps the edge list and reports truncation even when every node fits', async () => {
  const { body } = await summary('a', '?edge_limit=2');
  expect(body.nodes).toHaveLength(10);
  expect(body.edges).toEqual([
    { source: 'topo-app-1', target: 'topo-db-1', type: 'USES' },
    { source: 'topo-app-1', target: 'topo-srv-a', type: 'HOSTED_ON' },
  ]);
  expect(body.totals).toMatchObject({ nodes_returned: 10, edges_returned: 2, truncated: true });
  expect((await summary('a', '?edge_limit=6')).body.totals).toMatchObject({ edges_returned: 6, truncated: false });
});

it('clamps limits instead of rejecting them', async () => {
  expect((await summary('a', '?limit=0')).body.nodes).toHaveLength(1);
  expect((await summary('a', '?limit=-4&edge_limit=0')).body.totals).toMatchObject({ nodes_returned: 1, edges_returned: 0 });
  const huge = await summary('a', '?limit=100000&edge_limit=100000');
  expect(huge.status).toBe(200);
  expect(huge.body.nodes).toHaveLength(10);
  const garbage = await summary('a', '?limit=abc&edge_limit=');
  expect(garbage.status).toBe(200);
  expect(garbage.body.nodes).toHaveLength(10);
});

it('omits decommissioned CIs and their edges unless includeInactive=true', async () => {
  const hidden = await summary('a');
  expect(ids(hidden.body.nodes)).not.toContain('topo-dead-1');
  expect(hidden.body.edges.some((e: { source: string }) => e.source === 'topo-dead-1')).toBe(false);
  expect((await summary('a', '?includeInactive=false')).body.totals.cis).toBe(10);

  const all = await summary('a', '?includeInactive=true');
  expect(all.body.totals).toEqual({ cis: 11, relationships: 7, nodes_returned: 11, edges_returned: 7, truncated: false });
  expect(all.body.categories.infra).toBe(7);
  expect(ids(all.body.nodes)).toContain('topo-dead-1');
  expect(all.body.edges).toContainEqual({ source: 'topo-dead-1', target: 'topo-srv-a', type: 'DEPENDS_ON' });
});

it('never reads another organization: counts, nodes, edges and the cross-organization link', async () => {
  const own = await summary('a', '?includeInactive=true');
  expect(JSON.stringify(own.body)).not.toContain('topo-b-');
  expect(JSON.stringify(own.body)).not.toContain('foreign');

  const other = await summary('b');
  expect(other.status).toBe(200);
  expect(other.body.categories).toEqual({ services: 0, apps: 0, data: 1, infra: 1, critical: 1 });
  expect(ids(other.body.nodes)).toEqual(['topo-b-1', 'topo-b-2']);
  expect(other.body.edges).toEqual([{ source: 'topo-b-1', target: 'topo-b-2', type: 'USES' }]);
  expect(other.body.totals).toMatchObject({ cis: 2, relationships: 1, truncated: false });
  expect(JSON.stringify(other.body)).not.toMatch(/topo-(?!b-)/);
});

it('leaves a CI with a pending or failed reconciliation operation out of nodes, categories, totals, degrees and edges', async () => {
  const fenced = ['topo-srv-a', 'topo-st-1'];
  await sql.query(`INSERT INTO ci_reconciliation_operations
    (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
    VALUES ('10000000-1000-4000-8000-0000000000a1', '10000000-1000-4000-8000-0000000000a1',
      $1, $2, 'api', 'update', true, 'pending', 'topo-test', 1, now()),
      ('10000000-1000-4000-8000-0000000000a2', '10000000-1000-4000-8000-0000000000a2',
      $1, $3, 'api', 'update', true, 'failed', 'topo-test', 1, now())`, [A, fenced[0], fenced[1]]);
  try {
    const { status, body } = await summary('a');
    expect(status).toBe(200);
    // srv-a was infra with degree 3 and st-1 was data: both rings shrink, and every edge touching them goes.
    expect(body.categories).toEqual({ services: 1, apps: 1, data: 1, infra: 5, critical: 2 });
    expect(body.totals).toEqual({ cis: 8, relationships: 2, nodes_returned: 8, edges_returned: 2, truncated: false });
    // app-1 loses its srv-a neighbour (degree 2 left), and the zero-degree CIs now follow db-1 by id.
    expect(ids(body.nodes)).toEqual(['topo-app-1', 'topo-svc-1', 'topo-db-1', 'topo-mystery-1', 'topo-srv-b',
      'topo-srv-c', 'topo-srv-d', 'topo-vm-1']);
    expect(body.edges).toEqual([
      { source: 'topo-app-1', target: 'topo-db-1', type: 'USES' },
      { source: 'topo-svc-1', target: 'topo-app-1', type: 'DEPENDS_ON' },
    ]);
    for (const id of fenced) expect(JSON.stringify(body)).not.toContain(id);

    const all = await summary('a', '?includeInactive=true');
    expect(all.body.totals).toMatchObject({ cis: 9, relationships: 2 });
    expect(JSON.stringify(all.body.edges)).not.toContain('topo-srv-a');
    // The fence is per organization: the other tenant is unaffected.
    expect((await summary('b')).body.totals).toMatchObject({ cis: 2, relationships: 1 });
  } finally {
    await sql.query("DELETE FROM ci_reconciliation_operations WHERE actor = 'topo-test'");
  }
  // Once the operations are gone the CIs return.
  expect((await summary('a')).body.totals.cis).toBe(10);
});

it('answers 401 without credentials and 403 for an identity without an organization', async () => {
  expect((await request(app).get('/api/v1/analytics/topology-summary')).status).toBe(401);
  expect((await summary('none')).status).toBe(403);
});
