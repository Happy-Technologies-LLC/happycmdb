// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const clientQuery = jest.fn(async (sql: string) => {
  if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Empty service', ci_id: null }] };
  return { rows: [] };
});
const release = jest.fn();
const getClient = jest.fn(async () => ({ query: clientQuery, release }));
const run = jest.fn(async (_cypher: string, _params?: unknown, _options?: { timeout: number }) => ({ records: [] }));

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ getClient, query: jest.fn(async () => ({ rows: [] })) }),
  getNeo4jClient: () => ({ getSession: () => ({ run, close: async () => undefined }) }),
}));

import {
  ArchitectureOptimizationEngine, withArchitectureDeadline, architectureFailure,
} from '../../src/engines/architecture-optimization-engine';

beforeEach(() => {
  Object.assign(ArchitectureOptimizationEngine, { instance: undefined });
  clientQuery.mockClear();
  clientQuery.mockImplementation(async (sql) => {
    if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Empty service', ci_id: null }] };
    return { rows: [] };
  });
  run.mockImplementation(async () => ({ records: [] }));
  getClient.mockImplementation(async () => ({ query: clientQuery, release }));
  release.mockClear();
  run.mockClear();
});

it('propagates the remaining request budget to the owned-root Neo4j statement', async () => {
  clientQuery.mockImplementation(async (sql) => {
    if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Service', ci_id: 'ci-1' }] };
    return { rows: [] };
  });
  const engine = ArchitectureOptimizationEngine.getInstance();
  await withArchitectureDeadline(Date.now() + 1000, () => engine.analyzeBusinessService('service-1', 'org-a'));
  expect(run).toHaveBeenCalledTimes(1);
  const options = run.mock.calls[0][2];
  expect(options?.timeout).toBeGreaterThan(0);
  expect(options?.timeout).toBeLessThanOrEqual(1000);
});

it('maps a PostgreSQL statement cancellation to fixed 504', () => {
  expect(architectureFailure(Object.assign(new Error('SQL details'), { code: '57014' })))
    .toEqual({ status: 504, message: 'Architecture analysis timed out' });
  expect(architectureFailure(Object.assign(new Error('SQL details'), { code: '53200' })))
    .toEqual({ status: 503, message: 'Architecture analysis resource limit exceeded' });
});
