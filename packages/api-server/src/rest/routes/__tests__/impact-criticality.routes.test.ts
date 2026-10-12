// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const ORG = '11111111-1111-4111-8111-111111111111';
const edges = new Map<string, string[]>();
const run = jest.fn(async (_cypher: string, _params: { ciId: string }, _options?: { timeout: number }) => ({
  records: [] as Array<{ get: (key: string) => unknown }>,
}));
const getCI = jest.fn(async (id: string) => ({ id }));
const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as Array<Record<string, unknown>> }));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getCI, getSession: () => ({ run, close: async () => undefined }) }),
  getPostgresClient: () => ({ query }),
}));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async () => ({
    _userId: 'viewer-1', _username: 'viewer', _role: 'viewer', _organizationId: ORG, _type: 'access',
  }) } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});

import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { impactRoutes } from '../drift-impact.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/impact', getAuthMiddleware().authenticate(), impactRoutes);
const criticality = (id: string) => request(app).get(`/api/v1/impact/criticality/${id}`).set('authorization', 'Bearer viewer');
const graph = (depth: number) => request(app).get(`/api/v1/impact/graph/A?max_depth=${depth}`).set('authorization', 'Bearer viewer');
const graphRecord = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });

beforeEach(() => {
  edges.clear();
  run.mockImplementation(async (_cypher, params) => {
    if (run.mock.calls.length > 120) throw new Error('Neo4j statement budget exhausted');
    const id = params.ciId;
    const dependents = edges.get(id) ?? [];
    return { records: [{ get: (key: string) => {
      if (key === 'ci_name') return id;
      if (key === 'dependent_ids') return dependents;
      if (key === 'dependent_count') return { toNumber: () => dependents.length };
      if (key === 'dependency_count') return { toNumber: () => 0 };
      return null;
    } }] };
  });
  getCI.mockImplementation(async (id) => ({ id }));
  query.mockImplementation(async (sql) => {
    if (sql.includes('ci_criticality_scores s')) return { rows: [] };
    if (sql.includes('change_count')) return { rows: [{ change_count: '0' }] };
    return { rows: [{ ci_id: 'stored' }] };
  });
});

it('terminates an A-to-B-to-A cycle without unbounded driver or SQL calls', async () => {
  edges.set('A', ['B']); edges.set('B', ['A']);
  const response = await criticality('A');
  expect(response.status).toBe(200);
  expect(response.body.data.criticality_score).toBe(63);
  expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  expect(query.mock.calls.length).toBeLessThanOrEqual(6);
  expect(run.mock.calls.every((call) => call[2]?.timeout === 5000)).toBe(true);
});

it('keeps cached cyclic scores independent of which root was requested first', async () => {
  edges.set('A', ['B']); edges.set('B', ['A']);
  for (const first of ['A', 'B']) {
    const cache = new Map<string, Record<string, unknown>>();
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('ci_criticality_scores s')) {
        const stored = cache.get(params![0] as string);
        return { rows: stored ? [stored] : [] };
      }
      if (sql.includes('change_count')) return { rows: [{ change_count: '0' }] };
      if (sql.includes('INSERT INTO ci_criticality_scores')) {
        const [id, name, value, factors, date] = params as [string, string, number, string, Date];
        cache.set(id, {
          ci_id: id, ci_name: name, criticality_score: value,
          factors: JSON.parse(factors), calculated_at: date,
        });
        return { rows: [{ ci_id: id }] };
      }
      return { rows: [] };
    });
    const second = first === 'A' ? 'B' : 'A';
    expect((await criticality(first)).body.data.criticality_score).toBe(63);
    expect((await criticality(second)).body.data.criticality_score).toBe(63);
    expect(cache.size).toBe(0);
  }
});

it('terminates a self-loop deterministically', async () => {
  edges.set('A', ['A']);
  const response = await criticality('A');
  expect(response.status).toBe(200);
  expect(response.body.data.criticality_score).toBe(55);
  expect(run).toHaveBeenCalledTimes(1);
  expect(query.mock.calls.length).toBeLessThanOrEqual(3);
});

it('refuses an over-depth chain without caching any partial scores', async () => {
  for (let index = 0; index < 13; index++) edges.set(`N${index}`, [`N${index + 1}`]);
  const response = await criticality('N0');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toBe(false);
  expect(run.mock.calls.length).toBeLessThanOrEqual(12);
});

it('refuses a wide graph at the shared node budget with no cache writes', async () => {
  edges.set('A', Array.from({ length: 101 }, (_, index) => `D${index}`));
  const response = await criticality('A');
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toBe(false);
  expect(run.mock.calls.length).toBeLessThanOrEqual(100);
});

it('keeps the acyclic dependent weighting unchanged', async () => {
  edges.set('A', ['B']); edges.set('B', []);
  const response = await criticality('A');
  expect(response.status).toBe(200);
  expect(response.body.data.criticality_score).toBe(62);
  expect(response.body.data.factors.dependent_weight).toBe(22.5);
  expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toHaveLength(2);
});

it('refuses a dense fan-out graph beyond the node cap before criticality or cache writes', async () => {
  run.mockImplementation(async (cypher) => ({
    records: cypher.includes('RETURN node.id as id')
      ? Array.from({ length: 101 }, (_, index) =>
          graphRecord({ id: `N${index}`, name: `node ${index}`, ci_type: 'server',
            dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } }))
      : [],
  }));
  const response = await graph(5);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  expect(query).not.toHaveBeenCalled();
});

it('refuses an over-edge graph before any per-node cache writes', async () => {
  run.mockImplementation(async (cypher) => ({
    records: cypher.includes('RETURN node.id as id')
      ? [graphRecord({ id: 'A', name: 'root', ci_type: 'server',
          dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } })]
      : Array.from({ length: 201 }, (_, index) =>
          graphRecord({ source_id: 'A', target_id: 'A', rel_type: `EDGE_${index}` })),
  }));
  const response = await graph(5);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(query).not.toHaveBeenCalled();
});

it('shares a finite graph work budget across per-node criticality traversals', async () => {
  const roots = Array.from({ length: 6 }, (_, index) => `G${index}`);
  run.mockImplementation(async (cypher, params) => {
    if (cypher.includes('RETURN node.id as id')) {
      return { records: roots.map((id) => graphRecord({ id, name: id, ci_type: 'server',
        dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } })) };
    }
    if (cypher.includes('RETURN source.id as source_id')) return { records: [] };
    if (run.mock.calls.length > 500) throw new Error('Driver work exceeded budget');
    const id = params.ciId;
    const dependents = roots.includes(id) ? Array.from({ length: 75 }, (_, index) => `${id}-D${index}`) : [];
    return { records: [graphRecord({
      ci_name: id, dependent_ids: dependents,
      dependent_count: { toNumber: () => dependents.length },
      dependency_count: { toNumber: () => 0 },
    })] };
  });
  const response = await graph(5);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(run.mock.calls.length).toBeLessThanOrEqual(402);
  expect(query.mock.calls.length).toBeLessThanOrEqual(800);
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toBe(false);
});

it('reserves the whole graph cache-write budget before persisting a score', async () => {
  run.mockImplementation(async (cypher, params) => {
    if (cypher.includes('RETURN node.id as id')) {
      return { records: Array.from({ length: 100 }, (_, index) =>
        graphRecord({ id: `G${index}`, name: `G${index}`, ci_type: 'server',
          dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } })) };
    }
    if (cypher.includes('RETURN source.id as source_id')) {
      return { records: Array.from({ length: 200 }, (_, index) =>
        graphRecord({ source_id: 'G0', target_id: 'G1', rel_type: `EDGE_${index}` })) };
    }
    return { records: [graphRecord({ ci_name: params.ciId, dependent_ids: [],
      dependent_count: { toNumber: () => 0 }, dependency_count: { toNumber: () => 0 } })] };
  });
  const response = await graph(5);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ success: false, error: 'Impact criticality resource limit exceeded' });
  expect(run.mock.calls.length).toBeLessThanOrEqual(102);
  expect(query.mock.calls.length).toBeLessThanOrEqual(200);
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toBe(false);
});

it('preserves a small owned graph at depth boundaries and rejects depth outside 1..5', async () => {
  run.mockImplementation(async (cypher) => ({
    records: cypher.includes('RETURN node.id as id')
      ? ['A', 'B'].map((id) => graphRecord({ id, name: id, ci_type: 'server',
          dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } }))
      : [graphRecord({ source_id: 'A', target_id: 'B', rel_type: 'DEPENDS_ON' })],
  }));
  query.mockImplementation(async (sql, params) =>
    sql.includes('ci_criticality_scores s')
      ? { rows: [{ ci_id: params![0], ci_name: params![0], criticality_score: 50,
          factors: {}, calculated_at: new Date() }] }
      : { rows: [] });
  for (const depth of [1, 5]) {
    const response = await graph(depth);
    expect(response.status).toBe(200);
    expect(response.body.data.nodes.map((node: { ci_id: string; criticality: number }) =>
      [node.ci_id, node.criticality])).toEqual([['A', 50], ['B', 50]]);
    expect(response.body.data.edges).toEqual([{
      source_id: 'A', target_id: 'B', relationship_type: 'DEPENDS_ON', weight: 1, is_critical: true,
    }]);
    expect(response.body.data.metadata).toMatchObject({ total_nodes: 2, total_edges: 1, max_depth: depth });
  }
  expect(run.mock.calls.every(([cypher]) => cypher.includes('LIMIT'))).toBe(true);
  expect(run.mock.calls[0][1]).toMatchObject({ nodeLimit: 101 });
  expect(run.mock.calls[1][1]).toMatchObject({ edgeLimit: 201 });
  for (const depth of [0, 6]) expect((await graph(depth)).status).toBe(400);
  expect(run).toHaveBeenCalledTimes(4);
});

it('keeps uncached small-graph scores while writing the completed graph cache', async () => {
  edges.set('A', ['B']); edges.set('B', []);
  run.mockImplementation(async (cypher, params) => {
    if (cypher.includes('RETURN node.id as id')) {
      return { records: ['A', 'B'].map((id) => graphRecord({ id, name: id, ci_type: 'server',
        dependents_count: { toNumber: () => 0 }, dependencies_count: { toNumber: () => 0 } })) };
    }
    if (cypher.includes('RETURN source.id as source_id')) {
      return { records: [graphRecord({ source_id: 'A', target_id: 'B', rel_type: 'DEPENDS_ON' })] };
    }
    const dependents = edges.get(params.ciId) ?? [];
    return { records: [graphRecord({ ci_name: params.ciId, dependent_ids: dependents,
      dependent_count: { toNumber: () => dependents.length },
      dependency_count: { toNumber: () => 0 } })] };
  });
  const response = await graph(1);
  expect(response.status).toBe(200);
  expect(response.body.data.nodes.map((node: { ci_id: string; criticality: number }) =>
    [node.ci_id, node.criticality])).toEqual([['A', 62], ['B', 45]]);
  expect(response.body.data.edges).toEqual([{
    source_id: 'A', target_id: 'B', relationship_type: 'DEPENDS_ON', weight: 1, is_critical: true,
  }]);
  expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ci_criticality_scores'))).toHaveLength(2);
});
