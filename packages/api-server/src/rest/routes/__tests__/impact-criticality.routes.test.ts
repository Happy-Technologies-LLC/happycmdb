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
